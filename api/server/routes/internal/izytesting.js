const express = require('express');
const { logger } = require('@librechat/data-schemas');
const requireIzyTestingServiceSecret = require('~/server/middleware/requireIzyTestingServiceSecret');
const { markUserRevoked } = require('~/server/services/IzyTestingRevocation');
const {
  IzyBalanceSyncError,
  getBalanceByEmail,
  syncBalance,
} = require('~/server/services/IzyBalanceSync');
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

    await Promise.all([
      markUserRevoked(user._id.toString()),
      db.deleteAllUserSessions({ userId: user._id.toString() }),
    ]);
    return res.status(200).json({ revoked: true });
  } catch (error) {
    logger.error('[internal/izytesting logout] Error revoking sessions', error);
    return res.status(500).json({ message: 'Error revoking sessions' });
  }
});

/** Raw (unrounded) balance, so IzyTesting can reconcile its own figure against it. */
router.get('/balance', requireIzyTestingServiceSecret, async (req, res) => {
  const email = typeof req.query?.email === 'string' ? req.query.email.trim() : '';
  if (!email) {
    return res.status(400).json({ message: 'email is required' });
  }

  try {
    const balance = await getBalanceByEmail(email);
    if (!balance) {
      return res.status(404).json({ message: 'balance not found' });
    }
    return res.status(200).json(balance);
  } catch (error) {
    logger.error('[internal/izytesting balance] Error reading balance', error);
    return res.status(500).json({ message: 'Error reading balance' });
  }
});

/**
 * Sets the user's balance to the figure IzyTesting holds for their active organization.
 * Idempotent by `request_id`; the actual write is a ledger Transaction (see IzyBalanceSync).
 */
router.post('/balance-sync', requireIzyTestingServiceSecret, async (req, res) => {
  const {
    email,
    credits,
    organization_uuid: organizationUuid,
    request_id: requestId,
  } = req.body ?? {};

  try {
    const result = await syncBalance({ email, credits, organizationUuid, requestId });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof IzyBalanceSyncError) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    logger.error('[internal/izytesting balance-sync] Error syncing balance', error);
    return res.status(500).json({ message: 'Error syncing balance' });
  }
});

module.exports = router;
