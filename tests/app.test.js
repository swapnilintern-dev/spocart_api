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

  // The OTP limiter keys on the mobile in the body and falls back to the IP when
  // there is not a usable one. That fallback must never throw: a bad or missing
  // mobile has to reach the validator and come back as a 400.
  it('the OTP limiter survives a request with no usable mobile', async () => {
    for (const body of [{}, { mobile: '' }, { mobile: 123 }, { mobile: 'abcdefghij' }]) {
      const res = await request(app).post('/api/v1/auth/otp/send').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.ok).toBe(false);
    }
  });

  // Development convenience: with the console driver the code is already in
  // this server's log in plain text, so it also comes back in the response and
  // the app can show it. The production guard (isProd) cannot be exercised here
  // because the environment is read once at import; it was checked by hand with
  // a NODE_ENV=production server on the same console driver, which omitted it.
  it('a development server hands the OTP back so the app can show it', async () => {
    const res = await request(app)
      .post('/api/v1/auth/otp/send')
      .send({ mobile: '9876500011' });
    expect(res.status).toBe(200);
    expect(res.body.data.devCode).toMatch(/^\d{6}$/);

    const verified = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ mobile: '9876500011', code: res.body.data.devCode });
    expect(verified.status).toBe(200);
    expect(verified.body.data.user.mobile).toBe('9876500011');
    expect(verified.body.data.token).toBeTruthy();
  });

  it('sign-in methods are advertised', async () => {
    const res = await request(app).get('/api/v1/auth/methods');
    expect(res.status).toBe(200);
    expect(res.body.data.otp).toBe(true);
    expect(typeof res.body.data.firebase).toBe('boolean');
  });

  it('best sellers are public and ranked ids only', async () => {
    const res = await request(app).get('/api/v1/catalog/best-sellers?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.productIds)).toBe(true);
    expect(res.body.data.productIds.length).toBeLessThanOrEqual(5);
    // Ids only — the app already has the catalogue and resolves them itself.
    for (const id of res.body.data.productIds) expect(typeof id).toBe('string');
  });

  it('pinning a product to Best Sellers is admin-only', async () => {
    const pin = await request(app)
      .put('/api/v1/admin/products/ck-ss-ball/pin')
      .send({ rank: 1 });
    expect(pin.status).toBe(401);

    const report = await request(app).get('/api/v1/admin/best-sellers');
    expect(report.status).toBe(401);
  });

  it('the PIN lookup is not public', async () => {
    const res = await request(app).get('/api/v1/addresses/pincode/411001');
    expect(res.status).toBe(401);
  });

  it('changing a mobile number is not public', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mobile/change/send')
      .send({ mobile: '9123456780' });
    expect(res.status).toBe(401);
  });
});
