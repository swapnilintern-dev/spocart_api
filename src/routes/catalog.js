import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { toRupees } from '../utils/money.js';
import { absoluteUrl } from '../services/orders.js';

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
  tiers: p.tiers.map((t) => ({ minQty: t.minQty, unitPrice: toRupees(t.unitPrice) })),
});

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
