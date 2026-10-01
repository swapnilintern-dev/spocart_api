// Operations endpoints. Everything here requires role = admin.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { serializeOrder, orderInclude } from '../services/orders.js';
import { advanceStatus, cancelOrder } from '../services/status.js';
import { refundPayment } from '../services/payments.js';
import { reconcileOrder, reconcilePending } from '../services/reconcile.js';
import { respondToQuote, serializeQuote, quoteInclude } from '../services/quotes.js';
import { validateTiers } from '../services/pricing.js';
import { notify } from '../services/notify.js';
import { serializeProduct } from './catalog.js';
import { uuid } from './_schemas.js';
import adminDb from './adminDb.js';
import multer from 'multer';
import path from 'node:path';
import { storeFile, canonicalImageUrl } from '../services/storage.js';

const r = Router();
r.use(requireAuth, requireAdmin);
r.use('/db', adminDb);   // full database console (see adminDb.js)

const toPaise = (rupees) => BigInt(Math.round(rupees * 100));

// ─── Orders ──────────────────────────────────────────────────────────────────
r.get('/orders', asyncHandler(async (req, res) => {
  const { status, paid, q } = req.query;
  const rows = await prisma.order.findMany({
    where: {
      ...(status && { status: String(status) }),
      ...(paid !== undefined && { paid: paid === 'true' }),
      ...(q && { OR: [{ id: { contains: String(q), mode: 'insensitive' } }, { invoiceId: { contains: String(q), mode: 'insensitive' } }] }),
    },
    include: { ...orderInclude, user: { include: { profile: true } } },
    orderBy: { placedAt: 'desc' },
    take: 200,
  });
  ok(res, rows.map((o) => ({
    ...serializeOrder(o),
    buyer: { mobile: o.user.mobile, businessName: o.user.profile?.businessName, contactName: o.user.profile?.contactName },
  })));
}));

r.post('/orders/:id/status', validate(z.object({
  status: z.enum(['packed', 'dispatched', 'outForDelivery', 'delivered']),
  note: z.string().trim().max(500).optional(),
  trackingId: z.string().trim().max(60).optional(),
})), asyncHandler(async (req, res) => {
  ok(res, serializeOrder(await advanceStatus(req.params.id, req.body)));
}));

r.post('/orders/:id/cancel', validate(z.object({ note: z.string().trim().max(500).optional() })),
  asyncHandler(async (req, res) => {
    const order = await cancelOrder(req.params.id, req.body.note);
    const captured = order.payments?.find?.((p) => p.status === 'captured')
      ?? await prisma.payment.findFirst({ where: { orderId: order.id, status: 'captured' } });
    if (captured) await refundPayment(captured.id);
    ok(res, serializeOrder(order));
  }));

/** Pull payment status from Razorpay for one order / all pending orders. */
r.post('/orders/:id/reconcile', asyncHandler(async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: orderInclude });
  if (!order) throw new ApiError(404, 'Order not found.');
  ok(res, serializeOrder(await reconcileOrder(order)));
}));
r.post('/reconcile', asyncHandler(async (_req, res) => ok(res, await reconcilePending())));

r.post('/payments/:id/refund', validate(z.object({ amount: z.number().positive().optional() })),
  asyncHandler(async (req, res) => {
    const refund = await refundPayment(req.params.id, req.body.amount ? toPaise(req.body.amount) : undefined);
    ok(res, { refundId: refund.id, status: refund.status, amount: refund.amount / 100 });
  }));

