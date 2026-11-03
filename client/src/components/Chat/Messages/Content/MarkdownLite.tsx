import { memo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import supersub from 'remark-supersub';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import type { PluggableList } from 'unified';
import { ArtifactProvider, CodeBlockProvider, TableExportProvider } from '~/Providers';
import { code, codeNoExecution, a, p, img, table } from './MarkdownComponents';
import MarkdownErrorBoundary from './MarkdownErrorBoundary';
import { langSubset, remarkApproxTilde } from '~/utils';

const MarkdownLite = memo(
  ({ content = '', codeExecution = true }: { content?: string; codeExecution?: boolean }) => {
    const rehypePlugins: PluggableList = [
      [rehypeKatex],
      [
        rehypeHighlight,
        {
          detect: true,
          ignoreMissing: true,
          subset: langSubset,
        },
      ],
    ];

    return (
      <MarkdownErrorBoundary content={content} codeExecution={codeExecution}>
        <ArtifactProvider>
          <TableExportProvider>
            <CodeBlockProvider>
              <ReactMarkdown
                remarkPlugins={[
                  remarkApproxTilde,
                  /** @ts-ignore */
                  supersub,
                  remarkGfm,
                  [remarkMath, { singleDollarTextMath: false }],
                ]}
                /** @ts-ignore */
                rehypePlugins={rehypePlugins}
                components={
                  {
                    code: codeExecution ? code : codeNoExecution,
                    a,
                    p,
                    img,
                    table,
                  } as {
                    [nodeType: string]: React.ElementType;
                  }
                }
              >
                {content}
              </ReactMarkdown>
            </CodeBlockProvider>
          </TableExportProvider>
        </ArtifactProvider>
      </MarkdownErrorBoundary>
    );
  },
);

export default MarkdownLite;
