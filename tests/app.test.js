// Runs against the DATABASE_URL in .env (local Postgres). Read-only checks.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('public api', () => {
  it('health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('catalogue is public and priced in rupees', async () => {
    const res = await request(app).get('/api/v1/catalog/products/ck-kashmir-willow-bat');
    expect(res.status).toBe(200);
    expect(res.body.data.tiers[0]).toEqual({ minQty: 10, unitPrice: 1800 });
  });

  it('protected routes reject missing tokens with a friendly message', async () => {
    const res = await request(app).get('/api/v1/dashboard');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, message: 'Your session has expired. Please sign in again.' });
  });

  it('validation errors are readable', async () => {
    const res = await request(app).post('/api/v1/auth/otp/send').send({ mobile: '123' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid 10-digit mobile/);
  });
});
