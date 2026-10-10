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
import { toRupees } from '../utils/money.js';
import {
  activeUsers, funnel, productInterest, searchHealth, salesReport, buyerActivity,
} from '../services/analytics.js';
import adminDb from './adminDb.js';
import { bestSellerReport, clearBestSellerCache } from '../services/bestSellers.js';
import { recordPriceChange, entryPrice, notifyPriceDrops } from '../services/deals.js';
import { canonicalVideoUrl } from '../services/videoUrl.js';
import { reviewQueue, moderateReview } from '../services/reviews.js';
import { importProducts, templateWorkbook } from '../services/productImport.js';
import {
  settings as rewardSettings,
  serializeSettings,
  award,
  balance as creditBalance,
} from '../services/rewards.js';
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
  barcode: z.string().trim().min(4).max(64).nullable().optional(),
  tiers: z.array(z.object({ minQty: z.number().int().positive(), unitPrice: z.number().positive() })).min(1),
});

async function upsertProduct(data, existingId) {
  data.images = (data.images ?? []).map(canonicalImageUrl);
  if (data.videoUrl) {
    const url = canonicalVideoUrl(data.videoUrl);
    if (!url) throw new ApiError(400, 'That is not a YouTube video link.');
    data.videoUrl = url;
  }
  const tiers = data.tiers.map((t) => ({ minQty: t.minQty, unitPrice: toPaise(t.unitPrice) }));
  const problem = validateTiers(tiers, data.moq);
  if (problem) throw new ApiError(400, problem);
  const { tiers: _t, ...fields } = data;

  // What the product cost before this write, so a genuine drop can be recorded
  // and shown on the Deals shelf. Read before the tiers are replaced.
  const before = existingId
    ? await prisma.productTier.findMany({ where: { productId: existingId } })
    : [];
  const oldEntry = entryPrice(before);

  const saved = await prisma.$transaction(async (tx) => {
    const p = existingId
      ? await tx.product.update({ where: { id: existingId }, data: fields })
      : await tx.product.create({ data: fields });
    await tx.productTier.deleteMany({ where: { productId: p.id } });
    await tx.productTier.createMany({ data: tiers.map((t) => ({ ...t, productId: p.id })) });
    await recordPriceChange(tx, p.id, oldEntry, entryPrice(tiers));
    return tx.product.findUnique({ where: { id: p.id }, include: { tiers: { orderBy: { minQty: 'asc' } } } });
  });
  clearBestSellerCache();
  return saved;
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

// ── Best sellers ────────────────────────────────────────────────────────────
// What actually sold in the last 30 days, and the pin that puts a product on
// the home rail regardless — a new launch has no sales history to rank on.

// ── Analytics ───────────────────────────────────────────────────────────────
// Counts of what people did are estimates reported by the app, and say so.
// Money is read from the orders themselves and never from an event.

const window = (req) => Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

r.get('/analytics/active-users', asyncHandler(async (req, res) => {
  ok(res, await activeUsers({ days: window(req) }));
}));

r.get('/analytics/funnel', asyncHandler(async (req, res) => {
  ok(res, await funnel({ days: window(req) }));
}));

r.get('/analytics/products', asyncHandler(async (req, res) => {
  ok(res, await productInterest({
    days: window(req),
    limit: Math.min(Math.max(Number(req.query.limit) || 20, 1), 100),
  }));
}));

r.get('/analytics/search', asyncHandler(async (req, res) => {
  ok(res, await searchHealth({ days: window(req) }));
}));

r.get('/analytics/sales', asyncHandler(async (req, res) => {
  ok(res, await salesReport({ from: req.query.from, to: req.query.to }));
}));

r.get('/analytics/buyers', asyncHandler(async (req, res) => {
  ok(res, await buyerActivity({
    quietDays: Math.min(Math.max(Number(req.query.quietDays) || 45, 7), 365),
    limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 200),
  }));
}));

// ── Rewards ─────────────────────────────────────────────────────────────────
// The rules live in the database so turning the programme on, or switching
// between a daily streak and purchase-based credits, is an admin edit.

r.get('/rewards/settings', asyncHandler(async (_req, res) => {
  ok(res, serializeSettings(await rewardSettings()));
}));

r.put('/rewards/settings', validate(z.object({
  mode: z.enum(['purchase', 'streak', 'both']).optional(),
  creditsPer100Rupees: z.number().int().min(0).max(10000).optional(),
  creditValue: z.number().min(0).max(1000).optional(),
  dailyCheckInCredits: z.number().int().min(0).max(10000).optional(),
  referralCredits: z.number().int().min(0).max(100000).optional(),
  maxRedeemPercent: z.number().int().min(0).max(100).optional(),
  active: z.boolean().optional(),
})), asyncHandler(async (req, res) => {
  // creditPaiseValue is an Int column, not a money BigInt: one credit is worth
  // a few paise, never an amount that needs 64 bits.
  const { creditValue, ...rest } = req.body;
  const paiseValue = creditValue == null ? null : Math.round(creditValue * 100);
  const saved = await prisma.rewardSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...rest, ...(paiseValue != null && { creditPaiseValue: paiseValue }) },
    update: { ...rest, ...(paiseValue != null && { creditPaiseValue: paiseValue }) },
  });
  ok(res, serializeSettings(saved));
}));

