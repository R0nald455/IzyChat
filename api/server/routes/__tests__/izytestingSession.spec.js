const express = require('express');
const request = require('supertest');

jest.mock('~/models', () => ({
  countActiveSessions: jest.fn(),
}));

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

jest.mock('~/server/services/IzyTestingRevocation', () => ({
  isRequestRevoked: jest.fn(),
}));

describe('IzyTesting session check route', () => {
  const { isRequestRevoked } = require('~/server/services/IzyTestingRevocation');
  let currentUser;
  let currentStrategy;
  let app;

  beforeAll(() => {
    const router = require('../izytestingSession');
    app = express();
    app.use((req, res, next) => {
      req.user = currentUser;
      req.authStrategy = currentStrategy;
      next();
    });
    app.use('/api/izytesting-session', router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    isRequestRevoked.mockResolvedValue(false);
    currentStrategy = 'openidJwt';
  });

  it('asks for a refresh when the OpenID session lost its access token', async () => {
    currentUser = { id: 'user-1', federatedTokens: { id_token: 'id' } };

    const response = await request(app).get('/api/izytesting-session/check');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ valid: true, refreshRequired: true });
  });

  it('does not ask for a refresh while the access token is available', async () => {
    currentUser = { id: 'user-1', federatedTokens: { access_token: 'opaque', id_token: 'id' } };

    const response = await request(app).get('/api/izytesting-session/check');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ valid: true, refreshRequired: false });
  });

  it('still rejects a session revoked from IzyTesting', async () => {
    currentUser = { id: 'user-1', federatedTokens: { access_token: 'opaque' } };
    isRequestRevoked.mockResolvedValue(true);

    const response = await request(app).get('/api/izytesting-session/check');

    expect(response.status).toBe(401);
  });
});
