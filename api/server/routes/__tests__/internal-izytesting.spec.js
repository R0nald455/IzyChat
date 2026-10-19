const express = require('express');
const request = require('supertest');

jest.mock('~/models', () => ({
  findUser: jest.fn(),
  deleteAllUserSessions: jest.fn(),
}));
jest.mock('~/server/services/IzyTestingRevocation', () => ({ markUserRevoked: jest.fn() }));
jest.mock('~/server/services/IzyBalanceSync', () => {
  const actual = jest.requireActual('~/server/services/IzyBalanceSync');
  return { ...actual, getBalanceByEmail: jest.fn(), syncBalance: jest.fn() };
});

const {
  getBalanceByEmail,
  syncBalance,
  IzyBalanceSyncError,
} = require('~/server/services/IzyBalanceSync');

const SECRET = 'test-secret';
const auth = { 'X-IzyTesting-Service-Secret': SECRET };

describe('internal izytesting routes', () => {
  let app;

  beforeAll(() => {
    process.env.IZYCHAT_SERVICE_SECRET = SECRET;
    app = express();
    app.use(express.json());
    app.use('/api/internal/izytesting', require('../internal/izytesting'));
  });

  afterAll(() => {
    delete process.env.IZYCHAT_SERVICE_SECRET;
  });

  describe('GET /balance', () => {
    it('fails closed without the secret', async () => {
      const res = await request(app).get('/api/internal/izytesting/balance?email=a@b.com');
      expect(res.status).toBe(401);
      expect(getBalanceByEmail).not.toHaveBeenCalled();
    });

    it('400s without email', async () => {
      const res = await request(app).get('/api/internal/izytesting/balance').set(auth);
      expect(res.status).toBe(400);
    });

    it('404s when the user or balance is missing', async () => {
      getBalanceByEmail.mockResolvedValue(null);
      const res = await request(app)
        .get('/api/internal/izytesting/balance?email=a@b.com')
        .set(auth);
      expect(res.status).toBe(404);
    });

    it('returns the raw balance', async () => {
      getBalanceByEmail.mockResolvedValue({
        email: 'a@b.com',
        tokenCredits: 12.3456789,
        autoRefillEnabled: false,
        lastRefill: null,
      });
      const res = await request(app)
        .get('/api/internal/izytesting/balance?email=a@b.com')
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        email: 'a@b.com',
        tokenCredits: 12.3456789,
        autoRefillEnabled: false,
        lastRefill: null,
      });
    });
  });

  describe('POST /balance-sync', () => {
    const body = { email: 'a@b.com', credits: 50, organization_uuid: 'org-1', request_id: 'r1' };

    it('fails closed without the secret', async () => {
      const res = await request(app).post('/api/internal/izytesting/balance-sync').send(body);
      expect(res.status).toBe(401);
      expect(syncBalance).not.toHaveBeenCalled();
    });

    it('maps the body and returns the sync result', async () => {
      syncBalance.mockResolvedValue({ previous: 1, current: 50, replayed: false });
      const res = await request(app)
        .post('/api/internal/izytesting/balance-sync')
        .set(auth)
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ previous: 1, current: 50, replayed: false });
      expect(syncBalance).toHaveBeenCalledWith({
        email: 'a@b.com',
        credits: 50,
        organizationUuid: 'org-1',
        requestId: 'r1',
      });
    });

    it('maps service errors to their status without leaking internals', async () => {
      syncBalance.mockRejectedValueOnce(new IzyBalanceSyncError('invalid_credits', 400, 'bad'));
      let res = await request(app)
        .post('/api/internal/izytesting/balance-sync')
        .set(auth)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'bad', code: 'invalid_credits' });

      syncBalance.mockRejectedValueOnce(new Error('mongo exploded at 10.0.0.1'));
      res = await request(app).post('/api/internal/izytesting/balance-sync').set(auth).send(body);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('mongo');
    });
  });
});
