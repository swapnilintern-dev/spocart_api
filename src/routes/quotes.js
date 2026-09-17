import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { publicFormLimiter } from '../middleware/rateLimit.js';
import { ok } from '../utils/respond.js';
import { submitQuote, serializeQuote, quoteInclude } from '../services/quotes.js';
import { checkoutFor, orderInclude, serializeOrder } from '../services/orders.js';
import { nextId } from '../services/ids.js';
import { razorpay } from '../services/razorpay.js';
import { addDays } from '../utils/dates.js';
import { mobile } from './_schemas.js';

const r = Router();

r.get('/', requireAuth, asyncHandler(async (req, res) => {
  const rows = await prisma.quote.findMany({ where: { userId: req.user.id }, include: quoteInclude, orderBy: { createdAt: 'desc' } });
  ok(res, rows.map(serializeQuote));
}));

// Website visitors may post without a token (rate-limited); app users are attached via optionalAuth.
r.post('/', publicFormLimiter, optionalAuth, validate(z.object({
  kind: z.enum(['bulk', 'custom', 'csv']),
  items: z.array(z.object({
    description: z.string().trim().min(1),
    quantity: z.number().int().positive(),
    productId: z.string().optional(),
    size: z.string().optional(),
  })).min(1, 'Add at least one item.'),
  notes: z.string().trim().max(2000).default(''),
  designFileUrl: z.string().optional(),
  contactName: z.string().trim().optional(),
  contactMobile: mobile.optional(),
  website: z.string().max(0).optional(), // honeypot: bots fill it, humans never see it
})), asyncHandler(async (req, res) => {
  const quote = await submitQuote(req.user, req.body);
  ok(res, serializeQuote(quote), 201);
}));

/** Buyer accepts a quoted price → paymentPending order with the quoted total. */
r.post('/:id/accept', requireAuth, validate(z.object({ addressId: z.uuid() })), asyncHandler(async (req, res) => {
  const quote = await prisma.quote.findFirst({ where: { id: req.params.id, userId: req.user.id }, include: quoteInclude });
  if (!quote) throw new ApiError(404, 'Quote not found.');
  if (quote.status !== 'quoted' || quote.quotedTotal == null) throw new ApiError(400, 'This quotation has not been priced yet.');
  if (!req.user.profile) throw new ApiError(400, 'Complete your business details to place an order.');
  const address = await prisma.address.findFirst({ where: { id: req.body.addressId, userId: req.user.id } });
  if (!address) throw new ApiError(400, 'Please choose a delivery address.');

  const total = quote.quotedTotal;
  const subtotal = (total * 100n) / 118n;
  const gst = total - subtotal;

  const result = await prisma.$transaction(async (tx) => {
    const id = await nextId(tx, 'SC');
    const invoiceId = await nextId(tx, 'INV');
    const rzp = await razorpay.orders.create({ amount: Number(total), currency: 'INR', receipt: id, notes: { orderId: id, quoteId: quote.id } });
    const now = new Date();
    const order = await tx.order.create({
      data: {
        id, invoiceId, userId: req.user.id, paymentMethod: 'razorpay', status: 'paymentPending', paid: false,
        subtotal, gst, total, address, razorpayOrderId: rzp.id,
        trackingId: `SPK${now.getTime().toString().slice(-8)}`, etaStart: addDays(now, 7), etaEnd: addDays(now, 21),
        items: { create: quote.items.map((i) => ({
          productId: i.productId ?? 'custom', name: i.description, image: '', unit: 'pc', quantity: i.quantity,
          unitPrice: subtotal / BigInt(quote.items.reduce((s, x) => s + x.quantity, 0) || 1), size: i.size,
        })) },
        history: { create: { status: 'paymentPending', note: `From quotation ${quote.id}` } },
      },
      include: orderInclude,
    });
    await tx.quote.update({ where: { id: quote.id }, data: { status: 'accepted' } });
    return { order: serializeOrder(order), checkout: checkoutFor(order, req.user.profile, rzp.id) };
  });
  ok(res, result, 201);
}));

export default r;
