import type { FilterQuery } from 'mongoose';

/**
 * IzyTesting organization scope for conversation and memory queries.
 *
 * `undefined` — isolation is off (vanilla LibreChat / unit tests).
 * `null` or `''` — isolation is on but no org could be resolved; match nothing.
 * a string — restrict to that organization uuid.
 */
export function organizationScope<T>(organizationId?: string | null): FilterQuery<T> {
  if (organizationId === undefined) {
    return {};
  }
  if (organizationId == null || organizationId === '') {
    return { organizationId: { $in: [] } } as FilterQuery<T>;
  }
  return { organizationId } as FilterQuery<T>;
}

/**
 * Lookup of one conversation the user already has the id for. Unstamped
 * rows (saved before org isolation, or saved while org resolve lagged)
 * must still be readable, or the first GET after a stream 404s and the
 * client wipes the transcript.
 */
export function organizationLookupScope<T>(organizationId?: string | null): FilterQuery<T> {
  if (organizationId === undefined) {
    return {};
  }
  if (organizationId == null || organizationId === '') {
    return { organizationId: { $in: [] } } as FilterQuery<T>;
  }
  return {
    $or: [{ organizationId }, { organizationId: { $exists: false } }, { organizationId: null }],
  } as FilterQuery<T>;
}

export function organizationOnInsert(
  organizationId?: string | null,
): { organizationId: string } | Record<string, never> {
  if (typeof organizationId === 'string' && organizationId !== '') {
    return { organizationId };
  }
  return {};
}
