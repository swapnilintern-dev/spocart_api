// Account deletion. The point of these tests is the balance the feature has to
// strike: everything personal goes, the account can never be used again, and
// the GST invoice survives — because those records must be kept for years even
// after the buyer has left. Runs against the local database and cleans up
// after itself, so it can be run repeatedly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { deleteAccount } from '../src/services/auth.js';

const MOBILE = '9000000731';

let user;

/// A buyer with everything a real one accumulates: profile, address, an order
/// with its invoice, a device token, a notification and a pending OTP.
beforeEach(async () => {
  await prisma.user.deleteMany({ where: { mobile: MOBILE } });
  user = await prisma.user.create({
    data: {
      mobile: MOBILE,
      profile: {
        create: {
          businessName: 'Test Sports House',
          gstin: '20ABCDE1234F1Z5',
          businessType: 'retailer',
          contactName: 'Test Buyer',
          mobile: MOBILE,
          email: 'test.buyer@example.invalid',
        },
      },
      addresses: {
        create: {
          contactName: 'Test Buyer',
          line1: 'MG Road',
          city: 'Ranchi',
          state: 'Jharkhand',
          pincode: '834001',
          mobile: MOBILE,
        },
      },
      devices: { create: { token: `tok-${Date.now()}`, platform: 'android' } },
      notifications: {
        create: { type: 'orderPlaced', title: 'Order placed', body: 'SC-TEST' },
      },
    },
    include: { profile: true },
  });

  await prisma.otpCode.deleteMany({ where: { mobile: MOBILE } });
  await prisma.otpCode.create({
    data: {
      mobile: MOBILE,
      purpose: 'login',
      codeHash: 'x',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  await prisma.order.create({
    data: {
      id: `SC-TEST-${Date.now()}`,
      invoiceId: `INV-TEST-${Date.now()}`,
      userId: user.id,
      paymentMethod: 'payLater',
      status: 'placed',
      paid: false,
      subtotal: 24000n,
      gst: 4320n,
      total: 28320n,
      address: {
        city: 'Ranchi',
        state: 'Jharkhand',
        contactName: 'Test Buyer',
        mobile: MOBILE,
      },
      trackingId: 'SPKTEST',
      etaStart: new Date(),
      etaEnd: new Date(),
    },
  });

  await prisma.quote.create({
    data: {
      id: `QT-TEST-${Date.now()}`,
      userId: user.id,
      kind: 'bulk',
      notes: 'Need 50 jerseys with our school crest',
      contactName: 'Test Buyer',
      contactMobile: MOBILE,
      // Not a real asset; deleteFile swallows a miss, which is the point.
      designFileUrl: 'spocart/quotes/test-artwork',
    },
  });

  await prisma.lead.create({
    data: {
      name: 'Test Buyer',
      mobile: MOBILE,
      email: 'test.buyer@example.invalid',
      message: 'Please call me about bulk footballs',
    },
  });
});

afterEach(async () => {
  const rows = await prisma.order.findMany({ where: { userId: user.id } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: rows.map((o) => o.id) } } });
  await prisma.order.deleteMany({ where: { userId: user.id } });
  await prisma.quoteItem.deleteMany({ where: { quote: { userId: user.id } } });
  await prisma.quote.deleteMany({ where: { userId: user.id } });
  await prisma.lead.deleteMany({ where: { mobile: MOBILE } });
  await prisma.otpCode.deleteMany({ where: { mobile: MOBILE } });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => null);
});

describe('deleteAccount', () => {
  it('removes every personal record the buyer gave us', async () => {
    await deleteAccount(user);

    expect(await prisma.businessProfile.findUnique({ where: { userId: user.id } })).toBeNull();
    expect(await prisma.address.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.deviceToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.otpCode.count({ where: { mobile: MOBILE } })).toBe(0);
  });

  it('removes quotations, their artwork and any enquiry they sent', async () => {
    await deleteAccount(user);

    expect(await prisma.quote.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.lead.count({ where: { mobile: MOBILE } })).toBe(0);
  });

  it('keeps the order and its invoice, because GST records must survive', async () => {
    await deleteAccount(user);

    const orders = await prisma.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].invoiceId).toMatch(/^INV-TEST-/);
    expect(orders[0].total).toBe(28320n);
  });

  it('keeps what the invoice legally needs and drops what it does not', async () => {
    await deleteAccount(user);

    const [order] = await prisma.order.findMany({ where: { userId: user.id } });
    // A GST invoice must show who it was billed to and where it went.
    expect(order.address.contactName).toBe('Test Buyer');
    expect(order.address.city).toBe('Ranchi');
    expect(order.address.state).toBe('Jharkhand');
    // The phone number is not part of that, so it goes.
    expect(order.address.mobile).toBeUndefined();
  });

  it('retires the mobile so it can never sign in again', async () => {
    await deleteAccount(user);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.mobile).not.toBe(MOBILE);
    // Indian mobiles start 6-9, so a leading zero can never be dialled or
    // registered — and it is exactly the 10 characters the column holds.
    expect(after.mobile).toMatch(/^0\d{9}$/);
  });

  it('signs every device out and closes the credit line', async () => {
    const before = user.tokenVersion;
    await deleteAccount(user);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.tokenVersion).toBe(before + 1);
    expect(after.creditLimit).toBe(0n);
  });

  it('frees the number for a fresh account with none of the old history', async () => {
    await deleteAccount(user);

    const reused = await prisma.user.create({ data: { mobile: MOBILE } });
    try {
      expect(reused.id).not.toBe(user.id);
      expect(await prisma.order.count({ where: { userId: reused.id } })).toBe(0);
      expect(await prisma.businessProfile.findUnique({ where: { userId: reused.id } })).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: reused.id } });
    }
  });
});
