import { logger } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import type { ServerRequest } from '~/types/http';

const DEFAULT_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 4000;

type OrgCacheEntry = {
  organizationId: string | null;
  organizationName: string | null;
  expiresAt: number;
};

export type ResolvedIzyOrganization = {
  organizationId: string | null | undefined;
  organizationName: string | null;
};

export type ResolveIzyOrganizationOptions = {
  skipCache?: boolean;
};

const orgCache = new Map<string, OrgCacheEntry>();
const inflight = new Map<string, Promise<ResolvedIzyOrganization>>();

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

function rememberOrganization(
  userId: string,
  organization: { organizationId: string | null; organizationName: string | null },
): { organizationId: string | null; organizationName: string | null } {
  orgCache.set(userId, { ...organization, expiresAt: Date.now() + cacheTtlMs() });
  return organization;
}

function staleOrganization(userId: string): ResolvedIzyOrganization {
  const cached = orgCache.get(userId);
  if (!cached) {
    return { organizationId: undefined, organizationName: null };
  }
  return {
    organizationId: cached.organizationId,
    organizationName: cached.organizationName,
  };
}

function parseOrganizationName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function fetchActiveOrganization(accessToken: string): Promise<{
  organizationId: string | null;
  organizationName: string | null;
}> {
  const base = izyTestingBaseUrl();
  if (!base) {
    return { organizationId: null, organizationName: null };
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
  const body = (await response.json()) as {
    organization_id?: string | null;
    organization_name?: string | null;
  };
  const organizationId = body?.organization_id;
  return {
    organizationId:
      typeof organizationId === 'string' && organizationId.trim() ? organizationId.trim() : null,
    organizationName: parseOrganizationName(body?.organization_name),
  };
}

function applyResolvedOrganization(req: ServerRequest, resolved: ResolvedIzyOrganization): void {
  if (resolved.organizationId !== undefined) {
    req.izyOrganizationId = resolved.organizationId;
  }
  if (resolved.organizationName != null && resolved.organizationName !== '') {
    req.izyOrganizationName = resolved.organizationName;
  } else if (resolved.organizationId !== undefined) {
    req.izyOrganizationName = null;
  }
}

/**
 * `string` — org activa.
 * `null` — IzyTesting confirmó que no hay membresía default.
 * `undefined` — no se pudo resolver; el request no debe filtrar vacío ni pisar el cache.
 */
export async function resolveIzyOrganization(
  req: ServerRequest,
  options?: ResolveIzyOrganizationOptions,
): Promise<ResolvedIzyOrganization> {
  const userId = cacheKey(req);
  const path = req.method && req.originalUrl ? `${req.method} ${req.originalUrl}` : undefined;
  const skipCache = options?.skipCache === true;
  if (!userId) {
    logger.warn('[IzyWipe] [izy/organization] no userId', { path });
    return { organizationId: undefined, organizationName: null };
  }
  if (!skipCache) {
    const cached = orgCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug('[IzyWipe] [izy/organization] cache-hit', {
        userId,
        path,
        organizationId: cached.organizationId,
      });
      return {
        organizationId: cached.organizationId,
        organizationName: cached.organizationName,
      };
    }

    const pending = inflight.get(userId);
    if (pending) {
      return pending;
    }
  }

  const load = (async (): Promise<ResolvedIzyOrganization> => {
    const accessToken = getOpenIdAccessToken(req);
    if (!accessToken) {
      const stale = staleOrganization(userId);
      logger.warn('[IzyWipe] [izy/organization] no-openid-token', {
        userId,
        path,
        stale: stale.organizationId ?? 'unset',
      });
      return stale;
    }
    try {
      const fetched = rememberOrganization(userId, await fetchActiveOrganization(accessToken));
      logger.warn('[IzyWipe] [izy/organization] fetched', {
        userId,
        path,
        organizationId: fetched.organizationId,
      });
      return fetched;
    } catch (error) {
      const stale = staleOrganization(userId);
      logger.warn('[IzyWipe] [izy/organization] fetch-failed', {
        userId,
        path,
        stale: stale.organizationId ?? 'unset',
        error,
      });
      return stale;
    }
  })();

  if (!skipCache) {
    inflight.set(userId, load);
  }
  try {
    return await load;
  } finally {
    if (!skipCache) {
      inflight.delete(userId);
    }
  }
}

export async function resolveIzyOrganizationId(
  req: ServerRequest,
  options?: ResolveIzyOrganizationOptions,
): Promise<string | null | undefined> {
  const resolved = await resolveIzyOrganization(req, options);
  return resolved.organizationId;
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
    const resolved = await resolveIzyOrganization(req);
    logger.debug('[IzyWipe] [izy/organization] attach', {
      path: `${req.method} ${req.originalUrl}`,
      userId: cacheKey(req),
      organizationId: resolved.organizationId === undefined ? 'unset' : resolved.organizationId,
    });
    applyResolvedOrganization(req, resolved);
    next();
  } catch (error) {
    next(error);
  }
}

export async function refreshIzyOrganization(req: ServerRequest): Promise<ResolvedIzyOrganization> {
  const resolved = await resolveIzyOrganization(req, { skipCache: true });
  applyResolvedOrganization(req, resolved);
  return resolved;
}
