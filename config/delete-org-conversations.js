#!/usr/bin/env node
/**
 * Safely purge every conversation (and org-scoped memories/projects) for one
 * IzyTesting organization. Dry-run is the default; deletion requires --execute
 * and --confirm with the same organization UUID.
 *
 *   npm run delete:org-conversations -- --org <UUID>
 *   npm run delete:org-conversations -- --org <UUID> --execute --confirm <UUID>
 */

const DEFAULT_BATCH_SIZE = 200;
const SAMPLE_LIMIT = 10;

/**
 * @param {string[]} argv
 * @returns {{
 *   organizationId: string,
 *   confirm: string,
 *   execute: boolean,
 *   dryRun: boolean,
 *   yes: boolean,
 *   batchSize: number,
 * }}
 */
function parseArgs(argv) {
  /** @type {{ organizationId: string, confirm: string, execute: boolean, dryRun: boolean, yes: boolean, batchSize: number }} */
  const args = {
    organizationId: '',
    confirm: '',
    execute: false,
    dryRun: true,
    yes: false,
    batchSize: DEFAULT_BATCH_SIZE,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      i += 1;
      return argv[i] ?? '';
    };

    if (arg === '--execute') {
      args.execute = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--yes' || arg === '-y') {
      args.yes = true;
    } else if (arg === '--org' || arg === '--organizationId') {
      args.organizationId = takeValue();
    } else if (arg.startsWith('--org=')) {
      args.organizationId = arg.slice('--org='.length);
    } else if (arg === '--confirm') {
      args.confirm = takeValue();
    } else if (arg.startsWith('--confirm=')) {
      args.confirm = arg.slice('--confirm='.length);
    } else if (arg === '--batch-size') {
      args.batchSize = Number(takeValue()) || DEFAULT_BATCH_SIZE;
    } else if (arg.startsWith('--batch-size=')) {
      args.batchSize = Number(arg.slice('--batch-size='.length)) || DEFAULT_BATCH_SIZE;
    } else if (!arg.startsWith('-') && !args.organizationId) {
      args.organizationId = arg;
    }
  }

  if (argv.includes('--dry-run')) {
    args.execute = false;
  }
  args.dryRun = !args.execute;
  return args;
}

/**
 * Isolation treats an empty org as "match nothing". Refuse it so a missing
 * flag can never be mistaken for a wipe of unscoped rows.
 * @param {unknown} organizationId
 * @returns {string}
 */
function assertSafeOrganizationId(organizationId) {
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    throw new Error('A non-empty --org <organizationId> is required.');
  }
  return organizationId.trim();
}

/**
 * @param {{ execute?: boolean, organizationId: string, confirm?: string }} args
 */
function assertExecuteGuards({ execute, organizationId, confirm }) {
  if (!execute) {
    return;
  }
  if (typeof confirm !== 'string' || confirm !== organizationId) {
    throw new Error(
      'Refusing to delete: --execute requires --confirm <organizationId> matching --org exactly.',
    );
  }
}

/**
 * @param {unknown} query
 * @returns {Promise<any>}
 */
