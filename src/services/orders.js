// Order placement and serialisation. The server re-prices every line, applies
// GST, checks MOQ / stock / credit, creates the Razorpay order for the exact
// amount and stores everything in one transaction.
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { razorpay } from './razorpay.js';
import { nextId } from './ids.js';
import { notify } from './notify.js';
import { priceFor, totals } from './pricing.js';
import { inr, toRupees } from '../utils/money.js';
import { addDays } from '../utils/dates.js';

export const orderInclude = {
  items: { orderBy: { id: 'asc' } },
  history: { orderBy: { at: 'asc' } },
  payments: { orderBy: { createdAt: 'desc' }, take: 1 },
};

/** Shape the Flutter app's Order.fromJson expects (rupees, camelCase). */
export function serializeOrder(o) {
  const payment = o.payments?.[0];
  return {
    id: o.id,
    placedAt: o.placedAt,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paid: o.paid,
    subtotal: toRupees(o.subtotal),
    gst: toRupees(o.gst),
    total: toRupees(o.total),
    address: o.address,
    invoiceId: o.invoiceId,
    trackingId: o.trackingId,
    etaStart: o.etaStart,
    etaEnd: o.etaEnd,
    statusUpdatedAt: o.statusUpdatedAt,
    lines: (o.items ?? []).map((i) => ({
      productId: i.productId,
      name: i.name,
      image: absoluteUrl(i.image),
      unit: i.unit,
      quantity: i.quantity,
      unitPrice: toRupees(i.unitPrice),
      size: i.size,
    })),
    statusHistory: (o.history ?? []).map((h) => ({ status: h.status, note: h.note, at: h.at })),
    payment: payment
      ? { status: payment.status, method: payment.method, razorpayPaymentId: payment.razorpayPaymentId, capturedAt: payment.capturedAt }
      : null,
  };
}

export const absoluteUrl = (path) => (path && path.startsWith('/') ? `${env.PUBLIC_BASE_URL}${path}` : path);

export function checkoutFor(order, profile, razorpayOrderId) {
  return {
    keyId: env.RAZORPAY_KEY_ID,
    razorpayOrderId,
    amount: Number(order.total),
    currency: 'INR',
    name: 'SPOCART',
    description: `Order ${order.id}`,
    prefill: { contact: `+91${profile.mobile}`, email: profile.email, name: profile.contactName },
    themeColor: '#E4132B',
  };
}

export async function outstandingCredit(tx, userId) {
  const { _sum } = await tx.order.aggregate({
    _sum: { total: true },
    where: { userId, paymentMethod: 'payLater', paid: false, status: { not: 'cancelled' } },
  });
  return _sum.total ?? 0n;
}

export async function placeOrder(user, { lines, addressId, paymentMethod }) {
  if (!user.profile) throw new ApiError(400, 'Complete your business details to place an order.');

  const address = await prisma.address.findFirst({ where: { id: addressId, userId: user.id } });
  if (!address) throw new ApiError(400, 'Please choose a delivery address.');

  // Merge duplicate (product, size) lines the client may send.
  const merged = new Map();
  for (const l of lines) {
    const key = `${l.productId}#${l.size ?? ''}`;
    merged.set(key, { ...l, quantity: (merged.get(key)?.quantity ?? 0) + l.quantity });
  }

  const products = await prisma.product.findMany({
    where: { id: { in: [...merged.values()].map((l) => l.productId) }, active: true },
    include: { tiers: { orderBy: { minQty: 'asc' } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const items = [...merged.values()].map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw new ApiError(400, `${l.productId} is no longer available.`);
    if (!p.inStock) throw new ApiError(400, `${p.name} is currently out of stock.`);
    if (l.quantity < p.moq) throw new ApiError(400, `${p.name}: minimum order is ${p.moq} ${p.unit}.`);
    if (l.size && !p.sizes.includes(l.size)) throw new ApiError(400, `${p.name}: size ${l.size} is not available.`);
    if (p.sizes.length && !l.size) throw new ApiError(400, `${p.name}: please choose a size.`);
    return {
      productId: p.id,
      name: p.name,
      image: p.images[0] ?? '',
      unit: p.unit,
      quantity: l.quantity,
      unitPrice: priceFor(p.tiers, l.quantity),
      size: l.size ?? null,
    };
  });

  const { subtotal, gst, total } = totals(items);
  const isCredit = paymentMethod === 'payLater';

  if (isCredit) {
    const available = user.creditLimit - (await outstandingCredit(prisma, user.id));
    if (total > available) {
      throw new ApiError(400, `This order exceeds your available credit of ${inr(available)}. Pay online or reduce the order.`);
    }
  }

  return prisma.$transaction(async (tx) => {
    const id = await nextId(tx, 'SC');
    const invoiceId = await nextId(tx, 'INV');
    const status = isCredit ? 'placed' : 'paymentPending';
    const now = new Date();

    let razorpayOrderId = null;
    if (!isCredit) {
      const rzp = await razorpay.orders.create({
        amount: Number(total),
        currency: 'INR',
        receipt: id,
        notes: { orderId: id, userId: user.id },
      });
      razorpayOrderId = rzp.id;
    }

    const order = await tx.order.create({
      data: {
        id,
        invoiceId,
        userId: user.id,
        paymentMethod,
        status,
        paid: false,
        subtotal,
        gst,
        total,
        address: {
          id: address.id,
          contactName: address.contactName,
          businessName: address.businessName,
          line1: address.line1,
          line2: address.line2,
          city: address.city,
          state: address.state,
          pincode: address.pincode,
          mobile: address.mobile,
          label: address.label,
          isDefault: address.isDefault,
        },
        razorpayOrderId,
        trackingId: `SPK${now.getTime().toString().slice(-8)}`,
        etaStart: addDays(now, 3),
        etaEnd: addDays(now, 7),
        items: { create: items },
        history: { create: { status, note: isCredit ? 'Placed on business credit' : 'Awaiting payment' } },
      },
      include: orderInclude,
    });

    if (isCredit) {
      await notify(tx, user.id, {
        type: 'orderPlaced',
        title: 'Order Placed',
        body: `Order #${id} placed on business credit. Invoice ${invoiceId} is due in 30 days.`,
        orderId: id,
      });
    }

    return {
      order: serializeOrder(order),
      checkout: isCredit ? null : checkoutFor(order, user.profile, razorpayOrderId),
    };
  });
}

/** New Razorpay order for an unpaid order (the previous one expired or failed). */
export async function retryPayment(user, orderId) {
  const order = await prisma.order.findFirst({ where: { id: orderId, userId: user.id }, include: orderInclude });
  if (!order) throw new ApiError(404, 'Order not found.');
  if (order.status !== 'paymentPending') throw new ApiError(400, 'This order is not awaiting payment.');

  const rzp = await razorpay.orders.create({
    amount: Number(order.total),
    currency: 'INR',
    receipt: `${order.id}-${Date.now()}`,
    notes: { orderId: order.id, userId: user.id },
  });
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { razorpayOrderId: rzp.id },
    include: orderInclude,
  });
  return { order: serializeOrder(updated), checkout: checkoutFor(updated, user.profile, rzp.id) };
}
