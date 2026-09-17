// Invoices, dashboard and device registration — all derived from the account's
// orders / quotes, no extra tables.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { toRupees } from '../utils/money.js';
import { outstandingCredit, checkoutFor } from '../services/orders.js';
import { razorpay } from '../services/razorpay.js';

// Mounted at '/', so auth is applied per route (never router-wide) to keep
// the public routes registered after it public.
const r = Router();

r.get('/invoices', requireAuth, asyncHandler(async (req, res) => {
  const rows = await prisma.order.findMany({
    where: { userId: req.user.id, status: { notIn: ['paymentPending', 'cancelled'] } },
    orderBy: { placedAt: 'desc' },
  });
  ok(res, rows.map((o) => ({ id: o.invoiceId, orderId: o.id, date: o.placedAt, amount: toRupees(o.total), paid: o.paid })));
}));

/** Settle a Pay Later invoice online: returns a fresh Razorpay checkout for the same order. */
r.post('/invoices/:invoiceId/pay', requireAuth, asyncHandler(async (req, res) => {
  const order = await prisma.order.findFirst({ where: { invoiceId: req.params.invoiceId, userId: req.user.id } });
  if (!order) throw new ApiError(404, 'Invoice not found.');
  if (order.paid) throw new ApiError(400, 'This invoice is already paid.');
  const rzp = await razorpay.orders.create({
    amount: Number(order.total), currency: 'INR', receipt: `${order.invoiceId}-${Date.now()}`,
    notes: { orderId: order.id, invoiceId: order.invoiceId, userId: req.user.id },
  });
  await prisma.order.update({ where: { id: order.id }, data: { razorpayOrderId: rzp.id } });
  ok(res, { invoiceId: order.invoiceId, checkout: checkoutFor(order, req.user.profile, rzp.id) });
}));

r.get('/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const [stats, savedQuotations, repeat] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COALESCE(SUM(total) FILTER (WHERE status NOT IN ('cancelled','paymentPending')), 0)::bigint AS total_purchases,
        COUNT(*) FILTER (WHERE status IN ('placed','packed','dispatched','outForDelivery'))::int AS pending_orders
      FROM orders WHERE user_id = ${req.user.id}::uuid`,
    prisma.quote.count({ where: { userId: req.user.id } }),
    prisma.$queryRaw`
      WITH firsts AS (
        SELECT oi.product_id, MIN(o.placed_at) AS first_at
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.user_id = ${req.user.id}::uuid AND o.status <> 'cancelled'
        GROUP BY oi.product_id)
      SELECT COUNT(DISTINCT o.id)::int AS repeat_orders
      FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN firsts f ON f.product_id = oi.product_id
      WHERE o.user_id = ${req.user.id}::uuid AND o.status <> 'cancelled' AND o.placed_at > f.first_at`,
  ]);
  const outstanding = await outstandingCredit(prisma, req.user.id);
  const available = req.user.creditLimit - outstanding;
  ok(res, {
    totalPurchases: toRupees(stats[0].total_purchases),
    pendingOrders: stats[0].pending_orders,
    outstandingPayment: toRupees(outstanding),
    savedQuotations,
    repeatOrders: repeat[0].repeat_orders,
    availableCredit: toRupees(available < 0n ? 0n : available),
    creditLimit: toRupees(req.user.creditLimit),
  });
}));

r.post('/devices', requireAuth, validate(z.object({ token: z.string().min(10), platform: z.enum(['android', 'ios', 'web']) })),
  asyncHandler(async (req, res) => {
    await prisma.deviceToken.upsert({
      where: { token: req.body.token },
      create: { ...req.body, userId: req.user.id },
      update: { userId: req.user.id, platform: req.body.platform },
    });
    ok(res, { registered: true });
  }));

export default r;
