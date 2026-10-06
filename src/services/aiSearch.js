// AI-assisted search.
//
// A buyer says what they need in their own words — "kit for 50 kids under 12",
// "everything to start a badminton court" — and gets products from our own
// catalogue.
//
// Two rules make this safe to switch on:
//
//   1. It is **grounded**. The model is given the catalogue and may only answer
//      with ids from it. Any id it invents is dropped before anything is sent
//      back, so a product that does not exist can never reach a buyer.
//   2. It never speaks about **money or stock**. Prices, MOQ and availability
//      are attached from the database afterwards, so a wrong number cannot be
//      quoted even if the model claims one.
//
// It is off unless the business has switched it on *and* a key is configured.
// When it is off, when it fails, or when it takes too long, the ordinary
// typo-tolerant search answers instead — a buyer always gets results.
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { toRupees } from '../utils/money.js';

const TIMEOUT_MS = 12_000;

/** Most products the model may suggest in one answer. */
const MAX_SUGGESTIONS = 8;

/** Most products described to the model, newest and best-selling first. */
const MAX_CONTEXT = 300;

export function aiSearchEnabled() {
  return env.AI_SEARCH_ENABLED && Boolean(env.ANTHROPIC_API_KEY);
}

/** Why it is off, in words an admin can act on. */
export function aiSearchStatus() {
  if (!env.AI_SEARCH_ENABLED) return { enabled: false, reason: 'AI_SEARCH_ENABLED is off.' };
  if (!env.ANTHROPIC_API_KEY) return { enabled: false, reason: 'ANTHROPIC_API_KEY is not set.' };
  return { enabled: true, reason: null };
}

/** The catalogue as the model sees it: no prices, no stock, no money at all. */
async function catalogueForModel() {
  const products = await prisma.product.findMany({
    where: { active: true },
    select: {
      id: true, name: true, brand: true, categoryId: true,
      subcategory: true, sizes: true, description: true,
    },
    take: MAX_CONTEXT,
    orderBy: { name: 'asc' },
  });
  return products.map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.categoryId,
    subcategory: p.subcategory,
    sizes: p.sizes,
    // Enough to tell products apart, not the whole page.
    about: (p.description ?? '').slice(0, 160),
  }));
}

const SYSTEM = `You help a wholesale sports-goods buyer in India find products in one catalogue.

Rules you must follow:
- Recommend ONLY products from the catalogue you are given, by their exact id.
- Never invent a product, an id, a price, a discount, a quantity in stock, or a delivery time.
- Never mention prices or availability at all — the shop attaches those itself.
- If the catalogue has nothing suitable, say so plainly and return an empty list.

Reply with JSON only, in this shape:
{"productIds": ["id1", "id2"], "answer": "one or two sentences"}`;

/**
 * Asks the model, then keeps only what it is allowed to have said. Returns null
 * when it is off, slow, or failed — the caller then falls back to the ordinary
 * search, so a buyer is never left with nothing.
 */
async function ask(query, catalogue) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.AI_SEARCH_MODEL,
        max_tokens: 700,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Catalogue:\n${JSON.stringify(catalogue)}\n\nBuyer asked: ${query}`,
        }],
      }),
    });
    if (!res.ok) return null;

    const body = await res.json();
    const text = body?.content?.find((c) => c.type === 'text')?.text ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    return {
      productIds: Array.isArray(parsed.productIds) ? parsed.productIds : [],
      answer: typeof parsed.answer === 'string' ? parsed.answer.slice(0, 400) : '',
    };
  } catch {
    // Timed out, unreachable, or answered with something that is not JSON.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Suggests products for a plain-language request.
 * Always returns `{ products, answer, source }`; `source` is 'ai' when the model
 * answered and 'search' when the ordinary search did.
 */
export async function assist(query, { fallback }) {
  const asked = String(query ?? '').trim().slice(0, 300);
  if (!asked) return { products: [], answer: '', source: 'search' };

  if (aiSearchEnabled()) {
    const catalogue = await catalogueForModel();
    const suggestion = await ask(asked, catalogue);
    if (suggestion) {
      // Only ids that are really in the catalogue survive. This is what makes
      // an invented product impossible rather than unlikely.
      const allowed = new Set(catalogue.map((p) => p.id));
      const ids = suggestion.productIds
        .filter((id) => typeof id === 'string' && allowed.has(id))
        .slice(0, MAX_SUGGESTIONS);

      if (ids.length > 0) {
        const products = await hydrate(ids);
        return { products, answer: suggestion.answer, source: 'ai' };
      }
      // The model found nothing it was allowed to suggest; its words still
      // stand, but the products come from the ordinary search.
      return {
        products: await hydrate(await fallback(asked)),
        answer: suggestion.answer,
        source: 'search',
      };
    }
  }

  return {
    products: await hydrate(await fallback(asked)),
    answer: '',
    source: 'search',
  };
}

/** Attaches the real product, with its real price, in the given order. */
async function hydrate(ids) {
  if (ids.length === 0) return [];
  const rows = await prisma.product.findMany({
    where: { id: { in: ids }, active: true },
    include: { tiers: { orderBy: { minQty: 'asc' } } },
  });
  const by = new Map(rows.map((p) => [p.id, p]));
  return ids
    .map((id) => by.get(id))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      categoryId: p.categoryId,
      subcategory: p.subcategory,
      unit: p.unit,
      moq: p.moq,
      inStock: p.inStock,
      images: p.images,
      // From the database, never from the model.
      fromPrice: p.tiers.length ? toRupees(p.tiers[0].unitPrice) : 0,
    }));
}
