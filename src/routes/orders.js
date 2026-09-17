import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { placeOrder, retryPayment, serializeOrder, orderInclude } from '../services/orders.js';
import { markCaptured, verifyCheckoutSignature } from '../services/payments.js';
import { uuid } from './_schemas.js';

const r = Router();
r.use(requireAuth);

const STATUS_FILTERS = {
  pending: ['paymentPending', 'placed', 'packed'],
  shipped: ['dispatched', 'outForDelivery'],
  delivered: ['delivered'],
};

r.post('/', validate(z.object({
  lines: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().positive(),
    size: z.string().trim().min(1).optional(),
  })).min(1, 'Your cart is empty.'),
  addressId: uuid,
  paymentMethod: z.enum(['razorpay', 'payLater']),
})), asyncHandler(async (req, res) => {
  ok(res, await placeOrder(req.user, req.body), 201);
}));

r.get('/', asyncHandler(async (req, res) => {
  const filter = STATUS_FILTERS[String(req.query.status ?? '')];
  const rows = await prisma.order.findMany({
    where: {
      userId: req.user.id,
      ...(filter && { status: { in: filter } }),
    },
    include: orderInclude,
    orderBy: { placedAt: 'desc' },
  });
  ok(res, rows.map(serializeOrder));
}));

// Verify must be declared before /:id so "payments" is not read as an order id.
r.post('/payments/verify', validate(z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
})), asyncHandler(async (req, res) => {
  if (!verifyCheckoutSignature(req.body)) {
    throw new ApiError(400, 'Payment could not be verified. If money was debited it will be reconciled automatically.');
  }
  const order = await prisma.order.findFirst({ where: { razorpayOrderId: req.body.razorpayOrderId, userId: req.user.id } });
  if (!order) throw new ApiError(404, 'Order not found.');
  const updated = await markCaptured({
    order,
    razorpayPaymentId: req.body.razorpayPaymentId,
    amount: order.total,
    method: null,
    raw: req.body,
    source: 'app',
  });
  ok(res, serializeOrder(updated));
}));

r.get('/:id', asyncHandler(async (req, res) => {
  const o = await prisma.order.findFirst({ where: { id: req.params.id, userId: req.user.id }, include: orderInclude });
  if (!o) throw new ApiError(404, 'Order not found.');
  ok(res, serializeOrder(o));
}));

r.post('/:id/retry-payment', asyncHandler(async (req, res) => {
  ok(res, await retryPayment(req.user, req.params.id));
}));

export default r;
