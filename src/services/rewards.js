// Rewards and credits.
//
// The business has not settled how credits are earned — the CEO proposed a
// daily streak, and purchase-based credits suit a buyer who orders once a week
// — so both are supported and the choice lives in `reward_settings`, editable
// from the admin panel. Every rule starts at zero and the whole feature starts
// switched off, so nothing is earned or redeemed until someone sets real
// numbers.
//
// A balance is always the sum of its ledger, never a column that could drift.
// Every award carries an `eventKey` naming what it was for, so the same order
// or the same day can only ever be credited once, whatever the caller does.
import { prisma } from '../db/prisma.js';
import { ApiError } from '../middleware/error.js';
import { toRupees } from '../utils/money.js';

/** Orders that count as a real, kept purchase. */
const QUALIFYING = ['placed', 'packed', 'dispatched', 'outForDelivery', 'delivered'];

/** The rules, creating the row the first time if it is somehow missing. */
export async function settings() {
  return prisma.rewardSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  });
}

export const serializeSettings = (s) => ({
  mode: s.mode,
  creditsPer100Rupees: s.creditsPer100Rupees,
  creditValue: toRupees(s.creditPaiseValue),
  dailyCheckInCredits: s.dailyCheckInCredits,
  referralCredits: s.referralCredits,
  maxRedeemPercent: s.maxRedeemPercent,
  active: s.active,
  earnsOnPurchase: s.mode === 'purchase' || s.mode === 'both',
  earnsOnCheckIn: s.mode === 'streak' || s.mode === 'both',
});

/** Sum of the ledger. The only definition of a balance there is. */
export async function balance(userId) {
  const agg = await prisma.creditEntry.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  return agg._sum.delta ?? 0;
}

/** Qualifying purchases, in paise: everything not cancelled and not unpaid. */
export async function qualifyingTotal(userId) {
  const agg = await prisma.order.aggregate({
    where: { userId, status: { in: QUALIFYING } },
    _sum: { total: true },
  });
  return agg._sum.total ?? 0n;
}

/**
 * Adds one ledger entry. [eventKey] is what makes it safe to call twice: a
 * repeat is dropped rather than doubling someone's balance.
 * Returns the entry, or null when it had already been recorded.
 */
export async function award(tx, userId, { delta, reason, eventKey, orderId, note = '' }) {
  if (!Number.isInteger(delta) || delta === 0) return null;

  // createMany with skipDuplicates compiles to INSERT ... ON CONFLICT DO
  // NOTHING. Catching the unique violation instead would abort the surrounding
  // transaction in Postgres, taking the caller's other work down with it.
  const { count } = await tx.creditEntry.createMany({
    data: [{ userId, delta, reason, eventKey, orderId, note }],
    skipDuplicates: true,
  });
  if (count === 0) return null; // already credited for this event
  return tx.creditEntry.findUnique({ where: { eventKey } });
}

/**
 * Credits a paid order. Safe to call from the payment path and the reconciler
 * alike — the order's own id is the event key.
 */
export async function creditForOrder(orderId) {
  const rules = await settings();
  if (!rules.active || rules.creditsPer100Rupees <= 0) return null;
  if (rules.mode === 'streak') return null;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, total: true, status: true },
  });
  if (!order || !QUALIFYING.includes(order.status)) return null;

  const hundreds = Number(order.total / 10000n); // paise → whole ₹100 units
  const delta = hundreds * rules.creditsPer100Rupees;
  if (delta <= 0) return null;

  return prisma.$transaction((tx) =>
    award(tx, order.userId, {
      delta,
      reason: 'orderEarned',
      eventKey: `order:${order.id}`,
      orderId: order.id,
      note: `Earned on order ${order.id}`,
    }),
  );
}

/**
 * Takes back the credits an order earned, once it is cancelled. The reversal is
 * its own entry so the history still shows what happened.
 */
export async function reverseOrderCredits(orderId) {
  const earned = await prisma.creditEntry.findUnique({
    where: { eventKey: `order:${orderId}` },
  });
  if (!earned) return null;
  return prisma.$transaction((tx) =>
    award(tx, earned.userId, {
      delta: -earned.delta,
      reason: 'orderReversed',
      eventKey: `order-reversed:${orderId}`,
      orderId,
      note: `Reversed because order ${orderId} was cancelled`,
    }),
  );
}

