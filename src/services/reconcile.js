// Safety net for missed / delayed webhooks: ask Razorpay directly whether a
// paymentPending order has a captured payment and sync it. Idempotent.
import { prisma } from '../db/prisma.js';
import { razorpay } from './razorpay.js';
import { markCaptured } from './payments.js';
import { orderInclude } from './orders.js';

export async function reconcileOrder(order) {
  if (!order.razorpayOrderId) return order;
  const { items } = await razorpay.orders.fetchPayments(order.razorpayOrderId);
  const captured = items.find((p) => p.status === 'captured');
  if (!captured) return order;
  return markCaptured({
    order, razorpayPaymentId: captured.id, amount: BigInt(captured.amount),
    method: captured.method, raw: captured, source: 'reconcile',
  });
}

/** Sync every order still awaiting payment. Returns how many were fixed. */
export async function reconcilePending() {
  const pending = await prisma.order.findMany({
    where: { status: 'paymentPending', razorpayOrderId: { not: null } },
    include: orderInclude,
  });
  let fixed = 0;
  for (const order of pending) {
    try {
      const after = await reconcileOrder(order);
      if (after.paid) fixed++;
    } catch (e) {
      console.error(`reconcile ${order.id}:`, e.error?.description ?? e.message);
    }
  }
  return { checked: pending.length, fixed };
}