async function execQuery(query) {
  if (query == null) {
    return query;
  }
  if (typeof query.then === 'function') {
    return query;
  }
  if (typeof query.lean === 'function') {
    return query.lean();
  }
  if (typeof query.exec === 'function') {
    return query.exec();
  }
  return query;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * @param {{ log?: Function, purple?: Function, yellow?: Function, green?: Function, cyan?: Function, orange?: Function, red?: Function }} [logger]
 * @param {'log' | 'purple' | 'yellow' | 'green' | 'cyan' | 'orange' | 'red'} color
 * @param {string} message
 */
function emit(logger, color, message) {
  const target = logger ?? console;
  if (typeof target[color] === 'function') {
    target[color](message);
    return;
  }
  if (typeof target.log === 'function') {
    target.log(message);
  }
}

/**
 * @param {object | undefined} model
 * @param {Record<string, unknown>} filter
 * @param {{ select?: string, limit?: number }} [options]
 */
async function findLean(model, filter, options = {}) {
  if (model == null || typeof model.find !== 'function') {
    return [];
  }
  let query = model.find(filter);
  if (options.select && query && typeof query.select === 'function') {
    query = query.select(options.select);
  }
  if (options.limit != null && query && typeof query.limit === 'function') {
    query = query.limit(options.limit);
  }
  const rows = await execQuery(query);
  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {object | undefined} model
 * @param {Record<string, unknown>} filter
 * @returns {Promise<number>}
 */
async function countDocuments(model, filter) {
  if (model == null) {
    return 0;
  }
  if (typeof model.countDocuments === 'function') {
    return Number((await model.countDocuments(filter)) ?? 0);
  }
  const rows = await findLean(model, filter);
  return rows.length;
}

/**
 * @param {object | undefined} model
 * @param {string} field
 * @param {Record<string, unknown>} filter
 * @returns {Promise<any[]>}
 */
async function distinct(model, field, filter) {
  if (model != null && typeof model.distinct === 'function') {
    const values = await model.distinct(field, filter);
    return Array.isArray(values) ? values : [];
  }
  const rows = await findLean(model, filter, { select: field });
  return [...new Set(rows.map((row) => row?.[field]).filter((value) => value != null))];
}

/**
 * @param {object | undefined} model
 * @param {string[]} conversationIds
 * @param {number} batchSize
 * @returns {Promise<number>}
 */
async function countByConversationIds(model, conversationIds, batchSize) {
  if (model == null || conversationIds.length === 0) {
    return 0;
  }
  let total = 0;
  for (const batch of chunk(conversationIds, batchSize)) {
    total += await countDocuments(model, { conversationId: { $in: batch } });
  }
  return total;
}

/**
 * @param {object} deps
 * @param {string} organizationId
 * @param {{ batchSize?: number }} [options]
 */
async function inventoryOrganization(deps, organizationId, options = {}) {
  assertSafeOrganizationId(organizationId);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const orgFilter = { organizationId };
  const Conversation = deps.Conversation;
  const Message = deps.Message;
  const File = deps.File;
  const SharedLink = deps.SharedLink;
  const MemoryEntry = deps.MemoryEntry;
  const ChatProject = deps.ChatProject;

  const [conversations, users, memories, projects, sample] = await Promise.all([
    countDocuments(Conversation, orgFilter),
    distinct(Conversation, 'user', orgFilter),
    countDocuments(MemoryEntry, orgFilter),
    countDocuments(ChatProject, orgFilter),
    findLean(Conversation, orgFilter, {
      select: 'conversationId title user',
      limit: SAMPLE_LIMIT,
    }),
  ]);

  const conversationIds = (await distinct(Conversation, 'conversationId', orgFilter)).map(String);
  const [messages, files, sharedLinks] = await Promise.all([
    countByConversationIds(Message, conversationIds, batchSize),
    countByConversationIds(File, conversationIds, batchSize),
    countByConversationIds(SharedLink, conversationIds, batchSize),
  ]);

  const projectDocs = await findLean(ChatProject, orgFilter, { select: 'file_ids' });
  const projectFileIds = [
    ...new Set(
      projectDocs.flatMap((project) =>
        Array.isArray(project?.file_ids) ? project.file_ids.filter(Boolean) : [],
      ),
    ),
  ];
  let projectFiles = 0;
  if (projectFileIds.length > 0) {
    projectFiles = await countDocuments(File, { file_id: { $in: projectFileIds } });
  }

  return {
    organizationId,
    users: users.length,
    userIds: users.map(String),
    conversations,
    conversationIds,
    messages,
    files,
    sharedLinks,
    memories,
    projects,
    projectFiles,
    sample: sample.map((row) => ({
      conversationId: row.conversationId,
      title: row.title,
      user: row.user,
    })),
  };
}

/**
 * @param {object} deps
 * @param {string} userId
 * @returns {Promise<string | undefined>}
 */
async function resolveTenantId(deps, userId) {
  const User = deps.User;
  if (User == null) {
    return undefined;
  }
  try {
    let query;
    if (typeof User.findById === 'function') {
      query = User.findById(userId);
    } else if (typeof User.findOne === 'function') {
      query = User.findOne({ _id: userId });
    } else {
      return undefined;
    }
    if (query && typeof query.select === 'function') {
      query = query.select('tenantId');
    }
    const user = await execQuery(query);
    return typeof user?.tenantId === 'string' && user.tenantId !== '' ? user.tenantId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {object} deps
 * @param {string[]} conversationIds
 * @param {string} [userId]
 */
async function deleteFilesForConversationIds(deps, conversationIds, userId) {
  if (!conversationIds.length || deps.File == null) {
    return 0;
  }
  const files = [];
  for (const batch of chunk(conversationIds, deps.batchSize ?? DEFAULT_BATCH_SIZE)) {
    files.push(...(await findLean(deps.File, { conversationId: { $in: batch } })));
  }
  if (files.length === 0) {
    return 0;
  }
  if (typeof deps.deleteFiles === 'function') {
    const result = await deps.deleteFiles(files, userId);
    return Number(result?.deletedCount ?? files.length);
  }
  const result = await deps.File.deleteMany({
    file_id: { $in: files.map((file) => file.file_id).filter(Boolean) },
  });
  return Number(result?.deletedCount ?? 0);
}

/**
 * @param {object} deps
 * @param {string} userId
 * @param {string} conversationId
 */
async function deleteSharedLinksForConversation(deps, userId, conversationId) {
  if (typeof deps.deleteConvoSharedLinks === 'function') {
    const result = await deps.deleteConvoSharedLinks(userId, conversationId);
    return Number(result?.deletedCount ?? 0);
  }
  if (deps.SharedLink != null && typeof deps.SharedLink.deleteMany === 'function') {
    const result = await deps.SharedLink.deleteMany({ user: userId, conversationId });
    return Number(result?.deletedCount ?? 0);
  }
  return 0;
}

/**
 * @param {object} deps
 * @param {string} userId
 * @param {string} conversationId
 */
async function deleteToolCallsForConversation(deps, userId, conversationId) {
  if (typeof deps.methods?.deleteToolCalls === 'function') {
    const result = await deps.methods.deleteToolCalls(userId, conversationId);
    return Number(result?.deletedCount ?? 0);
  }
  return 0;
}

/**
 * @param {object} deps
 * @param {string} organizationId
 * @param {{ batchSize?: number }} [options]
 */
async function purgeOrganization(deps, organizationId, options = {}) {
  const safeOrg = assertSafeOrganizationId(organizationId);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const orgFilter = { organizationId: safeOrg };
  const totals = {
    users: 0,
    conversations: 0,
    messages: 0,
    toolCalls: 0,
    sharedLinks: 0,
    files: 0,
    memories: 0,
    projects: 0,
    projectFiles: 0,
  };

  const userIds = (await distinct(deps.Conversation, 'user', orgFilter)).map(String);
  totals.users = userIds.length;

  for (const userId of userIds) {
    emit(deps.logger, 'cyan', `Purging conversations for user ${userId}`);
    const tenantId = await resolveTenantId(deps, userId);

    // Re-read remaining ids each wave so a concurrent insert cannot hide
    // behind a snapshot taken at the start of the user loop.
    for (;;) {
      const batch = await findLean(
        deps.Conversation,
        { user: userId, ...orgFilter },
        {
          select: 'conversationId',
          limit: batchSize,
        },
      );
      if (batch.length === 0) {
        break;
      }
      const batchIds = batch.map((row) => row.conversationId).filter(Boolean);
      let checkpoint = null;
      if (typeof deps.openCheckpointDeletion === 'function') {
        try {
          checkpoint = await deps.openCheckpointDeletion(userId, tenantId);
          await checkpoint?.remember?.(batchIds);
        } catch (error) {
          emit(
            deps.logger,
            'yellow',
            `Checkpoint intent failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          checkpoint = null;
        }
      }

      const beforeDelete = async (conversationIds) => {
        if (checkpoint?.remember) {
          await checkpoint.remember(conversationIds);
        }
        if (typeof deps.drainGenerations === 'function') {
          await deps.drainGenerations(userId, conversationIds, tenantId);
        }
        if (checkpoint?.remember) {
          await checkpoint.remember(conversationIds);
        }
      };

      const deleted = await deps.methods.deleteConvos(
        userId,
        { conversationId: { $in: batchIds } },
        { organizationId: safeOrg, allowEmpty: true, beforeDelete },
      );
      const deletedIds = [
        ...new Set([...(deleted?.conversationIds ?? []), ...batchIds].filter(Boolean)),
      ];
      totals.conversations += Number(deleted?.deletedCount ?? deletedIds.length);
      totals.messages += Number(deleted?.messages?.deletedCount ?? 0);

      for (const conversationId of deletedIds) {
        totals.toolCalls += await deleteToolCallsForConversation(deps, userId, conversationId);
        totals.sharedLinks += await deleteSharedLinksForConversation(deps, userId, conversationId);
      }
      totals.files += await deleteFilesForConversationIds(deps, deletedIds, userId);

      if (checkpoint) {
        try {
          await checkpoint.cleanup?.();
          await checkpoint.acknowledge?.();
        } catch (error) {
          emit(
            deps.logger,
            'yellow',
            `Checkpoint cleanup failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  if (deps.MemoryEntry != null && typeof deps.MemoryEntry.deleteMany === 'function') {
    const memoryResult = await deps.MemoryEntry.deleteMany(orgFilter);
    totals.memories = Number(memoryResult?.deletedCount ?? 0);
  }

  const projects = await findLean(deps.ChatProject, orgFilter, { select: 'file_ids' });
  const projectFileIds = [
    ...new Set(
      projects.flatMap((project) =>
        Array.isArray(project?.file_ids) ? project.file_ids.filter(Boolean) : [],
      ),
    ),
  ];
  if (projectFileIds.length > 0 && deps.File != null) {
    const projectFiles = await findLean(deps.File, { file_id: { $in: projectFileIds } });
    if (projectFiles.length > 0) {
      if (typeof deps.deleteFiles === 'function') {
        const result = await deps.deleteFiles(projectFiles);
        totals.projectFiles = Number(result?.deletedCount ?? projectFiles.length);
      } else if (typeof deps.File.deleteMany === 'function') {
        const result = await deps.File.deleteMany({ file_id: { $in: projectFileIds } });
        totals.projectFiles = Number(result?.deletedCount ?? 0);
      }
    }
  }
  if (deps.ChatProject != null && typeof deps.ChatProject.deleteMany === 'function') {
    const projectResult = await deps.ChatProject.deleteMany(orgFilter);
    totals.projects = Number(projectResult?.deletedCount ?? 0);
  }

  return totals;
}

/**
 * @param {object} inventory
 * @param {object} [logger]
 */
function printInventory(inventory, logger) {
  emit(logger, 'purple', '---------------');
  emit(logger, 'purple', `Organization ${inventory.organizationId}`);
  emit(logger, 'purple', '---------------');
  emit(logger, 'log', `Users:            ${inventory.users}`);
  emit(logger, 'log', `Conversations:    ${inventory.conversations}`);
  emit(logger, 'log', `Messages:         ${inventory.messages}`);
  emit(logger, 'log', `Files:            ${inventory.files}`);
  emit(logger, 'log', `Shared links:     ${inventory.sharedLinks}`);
  emit(logger, 'log', `Memories:         ${inventory.memories}`);
  emit(logger, 'log', `Chat projects:    ${inventory.projects}`);
  emit(logger, 'log', `Project files:    ${inventory.projectFiles}`);
  if (inventory.sample?.length) {
    emit(logger, 'cyan', 'Sample conversations:');
    for (const row of inventory.sample) {
      emit(
        logger,
        'log',
        `  ${row.conversationId}  ${row.title ?? '(untitled)'}  user=${row.user}`,
      );
    }
  }
}

/**
 * Testable CLI body: inventory always runs; purge runs only after execute guards.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {object} deps
 */
async function run(args, deps) {
  const organizationId = assertSafeOrganizationId(args.organizationId);
  assertExecuteGuards({
    execute: args.execute,
    organizationId,
    confirm: args.confirm,
  });

  const inventory = await inventoryOrganization(deps, organizationId, {
    batchSize: args.batchSize,
  });
  printInventory(inventory, deps.logger);

  if (!args.execute) {
    emit(
      deps.logger,
      'yellow',
      'Dry-run only. Pass --execute --confirm <organizationId> to delete.',
    );
    return { dryRun: true, aborted: false, inventory };
  }

  if (typeof deps.confirmExecute === 'function') {
    const confirmed = await deps.confirmExecute(inventory);
    if (confirmed !== true) {
      emit(deps.logger, 'yellow', 'Aborted.');
      return { dryRun: false, aborted: true, inventory };
    }
  }

  const result = await purgeOrganization(deps, organizationId, { batchSize: args.batchSize });
  emit(
    deps.logger,
    'green',
    `Deleted ${result.conversations} conversation(s), ${result.messages} message(s), ${result.memories} memor(ies), ${result.projects} project(s) for org ${organizationId}.`,
  );
  return { dryRun: false, aborted: false, inventory, result };
}

async function createRuntimeDeps() {
  const path = require('path');
  const mongoose = require('mongoose');
  const { createModels, createMethods } = require('@librechat/data-schemas');
  require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
  const {
    GenerationJobManager,
    createStreamServices,
    waitForKeyvRedisClient,
    openCheckpointDeletion,
    deleteConvoSharedLinksWithCleanup,
  } = require('@librechat/api');
  const getLogStores = require('~/cache/getLogStores');
  const { getAppConfig } = require('~/server/services/Config');
  const { processDeleteRequest } = require('~/server/services/Files/process');
  const models = createModels(mongoose);
  const methods = createMethods(mongoose, { getCache: getLogStores });

  let streamServices;
  let hasSharedGenerationStore = false;
  try {
    await waitForKeyvRedisClient();
    streamServices = createStreamServices();
    hasSharedGenerationStore = Boolean(streamServices?.isRedis);
  } catch (error) {
    console.yellow(
      `Shared Redis generation coordination is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
    streamServices = createStreamServices({ useRedis: false });
  }
  if (hasSharedGenerationStore) {
    GenerationJobManager.configure({ ...streamServices, cleanupOnComplete: false });
    GenerationJobManager.initialize();
  }

  /** @param {object[]} files @param {string} [userId] */
  const deleteFiles = async (files, userId) => {
    if (!files.length) {
      return { deletedCount: 0 };
    }
    try {
      const appConfig = await getAppConfig({ baseOnly: true });
      const result = await processDeleteRequest({
        req: {
          user: { id: userId ?? String(files[0]?.user ?? '') },
          config: appConfig,
          body: {},
        },
        files,
      });
      return { deletedCount: result?.deletedFileIds?.length ?? 0 };
    } catch (error) {
      console.yellow(
        `Storage delete failed (${error instanceof Error ? error.message : String(error)}); removing file metadata only.`,
      );
      const result = await models.File.deleteMany({
        file_id: { $in: files.map((file) => file.file_id).filter(Boolean) },
      });
      return { deletedCount: result?.deletedCount ?? 0 };
    }
  };

  const drainGenerations = hasSharedGenerationStore
    ? async (userId, conversationIds, tenantId) => {
        if (!conversationIds.length) {
          return;
        }
        const runIds = await GenerationJobManager.getCleanupBlockingJobIdsForConversations(
          userId,
          conversationIds,
          tenantId,
        );
        const ids = [...new Set([...conversationIds, ...runIds])];
        await Promise.all(
          ids.map((id) =>
            GenerationJobManager.abortJob(id, { awaitProviderDrain: true }).catch((error) => {
              console.yellow(
                `Generation abort failed for ${id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }),
          ),
        );
      }
    : undefined;

  const openCheckpoints = async (userId, tenantId) => {
    const appConfig = await getAppConfig({ baseOnly: true });
    const checkpointer = appConfig?.endpoints?.agents?.checkpointer;
    return openCheckpointDeletion(userId, tenantId, undefined, checkpointer);
  };

  return {
    mongoose,
    hasSharedGenerationStore,
    GenerationJobManager,
    deps: {
      Conversation: models.Conversation,
      Message: models.Message,
      File: models.File,
      SharedLink: models.SharedLink,
      MemoryEntry: models.MemoryEntry,
      ChatProject: models.ChatProject,
      User: models.User,
      methods,
      deleteConvoSharedLinks: deleteConvoSharedLinksWithCleanup,
      deleteFiles,
      drainGenerations,
      openCheckpointDeletion: openCheckpoints,
      logger: console,
      batchSize: DEFAULT_BATCH_SIZE,
    },
  };
}

async function main() {
  require('dotenv').config();
  process.env.MONGO_AUTO_INDEX = 'false';
  process.env.MONGO_AUTO_CREATE = 'false';
  const { askQuestion, silentExit } = require('./helpers');
  const args = parseArgs(process.argv.slice(2));

  try {
    assertSafeOrganizationId(args.organizationId);
    assertExecuteGuards(args);
  } catch (error) {
    console.red(error instanceof Error ? error.message : String(error));
    silentExit(1);
    return;
  }

  const connect = require('./connect');
  await connect();

  let runtime;
  try {
    runtime = await createRuntimeDeps();
  } catch (error) {
    console.error(error);
    await require('mongoose')
      .disconnect()
      .catch(() => undefined);
    silentExit(1);
    return;
  }

  const { deps, hasSharedGenerationStore, mongoose, GenerationJobManager } = runtime;
  deps.batchSize = args.batchSize;

  if (args.execute && !hasSharedGenerationStore && !args.yes) {
    const confirmOffline = await askQuestion(
      'Shared Redis generation coordination is unavailable. Confirm ALL IzyChat app, worker, and other CLI processes are stopped before continuing. (y/N)',
    );
    if (confirmOffline.toLowerCase() !== 'y') {
      console.yellow('Aborted. Stop every IzyChat process or enable Redis stream coordination.');
      await mongoose.disconnect().catch(() => undefined);
      silentExit(1);
      return;
    }
  }

  if (args.execute && process.stdin.isTTY && !args.yes) {
    deps.confirmExecute = async () => {
      const answer = await askQuestion(
        `Really delete ALL conversations, memories, and chat projects for organization ${args.organizationId}? (y/N)`,
      );
      return answer.toLowerCase() === 'y';
    };
  }

  let exitCode = 0;
  try {
    await run(args, deps);
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }

  if (hasSharedGenerationStore) {
    await GenerationJobManager.destroy().catch((error) =>
      console.error('Failed to close generation coordination:', error),
    );
  }
  await mongoose.disconnect().catch(() => undefined);
  silentExit(exitCode);
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  parseArgs,
  assertSafeOrganizationId,
  assertExecuteGuards,
  inventoryOrganization,
  purgeOrganization,
  run,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
