// Order fulfilment pipeline. Admin-only, forward-only, always with a history
// row and the matching buyer notification.
import { prisma } from '../db/prisma.js';
import { ApiError } from '../middleware/error.js';
import { notify } from './notify.js';
import { orderInclude } from './orders.js';

const PIPELINE = ['placed', 'packed', 'dispatched', 'outForDelivery', 'delivered'];
const CANCELLABLE = new Set(['paymentPending', 'placed', 'packed']);

export async function advanceStatus(orderId, { status, note, trackingId }) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, 'Order not found.');

  const from = PIPELINE.indexOf(order.status);
  const to = PIPELINE.indexOf(status);
  if (from === -1) throw new ApiError(400, `Order is ${order.status}; it cannot be moved.`);
  if (to <= from) throw new ApiError(400, `Order is already ${order.status}; status can only move forward.`);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status,
        statusUpdatedAt: new Date(),
        ...(trackingId && { trackingId }),
        history: { create: { status, note } },
      },
      include: orderInclude,
    });
    if (status === 'dispatched') {
      await notify(tx, order.userId, {
        type: 'orderShipped', title: 'Order Shipped',
        body: `Your order #${order.id} has been dispatched.${trackingId ? ` Tracking ID ${trackingId}.` : ''}`, orderId: order.id,
      });
    } else if (status === 'delivered') {
      await notify(tx, order.userId, {
        type: 'orderDelivered', title: 'Order Delivered',
        body: `Order #${order.id} was delivered successfully.`, orderId: order.id,
      });
    }
    return updated;
  });
}

export async function cancelOrder(orderId, note) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, 'Order not found.');
  if (!CANCELLABLE.has(order.status)) throw new ApiError(400, `A ${order.status} order cannot be cancelled.`);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: 'cancelled', statusUpdatedAt: new Date(), history: { create: { status: 'cancelled', note } } },
      include: orderInclude,
    });
    await notify(tx, order.userId, {
      type: 'orderPlaced', title: 'Order Cancelled',
      body: `Order #${order.id} was cancelled.${note ? ` ${note}` : ''}`, orderId: order.id,
    });
    return updated;
  });
}
