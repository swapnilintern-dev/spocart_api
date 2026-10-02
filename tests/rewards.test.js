// Rewards and credits. These run against the local database and clean up after
// themselves, so they can be run repeatedly.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import {
  settings, award, balance, businessDay, checkIn, currentStreak,
  creditForOrder, reverseOrderCredits, redeemable, redeem, syncTiers, rewardsFor,
} from '../src/services/rewards.js';

let userId;
let tierId;

const rules = (over = {}) => prisma.rewardSettings.update({
  where: { id: 'default' },
  data: {
    mode: 'both', creditsPer100Rupees: 2, creditPaiseValue: 25,
    dailyCheckInCredits: 10, maxRedeemPercent: 10, active: true, ...over,
  },
});

beforeAll(async () => {
  const user = await prisma.user.create({ data: { mobile: '9000000001' } });
  userId = user.id;
  const tier = await prisma.rewardTier.create({
    data: { name: 'Test Silver', threshold: 100000n, giftLabel: 'Test kit bag' },
  });
  tierId = tier.id;
});

afterAll(async () => {
  await prisma.creditEntry.deleteMany({ where: { userId } });
  await prisma.rewardClaim.deleteMany({ where: { userId } });
  await prisma.rewardTier.delete({ where: { id: tierId } }).catch(() => null);
  await prisma.user.delete({ where: { id: userId } }).catch(() => null);
  await prisma.rewardSettings.update({
    where: { id: 'default' },
    data: {
      mode: 'purchase', creditsPer100Rupees: 0, creditPaiseValue: 0,
      dailyCheckInCredits: 0, referralCredits: 0, maxRedeemPercent: 0, active: false,
    },
  });
});

beforeEach(async () => {
  await prisma.creditEntry.deleteMany({ where: { userId } });
  await prisma.rewardClaim.deleteMany({ where: { userId } });
  await rules();
});

describe('credits ledger', () => {
  it('a balance is the sum of its entries', async () => {
    expect(await balance(userId)).toBe(0);
    await prisma.$transaction((tx) => award(tx, userId, { delta: 30, reason: 'adminAdjust', eventKey: `t1:${userId}` }));
    await prisma.$transaction((tx) => award(tx, userId, { delta: -12, reason: 'redeemed', eventKey: `t2:${userId}` }));
    expect(await balance(userId)).toBe(18);
  });

  it('the same event can only ever be credited once', async () => {
    const key = `same:${userId}`;
    const first = await prisma.$transaction((tx) => award(tx, userId, { delta: 50, reason: 'adminAdjust', eventKey: key }));
    const second = await prisma.$transaction((tx) => award(tx, userId, { delta: 50, reason: 'adminAdjust', eventKey: key }));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await balance(userId)).toBe(50);
  });

  it('a duplicate award does not poison the transaction around it', async () => {
    const key = `tx:${userId}`;
    await prisma.$transaction((tx) => award(tx, userId, { delta: 5, reason: 'adminAdjust', eventKey: key }));
    // The second award is a no-op; the work after it must still run.
    const after = await prisma.$transaction(async (tx) => {
      await award(tx, userId, { delta: 5, reason: 'adminAdjust', eventKey: key });
      return tx.creditEntry.aggregate({ where: { userId }, _sum: { delta: true } });
    });
    expect(after._sum.delta).toBe(5);
  });
});

describe('daily check-in', () => {
  it('earns once a day, however many times it is tapped', async () => {
    const first = await checkIn(userId);
    expect(first.credited).toBe(10);
    expect(first.alreadyCheckedIn).toBe(false);

    for (let i = 0; i < 3; i++) {
      const again = await checkIn(userId);
      expect(again.credited).toBe(0);
      expect(again.alreadyCheckedIn).toBe(true);
    }
    expect(await balance(userId)).toBe(10);
  });

  it('uses the server\'s day, so a phone clock cannot earn extra', async () => {
    await checkIn(userId);
    const entry = await prisma.creditEntry.findFirst({ where: { userId, reason: 'dailyCheckIn' } });
    expect(entry.eventKey.endsWith(businessDay())).toBe(true);
  });

  it('counts consecutive days', async () => {
    expect(await currentStreak(userId)).toBe(0);
    await checkIn(userId);
    expect(await currentStreak(userId)).toBe(1);

    // Yesterday, written directly: the streak reads the ledger, not a counter.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await prisma.creditEntry.create({
      data: {
        userId, delta: 10, reason: 'dailyCheckIn',
        eventKey: `checkin:${userId}:${businessDay(yesterday)}`,
      },
    });
    expect(await currentStreak(userId)).toBe(2);
  });

  it('is refused while the programme is off', async () => {
    await rules({ active: false });
    await expect(checkIn(userId)).rejects.toThrow(/not switched on/i);
  });
});

