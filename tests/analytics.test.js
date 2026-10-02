// Usage analytics. The point of these is the two rules that must never slip:
// nothing a buyer typed is stored, and money never comes from an event.
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { record, salesReport, activeUsers, funnel, day } from '../src/services/analytics.js';

const DEVICE = 'vitest-device-0001';

afterEach(async () => {
  await prisma.usageEvent.deleteMany({ where: { deviceId: { startsWith: 'vitest-' } } });
});

afterAll(async () => {
  await prisma.usageEvent.deleteMany({ where: { deviceId: { startsWith: 'vitest-' } } });
});

describe('what gets stored', () => {
  it('keeps only whole numbers under known keys', async () => {
    await record(
      [{
        name: 'search',
        meta: {
          results: 3,
          queryLength: 12,
          query: 'cricket bats for my academy',
          mobile: '9876543210',
          email: 'buyer@example.com',
          note: 'anything at all',
          results2: 9,
        },
      }],
      { user: null, deviceId: DEVICE, platform: 'android' },
    );

    const row = await prisma.usageEvent.findFirst({ where: { deviceId: DEVICE } });
    expect(row.meta).toEqual({ results: 3, queryLength: 12 });
    // Nothing anyone typed, and nothing that identifies a person.
    expect(JSON.stringify(row.meta)).not.toMatch(/cricket|9876543210|example\.com|anything/);
  });

  it('drops events it does not recognise instead of storing them', async () => {
    const result = await record(
      [{ name: 'appOpen' }, { name: 'somethingInvented' }, { name: '' }, {}],
      { user: null, deviceId: DEVICE },
    );
    expect(result.stored).toBe(1);
  });

  it('refuses an oversized batch at the edge, and caps it in the service', async () => {
    const tooMany = Array.from({ length: 150 }, () => ({ name: 'appOpen' }));
    const res = await request(app).post('/api/v1/events').send({ deviceId: DEVICE, events: tooMany });
    expect(res.status).toBe(400);

    const capped = await record(tooMany, { user: null, deviceId: DEVICE });
    expect(capped.stored).toBe(100);
  });

  it('stamps the business day so a day\'s count is one lookup', async () => {
    await record([{ name: 'appOpen' }], { user: null, deviceId: DEVICE });
    const row = await prisma.usageEvent.findFirst({ where: { deviceId: DEVICE } });
    expect(row.day).toBe(day());
  });
});

describe('the endpoint', () => {
  it('counts a visit from someone who has not signed in', async () => {
    const res = await request(app)
      .post('/api/v1/events')
      .send({ deviceId: DEVICE, platform: 'android', events: [{ name: 'appOpen' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.stored).toBe(1);

    const row = await prisma.usageEvent.findFirst({ where: { deviceId: DEVICE } });
    expect(row.userId).toBeNull();
  });

  it('needs a device id it can count by', async () => {
    const res = await request(app).post('/api/v1/events').send({ events: [{ name: 'appOpen' }] });
    expect(res.status).toBe(400);
  });

  it('reports are admin-only', async () => {
    for (const path of ['active-users', 'funnel', 'products', 'search', 'sales', 'buyers']) {
      const res = await request(app).get(`/api/v1/admin/analytics/${path}`);
      expect(res.status, path).toBe(401);
    }
  });
});

describe('estimates and facts are labelled', () => {
  it('usage counts say they are estimates', async () => {
    expect((await activeUsers({ days: 7 })).estimate).toBe(true);
    expect((await funnel({ days: 7 })).estimate).toBe(true);
  });

  it('sales are not an estimate, and do not move when events are added', async () => {
    const before = await salesReport({});
    expect(before.estimate).toBe(false);

    // A pile of "orderPlaced" events must not change a rupee of the sales
    // report: money comes from the orders themselves.
    await record(
      Array.from({ length: 20 }, () => ({ name: 'orderPlaced', orderId: 'FAKE-1' })),
      { user: null, deviceId: DEVICE },
    );
    const after = await salesReport({});
    expect(after.total).toBe(before.total);
    expect(after.orders).toBe(before.orders);
  });
});
