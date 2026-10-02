// Usage analytics.
//
// Two kinds of number live here and they are never mixed:
//
//   • Counts of what people did — active users, the cart funnel, which products
//     get looked at. These come from `usage_events`, which the app reports. They
//     are estimates: an event can be lost offline or sent twice from a flaky
//     connection, and they are labelled as estimates wherever they are returned.
//
//   • Money. Always read from `orders`, never from an event. A sales figure is
//     an accounting fact and cannot depend on whether a phone's report arrived.
//
// Nothing a buyer typed is stored. A search records how long the query was and
// whether it matched, so "people search for things we do not stock" is
// answerable without keeping anyone's words.
import { prisma } from '../db/prisma.js';

const EVENT_NAMES = new Set([
  'appOpen', 'productView', 'search', 'addToCart', 'checkoutStart', 'orderPlaced',
]);

/** Orders that count as a sale. Cancelled and unpaid are not. */
const SOLD = ['placed', 'packed', 'dispatched', 'outForDelivery', 'delivered'];

const TZ = 'Asia/Kolkata';

/** The business day an instant belongs to, as YYYY-MM-DD. */
export function day(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * Stores a batch the app reported. Anything unrecognised is dropped rather than
 * stored, so a future app version cannot write junk into the table, and only
 * the counts in `meta` are kept.
 */
export async function record(events, { user, deviceId, platform }) {
  if (!Array.isArray(events) || events.length === 0) return { stored: 0 };

  const rows = [];
  for (const event of events.slice(0, 100)) {
    if (!EVENT_NAMES.has(event?.name)) continue;
    const at = Number.isFinite(Date.parse(event.at ?? '')) ? new Date(event.at) : new Date();
    rows.push({
      name: event.name,
      userId: user?.id ?? null,
      deviceId,
      platform: String(platform ?? '').slice(0, 32),
      productId: typeof event.productId === 'string' ? event.productId.slice(0, 64) : null,
      orderId: typeof event.orderId === 'string' ? event.orderId.slice(0, 64) : null,
      meta: safeMeta(event.meta),
      at,
      day: day(at),
    });
  }
  if (rows.length === 0) return { stored: 0 };

  const { count } = await prisma.usageEvent.createMany({ data: rows });
  return { stored: count };
}

/**
 * Keeps only whole numbers under known keys. This is what stops a query, a name
 * or a phone number ever reaching the table, whatever a client sends.
 */
function safeMeta(meta) {
  const allowed = ['results', 'queryLength', 'quantity', 'position'];
  const out = {};
  if (meta && typeof meta === 'object') {
    for (const key of allowed) {
      const value = meta[key];
      if (Number.isFinite(value)) out[key] = Math.trunc(value);
    }
  }
  return out;
}

/**
 * Daily and monthly active users, and the ratio between them — how many of the
 * people who use SPOCART in a month use it on any given day.
 *
 * Counted by device, so one buyer on a phone and a tablet is two; and by signed-
 * in user as well, which is the number worth quoting to the business.
 */
export async function activeUsers({ days = 30 } = {}) {
  const since = daysAgo(days);
  const today = day();
  const monthStart = daysAgo(30);

  const [dauDevices, dauUsers, mauDevices, mauUsers, perDay] = await Promise.all([
    prisma.usageEvent.findMany({ where: { day: today }, distinct: ['deviceId'], select: { deviceId: true } }),
    prisma.usageEvent.findMany({ where: { day: today, userId: { not: null } }, distinct: ['userId'], select: { userId: true } }),
    prisma.usageEvent.findMany({ where: { at: { gte: monthStart } }, distinct: ['deviceId'], select: { deviceId: true } }),
    prisma.usageEvent.findMany({ where: { at: { gte: monthStart }, userId: { not: null } }, distinct: ['userId'], select: { userId: true } }),
    prisma.$queryRaw`
      SELECT "day", COUNT(DISTINCT "device_id")::int AS devices,
             COUNT(DISTINCT "user_id")::int AS users
      FROM "usage_events" WHERE "at" >= ${since}
      GROUP BY "day" ORDER BY "day" ASC`,
  ]);

  const dau = dauDevices.length;
  const mau = mauDevices.length;
  return {
    estimate: true, // reported by the app, not an accounting figure
    windowDays: days,
    dau,
    mau,
    dauUsers: dauUsers.length,
    mauUsers: mauUsers.length,
    stickiness: mau === 0 ? 0 : Number((dau / mau).toFixed(3)),
    perDay,
  };
}

/**
 * How many people who opened the app went on to look, add, start checkout and
 * order. Counted by device so an anonymous browser is not lost.
 */
export async function funnel({ days = 30 } = {}) {
  const since = daysAgo(days);
  const steps = ['appOpen', 'productView', 'addToCart', 'checkoutStart', 'orderPlaced'];

  const counts = await Promise.all(
    steps.map(async (name) => {
      const rows = await prisma.usageEvent.findMany({
        where: { name, at: { gte: since } },
        distinct: ['deviceId'],
        select: { deviceId: true },
      });
      return rows.length;
    }),
  );

  const opened = counts[0] || 0;
  return {
    estimate: true,
    windowDays: days,
    steps: steps.map((name, i) => ({
      step: name,
      devices: counts[i],
      // Of everyone who opened the app, how many reached this step.
      ofOpened: opened === 0 ? 0 : Number((counts[i] / opened).toFixed(3)),
      // And how many of the previous step carried on to this one.
      ofPrevious: i === 0 || counts[i - 1] === 0
        ? 1
        : Number((counts[i] / counts[i - 1]).toFixed(3)),
    })),
  };
}

/** Which products get looked at, and how often that turns into a cart line. */
export async function productInterest({ days = 30, limit = 20 } = {}) {
  const since = daysAgo(days);
  const [views, adds] = await Promise.all([
    prisma.usageEvent.groupBy({
      by: ['productId'],
      where: { name: 'productView', at: { gte: since }, productId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { productId: 'desc' } },
      take: limit,
    }),
    prisma.usageEvent.groupBy({
      by: ['productId'],
      where: { name: 'addToCart', at: { gte: since }, productId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  if (views.length === 0) return { estimate: true, windowDays: days, products: [] };

  const addsBy = new Map(adds.map((a) => [a.productId, a._count._all]));
  const products = await prisma.product.findMany({
    where: { id: { in: views.map((v) => v.productId) } },
    select: { id: true, name: true, inStock: true },
  });
  const nameBy = new Map(products.map((p) => [p.id, p]));

  return {
    estimate: true,
    windowDays: days,
    products: views.map((v) => {
      const added = addsBy.get(v.productId) ?? 0;
      return {
        productId: v.productId,
        name: nameBy.get(v.productId)?.name ?? v.productId,
        inStock: nameBy.get(v.productId)?.inStock ?? false,
        views: v._count._all,
        addedToCart: added,
        addRate: v._count._all === 0 ? 0 : Number((added / v._count._all).toFixed(3)),
      };
    }),
  };
}

/** How often searches come back empty — what buyers want and we do not stock. */
export async function searchHealth({ days = 30 } = {}) {
  const since = daysAgo(days);
  const rows = await prisma.usageEvent.findMany({
    where: { name: 'search', at: { gte: since } },
    select: { meta: true },
    take: 5000,
  });
  const total = rows.length;
  const empty = rows.filter((r) => (r.meta?.results ?? 0) === 0).length;
  return {
    estimate: true,
    windowDays: days,
    searches: total,
    withNoResults: empty,
    emptyRate: total === 0 ? 0 : Number((empty / total).toFixed(3)),
    // The queries themselves are not stored, so this says how often buyers
    // find nothing — never what they were looking for.
    note: 'Search text is not stored.',
  };
}

/**
 * Sales. Read from `orders`, never from an event: this is an accounting figure,
 * so it must not depend on whether a phone's report arrived.
 */
export async function salesReport({ from, to } = {}) {
  const start = from ? new Date(from) : daysAgo(30);
  const end = to ? new Date(to) : new Date();

  const where = { status: { in: SOLD }, placedAt: { gte: start, lte: end } };
  const [agg, byDay, buyers] = await Promise.all([
    prisma.order.aggregate({ where, _sum: { subtotal: true, gst: true, total: true }, _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT to_char("placed_at" AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS orders,
             SUM("total")::bigint AS total
      FROM "orders"
      WHERE "status" = ANY(${SOLD}::"OrderStatus"[])
        AND "placed_at" BETWEEN ${start} AND ${end}
      GROUP BY 1 ORDER BY 1 ASC`,
    prisma.order.findMany({ where, distinct: ['userId'], select: { userId: true } }),
  ]);

  const orders = agg._count._all;
  const total = agg._sum.total ?? 0n;
  return {
    estimate: false, // read from the orders themselves
    from: start.toISOString(),
    to: end.toISOString(),
    orders,
    buyers: buyers.length,
    subtotal: Number(agg._sum.subtotal ?? 0n) / 100,
    gst: Number(agg._sum.gst ?? 0n) / 100,
    total: Number(total) / 100,
    averageOrder: orders === 0 ? 0 : Number((Number(total) / 100 / orders).toFixed(2)),
    byDay: byDay.map((d) => ({ day: d.day, orders: d.orders, total: Number(d.total) / 100 })),
  };
}

/**
 * Who is ordering and who has gone quiet — the list the sales team can act on.
 * Read from orders, so it is a fact rather than an estimate.
 */
export async function buyerActivity({ quietDays = 45, limit = 50 } = {}) {
  const cutoff = daysAgo(quietDays);
  const rows = await prisma.order.groupBy({
    by: ['userId'],
    where: { status: { in: SOLD } },
    _count: { _all: true },
    _sum: { total: true },
    _max: { placedAt: true },
  });
  if (rows.length === 0) return { quietDays, buyers: [] };

  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true, mobile: true, profile: { select: { businessName: true } } },
  });
  const by = new Map(users.map((u) => [u.id, u]));

  return {
    quietDays,
    buyers: rows
      .map((r) => ({
        userId: r.userId,
        business: by.get(r.userId)?.profile?.businessName ?? '',
        mobile: by.get(r.userId)?.mobile ?? '',
        orders: r._count._all,
        spent: Number(r._sum.total ?? 0n) / 100,
        lastOrderAt: r._max.placedAt?.toISOString() ?? null,
        quiet: r._max.placedAt != null && r._max.placedAt < cutoff,
      }))
      .sort((a, b) => b.spent - a.spent)
      .slice(0, limit),
  };
}
