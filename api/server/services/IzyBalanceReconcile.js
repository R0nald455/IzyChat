const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { syncBalance } = require('./IzyBalanceSync');
const db = require('~/models');

const USAGE_KEY_HEADER = 'X-Izy-Usage-Key';
const DEFAULT_TIMEOUT_MS = 5000;
/** Credits within this distance are considered equal (floating point noise). */
const TOLERANCE = 1e-6;

/** In-flight calls per user: concurrent admissions share one Django round trip. Never a cache. */
const inFlight = new Map();

function getConfig() {
  const key = (process.env.IZYTESTING_USAGE_KEY ?? '').trim();
  const explicit = (process.env.IZYTESTING_BALANCE_URL ?? '').trim();
  const usageUrl = (process.env.IZYTESTING_USAGE_URL ?? '').trim();
  let url = explicit;
  if (!url && usageUrl && /ingest\/?$/.test(usageUrl)) {
    url = usageUrl.replace(/ingest\/?$/, 'balance/');
  }
  if (!url || !key) {
    return null;
  }
  const parsedTimeout = Number(process.env.IZYTESTING_USAGE_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const strict = (process.env.IZYTESTING_BALANCE_ENFORCE ?? '').trim().toLowerCase() === 'strict';
  return { url, key, timeoutMs, strict };
}

async function fetchDjangoCredits(config, email) {
  const separator = config.url.includes('?') ? '&' : '?';
  const response = await fetch(`${config.url}${separator}email=${encodeURIComponent(email)}`, {
    method: 'GET',
    headers: { [USAGE_KEY_HEADER]: config.key },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = await response.json();
  const credits = body?.credits;
  if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) {
    throw new Error('invalid credits in response');
  }
  return credits;
}

async function reconcile({ userId, email }, config) {
  try {
    const credits = await fetchDjangoCredits(config, email);
    const balance = await db.findBalanceByUser(userId, { applyReset: false });
    const local = balance?.tokenCredits ?? 0;
    if (Math.abs(local - credits) <= TOLERANCE) {
      return;
    }
    await syncBalance({ email, credits, requestId: `reconcile:${crypto.randomUUID()}` });
    logger.info(`[izy/balance] Local balance aligned with IzyTesting: ${local} -> ${credits}`);
  } catch (error) {
    if (config.strict) {
      throw new Error(`Could not verify the IzyBot balance with IzyTesting: ${error.message}`);
    }
    logger.warn(
      `[izy/balance] Could not reconcile with IzyTesting, keeping local balance: ${error.message}`,
    );
  }
}

/**
 * IzyTesting (Django) is the source of truth for the IzyBot wallet. Right before a run is
 * admitted, align the local Balance with Django's value so an organization switch is
 * reflected immediately even if the push lagged or failed.
 *
 * Inert without IZYTESTING_USAGE_KEY and a usable base URL (IZYTESTING_BALANCE_URL, or
 * IZYTESTING_USAGE_URL ending in `ingest/`). `IZYTESTING_BALANCE_ENFORCE=strict` makes an
 * unreachable/invalid Django response throw; the default `lenient` keeps the local balance.
 *
 * @param {{ userId: string, email?: string | null }} params
 * @returns {Promise<void>}
 */
async function reconcileBalanceWithIzytesting({ userId, email }) {
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  const config = getConfig();
  if (!config || !cleanEmail || !userId) {
    return;
  }
  const flightKey = String(userId);
  const pending = inFlight.get(flightKey);
  if (pending) {
    return pending;
  }
  const promise = reconcile({ userId: flightKey, email: cleanEmail }, config).finally(() =>
    inFlight.delete(flightKey),
  );
  inFlight.set(flightKey, promise);
  return promise;
}

module.exports = { reconcileBalanceWithIzytesting };
