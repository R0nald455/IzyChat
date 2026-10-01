const express = require('express');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const db = require('~/models');

const router = express.Router();

/**
 * Polled every few seconds while authenticated (see useIzyTestingSessionGuard)
 * so a session revoked from IzyTesting's side (deleteAllUserSessions, see
 * routes/internal/izytesting.js) is noticed within seconds - the access token
 * itself stays cryptographically valid for its own lifetime regardless of
 * whether the underlying Session document was deleted, so requireJwtAuth alone
 * would not catch this until the token's next refresh attempt.
 */
router.get('/check', requireJwtAuth, async (req, res) => {
  const userId = req.user?.id ?? req.user?._id?.toString?.();
  const activeCount = await db.countActiveSessions(userId);

  if (activeCount === 0) {
    return res.status(401).json({ message: 'Session revoked' });
  }

  return res.status(200).json({ valid: true });
});

module.exports = router;