/** Mark a Pay Later invoice settled offline (NEFT / cheque / cash). */
r.post('/invoices/:invoiceId/settle', validate(z.object({ reference: z.string().trim().min(2) })),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({ where: { invoiceId: req.params.invoiceId } });
    if (!order) throw new ApiError(404, 'Invoice not found.');
    if (order.paid) throw new ApiError(400, 'Already paid.');
    const updated = await prisma.$transaction(async (tx) => {
      const o = await tx.order.update({
        where: { id: order.id },
        data: { paid: true, history: { create: { status: order.status, note: `Payment received offline: ${req.body.reference}` } } },
        include: orderInclude,
      });
      await notify(tx, order.userId, {
        type: 'orderPlaced', title: 'Payment Received',
        body: `Invoice ${order.invoiceId} for order #${order.id} is settled. Thank you.`, orderId: order.id,
      });
      return o;
    });
    ok(res, serializeOrder(updated));
  }));

// ─── Quotes & leads ──────────────────────────────────────────────────────────
r.get('/quotes', asyncHandler(async (req, res) => {
  const rows = await prisma.quote.findMany({
    where: req.query.status ? { status: String(req.query.status) } : {},
    include: { ...quoteInclude, user: { include: { profile: true } } },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  ok(res, rows.map((q) => ({
    ...serializeQuote(q),
    contactName: q.contactName ?? q.user?.profile?.contactName,
    contactMobile: q.contactMobile ?? q.user?.mobile,
    businessName: q.user?.profile?.businessName,
  })));
}));

r.post('/quotes/:id/respond', validate(z.object({
  quotedTotal: z.number().positive('Enter the quoted total in rupees (incl. GST)'),
  adminNote: z.string().trim().max(1000).optional(),
})), asyncHandler(async (req, res) => {
  const q = await respondToQuote(req.params.id, { quotedTotalPaise: toPaise(req.body.quotedTotal), adminNote: req.body.adminNote });
  ok(res, serializeQuote(q));
}));

r.post('/quotes/:id/decline', validate(z.object({ adminNote: z.string().trim().max(1000).optional() })),
  asyncHandler(async (req, res) => {
    const q = await prisma.quote.update({ where: { id: req.params.id }, data: { status: 'declined', adminNote: req.body.adminNote }, include: quoteInclude });
    ok(res, serializeQuote(q));
  }));

r.get('/leads', asyncHandler(async (_req, res) => {
  ok(res, await prisma.lead.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }));
}));

// ─── Buyers ──────────────────────────────────────────────────────────────────
r.get('/users', asyncHandler(async (req, res) => {
  const rows = await prisma.user.findMany({
    where: req.query.q ? { OR: [{ mobile: { contains: String(req.query.q) } }, { profile: { businessName: { contains: String(req.query.q), mode: 'insensitive' } } }] } : {},
    include: { profile: true, _count: { select: { orders: true } } },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  ok(res, rows.map((u) => ({
    id: u.id, mobile: u.mobile, role: u.role, creditLimit: Number(u.creditLimit) / 100,
    businessName: u.profile?.businessName, gstin: u.profile?.gstin, orders: u._count.orders, createdAt: u.createdAt,
  })));
}));

r.post('/users/:id/credit', validate(z.object({ creditLimit: z.number().min(0) })), asyncHandler(async (req, res) => {
  const u = await prisma.user.update({ where: { id: req.params.id }, data: { creditLimit: toPaise(req.body.creditLimit) } });
  ok(res, { id: u.id, creditLimit: Number(u.creditLimit) / 100 });
}));

r.post('/users/:id/logout-all', asyncHandler(async (req, res) => {
  await prisma.user.update({ where: { id: req.params.id }, data: { tokenVersion: { increment: 1 } } });
  ok(res, { signedOut: true });
}));

// ─── Catalogue ───────────────────────────────────────────────────────────────
const productBody = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Use a slug id like ck-kashmir-willow-bat'),
  categoryId: z.string().min(1),
  name: z.string().trim().min(2),
  brand: z.string().trim().min(1),
  subcategory: z.string().trim().min(1),
  unit: z.enum(['pc', 'pair', 'set', 'box']).default('pc'),
  moq: z.number().int().positive(),
  description: z.string().trim().default(''),
  images: z.array(z.string()).default([]),
  sizes: z.array(z.string()).default([]),
  features: z.array(z.object({ label: z.string(), icon: z.string() })).default([]),
  rating: z.number().min(0).max(5).default(0),
  reviewCount: z.number().int().min(0).default(0),
  inStock: z.boolean().default(true),
  popular: z.boolean().default(false),
  customisable: z.boolean().default(false),
  active: z.boolean().default(true),
  tiers: z.array(z.object({ minQty: z.number().int().positive(), unitPrice: z.number().positive() })).min(1),
});

