const crypto = require('node:crypto');
const { logger } = require('@librechat/data-schemas');

/**
 * Authenticates server-to-server requests from the IzyTesting backend (not a user's
 * browser, so no cookies/JWT): a shared secret sent in the `X-IzyTesting-Service-Secret`
 * header, compared in constant time. Fails closed if the secret isn't configured.
 */
const requireIzyTestingServiceSecret = (req, res, next) => {
  const expected = process.env.IZYCHAT_SERVICE_SECRET;
  if (!expected) {
    logger.error(
      '[requireIzyTestingServiceSecret] IZYCHAT_SERVICE_SECRET is not configured; rejecting request',
    );
    return res.status(503).json({ message: 'Service not configured' });
  }

  const provided = req.headers['x-izytesting-service-secret'];
  const providedBuffer = Buffer.from(typeof provided === 'string' ? provided : '', 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  const isValid =
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);

  if (!isValid) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
};

module.exports = requireIzyTestingServiceSecret;
