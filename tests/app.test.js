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

  // The echo exists so the app can be tested before DLT approval. Two things
  // must hold: a real gateway is never echoed, and in production it needs the
  // switch. The production half is checked by hand (the environment is read
  // once at import) — a NODE_ENV=production server returns no code by default,
  // returns one with DEV_OTP_ECHO=true, and returns none again on a real driver.
  it('the echoed code is the one that actually signs you in', async () => {
    const sent = await request(app)
      .post('/api/v1/auth/otp/send')
      .send({ mobile: '9876500022' });
    expect(sent.body.data.devCode).toMatch(/^\d{6}$/);

    const wrong = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ mobile: '9876500022', code: '000000' });
    expect(wrong.status).toBe(400);

    const right = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ mobile: '9876500022', code: sent.body.data.devCode });
    expect(right.status).toBe(200);
    expect(right.body.data.user.mobile).toBe('9876500022');
  });

  it('an on/off flag only counts the words that mean on', async () => {
    // z.coerce.boolean() would read "false" as true, which for DEV_OTP_ECHO
    // means handing out OTPs and for AI_SEARCH_ENABLED means paying per search.
    const { boolish } = await import('../src/config/env.js');
    for (const on of ['true', 'TRUE', ' on ', '1', 'yes', true]) {
      expect(boolish(false).parse(on), String(on)).toBe(true);
    }
    for (const off of ['false', '0', 'no', 'off', '', undefined, false]) {
      expect(boolish(false).parse(off), String(off)).toBe(false);
    }
  });

  it('sign-in methods are advertised, without leaking a key', async () => {
    const res = await request(app).get('/api/v1/auth/methods');
    expect(res.status).toBe(200);
    expect(res.body.data.otp).toBe(true);
    expect(typeof res.body.data.firebase).toBe('boolean');
    // Tells the clients how a code arrives, so the app can say "the code is
    // below" instead of "check your messages".
    expect(['console', '2factor', 'msg91']).toContain(res.body.data.smsDriver);
    expect(typeof res.body.data.otpOnScreen).toBe('boolean');
    // Nothing secret may ride along.
    expect(JSON.stringify(res.body)).not.toMatch(/KEY|SECRET|TOKEN|AUTH/i);
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

  it('the live promotion is readable without signing in', async () => {
    const res = await request(app).get('/api/v1/promotions/active');
    expect(res.status).toBe(200);
    // Either a promotion or null — never an error, because the home screen
    // renders before sign-in.
    expect(res.body.data).toHaveProperty('promotion');
  });

  it('deals never invent a saving or a stock count', async () => {
    const res = await request(app).get('/api/v1/catalog/deals');
    expect(res.status).toBe(200);
    for (const d of res.body.data) {
      // A deal is on the shelf for a recorded price drop or a tracked low
      // stock — one of the two must be a real number.
      expect(d.previousPrice != null || d.stockLeft != null).toBe(true);
      if (d.previousPrice != null) expect(d.previousPrice).toBeGreaterThan(d.currentPrice);
      if (d.stockLeft != null) expect(d.stockLeft).toBeGreaterThan(0);
    }
  });

  it('new launches come back newest first', async () => {
    const res = await request(app).get('/api/v1/catalog/new-launches?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(5);
    for (const p of res.body.data) expect(p.tiers.length).toBeGreaterThan(0);
  });

  it('a product carries its video and thumbnail together, or neither', async () => {
    const res = await request(app).get('/api/v1/catalog/products?limit=100');
    expect(res.status).toBe(200);
    for (const p of res.body.data) {
      expect(p.videoUrl == null).toBe(p.videoThumbnailUrl == null);
      if (p.videoUrl) expect(p.videoUrl).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
    }
  });

  it('a review cannot be written without signing in', async () => {
    const res = await request(app)
      .put('/api/v1/reviews/ck-kashmir-willow-bat')
      .send({ rating: 5, body: 'Trying to post without an account.' });
    expect(res.status).toBe(401);
  });

  it('a product\'s reviews are public and only ever approved ones', async () => {
    const res = await request(app).get('/api/v1/catalog/products/ck-kashmir-willow-bat/reviews');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('average');
    expect(res.body.data).toHaveProperty('breakdown');
    for (const r of res.body.data.reviews) {
      expect(r.status).toBe('approved');
      // Eligibility was proved server-side, so this is never a client claim.
      expect(r.verifiedBuyer).toBe(true);
      // A reviewer is recognisable but never fully exposed.
      expect(r.author).not.toMatch(/^[6-9]\d{9}$/);
    }
  });

  it('review moderation is admin-only', async () => {
    expect((await request(app).get('/api/v1/admin/reviews')).status).toBe(401);
    expect(
      (await request(app).put('/api/v1/admin/reviews/00000000-0000-0000-0000-000000000000/status')
        .send({ status: 'hidden' })).status,
    ).toBe(401);
  });

  it('managing offers is admin-only', async () => {
    const res = await request(app).post('/api/v1/admin/db/promotions').send({ title: 'Nope', body: 'Nope' });
    expect(res.status).toBe(401);
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
