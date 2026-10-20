jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { attachIzyOrganization, resetIzyOrganizationCache } from './organization';
import type { ServerRequest } from '~/types/http';

describe('attachIzyOrganization', () => {
  const originalUrl = process.env.IZYTESTING_URL;
  const originalCacheMs = process.env.IZYTESTING_ORG_CACHE_MS;
  const fetchMock = jest.fn();

  beforeEach(() => {
    resetIzyOrganizationCache();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.IZYTESTING_ORG_CACHE_MS;
  });

  afterAll(() => {
    process.env.IZYTESTING_URL = originalUrl;
    if (originalCacheMs === undefined) {
      delete process.env.IZYTESTING_ORG_CACHE_MS;
    } else {
      process.env.IZYTESTING_ORG_CACHE_MS = originalCacheMs;
    }
  });

  it('skips isolation when IZYTESTING_URL is unset', async () => {
    delete process.env.IZYTESTING_URL;
    const req = { user: { id: 'user-1' } } as ServerRequest;
    const next = jest.fn();
    await attachIzyOrganization(req, {} as never, next);
    expect(req.izyOrganizationId).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('resolves organization_id from IzyTesting with the OpenID access token', async () => {
    process.env.IZYTESTING_URL = 'http://izytesting.example';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ organization_id: 'org-uuid' }),
    });
    const req = {
      user: { id: 'user-1' },
      session: { openidTokens: { accessToken: 'opaque-token' } },
    } as unknown as ServerRequest;
    const next = jest.fn();
    await attachIzyOrganization(req, {} as never, next);
    expect(req.izyOrganizationId).toBe('org-uuid');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://izytesting.example/usuario/active-organization/',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer opaque-token' }),
      }),
    );
    expect(next).toHaveBeenCalled();
  });

  it('caches the organization for subsequent requests of the same user', async () => {
    process.env.IZYTESTING_URL = 'http://izytesting.example';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ organization_id: 'org-uuid' }),
    });
    const makeReq = () =>
      ({
        user: { id: 'user-1' },
        session: { openidTokens: { accessToken: 'opaque-token' } },
      }) as unknown as ServerRequest;
    await attachIzyOrganization(makeReq(), {} as never, jest.fn());
    await attachIzyOrganization(makeReq(), {} as never, jest.fn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the last organization when a later lookup fails', async () => {
    process.env.IZYTESTING_URL = 'http://izytesting.example';
    process.env.IZYTESTING_ORG_CACHE_MS = '1';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ organization_id: 'org-uuid' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      });
    const makeReq = () =>
      ({
        user: { id: 'user-1' },
        session: { openidTokens: { accessToken: 'opaque-token' } },
      }) as unknown as ServerRequest;
    const first = makeReq();
    await attachIzyOrganization(first, {} as never, jest.fn());
    expect(first.izyOrganizationId).toBe('org-uuid');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = makeReq();
    await attachIzyOrganization(second, {} as never, jest.fn());
    expect(second.izyOrganizationId).toBe('org-uuid');
  });

  it('does not fail-closed when the org has never been resolved', async () => {
    process.env.IZYTESTING_URL = 'http://izytesting.example';
    const req = { user: { id: 'user-1' } } as ServerRequest;
    const next = jest.fn();
    await attachIzyOrganization(req, {} as never, next);
    expect(req.izyOrganizationId).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
