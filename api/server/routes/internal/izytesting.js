const express = require('express');
const { logger } = require('@librechat/data-schemas');
const requireIzyTestingServiceSecret = require('~/server/middleware/requireIzyTestingServiceSecret');
const db = require('~/models');

const router = express.Router();

/**
 * Called server-to-server by IzyTesting's backend once a user's IzyTesting session has
 * been expired for longer than its allowed lifetime, so this app's session ends with it
 * even if the user never comes back to open a tab here. No IzyChat account for that
 * email is a normal, non-error case (the user may never have opened IzyBot).
 */
router.post('/logout', requireIzyTestingServiceSecret, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!email) {
    return res.status(400).json({ message: 'email is required' });
  }

  try {
    const user = await db.findUser({ email }, ['_id']);
    if (!user) {
      return res.status(200).json({ revoked: false });
    }

    await db.deleteAllUserSessions({ userId: user._id.toString() });
    return res.status(200).json({ revoked: true });
  } catch (error) {
    logger.error('[internal/izytesting logout] Error revoking sessions', error);
    return res.status(500).json({ message: 'Error revoking sessions' });
  }
});

module.exports = router;
