const {
  parseArgs,
  assertSafeOrganizationId,
  assertExecuteGuards,
  inventoryOrganization,
  purgeOrganization,
  run,
} = require('../delete-org-conversations');

const ORG = 'org-izy-123';
const OTHER_ORG = 'org-other';

function mockQuery(result) {
  const query = {
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
  return query;
}

function createModels({
  conversations = [],
  messages = [],
  files = [],
  shares = [],
  memories = [],
  projects = [],
  users = [],
} = {}) {
  const Conversation = {
    find: jest.fn((filter = {}) => {
      const rows = conversations.filter((row) => matches(row, filter));
      const limited = { rows };
      const query = {
        select: jest.fn().mockReturnThis(),
        limit: jest.fn((n) => {
          limited.rows = rows.slice(0, n);
          return query;
        }),
        lean: jest.fn(async () => limited.rows),
      };
      return query;
    }),
    countDocuments: jest.fn(
      async (filter = {}) => conversations.filter((row) => matches(row, filter)).length,
    ),
    distinct: jest.fn(async (field, filter = {}) => [
      ...new Set(conversations.filter((row) => matches(row, filter)).map((row) => row[field])),
    ]),
    deleteMany: jest.fn(),
  };

  const Message = {
    countDocuments: jest.fn(
      async (filter = {}) => messages.filter((row) => matches(row, filter)).length,
    ),
    deleteMany: jest.fn(),
  };

  const File = {
    find: jest.fn((filter = {}) => mockQuery(files.filter((row) => matches(row, filter)))),
    countDocuments: jest.fn(
      async (filter = {}) => files.filter((row) => matches(row, filter)).length,
    ),
    deleteMany: jest.fn(async (filter = {}) => ({
      deletedCount: files.filter((row) => matches(row, filter)).length,
    })),
  };

  const SharedLink = {
    countDocuments: jest.fn(
      async (filter = {}) => shares.filter((row) => matches(row, filter)).length,
    ),
    deleteMany: jest.fn(async (filter = {}) => ({
      deletedCount: shares.filter((row) => matches(row, filter)).length,
    })),
  };

  const MemoryEntry = {
    countDocuments: jest.fn(
      async (filter = {}) => memories.filter((row) => matches(row, filter)).length,
    ),
    deleteMany: jest.fn(async (filter = {}) => ({
      deletedCount: memories.filter((row) => matches(row, filter)).length,
    })),
  };

  const ChatProject = {
    find: jest.fn((filter = {}) => mockQuery(projects.filter((row) => matches(row, filter)))),
    countDocuments: jest.fn(
      async (filter = {}) => projects.filter((row) => matches(row, filter)).length,
    ),
    deleteMany: jest.fn(async (filter = {}) => ({
      deletedCount: projects.filter((row) => matches(row, filter)).length,
    })),
  };

  const User = {
    findById: jest.fn((id) =>
      mockQuery(users.find((user) => String(user._id) === String(id)) ?? null),
    ),
    findOne: jest.fn((filter) =>
      mockQuery(users.find((user) => String(user._id) === String(filter._id)) ?? null),
    ),
  };

  return { Conversation, Message, File, SharedLink, MemoryEntry, ChatProject, User };
}

function matches(doc, filter) {
  if (filter.organizationId && doc.organizationId !== filter.organizationId) {
    return false;
  }
  if (filter.user && doc.user !== filter.user) {
    return false;
  }
  if (filter.conversationId?.$in) {
    return filter.conversationId.$in.includes(doc.conversationId);
  }
  if (filter.file_id?.$in) {
    return filter.file_id.$in.includes(doc.file_id);
  }
  if (typeof filter.conversationId === 'string' && doc.conversationId !== filter.conversationId) {
    return false;
  }
  return true;
}

function createDeps(fixtures, extras = {}) {
  const models = createModels(fixtures);
  const remainingConvos = [...(fixtures.conversations ?? [])];
  models.Conversation.find = jest.fn((filter = {}) => {
    const rows = remainingConvos.filter((row) => matches(row, filter));
    const state = { rows };
    const query = {
      select: jest.fn().mockReturnThis(),
      limit: jest.fn((n) => {
        state.rows = rows.slice(0, n);
        return query;
      }),
      lean: jest.fn(async () => state.rows),
    };
    return query;
  });
  models.Conversation.distinct = jest.fn(async (field, filter = {}) => [
    ...new Set(remainingConvos.filter((row) => matches(row, filter)).map((row) => row[field])),
  ]);

  const deleteConvos = jest.fn(async (userId, filter) => {
    const ids = filter.conversationId?.$in ?? [];
    const removed = [];
    for (let i = remainingConvos.length - 1; i >= 0; i -= 1) {
      const row = remainingConvos[i];
      if (row.user === userId && ids.includes(row.conversationId)) {
        removed.push(remainingConvos.splice(i, 1)[0]);
      }
    }
    return {
      deletedCount: removed.length,
      messages: { deletedCount: removed.length },
      conversationIds: removed.map((row) => row.conversationId),
    };
  });

  const deleteToolCalls = jest.fn(async () => ({ deletedCount: 1 }));
  const deleteConvoSharedLinks = jest.fn(async () => ({ deletedCount: 1 }));
  const deleteFiles = jest.fn(async (files) => ({ deletedCount: files.length }));
  const deleteAllSharedLinks = jest.fn();
  const logger = {
    log: jest.fn(),
    purple: jest.fn(),
    yellow: jest.fn(),
    green: jest.fn(),
    cyan: jest.fn(),
    red: jest.fn(),
  };

  return {
    ...models,
    methods: { deleteConvos, deleteToolCalls },
    deleteConvoSharedLinks,
    deleteAllSharedLinks,
    deleteFiles,
    logger,
    ...extras,
  };
}

const fixtures = {
  conversations: [
    { conversationId: 'c1', user: 'user-a', title: 'Org chat', organizationId: ORG },
    { conversationId: 'c2', user: 'user-a', title: 'Other org', organizationId: OTHER_ORG },
    { conversationId: 'c3', user: 'user-b', title: 'Second user', organizationId: ORG },
  ],
  messages: [
    { conversationId: 'c1' },
    { conversationId: 'c1' },
    { conversationId: 'c2' },
    { conversationId: 'c3' },
  ],
  files: [
    { conversationId: 'c1', file_id: 'f1' },
    { conversationId: 'c2', file_id: 'f2' },
  ],
  shares: [
    { conversationId: 'c1', user: 'user-a' },
    { conversationId: 'c2', user: 'user-a' },
  ],
  memories: [
    { organizationId: ORG, key: 'keep' },
    { organizationId: OTHER_ORG, key: 'other' },
  ],
  projects: [
    { organizationId: ORG, file_ids: ['pf1'] },
    { organizationId: OTHER_ORG, file_ids: ['pf2'] },
  ],
  users: [{ _id: 'user-a', tenantId: 'tenant-1' }],
};

describe('parseArgs', () => {
  it('defaults to dry-run', () => {
    const args = parseArgs(['--org', ORG]);
    expect(args).toMatchObject({
      organizationId: ORG,
      execute: false,
      dryRun: true,
    });
  });

  it('enables execute only with --execute', () => {
    const args = parseArgs(['--org', ORG, '--execute', '--confirm', ORG]);
    expect(args.execute).toBe(true);
    expect(args.dryRun).toBe(false);
    expect(args.confirm).toBe(ORG);
  });

  it('lets --dry-run win over --execute', () => {
    const args = parseArgs(['--org', ORG, '--execute', '--dry-run', '--confirm', ORG]);
    expect(args.execute).toBe(false);
    expect(args.dryRun).toBe(true);
  });
});

describe('guards', () => {
  it('rejects an empty organization id', () => {
    expect(() => assertSafeOrganizationId('')).toThrow(/non-empty --org/);
    expect(() => assertSafeOrganizationId('   ')).toThrow(/non-empty --org/);
    expect(() => assertSafeOrganizationId(null)).toThrow(/non-empty --org/);
  });

  it('rejects --execute without a matching --confirm', () => {
    expect(() => assertExecuteGuards({ execute: true, organizationId: ORG, confirm: '' })).toThrow(
      /--confirm/,
    );
    expect(() =>
      assertExecuteGuards({ execute: true, organizationId: ORG, confirm: OTHER_ORG }),
    ).toThrow(/--confirm/);
  });

  it('allows execute when confirm matches', () => {
    expect(() =>
      assertExecuteGuards({ execute: true, organizationId: ORG, confirm: ORG }),
    ).not.toThrow();
  });
});

describe('inventoryOrganization', () => {
  it('counts only the target org and does not delete', async () => {
    const deps = createDeps(fixtures);
    const inventory = await inventoryOrganization(deps, ORG);

    expect(inventory.users).toBe(2);
    expect(inventory.conversations).toBe(2);
    expect(inventory.messages).toBe(3);
    expect(inventory.files).toBe(1);
    expect(inventory.sharedLinks).toBe(1);
    expect(inventory.memories).toBe(1);
    expect(inventory.projects).toBe(1);
    expect(deps.methods.deleteConvos).not.toHaveBeenCalled();
    expect(deps.Conversation.deleteMany).not.toHaveBeenCalled();
    expect(deps.MemoryEntry.deleteMany).not.toHaveBeenCalled();
    expect(deps.ChatProject.deleteMany).not.toHaveBeenCalled();
  });
});

describe('run', () => {
  it('dry-run inventories and never purges', async () => {
    const deps = createDeps(fixtures);
    const outcome = await run(parseArgs(['--org', ORG]), deps);

    expect(outcome.dryRun).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(deps.methods.deleteConvos).not.toHaveBeenCalled();
    expect(deps.deleteConvoSharedLinks).not.toHaveBeenCalled();
    expect(deps.MemoryEntry.deleteMany).not.toHaveBeenCalled();
    expect(deps.ChatProject.deleteMany).not.toHaveBeenCalled();
  });

  it('aborts execute without a matching confirm before touching data', async () => {
    const deps = createDeps(fixtures);
    await expect(run(parseArgs(['--org', ORG, '--execute']), deps)).rejects.toThrow(/--confirm/);
    expect(deps.Conversation.find).not.toHaveBeenCalled();
    expect(deps.methods.deleteConvos).not.toHaveBeenCalled();
  });

  it('aborts when confirm does not match the org', async () => {
    const deps = createDeps(fixtures);
    await expect(
      run(parseArgs(['--org', ORG, '--execute', '--confirm', OTHER_ORG]), deps),
    ).rejects.toThrow(/--confirm/);
    expect(deps.methods.deleteConvos).not.toHaveBeenCalled();
  });

  it('refuses an empty org before querying', async () => {
    const deps = createDeps(fixtures);
    await expect(run(parseArgs(['--execute', '--confirm', ORG]), deps)).rejects.toThrow(
      /non-empty --org/,
    );
    expect(deps.Conversation.find).not.toHaveBeenCalled();
    expect(deps.Conversation.countDocuments).not.toHaveBeenCalled();
  });
});

describe('purgeOrganization', () => {
  it('deletes convos per user scoped to the org, then memories and projects', async () => {
    const deps = createDeps(fixtures);
    const result = await purgeOrganization(deps, ORG);

    expect(deps.methods.deleteConvos).toHaveBeenCalledTimes(2);
    expect(deps.methods.deleteConvos).toHaveBeenCalledWith(
      'user-a',
      { conversationId: { $in: ['c1'] } },
      expect.objectContaining({ organizationId: ORG, allowEmpty: true }),
    );
    expect(deps.methods.deleteConvos).toHaveBeenCalledWith(
      'user-b',
      { conversationId: { $in: ['c3'] } },
      expect.objectContaining({ organizationId: ORG, allowEmpty: true }),
    );
    expect(
      deps.methods.deleteConvos.mock.calls.every((call) => call[2].organizationId === ORG),
    ).toBe(true);

    expect(deps.deleteConvoSharedLinks).toHaveBeenCalledWith('user-a', 'c1');
    expect(deps.deleteConvoSharedLinks).toHaveBeenCalledWith('user-b', 'c3');
    expect(deps.deleteConvoSharedLinks).not.toHaveBeenCalledWith('user-a', 'c2');
    expect(deps.deleteAllSharedLinks).not.toHaveBeenCalled();

    expect(deps.methods.deleteToolCalls).toHaveBeenCalledWith('user-a', 'c1');
    expect(deps.deleteFiles).toHaveBeenCalled();

    expect(deps.MemoryEntry.deleteMany).toHaveBeenCalledWith({ organizationId: ORG });
    expect(deps.ChatProject.deleteMany).toHaveBeenCalledWith({ organizationId: ORG });
    expect(deps.MemoryEntry.deleteMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.methods.deleteConvos.mock.invocationCallOrder[0],
    );
    expect(deps.ChatProject.deleteMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.methods.deleteConvos.mock.invocationCallOrder[0],
    );

    expect(result.conversations).toBe(2);
    expect(result.memories).toBe(1);
    expect(result.projects).toBe(1);
  });

  it('honors confirmExecute abort and does not purge when run is cancelled', async () => {
    const deps = createDeps(fixtures, { confirmExecute: jest.fn(async () => false) });
    const outcome = await run(parseArgs(['--org', ORG, '--execute', '--confirm', ORG]), deps);
    expect(outcome.aborted).toBe(true);
    expect(deps.methods.deleteConvos).not.toHaveBeenCalled();
    expect(deps.MemoryEntry.deleteMany).not.toHaveBeenCalled();
  });
});