/** Local calendar day in the business's timezone, as YYYY-MM-DD. */
export function businessDay(at = new Date(), timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The daily check-in. The day is the server's, in the business's timezone, so
 * changing the phone's clock earns nothing.
 * Returns { credited, balance, streak }.
 */
export async function checkIn(userId) {
  const rules = await settings();
  if (!rules.active || rules.mode === 'purchase' || rules.dailyCheckInCredits <= 0) {
    throw new ApiError(400, 'Daily check-in is not switched on.');
  }

  const today = businessDay();
  const entry = await prisma.$transaction((tx) =>
    award(tx, userId, {
      delta: rules.dailyCheckInCredits,
      reason: 'dailyCheckIn',
      eventKey: `checkin:${userId}:${today}`,
      note: `Check-in for ${today}`,
    }),
  );

  return {
    credited: entry ? rules.dailyCheckInCredits : 0,
    alreadyCheckedIn: entry == null,
    balance: await balance(userId),
    streak: await currentStreak(userId),
  };
}

/** Consecutive days up to today on which this buyer checked in. */
export async function currentStreak(userId) {
  const entries = await prisma.creditEntry.findMany({
    where: { userId, reason: 'dailyCheckIn' },
    orderBy: { createdAt: 'desc' },
    take: 400,
    select: { eventKey: true },
  });
  const days = new Set(entries.map((e) => e.eventKey.split(':').pop()));
  if (days.size === 0) return 0;

  let streak = 0;
  const cursor = new Date();
  // Today may not be claimed yet, which does not break yesterday's streak.
  if (!days.has(businessDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(businessDay(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * Grants every tier this buyer's purchases have passed. Each grant is unique
 * per buyer per tier, so refreshing the screen cannot claim a gift twice.
 */
export async function syncTiers(userId) {
  const total = await qualifyingTotal(userId);
  const tiers = await prisma.rewardTier.findMany({
    where: { active: true, threshold: { lte: total } },
  });
  if (tiers.length === 0) return [];

  const { count } = await prisma.rewardClaim.createMany({
    data: tiers.map((tier) => ({ userId, tierId: tier.id, totalAtClaim: total })),
    skipDuplicates: true,
  });
  if (count === 0) return [];
  return prisma.rewardClaim.findMany({
    where: { userId, tierId: { in: tiers.map((t) => t.id) } },
  });
}

/** Everything the Rewards screen needs, in one call. */
export async function rewardsFor(userId) {
  const rules = await settings();
  if (!rules.active) {
    return { active: false, settings: serializeSettings(rules) };
  }

  await syncTiers(userId);

  const [total, credits, tiers, claims, streak] = await Promise.all([
    qualifyingTotal(userId),
    balance(userId),
    prisma.rewardTier.findMany({
      where: { active: true },
      orderBy: [{ threshold: 'asc' }, { sortOrder: 'asc' }],
    }),
    prisma.rewardClaim.findMany({ where: { userId } }),
    currentStreak(userId),
  ]);

  const claimed = new Map(claims.map((c) => [c.tierId, c]));
  const next = tiers.find((t) => t.threshold > total) ?? null;

  return {
    active: true,
    settings: serializeSettings(rules),
    balance: credits,
    creditsWorth: toRupees(credits * rules.creditPaiseValue),
    purchasedTotal: toRupees(total),
    streak,
    checkedInToday: await hasCheckedInToday(userId),
    nextTier: next
      ? {
          id: next.id,
          name: next.name,
          giftLabel: next.giftLabel,
          threshold: toRupees(next.threshold),
          remaining: toRupees(next.threshold - total),
          progress: Number((Number(total) / Number(next.threshold)).toFixed(4)),
        }
      : null,
    tiers: tiers.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      giftLabel: t.giftLabel,
      imageUrl: t.imageUrl,
      threshold: toRupees(t.threshold),
      reached: total >= t.threshold,
      status: claimed.get(t.id)?.status ?? null,
    })),
  };
}

async function hasCheckedInToday(userId) {
  const entry = await prisma.creditEntry.findUnique({
    where: { eventKey: `checkin:${userId}:${businessDay()}` },
  });
  return entry != null;
}

/** The buyer's own ledger, newest first. */
export async function ledger(userId, { offset = 0, limit = 25 } = {}) {
  const [rows, total] = await Promise.all([
    prisma.creditEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.creditEntry.count({ where: { userId } }),
  ]);
  return {
    entries: rows.map((r) => ({
      id: String(r.id),
      delta: r.delta,
      reason: r.reason,
      note: r.note,
      orderId: r.orderId,
      at: r.createdAt.toISOString(),
    })),
    total,
    offset,
    limit,
    balance: await balance(userId),
  };
}

/**
 * The most credits that may be spent on an order of [orderPaise], and what that
 * is worth. Capped by the balance, by the configured percentage of the order,
 * and by whole credits — a buyer can never spend more than they hold or take an
 * order below what the rules allow.
 */
export async function redeemable(userId, orderPaise) {
  const rules = await settings();
  if (!rules.active || rules.creditPaiseValue <= 0 || rules.maxRedeemPercent <= 0) {
    return { credits: 0, value: 0 };
  }
  const held = await balance(userId);
  if (held <= 0) return { credits: 0, value: 0 };

  const capPaise = (BigInt(orderPaise) * BigInt(rules.maxRedeemPercent)) / 100n;
  const capCredits = Number(capPaise / BigInt(rules.creditPaiseValue));
  const credits = Math.max(0, Math.min(held, capCredits));
  return { credits, value: toRupees(credits * rules.creditPaiseValue) };
}

/** Spends credits against an order. Refuses rather than overdrawing. */
export async function redeem(userId, orderId, credits, orderPaise) {
  const allowed = await redeemable(userId, orderPaise);
  if (credits <= 0) return null;
  if (credits > allowed.credits) {
    throw new ApiError(400, `You can use up to ${allowed.credits} credits on this order.`);
  }
  return prisma.$transaction(async (tx) => {
    const entry = await award(tx, userId, {
      delta: -credits,
      reason: 'redeemed',
      eventKey: `redeem:${orderId}`,
      orderId,
      note: `Used on order ${orderId}`,
    });
    // The balance is re-read inside the transaction, so two taps cannot both
    // spend the same credits.
    const agg = await tx.creditEntry.aggregate({ where: { userId }, _sum: { delta: true } });
    if ((agg._sum.delta ?? 0) < 0) {
      throw new ApiError(400, 'That would spend more credits than you have.');
    }
    return entry;
  });
}