describe('credits from orders', () => {
  let orderId;

  beforeEach(async () => {
    const address = { contactName: 'QA', line1: 'Test', city: 'Pune', state: 'Maharashtra', pincode: '411001', mobile: '9000000001' };
    const order = await prisma.order.create({
      data: {
        id: `TEST-${Date.now()}`, userId, status: 'placed', paymentMethod: 'razorpay',
        paid: true, subtotal: 100000n, gst: 18000n, total: 118000n,
        address, invoiceId: `INV-TEST-${Date.now()}`,
        etaStart: new Date(), etaEnd: new Date(),
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId } });
  });

  it('credits a paid order once, however many times the payment is confirmed', async () => {
    // ₹1,180 → 11 whole hundreds × 2 credits.
    expect((await creditForOrder(orderId))?.delta).toBe(22);
    expect(await creditForOrder(orderId)).toBeNull();
    expect(await creditForOrder(orderId)).toBeNull();
    expect(await balance(userId)).toBe(22);
  });

  it('takes the credits back when the order is cancelled, once', async () => {
    await creditForOrder(orderId);
    expect((await reverseOrderCredits(orderId))?.delta).toBe(-22);
    expect(await reverseOrderCredits(orderId)).toBeNull();
    expect(await balance(userId)).toBe(0);
  });

  it('credits nothing while the programme is off', async () => {
    await rules({ active: false });
    expect(await creditForOrder(orderId)).toBeNull();
    expect(await balance(userId)).toBe(0);
  });

  it('credits nothing in streak-only mode', async () => {
    await rules({ mode: 'streak' });
    expect(await creditForOrder(orderId)).toBeNull();
  });
});

describe('redeeming', () => {
  it('is capped by the balance and by the order percentage', async () => {
    await prisma.$transaction((tx) => award(tx, userId, { delta: 1000, reason: 'adminAdjust', eventKey: `big:${userId}` }));
    // ₹500 order, 10% cap = ₹50, at ₹0.25 a credit = 200 credits.
    const allowed = await redeemable(userId, 50000);
    expect(allowed.credits).toBe(200);
    expect(allowed.value).toBe(50);
  });

  it('refuses to spend more than is allowed', async () => {
    await prisma.$transaction((tx) => award(tx, userId, { delta: 100, reason: 'adminAdjust', eventKey: `small:${userId}` }));
    const allowed = await redeemable(userId, 50000);
    await expect(redeem(userId, 'ORDER-X', allowed.credits + 1, 50000)).rejects.toThrow(/up to/i);
    expect(await balance(userId)).toBe(100);
  });

  it('spends once per order', async () => {
    await prisma.$transaction((tx) => award(tx, userId, { delta: 100, reason: 'adminAdjust', eventKey: `once:${userId}` }));
    expect((await redeem(userId, 'ORDER-Y', 20, 50000))?.delta).toBe(-20);
    expect(await redeem(userId, 'ORDER-Y', 20, 50000)).toBeNull();
    expect(await balance(userId)).toBe(80);
  });

  it('offers nothing while the programme is off', async () => {
    await rules({ active: false });
    expect((await redeemable(userId, 50000)).credits).toBe(0);
  });
});

describe('gift tiers', () => {
  it('a tier is earned once, however often it is synced', async () => {
    await prisma.order.create({
      data: {
        id: `TIER-${Date.now()}`, userId, status: 'delivered', paymentMethod: 'razorpay',
        paid: true, subtotal: 200000n, gst: 0n, total: 200000n,
        address: {}, invoiceId: `INV-TIER-${Date.now()}`,
        etaStart: new Date(), etaEnd: new Date(),
      },
    });
    await syncTiers(userId);
    await syncTiers(userId);
    await syncTiers(userId);
    const claims = await prisma.rewardClaim.findMany({ where: { userId, tierId } });
    expect(claims.length).toBe(1);
    await prisma.order.deleteMany({ where: { userId } });
  });

  it('the screen says nothing at all while the programme is off', async () => {
    await rules({ active: false });
    const view = await rewardsFor(userId);
    expect(view.active).toBe(false);
    expect(view.balance).toBeUndefined();
    expect(view.tiers).toBeUndefined();
  });
});
