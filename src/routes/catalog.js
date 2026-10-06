import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { toRupees } from '../utils/money.js';
import { absoluteUrl } from '../services/orders.js';
import { bestSellerIds } from '../services/bestSellers.js';
import { deals, entryPrice, LOW_STOCK_THRESHOLD } from '../services/deals.js';
import { videoThumbnailUrl } from '../services/videoUrl.js';
import { reviewsFor } from '../services/reviews.js';
import { optionalAuth } from '../middleware/auth.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { aiAssistLimiter } from '../middleware/rateLimit.js';
import { assist, aiSearchStatus } from '../services/aiSearch.js';

const r = Router();
const cache = (_req, res, next) => { res.set('Cache-Control', 'public, max-age=300'); next(); };
const tiersInclude = { tiers: { orderBy: { minQty: 'asc' } } };

export const serializeCategory = (c) => ({ ...c, imageUrl: absoluteUrl(c.imageUrl) });

export const serializeProduct = (p) => ({
  id: p.id,
  categoryId: p.categoryId,
  name: p.name,
  brand: p.brand,
  subcategory: p.subcategory,
  unit: p.unit,
  moq: p.moq,
  description: p.description,
  images: p.images.map(absoluteUrl),
  sizes: p.sizes,
  features: p.features,
  rating: Number(p.rating),
  reviewCount: p.reviewCount,
  inStock: p.inStock,
  popular: p.popular,
  customisable: p.customisable,
  pinned: p.featuredRank != null,
  barcode: p.barcode ?? null,
  videoUrl: p.videoUrl ?? null,
  videoThumbnailUrl: videoThumbnailUrl(p.videoUrl),
  // Only sent when an admin actually tracks this product's stock, and only
  // once it is low — the app says nothing about quantity otherwise.
  stockLeft:
    p.stockQty != null && p.stockQty > 0 && p.stockQty <= LOW_STOCK_THRESHOLD
      ? p.stockQty
      : null,
  tiers: p.tiers.map((t) => ({ minQty: t.minQty, unitPrice: toRupees(t.unitPrice) })),
});

/**
 * Best sellers for the home rail: product ids in rank order, newest sales data
 * within the last 30 days, pinned products first. Public — the home screen is
 * shown before sign-in.
 */
r.get('/best-sellers', cache, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 30);
  ok(res, { productIds: await bestSellerIds({ limit }) });
}));

/**
 * Deals: products whose price genuinely dropped in the last two weeks, and
 * products whose tracked stock is running out. `previousPrice` is only present
 * because we recorded the change ourselves, so nothing here is invented.
 */
r.get('/deals', cache, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const rows = await deals({ limit });
  ok(res, rows.map((d) => ({
    ...serializeProduct(d.product),
    previousPrice: d.previousPrice == null ? null : toRupees(d.previousPrice),
    currentPrice: toRupees(entryPrice(d.product.tiers) ?? 0n),
    droppedAt: d.droppedAt ? d.droppedAt.toISOString() : null,
    stockLeft: d.stockLeft,
  })));
}));

/**
 * New launches: the most recently added products, so a fresh range is visible
 * before it has any sales history to rank on.
 */
r.get('/new-launches', cache, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 30);
  const rows = await prisma.product.findMany({
    where: { active: true },
    include: tiersInclude,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  ok(res, rows.map(serializeProduct));
}));

/**
 * A product's approved reviews with the star breakdown. Public, and optionally
 * authenticated so a buyer can see which one is theirs.
 */
r.get('/products/:id/reviews', optionalAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  ok(res, await reviewsFor(req.params.id, { offset, limit, userId: req.user?.id }));
}));

/**
 * Resolves a scanned barcode to a product. Public, because scanning happens on
 * the search bar before a buyer needs an account. A code nobody has entered yet
 * answers 404 — the app then says so instead of guessing at a product.
 */
r.get('/barcode/:code', asyncHandler(async (req, res) => {
  const code = String(req.params.code ?? '').trim();
  if (!/^[A-Za-z0-9._-]{4,64}$/.test(code)) {
    throw new ApiError(400, 'That does not look like a product barcode.');
  }
  const product = await prisma.product.findFirst({
    where: { barcode: code, active: true },
    include: tiersInclude,
  });
  if (!product) throw new ApiError(404, 'No SPOCART product carries that barcode.');
  ok(res, serializeProduct(product));
}));

/**
 * Plain-language product help: "kit for 50 kids under 12". Answers from the
 * model when the business has switched that on, and from the ordinary
 * typo-tolerant search otherwise — the response says which, and a buyer always
 * gets products either way.
 */
r.post('/assist', optionalAuth, aiAssistLimiter, validate(z.object({
  query: z.string().trim().min(2, 'Tell us what you need').max(300),
})), asyncHandler(async (req, res) => {
  ok(res, await assist(req.body.query, { fallback: fallbackSearch }));
}));

r.get('/assist/status', asyncHandler(async (_req, res) => {
  ok(res, aiSearchStatus());
}));

/**
 * The plain search the assistant falls back to: whole-word and prefix matches
 * over the catalogue, newest first, ids only.
 */
async function fallbackSearch(query) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length === 0) return [];
  const rows = await prisma.product.findMany({
    where: {
      active: true,
      OR: words.flatMap((w) => [
        { name: { contains: w, mode: 'insensitive' } },
        { brand: { contains: w, mode: 'insensitive' } },
        { subcategory: { contains: w, mode: 'insensitive' } },
        { categoryId: { contains: w, mode: 'insensitive' } },
      ]),
    },
    select: { id: true },
    take: 8,
  });
  return rows.map((p) => p.id);
}

r.get('/categories', cache, asyncHandler(async (_req, res) => {
  const rows = await prisma.category.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  ok(res, rows.map(serializeCategory));
}));

r.get('/products', cache, asyncHandler(async (req, res) => {
  const { categoryId, q, popular } = req.query;
  const rows = await prisma.product.findMany({
    where: {
      active: true,
      ...(categoryId && { categoryId: String(categoryId) }),
      ...(popular && { popular: true }),
      ...(q && {
        OR: [
          { name: { contains: String(q), mode: 'insensitive' } },
          { brand: { contains: String(q), mode: 'insensitive' } },
          { subcategory: { contains: String(q), mode: 'insensitive' } },
        ],
      }),
    },
    include: tiersInclude,
    orderBy: [{ popular: 'desc' }, { name: 'asc' }],
  });
  ok(res, rows.map(serializeProduct));
}));

r.get('/products/:id', cache, asyncHandler(async (req, res) => {
  const p = await prisma.product.findFirst({ where: { id: req.params.id, active: true }, include: tiersInclude });
  if (!p) throw new ApiError(404, 'Product not found.');
  ok(res, serializeProduct(p));
}));

export default r;
