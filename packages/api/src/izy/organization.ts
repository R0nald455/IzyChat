import { logger } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types/http';

const DEFAULT_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 4000;

type OrgCacheEntry = { organizationId: string | null; expiresAt: number };

const orgCache = new Map<string, OrgCacheEntry>();
const inflight = new Map<string, Promise<string | null | undefined>>();

export function resetIzyOrganizationCache(): void {
  orgCache.clear();
  inflight.clear();
}

function izyTestingBaseUrl(): string | undefined {
  const url = (process.env.IZYTESTING_URL ?? '').trim();
  return url ? url.replace(/\/$/, '') : undefined;
}

export function isIzyOrganizationIsolationEnabled(): boolean {
  return Boolean(izyTestingBaseUrl());
}

function cacheTtlMs(): number {
  const parsed = Number(process.env.IZYTESTING_ORG_CACHE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

function getOpenIdAccessToken(req: ServerRequest): string | undefined {
  const sessionTokens = (
    req as ServerRequest & {
      session?: { openidTokens?: { accessToken?: string } };
    }
  ).session?.openidTokens?.accessToken;
  if (typeof sessionTokens === 'string' && sessionTokens.trim()) {
    return sessionTokens.trim();
  }
  const userTokens =
    req.user?.openidTokens?.access_token ?? req.user?.federatedTokens?.access_token;
  if (typeof userTokens === 'string' && userTokens.trim()) {
    return userTokens.trim();
  }
  return undefined;
}

function cacheKey(req: ServerRequest): string | undefined {
  return req.user?.id ?? req.user?._id?.toString?.();
}

function rememberOrganization(userId: string, organizationId: string | null): string | null {
  orgCache.set(userId, { organizationId, expiresAt: Date.now() + cacheTtlMs() });
  return organizationId;
}

function staleOrganization(userId: string): string | null | undefined {
  const cached = orgCache.get(userId);
  return cached ? cached.organizationId : undefined;
}

async function fetchActiveOrganization(accessToken: string): Promise<string | null> {
  const base = izyTestingBaseUrl();
  if (!base) {
    return null;
  }
  const url = `${base}/usuario/active-organization/`;
  const parsedTimeout = Number(process.env.IZYTESTING_ORG_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`IzyTesting active-organization failed (${response.status})`);
  }
  const body = (await response.json()) as { organization_id?: string | null };
  const organizationId = body?.organization_id;
  return typeof organizationId === 'string' && organizationId.trim() ? organizationId.trim() : null;
}

/**
 * `string` — org activa.
 * `null` — IzyTesting confirmó que no hay membresía default.
 * `undefined` — no se pudo resolver; el request no debe filtrar vacío ni pisar el cache.
 */
export async function resolveIzyOrganizationId(
  req: ServerRequest,
): Promise<string | null | undefined> {
  const userId = cacheKey(req);
  const path = req.method && req.originalUrl ? `${req.method} ${req.originalUrl}` : undefined;
  if (!userId) {
    logger.warn('[IzyWipe] [izy/organization] no userId', { path });
    return undefined;
  }
  const cached = orgCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug('[IzyWipe] [izy/organization] cache-hit', {
      userId,
      path,
      organizationId: cached.organizationId,
    });
    return cached.organizationId;
  }

  const pending = inflight.get(userId);
  if (pending) {
    return pending;
  }

  const load = (async (): Promise<string | null | undefined> => {
    const accessToken = getOpenIdAccessToken(req);
    if (!accessToken) {
      const stale = staleOrganization(userId);
      logger.warn('[IzyWipe] [izy/organization] no-openid-token', {
        userId,
        path,
        stale: stale ?? 'unset',
      });
      return stale;
    }
    try {
      const organizationId = rememberOrganization(
        userId,
        await fetchActiveOrganization(accessToken),
      );
      logger.warn('[IzyWipe] [izy/organization] fetched', { userId, path, organizationId });
      return organizationId;
    } catch (error) {
      const stale = staleOrganization(userId);
      logger.warn('[IzyWipe] [izy/organization] fetch-failed', {
        userId,
        path,
        stale: stale ?? 'unset',
        error,
      });
      return stale;
    }
  })();

  inflight.set(userId, load);
  try {
    return await load;
  } finally {
    inflight.delete(userId);
  }
}

/**
 * When IZYTESTING_URL is set, authenticated requests carry `req.izyOrganizationId`
 * once the org is known. Lookup failures leave the property unset so conversation
 * reads do not match-nothing and wipe a chat that was just created.
 */
export async function attachIzyOrganization(
  req: ServerRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isIzyOrganizationIsolationEnabled()) {
    next();
    return;
  }
  try {
    const organizationId = await resolveIzyOrganizationId(req);
    logger.debug('[IzyWipe] [izy/organization] attach', {
      path: `${req.method} ${req.originalUrl}`,
      userId: cacheKey(req),
      organizationId: organizationId === undefined ? 'unset' : organizationId,
    });
    if (organizationId !== undefined) {
      req.izyOrganizationId = organizationId;
    }
    next();
  } catch (error) {
    next(error);
  }
}
