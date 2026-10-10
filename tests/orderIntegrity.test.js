// The order and payment path. These exist because each one was a real hole:
// concurrent orders could go past a credit limit, a short payment would have
// marked an order paid, and money arriving after an order expired left the
// buyer having paid for nothing.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { placeOrder, outstandingCredit } from '../src/services/orders.js';
import { markCaptured } from '../src/services/payments.js';

let user;
let address;
let product;
let lineTotal;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { mobile: '9700000003' } });
  user = await prisma.user.create({
    data: {
      mobile: '9700000003',
      creditLimit: 100000n,
      profile: {
        create: {
          businessName: 'Integrity Test', gstin: '27AAPFU0939F1ZV',
          businessType: 'academy', contactName: 'QA',
          mobile: '9700000003', email: 'i@x.test',
        },
      },
      addresses: {
        create: {
          contactName: 'QA', line1: 'Test', city: 'Pune',
          state: 'Maharashtra', pincode: '411001', mobile: '9700000003',
        },
      },
    },
    include: { profile: true, addresses: true },
  });
  address = user.addresses[0];

  const all = await prisma.product.findMany({
    where: { active: true, inStock: true },
    include: { tiers: { orderBy: { minQty: 'asc' } } },
  });
  all.sort((a, b) => Number(a.tiers[0].unitPrice) * a.moq - Number(b.tiers[0].unitPrice) * b.moq);
  product = all[0];
  lineTotal = BigInt(Math.round(Number(product.tiers[0].unitPrice) * product.moq * 1.18));
});

afterEach(async () => {
  const orders = await prisma.order.findMany({ where: { userId: user.id }, select: { id: true } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await prisma.order.deleteMany({ where: { userId: user.id } });
  await prisma.creditEntry.deleteMany({ where: { userId: user.id } });
  await prisma.notification.deleteMany({ where: { userId: user.id } });
});

afterAll(async () => {
  await prisma.address.deleteMany({ where: { userId: user.id } });
  await prisma.businessProfile.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
});

const body = () => ({
  lines: [{
    productId: product.id,
    quantity: product.moq,
    ...(product.sizes.length ? { size: product.sizes[0] } : {}),
  }],
  addressId: address.id,
  paymentMethod: 'payLater',
});

describe('credit limit', () => {
  it('holds when several orders are placed at the same moment', async () => {
    // Room for two of these, not five.
    const limit = lineTotal * 5n / 2n;
    await prisma.user.update({ where: { id: user.id }, data: { creditLimit: limit } });
    const buyer = await prisma.user.findUnique({ where: { id: user.id }, include: { profile: true } });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => placeOrder(buyer, body())),
    );
    const placed = results.filter((r) => r.status === 'fulfilled').length;
    const used = await outstandingCredit(prisma, user.id);

    expect(placed).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(limit);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(5 - placed);
  });

  it('refuses an order that does not fit at all', async () => {
    await prisma.user.update({ where: { id: user.id }, data: { creditLimit: 1n } });
    const buyer = await prisma.user.findUnique({ where: { id: user.id }, include: { profile: true } });
    await expect(placeOrder(buyer, body())).rejects.toThrow(/available credit/i);
    await prisma.user.update({ where: { id: user.id }, data: { creditLimit: 100000n } });
  });
});

describe('a payment arriving', () => {
  async function order(status, paid = false) {
    const id = `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return prisma.order.create({
      data: {
        id, invoiceId: `INV-${id}`, userId: user.id, paymentMethod: 'razorpay',
        status, paid, subtotal: 100000n, gst: 18000n, total: 118000n,
        address: {}, etaStart: new Date(), etaEnd: new Date(),
        razorpayOrderId: `order_${id}`,
      },
    });
  }

  it('for the full amount places the order', async () => {
    const o = await order('paymentPending');
    await markCaptured({ order: o, razorpayPaymentId: `pay_${o.id}`, amount: 118000n, method: 'upi', raw: {}, source: 'test' });
    const after = await prisma.order.findUnique({ where: { id: o.id } });
    expect(after.paid).toBe(true);
    expect(after.status).toBe('placed');
  });

  it('for less than the total does NOT place it, and is flagged', async () => {
    const o = await order('paymentPending');
    await markCaptured({ order: o, razorpayPaymentId: `pay_${o.id}`, amount: 50000n, method: 'upi', raw: {}, source: 'test' });
    const after = await prisma.order.findUnique({ where: { id: o.id }, include: { history: true } });
    expect(after.paid).toBe(false);
    expect(after.status).toBe('paymentPending');
    expect(after.history.some((h) => h.note?.includes('Part payment'))).toBe(true);
  });

  it('after the order expired brings it back rather than losing the money', async () => {
    const o = await order('cancelled');
    await markCaptured({ order: o, razorpayPaymentId: `pay_${o.id}`, amount: 118000n, method: 'upi', raw: {}, source: 'webhook' });
    const after = await prisma.order.findUnique({ where: { id: o.id }, include: { history: true } });
    expect(after.paid).toBe(true);
    expect(after.status).toBe('placed');
    expect(after.history.some((h) => h.note?.includes('reinstated'))).toBe(true);
  });

  it('twice counts once', async () => {
    const o = await order('paymentPending');
    const args = { order: o, razorpayPaymentId: `pay_${o.id}`, amount: 118000n, method: 'upi', raw: {}, source: 'test' };
    await markCaptured(args);
    await markCaptured(args);
    await markCaptured(args);
    const payments = await prisma.payment.count({ where: { orderId: o.id } });
    expect(payments).toBe(1);
  });
});
