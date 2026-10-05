const jwt = require('jsonwebtoken');
const { Keyv } = require('keyv');
const { Time } = require('librechat-data-provider');
const { keyvMongo } = require('@librechat/api');

/**
 * Per-user "revoked at" marker written when IzyTesting ends a user's session.
 * Needed because OpenID-reuse sessions never create Mongo `Session` documents,
 * so counting sessions cannot tell a revoked OIDC user from an active one.
 * Tokens issued before the marker are rejected; a fresh login issues a newer token.
 */
const revocations = new Keyv({
  store: keyvMongo,
  namespace: 'izytesting_revocations',
  ttl: Time.ONE_DAY * 7,
});

const markUserRevoked = (userId) => revocations.set(userId, Date.now());

/** @returns {number | null} issued-at of the request's bearer token, in ms */
const getBearerIssuedAtMs = (req) => {
  const match = req.headers?.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const payload = jwt.decode(match[1]);
  return typeof payload?.iat === 'number' ? payload.iat * 1000 : null;
};

const isRequestRevoked = async (req, userId) => {
  const revokedAt = await revocations.get(userId);
  if (typeof revokedAt !== 'number') {
    return false;
  }
  const issuedAt = getBearerIssuedAtMs(req);
  return issuedAt == null || issuedAt <= revokedAt;
};

/**
 * The OpenID refresh path has no bearer to compare against, so any pending marker
 * blocks it until the user completes a fresh interactive login (which clears it).
 */
const isUserRevoked = async (userId) => typeof (await revocations.get(userId)) === 'number';

const clearUserRevoked = (userId) => revocations.delete(userId);

module.exports = { markUserRevoked, isRequestRevoked, isUserRevoked, clearUserRevoked };
