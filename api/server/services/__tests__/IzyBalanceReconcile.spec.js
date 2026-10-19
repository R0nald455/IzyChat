jest.mock('~/models', () => ({
  findUser: jest.fn(),
  findBalanceByUser: jest.fn(),
  getTransactions: jest.fn(),
  createTransaction: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const db = require('~/models');
const { reconcileBalanceWithIzytesting } = require('../IzyBalanceReconcile');

const USER = { _id: { toString: () => 'user-1' }, email: 'a@b.com' };
const ENV_KEYS = [
  'IZYTESTING_BALANCE_URL',
  'IZYTESTING_USAGE_URL',
  'IZYTESTING_USAGE_KEY',
  'IZYTESTING_USAGE_TIMEOUT_MS',
  'IZYTESTING_BALANCE_ENFORCE',
];

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

describe('reconcileBalanceWithIzytesting', () => {
  const originalEnv = {};
  let localCredits;

  beforeAll(() => {
    ENV_KEYS.forEach((k) => (originalEnv[k] = process.env[k]));
  });
  afterAll(() => {
    ENV_KEYS.forEach((k) =>
      originalEnv[k] === undefined ? delete process.env[k] : (process.env[k] = originalEnv[k]),
    );
  });

  beforeEach(() => {
    jest.resetAllMocks();
    ENV_KEYS.forEach((k) => delete process.env[k]);
    process.env.IZYTESTING_USAGE_URL = 'https://izy.test/api/agent_usage/ingest/';
    process.env.IZYTESTING_USAGE_KEY = 'secret';
    localCredits = 5000;
    db.findUser.mockResolvedValue(USER);
    db.getTransactions.mockResolvedValue([]);
    db.findBalanceByUser.mockImplementation(async () => ({ tokenCredits: localCredits }));
    db.createTransaction.mockImplementation(async ({ rawAmount }) => {
      localCredits += rawAmount;
      return { balance: localCredits };
    });
    global.fetch = jest.fn();
  });

  it('applies the Django value when it differs, before returning', async () => {
    global.fetch.mockResolvedValue(
      okResponse({ email: 'a@b.com', credits: 1000, organization_uuid: 'org-1' }),
    );
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://izy.test/api/agent_usage/balance/?email=a%40b.com');
    expect(init.headers['X-Izy-Usage-Key']).toBe('secret');
    expect(db.createTransaction).toHaveBeenCalledTimes(1);
    expect(db.createTransaction.mock.calls[0][0].context).toMatch(/^izytesting-sync:reconcile:/);
    expect(localCredits).toBe(1000);
  });

  it('is a no-op when values are equal within tolerance', async () => {
    global.fetch.mockResolvedValue(okResponse({ email: 'a@b.com', credits: 5000 + 1e-9 }));
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    expect(db.createTransaction).not.toHaveBeenCalled();
  });

  it('prefers IZYTESTING_BALANCE_URL over the derived URL', async () => {
    process.env.IZYTESTING_BALANCE_URL = 'https://other.test/balance/';
    global.fetch.mockResolvedValue(okResponse({ email: 'a@b.com', credits: 5000 }));
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    expect(global.fetch.mock.calls[0][0]).toBe('https://other.test/balance/?email=a%40b.com');
  });

  it('lenient (default): keeps local balance on network error', async () => {
    global.fetch.mockRejectedValue(new Error('boom'));
    await expect(
      reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' }),
    ).resolves.toBeUndefined();
    expect(localCredits).toBe(5000);
  });

  it('lenient: keeps local balance on HTTP error or invalid payload', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    global.fetch.mockResolvedValueOnce(okResponse({ credits: -1 }));
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    global.fetch.mockResolvedValueOnce(okResponse({ credits: 'NaN' }));
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    expect(db.createTransaction).not.toHaveBeenCalled();
  });

  it('strict: throws when Django cannot be consulted', async () => {
    process.env.IZYTESTING_BALANCE_ENFORCE = 'strict';
    global.fetch.mockRejectedValue(new Error('boom'));
    await expect(
      reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' }),
    ).rejects.toThrow(/IzyTesting/);
    global.fetch.mockResolvedValue(okResponse({ credits: Infinity }));
    await expect(
      reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' }),
    ).rejects.toThrow(/IzyTesting/);
  });

  it('is inert without key, without usable URL, or without email', async () => {
    process.env.IZYTESTING_USAGE_KEY = '';
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    process.env.IZYTESTING_USAGE_KEY = 'secret';
    process.env.IZYTESTING_USAGE_URL = 'https://izy.test/api/agent_usage/other/';
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    process.env.IZYTESTING_USAGE_URL = 'https://izy.test/api/agent_usage/ingest/';
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: '' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('strict stays inert (no throw) when unconfigured', async () => {
    process.env.IZYTESTING_BALANCE_ENFORCE = 'strict';
    delete process.env.IZYTESTING_USAGE_KEY;
    await expect(
      reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' }),
    ).resolves.toBeUndefined();
  });

  it('org switch: Django lower than local lowers the local balance, never cached', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ email: 'a@b.com', credits: 0 }));
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    expect(localCredits).toBe(0);

    global.fetch.mockResolvedValueOnce(okResponse({ email: 'a@b.com', credits: 900 }));
    await reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    expect(localCredits).toBe(900);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent in-flight calls for the same user', async () => {
    let resolveFetch;
    global.fetch.mockReturnValue(new Promise((r) => (resolveFetch = r)));
    const p1 = reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    const p2 = reconcileBalanceWithIzytesting({ userId: 'user-1', email: 'a@b.com' });
    resolveFetch(okResponse({ email: 'a@b.com', credits: 10 }));
    await Promise.all([p1, p2]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
