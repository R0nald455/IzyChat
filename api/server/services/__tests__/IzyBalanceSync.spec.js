jest.mock('~/models', () => ({
  findUser: jest.fn(),
  findBalanceByUser: jest.fn(),
  getTransactions: jest.fn(),
  createTransaction: jest.fn(),
}));

const db = require('~/models');
const {
  MAX_SYNC_CREDITS,
  IzyBalanceSyncError,
  getBalanceByEmail,
  syncBalance,
} = require('../IzyBalanceSync');

const USER = { _id: { toString: () => 'user-1' }, email: 'a@b.com' };
const base = { email: 'a@b.com', organizationUuid: 'org-1', requestId: 'req-1' };

describe('IzyBalanceSync', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    db.findUser.mockResolvedValue(USER);
    db.getTransactions.mockResolvedValue([]);
  });

  describe('getBalanceByEmail', () => {
    it('returns the raw balance values', async () => {
      const lastRefill = new Date('2026-01-01');
      db.findBalanceByUser.mockResolvedValue({
        tokenCredits: 1234.5678,
        autoRefillEnabled: false,
        lastRefill,
      });
      await expect(getBalanceByEmail('a@b.com')).resolves.toEqual({
        email: 'a@b.com',
        tokenCredits: 1234.5678,
        autoRefillEnabled: false,
        lastRefill,
      });
    });

    it('returns null when the user or balance is missing', async () => {
      db.findUser.mockResolvedValueOnce(null);
      await expect(getBalanceByEmail('x@y.com')).resolves.toBeNull();
      db.findBalanceByUser.mockResolvedValue(null);
      await expect(getBalanceByEmail('a@b.com')).resolves.toBeNull();
    });
  });

  describe('syncBalance', () => {
    it('creates a credits transaction with the delta and the request marker', async () => {
      db.findBalanceByUser.mockResolvedValue({ tokenCredits: 100.25 });
      db.createTransaction.mockResolvedValue({ balance: 5000.5 });

      const result = await syncBalance({ ...base, credits: 5000.5 });

      expect(db.createTransaction).toHaveBeenCalledWith({
        user: 'user-1',
        tokenType: 'credits',
        context: 'izytesting-sync:req-1',
        rawAmount: 4900.25,
        balance: { enabled: true },
      });
      expect(result).toEqual({ previous: 100.25, current: 5000.5, replayed: false });
    });

    it('treats a missing balance record as zero', async () => {
      db.findBalanceByUser.mockResolvedValue(null);
      db.createTransaction.mockResolvedValue({ balance: 10 });
      const result = await syncBalance({ ...base, credits: 10 });
      expect(db.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ rawAmount: 10 }));
      expect(result.previous).toBe(0);
    });

    it('replays an already applied request_id without writing again', async () => {
      db.getTransactions.mockResolvedValue([{ tokenValue: 40 }]);
      db.findBalanceByUser.mockResolvedValue({ tokenCredits: 140 });
      const result = await syncBalance({ ...base, credits: 140 });
      expect(db.getTransactions).toHaveBeenCalledWith({
        user: 'user-1',
        tokenType: 'credits',
        context: 'izytesting-sync:req-1',
      });
      expect(db.createTransaction).not.toHaveBeenCalled();
      expect(result).toEqual({ previous: 100, current: 140, replayed: true });
    });

    it.each([-1, NaN, Infinity, '5', null, MAX_SYNC_CREDITS + 1])(
      'rejects invalid credits %p',
      async (credits) => {
        await expect(syncBalance({ ...base, credits })).rejects.toMatchObject({
          code: 'invalid_credits',
          status: 400,
        });
        expect(db.createTransaction).not.toHaveBeenCalled();
      },
    );

    it('accepts credits equal to the cap and zero', async () => {
      db.findBalanceByUser.mockResolvedValue({ tokenCredits: 1 });
      db.createTransaction.mockResolvedValue({ balance: 0 });
      await expect(syncBalance({ ...base, credits: 0 })).resolves.toMatchObject({ current: 0 });
      db.createTransaction.mockResolvedValue({ balance: MAX_SYNC_CREDITS });
      await expect(syncBalance({ ...base, credits: MAX_SYNC_CREDITS })).resolves.toBeDefined();
    });

    it('requires email and request_id', async () => {
      await expect(syncBalance({ ...base, credits: 1, email: '' })).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
      await expect(syncBalance({ ...base, credits: 1, requestId: ' ' })).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
    });

    it('rejects an unknown user with 404', async () => {
      db.findUser.mockResolvedValue(null);
      const promise = syncBalance({ ...base, credits: 1 });
      await expect(promise).rejects.toBeInstanceOf(IzyBalanceSyncError);
      await expect(promise).rejects.toMatchObject({ code: 'user_not_found', status: 404 });
    });

    it('fails when the transaction was not applied', async () => {
      db.findBalanceByUser.mockResolvedValue({ tokenCredits: 1 });
      db.createTransaction.mockResolvedValue(undefined);
      await expect(syncBalance({ ...base, credits: 5 })).rejects.toThrow(/not applied/);
    });
  });
});
