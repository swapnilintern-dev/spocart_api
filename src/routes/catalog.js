import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { toRupees } from '../utils/money.js';
import { absoluteUrl } from '../services/orders.js';
import { bestSellerIds } from '../services/bestSellers.js';
import { deals, entryPrice, LOW_STOCK_THRESHOLD } from '../services/deals.js';
import { videoThumbnailUrl } from '../services/videoUrl.js';

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
