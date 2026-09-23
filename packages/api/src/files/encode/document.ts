import { Providers } from '@librechat/agents';
import {
  isOpenAILikeProvider,
  isBedrockDocumentType,
  bedrockDocumentFormats,
  isAnthropicDocumentType,
  isDocumentSupportedProvider,
  isAnthropicTextDocumentType,
} from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type {
  DocumentBlock,
  AnthropicDocumentBlock,
  StrategyFunctions,
  DocumentResult,
  ServerRequest,
} from '~/types';
import {
  getFileStream,
  getConfiguredFileSizeLimit,
  isAttachmentObjectNotFoundError,
} from './utils';
import { validatePdf, validateBedrockDocument } from '~/files/validation';
import { runGuardedEncode } from './memoryGuard';

/** Anthropic only accepts PDFs as base64 documents; textual types must use a text source */
function getAnthropicDocumentSource(
  mimeType: string,
  content: string,
): AnthropicDocumentBlock['source'] | null {
  if (isAnthropicTextDocumentType(mimeType)) {
    return {
      type: 'text',
      media_type: 'text/plain',
      data: Buffer.from(content, 'base64').toString('utf8'),
    };
  }

  if (mimeType === 'application/pdf') {
    return {
      type: 'base64',
      media_type: mimeType,
      data: content,
    };
  }

  return null;
}

/**
 * Formats a base64-encoded document into the appropriate provider-specific block.
 * Returns `null` when the provider has no matching handler.
 */
function formatDocumentBlock(
  provider: Providers,
  mimeType: string,
  content: string,
  filename: string | undefined,
  useResponsesApi: boolean | undefined,
): DocumentBlock | null {
  if (provider === Providers.ANTHROPIC) {
    const source = getAnthropicDocumentSource(mimeType, content);
    if (!source) {
      return null;
    }

    const document: AnthropicDocumentBlock = {
      type: 'document',
      source,
      citations: { enabled: true },
    };

    if (filename) {
      document.context = `File: "${filename}"`;
    }

    return document;
  }

  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    return {
      type: 'media',
      mimeType,
      data: content,
    };
  }

  const resolvedFilename = filename ?? 'document';

  if (useResponsesApi) {
    return {
      type: 'input_file',
      filename: resolvedFilename,
      file_data: `data:${mimeType};base64,${content}`,
    };
  }

  if (isOpenAILikeProvider(provider) && provider !== Providers.AZURE) {
    return {
      type: 'file',
      file: {
        filename: resolvedFilename,
        file_data: `data:${mimeType};base64,${content}`,
      },
    };
  }

  return null;
}

/** Splits `files` by `isSupported(mimeType)`, warning once (with `label`) about anything dropped. */
function partitionSupportedDocuments(
  files: IMongoFile[],
  isSupported: (mimeType: string) => boolean,
  label: string,
): IMongoFile[] {
  const processable: IMongoFile[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (isSupported(file.type)) {
      processable.push(file);
    } else {
      skipped.push(`"${file.filename}" (${file.type})`);
    }
  }

  if (skipped.length) {
    console.warn(`Skipping attachment(s) unsupported by ${label}: ${skipped.join(', ')}`);
  }

  return processable;
}

/**
 * Filters out files the provider's document path cannot send to the model at all.
 * Claude rejects non-PDF binary documents with a 400 that recurs on every retry,
 * including when it is reached through an OpenAI-compatible gateway. OpenAI's own
 * file input (`input_file`/`file` with `file_data`) rejects every MIME type except
 * `application/pdf` with a 400, for both the Responses API and Chat Completions --
 * but a *textual* type (json, xml, csv, plain text, ...) still has somewhere to go:
 * `encodeAndFormatDocuments` inlines it as plain text (`textContext`) instead of a
 * broken file block, so those are let through here. Only genuinely unrepresentable
 * types (binary, non-PDF) are dropped, with a warning, instead of bricking the
 * conversation.
 */
function filterProviderDocumentFiles(
  provider: Providers,
  files: IMongoFile[],
  model?: string,
): IMongoFile[] {
  if (provider === Providers.BEDROCK) {
    return files.filter((file) => isBedrockDocumentType(file.type));
  }

  const usesAnthropicDocumentCapabilities =
    provider === Providers.ANTHROPIC ||
    (isOpenAILikeProvider(provider) && model?.toLowerCase().includes('claude'));

  if (usesAnthropicDocumentCapabilities) {
    return partitionSupportedDocuments(files, isAnthropicDocumentType, 'Claude document input');
  }

  if (isOpenAILikeProvider(provider) && provider !== Providers.AZURE) {
    return partitionSupportedDocuments(
      files,
      (mimeType) => mimeType === 'application/pdf' || isAnthropicTextDocumentType(mimeType),
      "OpenAI's file input (PDF, or textual types inlined as plain text)",
    );
  }

  return files;
}

function getBase64DecodedByteCount(content: string): number {
  let paddingChars = 0;

  if (content.endsWith('==')) {
    paddingChars = 2;
  } else if (content.endsWith('=')) {
    paddingChars = 1;
  }

  return Math.floor((content.length * 3) / 4) - paddingChars;
}

