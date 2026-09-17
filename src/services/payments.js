// Payment state transitions. `markCaptured` is shared by the client verify
// endpoint and the Razorpay webhook and is idempotent: the unique
// razorpay_payment_id means the second arrival is a no-op.
import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { notify } from './notify.js';
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
    if (current.status === 'paymentPending' || !current.paid) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          paid: true,
          ...(current.status === 'paymentPending' && {
            status: 'placed',
            statusUpdatedAt: new Date(),
            history: { create: { status: 'placed', note: `Paid via Razorpay (${source})` } },
          }),
        },
      });
      if (current.status === 'paymentPending') {
        await notify(tx, order.userId, {
          type: 'orderPlaced',
          title: 'Order Placed',
          body: `Payment received. Order #${order.id} is being processed.`,
          orderId: order.id,
        });
      }
    }
    return tx.order.findUnique({ where: { id: order.id }, include: orderInclude });
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
