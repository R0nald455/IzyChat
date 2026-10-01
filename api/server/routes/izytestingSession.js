const express = require('express');
const { logger } = require('@librechat/data-schemas');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { isRequestRevoked } = require('~/server/services/IzyTestingRevocation');
const db = require('~/models');

const router = express.Router();

/**
 * Polled every few seconds while authenticated (see useIzyTestingSessionGuard)
 * so a session revoked from IzyTesting's side (see routes/internal/izytesting.js)
 * is noticed within seconds - the access token itself stays cryptographically
 * valid for its own lifetime, so requireJwtAuth alone would not catch this.
 *
 * OpenID-reuse sessions (`authStrategy === 'openidJwt'`) never create Mongo
 * `Session` documents, so for them only the revocation marker is meaningful;
 * counting sessions would answer 401 forever and loop the client through refresh.
 */
router.get('/check', requireJwtAuth, async (req, res) => {
  const userId = req.user?.id ?? req.user?._id?.toString?.();

  try {
    if (await isRequestRevoked(req, userId)) {
      return res.status(401).json({ message: 'Session revoked' });
    }

    if (req.authStrategy === 'openidJwt') {
      return res.status(200).json({ valid: true });
    }

    const activeCount = await db.countActiveSessions(userId);
    if (activeCount === 0) {
      return res.status(401).json({ message: 'Session revoked' });
    }

    return res.status(200).json({ valid: true });
  } catch (error) {
    logger.error('[izytesting-session/check] Error checking session', error);
    return res.status(500).json({ message: 'Error checking session' });
  }
});

module.exports = router;
