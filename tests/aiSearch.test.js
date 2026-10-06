// AI-assisted search. The point of these tests is the two guarantees that make
// it safe to switch on: a product the model invents can never reach a buyer,
// and a price never comes from the model.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { env } from '../src/config/env.js';
import { assist, aiSearchEnabled, aiSearchStatus } from '../src/services/aiSearch.js';

const fallback = async () => ['ck-kashmir-willow-bat'];

/** Answers the Anthropic call with whatever the model is pretending to say. */
function stubModel(payload) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
  }));
}

let realFetch;
let realEnabled;
let realKey;

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEnabled = env.AI_SEARCH_ENABLED;
  realKey = env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  env.AI_SEARCH_ENABLED = realEnabled;
  env.ANTHROPIC_API_KEY = realKey;
  vi.restoreAllMocks();
});

describe('while it is switched off', () => {
  it('says why, and costs nothing', () => {
    env.AI_SEARCH_ENABLED = false;
    expect(aiSearchEnabled()).toBe(false);
    expect(aiSearchStatus().reason).toMatch(/AI_SEARCH_ENABLED/);
  });

  it('is still off with the flag on but no key', () => {
    env.AI_SEARCH_ENABLED = true;
    env.ANTHROPIC_API_KEY = undefined;
    expect(aiSearchEnabled()).toBe(false);
    expect(aiSearchStatus().reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('never calls the model, and answers from the ordinary search', async () => {
    env.AI_SEARCH_ENABLED = false;
    globalThis.fetch = vi.fn();
    const result = await assist('cricket kit for an academy', { fallback });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.source).toBe('search');
    expect(result.products.length).toBeGreaterThan(0);
  });
});

describe('once it is switched on', () => {
  beforeEach(() => {
    env.AI_SEARCH_ENABLED = true;
    env.ANTHROPIC_API_KEY = 'test-key-not-real';
  });

  it('a product the model invents never reaches the buyer', async () => {
    stubModel({
      productIds: ['ck-kashmir-willow-bat', 'totally-made-up-product', '../../etc/passwd'],
      answer: 'Here is a starter set.',
    });
    const result = await assist('starter cricket set', { fallback });

    expect(result.source).toBe('ai');
    expect(result.products.map((p) => p.id)).toEqual(['ck-kashmir-willow-bat']);
  });

  it('prices come from the database, whatever the model claims', async () => {
    stubModel({
      productIds: ['ck-kashmir-willow-bat'],
      answer: 'This bat is only ₹99 today with 80% off and 3 left in stock.',
    });
    const result = await assist('cheap bat', { fallback });

    const real = await prisma.product.findUnique({
      where: { id: 'ck-kashmir-willow-bat' },
      include: { tiers: { orderBy: { minQty: 'asc' } } },
    });
    expect(result.products[0].fromPrice).toBe(Number(real.tiers[0].unitPrice) / 100);
    expect(result.products[0].fromPrice).not.toBe(99);
    // The model's words come back, but nothing it said became a number we show.
    expect(result.products[0]).not.toHaveProperty('discount');
    expect(result.products[0]).not.toHaveProperty('stockLeft');
  });

  it('falls back when the model suggests nothing we have', async () => {
    stubModel({ productIds: ['nothing-real'], answer: 'We do not stock that.' });
    const result = await assist('a submarine', { fallback });

    expect(result.source).toBe('search');
    expect(result.answer).toBe('We do not stock that.');
    expect(result.products.length).toBeGreaterThan(0);
  });

  it('falls back when the model fails, times out or answers with nonsense', async () => {
    for (const bad of [
      async () => ({ ok: false, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'not json' }] }) }),
      async () => { throw new Error('socket hang up'); },
    ]) {
      globalThis.fetch = vi.fn(bad);
      const result = await assist('cricket bat', { fallback });
      expect(result.source).toBe('search');
      expect(result.products.length).toBeGreaterThan(0);
    }
  });

  it('caps how many products one answer may suggest', async () => {
    const all = await prisma.product.findMany({ where: { active: true }, select: { id: true }, take: 30 });
    stubModel({ productIds: all.map((p) => p.id), answer: 'Everything.' });
    const result = await assist('everything you have', { fallback });
    expect(result.products.length).toBeLessThanOrEqual(8);
  });

  it('never sends a price to the model', async () => {
    stubModel({ productIds: [], answer: '' });
    await assist('anything', { fallback });

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    const sent = body.messages[0].content;
    expect(sent).not.toMatch(/unitPrice|fromPrice|tiers|"price"/i);
  });
});

describe('the endpoint', () => {
  it('needs something to go on', async () => {
    const res = await request(app).post('/api/v1/catalog/assist').send({ query: 'a' });
    expect(res.status).toBe(400);
  });

  it('reports whether it is on without needing an account', async () => {
    const res = await request(app).get('/api/v1/catalog/assist/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.enabled).toBe('boolean');
  });
});