/**
 * Encodes and formats document files for various providers.
 *
 * Callers are responsible for pre-filtering `files` to types the endpoint accepts
 * (e.g., via `supportedMimeTypes` in `processAttachments`). This function processes
 * every file it receives and dispatches to the appropriate provider format:
 * - **Bedrock**: Only encodes types in `bedrockDocumentFormats`; all others are skipped.
 * - **Anthropic**: Only encodes PDFs (base64 source) and textual types (plain-text source);
 *   all others are skipped.
 * - **PDF**: Validated via `validatePdf` before encoding.
 * - **Generic types**: Encoded with a provider-specific size check. For an OpenAI-like
 *   provider, a non-PDF textual type (json, xml, csv, plain text, ...) can't go through
 *   `file_data` (PDF-only), so it's decoded and appended to `textContext` instead of
 *   `documents` -- the caller merges that into `message.fileContext`, a plain-text field
 *   every provider understands, rather than a provider-specific document block.
 */
export async function encodeAndFormatDocuments(
  req: ServerRequest,
  files: IMongoFile[],
  params: { provider: Providers; endpoint?: string; useResponsesApi?: boolean; model?: string },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<DocumentResult> {
  const { provider, endpoint, useResponsesApi, model } = params;
  if (!files?.length) {
    return { documents: [], files: [] };
  }

  const encodingMethods: Record<string, StrategyFunctions> = {};
  const result: DocumentResult = { documents: [], files: [] };

  const isBedrock = provider === Providers.BEDROCK;
  const isDocSupported = isDocumentSupportedProvider(provider);

  if (!isDocSupported && !isBedrock) {
    return result;
  }

  const processableFiles = filterProviderDocumentFiles(provider, files, model);

  if (!processableFiles.length) {
    return result;
  }

  const configuredFileSizeLimit = getConfiguredFileSizeLimit(req, { provider, endpoint });

  const results = await Promise.allSettled(
    processableFiles.map((file) =>
      runGuardedEncode(file.bytes ?? 0, () =>
        getFileStream(req, file, encodingMethods, getStrategyFunctions),
      ),
    ),
  );

  for (const settledResult of results) {
    if (settledResult.status === 'rejected') {
      if (isAttachmentObjectNotFoundError(settledResult.reason)) {
        throw settledResult.reason;
      }
      console.error('Document processing failed:', settledResult.reason);
      continue;
    }

    const processed = settledResult.value;
    if (!processed) continue;

    const { file, content, metadata } = processed;

    if (!content || !file) {
      if (metadata) result.files.push(metadata);
      continue;
    }

    const mimeType = file.type ?? '';

    if (isBedrock && isBedrockDocumentType(mimeType)) {
      const fileBuffer = Buffer.from(content, 'base64');
      const format = bedrockDocumentFormats[mimeType];

      const validation = await validateBedrockDocument(
        fileBuffer.length,
        mimeType,
        fileBuffer,
        configuredFileSizeLimit,
        model,
      );

      if (!validation.isValid) {
        throw new Error(`Document validation failed: ${validation.error}`);
      }

      const sanitizedName = (file.filename || 'document')
        .replace(/[^a-zA-Z0-9\s\-()[\]]/g, '_')
        .slice(0, 200);
      result.documents.push({
        type: 'document',
        document: {
          name: sanitizedName,
          format,
          source: {
            bytes: fileBuffer,
          },
        },
      });
      result.files.push(metadata);
    } else if (file.type === 'application/pdf' && isDocSupported) {
      const pdfBuffer = Buffer.from(content, 'base64');

      const validation = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        provider,
        configuredFileSizeLimit,
        model,
      );

      if (!validation.isValid) {
        throw new Error(`PDF validation failed: ${validation.error}`);
      }

      const block = formatDocumentBlock(
        provider,
        mimeType,
        content,
        file.filename,
        useResponsesApi,
      );
      if (block) {
        result.documents.push(block);
        result.files.push(metadata);
      }
    } else if (isDocSupported && !isBedrock) {
      const decodedByteCount = getBase64DecodedByteCount(content);
      if (configuredFileSizeLimit && decodedByteCount > configuredFileSizeLimit) {
        throw new Error(
          `File size (~${(decodedByteCount / 1024 / 1024).toFixed(1)}MB) exceeds the configured limit for ${provider}`,
        );
      }

      const needsTextFallback =
        isOpenAILikeProvider(provider) &&
        provider !== Providers.AZURE &&
        mimeType !== 'application/pdf';

      if (needsTextFallback) {
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        const entry = `File: "${file.filename}"\n${decoded}`;
        result.textContext = result.textContext ? `${result.textContext}\n\n${entry}` : entry;
        result.files.push(metadata);
        continue;
      }

      const block = formatDocumentBlock(
        provider,
        mimeType,
        content,
        file.filename,
        useResponsesApi,
      );
      if (block) {
        result.documents.push(block);
        result.files.push(metadata);
      }
    }
  }

  return result;
}