/** Who has reached a gift tier and not yet received it. */
r.get('/rewards/claims', asyncHandler(async (req, res) => {
  const status = ['earned', 'claimed', 'delivered'].includes(req.query.status) ? req.query.status : undefined;
  const rows = await prisma.rewardClaim.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(req.query.limit) || 50, 1), 200),
    include: {
      tier: { select: { name: true, giftLabel: true, threshold: true } },
      user: { select: { mobile: true, profile: { select: { businessName: true } } } },
    },
  });
  ok(res, rows.map((c) => ({
    id: c.id,
    status: c.status,
    buyer: c.user.profile?.businessName || c.user.mobile,
    mobile: c.user.mobile,
    tier: c.tier.name,
    gift: c.tier.giftLabel,
    threshold: toRupees(c.tier.threshold),
    totalAtClaim: toRupees(c.totalAtClaim),
    adminNote: c.adminNote,
    at: c.createdAt.toISOString(),
  })));
}));

r.put('/rewards/claims/:id', validate(z.object({
  status: z.enum(['earned', 'claimed', 'delivered']),
  adminNote: z.string().trim().max(500).optional(),
})), asyncHandler(async (req, res) => {
  const saved = await prisma.rewardClaim.update({
    where: { id: req.params.id },
    data: { status: req.body.status, adminNote: req.body.adminNote },
  });
  ok(res, { id: saved.id, status: saved.status });
}));

/** A manual correction, which lands in the buyer's ledger like any other. */
r.post('/rewards/adjust', validate(z.object({
  userId: uuid,
  delta: z.number().int().refine((n) => n !== 0, 'Enter a non-zero number of credits'),
  note: z.string().trim().min(3, 'Say why, so the buyer can see it'),
})), asyncHandler(async (req, res) => {
  const entry = await prisma.$transaction((tx) => award(tx, req.body.userId, {
    delta: req.body.delta,
    reason: 'adminAdjust',
    // Unique per adjustment: a correction is deliberate, not an event to dedupe.
    eventKey: `adjust:${req.body.userId}:${Date.now()}`,
    note: req.body.note,
  }));
  ok(res, { credited: entry?.delta ?? 0, balance: await creditBalance(req.body.userId) });
}));

// ── Review moderation ───────────────────────────────────────────────────────
r.get('/reviews', asyncHandler(async (req, res) => {
  const status = ['pending', 'approved', 'hidden'].includes(req.query.status) ? req.query.status : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  ok(res, await reviewQueue({ status, offset, limit }));
}));

r.put('/reviews/:id/status', validate(z.object({
  status: z.enum(['pending', 'approved', 'hidden']),
  adminNote: z.string().trim().max(500).optional(),
})), asyncHandler(async (req, res) => {
  ok(res, await moderateReview(req.params.id, req.body.status, req.body.adminNote));
}));

r.post('/price-drops/notify', asyncHandler(async (_req, res) => {
  ok(res, await notifyPriceDrops());
}));

r.get('/best-sellers', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  ok(res, await bestSellerReport({ limit }));
}));

r.put('/products/:id/pin', validate(z.object({
  rank: z.number().int().min(1).max(999).default(1),
})), asyncHandler(async (req, res) => {
  const product = await prisma.product.update({
    where: { id: req.params.id },
    data: { featuredRank: req.body.rank },
    select: { id: true, name: true, featuredRank: true },
  });
  clearBestSellerCache();
  ok(res, product);
}));

r.delete('/products/:id/pin', asyncHandler(async (req, res) => {
  const product = await prisma.product.update({
    where: { id: req.params.id },
    data: { featuredRank: null },
    select: { id: true, name: true, featuredRank: true },
  });
  clearBestSellerCache();
  ok(res, product);
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
// ── Bulk product import ─────────────────────────────────────────────────────
// A data-entry employee fills the template; an admin uploads it. Nothing is
// written unless the whole sheet is valid, and `dryRun` checks it first.

/** The template to hand the employee: columns, an example, and a reference. */
r.get('/products/import/template', asyncHandler(async (_req, res) => {
  const wb = await templateWorkbook();
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    'attachment; filename="spocart-products-template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.csv') {
      return cb(new ApiError(400, 'Upload the filled template as .xlsx or .csv.'));
    }
    cb(null, true);
  },
});

/**
 * Imports the sheet. `?dryRun=true` validates and reports without changing
 * anything — the admin panel should always run that first and show the result.
 */
r.post('/products/import', sheetUpload.single('file'), asyncHandler(async (req, res) => {
  const result = await importProducts(req.file, {
    dryRun: req.query.dryRun === 'true' || req.body?.dryRun === 'true',
  });
  ok(res, result, result.ok ? 200 : 422);
}));

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
