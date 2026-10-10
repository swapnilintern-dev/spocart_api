// Payment state transitions. `markCaptured` is shared by the client verify
// endpoint and the Razorpay webhook and is idempotent: the unique
// razorpay_payment_id means the second arrival is a no-op.
import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { notify } from './notify.js';
import { inr } from '../utils/money.js';
import { creditForOrder, syncTiers } from './rewards.js';
import { orderInclude } from './orders.js';
import { razorpay } from './razorpay.js';

export function verifyCheckoutSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpaySignature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function markCaptured({ order, razorpayPaymentId, amount, method, raw, source }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findUnique({ where: { razorpayPaymentId } });
    if (existing?.status !== 'captured') {
      await tx.payment.upsert({
        where: { razorpayPaymentId },
        create: {
          orderId: order.id,
          razorpayOrderId: order.razorpayOrderId ?? '',
          razorpayPaymentId,
          amount,
          method,
          status: 'captured',
          raw,
          capturedAt: new Date(),
        },
        update: { status: 'captured', method, raw, capturedAt: new Date() },
      });
    }

    const current = await tx.order.findUnique({ where: { id: order.id } });

    // Short payment: the money is recorded, but the order is not marked paid.
    // Razorpay orders are fixed-amount so this should never happen — and if it
    // ever does, a human settles it rather than the shop shipping for less.
    if (BigInt(amount) < current.total) {
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          status: current.status,
          note: `Part payment of ${inr(BigInt(amount))} received against ${inr(current.total)} (${source}). Needs review.`,
        },
      });
      return tx.order.findUnique({ where: { id: order.id }, include: orderInclude });
    }

    // A payment can land after the order was cancelled for not being paid in
    // time. The money is real, so the order comes back rather than the buyer
    // being left having paid for nothing.
    const revive = current.status === 'cancelled' && !current.paid;
    const opening = current.status === 'paymentPending' || revive;

    if (opening || !current.paid) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          paid: true,
          ...(opening && {
            status: 'placed',
            statusUpdatedAt: new Date(),
            history: {
              create: {
                status: 'placed',
                note: revive
                  ? `Paid via Razorpay (${source}) after the order had expired — reinstated`
                  : `Paid via Razorpay (${source})`,
              },
            },
          }),
        },
      });
      if (opening) {
        await notify(tx, order.userId, {
          type: 'orderPlaced',
          title: 'Order Placed',
          body: `Payment received. Order #${order.id} is being processed.`,
          orderId: order.id,
        });
      }
    }
    return tx.order.findUnique({ where: { id: order.id }, include: orderInclude });
  }).then(async (saved) => {
    // Keyed on the order id, so verify, webhook and reconcile cannot each award
    // the same credits.
    await creditForOrder(order.id).catch(() => null);
    await syncTiers(order.userId).catch(() => null);
    return saved;
  });
}

export async function markFailed(entity) {
  const order = await prisma.order.findUnique({ where: { razorpayOrderId: entity.order_id } });
  if (!order) return;
  await prisma.payment.upsert({
    where: { razorpayPaymentId: entity.id },
    create: {
      orderId: order.id,
      razorpayOrderId: entity.order_id,
      razorpayPaymentId: entity.id,
      amount: BigInt(entity.amount),
      method: entity.method,
      status: 'failed',
      raw: entity,
    },
    update: { status: 'failed', raw: entity },
  });
}

export async function markRefunded(refund) {
  const payment = await prisma.payment.findUnique({ where: { razorpayPaymentId: refund.payment_id } });
  if (!payment) return;
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'refunded', refundId: refund.id } });
    const order = await tx.order.findUnique({ where: { id: payment.orderId } });
    if (order && order.status !== 'cancelled') {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'cancelled', paid: false, statusUpdatedAt: new Date(), history: { create: { status: 'cancelled', note: 'Refunded' } } },
      });
    }
  });
}

/** Admin refund (full or partial). The refund.processed webhook finalises the rows. */
export async function refundPayment(paymentId, amountPaise) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment?.razorpayPaymentId || payment.status !== 'captured') {
    throw new ApiError(400, 'Only captured payments can be refunded.');
  }
  const refund = await razorpay.payments.refund(payment.razorpayPaymentId, {
    amount: amountPaise ? Number(amountPaise) : Number(payment.amount),
    speed: 'normal',
    notes: { orderId: payment.orderId },
  });
  await prisma.payment.update({ where: { id: payment.id }, data: { refundId: refund.id } });
  return refund;
}