async function upsertProduct(data, existingId) {
  data.images = (data.images ?? []).map(canonicalImageUrl);
  const tiers = data.tiers.map((t) => ({ minQty: t.minQty, unitPrice: toPaise(t.unitPrice) }));
  const problem = validateTiers(tiers, data.moq);
  if (problem) throw new ApiError(400, problem);
  const { tiers: _t, ...fields } = data;
  return prisma.$transaction(async (tx) => {
    const p = existingId
      ? await tx.product.update({ where: { id: existingId }, data: fields })
      : await tx.product.create({ data: fields });
    await tx.productTier.deleteMany({ where: { productId: p.id } });
    await tx.productTier.createMany({ data: tiers.map((t) => ({ ...t, productId: p.id })) });
    return tx.product.findUnique({ where: { id: p.id }, include: { tiers: { orderBy: { minQty: 'asc' } } } });
  });
}

r.post('/products', validate(productBody), asyncHandler(async (req, res) => ok(res, serializeProduct(await upsertProduct(req.body)), 201)));
r.put('/products/:id', validate(productBody.partial({ id: true }).extend({ id: z.string().optional() })), asyncHandler(async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id }, include: { tiers: { orderBy: { minQty: 'asc' } } } });
  if (!existing) throw new ApiError(404, 'Product not found.');
  const merged = {
    ...existing, ...req.body, id: existing.id, rating: Number(existing.rating),
    tiers: req.body.tiers ?? existing.tiers.map((t) => ({ minQty: t.minQty, unitPrice: Number(t.unitPrice) / 100 })),
  };
  ok(res, serializeProduct(await upsertProduct(productBody.parse(merged), existing.id)));
}));

r.patch('/products/:id/stock', validate(z.object({ inStock: z.boolean() })), asyncHandler(async (req, res) => {
  await prisma.product.update({ where: { id: req.params.id }, data: { inStock: req.body.inStock } });
  ok(res, { id: req.params.id, inStock: req.body.inStock });
}));

r.post('/categories', validate(z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1), icon: z.string().min(1),
  imageUrl: z.string().optional(), subcategories: z.array(z.string()).default([]), sortOrder: z.number().int().default(0), active: z.boolean().default(true),
})), asyncHandler(async (req, res) => {
  ok(res, await prisma.category.upsert({ where: { id: req.body.id }, create: req.body, update: req.body }), 201);
}));

// ─── Catalogue images (admin panel product editor) ──────────────────────────
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const catalogUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!IMAGE_EXT.has(path.extname(file.originalname).toLowerCase())) return cb(new ApiError(400, 'Upload PNG, JPG or WebP images only.'));
    cb(null, true);
  },
});
r.post('/uploads/catalog', catalogUpload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'Attach an image in the "file" field.');
  ok(res, await storeFile(req.file, req.query.folder === 'categories' ? 'categories' : 'products'), 201);
}));

// ─── Broadcast ───────────────────────────────────────────────────────────────
r.post('/broadcast', validate(z.object({
  type: z.enum(['offer', 'newProduct', 'priceDrop']),
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(2).max(300),
  productId: z.string().optional(),
})), asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({ where: { role: 'buyer' }, select: { id: true } });
  await prisma.notification.createMany({ data: users.map((u) => ({ userId: u.id, ...req.body })) });
  ok(res, { sent: users.length });
}));

export default r;
