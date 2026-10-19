const db = require('~/models');

/**
 * Safety cap for a single sync, in tokenCredits (1 credit = USD 1e-6), so this is USD 1,000,000.
 * Guards against a corrupted or malicious caller setting an absurd balance.
 */
const MAX_SYNC_CREDITS = 1e12;

/** Transaction `context` prefix used as the idempotency marker for a sync request. */
const SYNC_CONTEXT_PREFIX = 'izytesting-sync:';

class IzyBalanceSyncError extends Error {
  /**
   * @param {string} code stable, machine-readable code
   * @param {number} status HTTP status the boundary should answer with
   */
  constructor(code, status, message) {
    super(message ?? code);
    this.name = 'IzyBalanceSyncError';
    this.code = code;
    this.status = status;
  }
}

const asTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Raw (unrounded) balance of the user with that email, or `null` when the user or their
 * balance record does not exist.
 */
async function getBalanceByEmail(email) {
  const user = await db.findUser({ email }, ['_id']);
  if (!user) {
    return null;
  }
  const balance = await db.findBalanceByUser(user._id.toString(), { applyReset: false });
  if (!balance) {
    return null;
  }
  return {
    email,
    tokenCredits: balance.tokenCredits,
    autoRefillEnabled: balance.autoRefillEnabled ?? false,
    lastRefill: balance.lastRefill ?? null,
  };
}

/**
 * Sets the user's tokenCredits to `credits` by recording a `credits` Transaction with the
 * delta (never writing Balance directly), so the ledger keeps a trail and the regular
 * balance-update path is used. Idempotent by `requestId`, which is persisted in the
 * transaction `context`: a repeated request answers `replayed: true` without a second write.
 *
 * @param {{ email: string, credits: number, organizationUuid?: string, requestId: string }} params
 * @returns {Promise<{ previous: number, current: number, replayed: boolean }>}
 * @throws {IzyBalanceSyncError}
 */
async function syncBalance({ email, credits, requestId }) {
  const cleanEmail = asTrimmedString(email);
  const cleanRequestId = asTrimmedString(requestId);
  if (!cleanEmail || !cleanRequestId) {
    throw new IzyBalanceSyncError('invalid_request', 400, 'email and request_id are required');
  }
  if (
    typeof credits !== 'number' ||
    !Number.isFinite(credits) ||
    credits < 0 ||
    credits > MAX_SYNC_CREDITS
  ) {
    throw new IzyBalanceSyncError(
      'invalid_credits',
      400,
      `credits must be a finite number between 0 and ${MAX_SYNC_CREDITS}`,
    );
  }

  const user = await db.findUser({ email: cleanEmail }, ['_id']);
  if (!user) {
    throw new IzyBalanceSyncError('user_not_found', 404, 'user not found');
  }
  const userId = user._id.toString();
  const context = `${SYNC_CONTEXT_PREFIX}${cleanRequestId}`;

  const balance = await db.findBalanceByUser(userId, { applyReset: false });
  const current = balance?.tokenCredits ?? 0;

  const [applied] = await db.getTransactions({ user: userId, tokenType: 'credits', context });
  if (applied) {
    return { previous: current - (applied.tokenValue ?? 0), current, replayed: true };
  }

  const result = await db.createTransaction({
    user: userId,
    tokenType: 'credits',
    context,
    rawAmount: credits - current,
    balance: { enabled: true },
  });
  if (!result) {
    throw new Error('Balance sync transaction was not applied');
  }
  return { previous: current, current: result.balance, replayed: false };
}

module.exports = {
  MAX_SYNC_CREDITS,
  IzyBalanceSyncError,
  getBalanceByEmail,
  syncBalance,
};
