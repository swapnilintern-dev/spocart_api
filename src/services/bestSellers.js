// Best sellers, counted from real order lines.
//
// Only orders that actually count as business are included: cancelled ones and
// orders still waiting for payment are left out, so an abandoned checkout can
// never push a product up the list. Admins can pin a product (featuredRank) —
// a new launch has no sales history and could never rank on its own.
import { prisma } from '../db/prisma.js';

/** Order states that represent a real sale. */
const SOLD_STATUSES = ['placed', 'packed', 'dispatched', 'outForDelivery', 'delivered'];

const WINDOW_DAYS = 30;

/// Ranking the whole catalogue is a single grouped query, but it runs on every
/// home-screen open, so the result is held briefly in process.
const TTL_MS = 10 * 60_000;
let cached = null;

export function clearBestSellerCache() {
  cached = null;
}

/**
 * Product ids in rank order: pinned products first (by featuredRank), then the
 * rest by units sold in the last 30 days. Products with no sales are not
 * included — the caller decides what to show when the list is short.
 */
export async function bestSellerIds({ limit = 10 } = {}) {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.ids.slice(0, limit);

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60_000);

  const [sold, pinned] = await Promise.all([
    prisma.orderItem.groupBy({
      by: ['productId'],
      where: { order: { placedAt: { gte: since }, status: { in: SOLD_STATUSES } } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 50,
    }),
    prisma.product.findMany({
      where: { featuredRank: { not: null }, active: true },
      orderBy: { featuredRank: 'asc' },
      select: { id: true },
    }),
  ]);

  // A pinned product keeps its place even if it also sold well.
  const ids = [...pinned.map((p) => p.id)];
  for (const row of sold) {
    if (!ids.includes(row.productId)) ids.push(row.productId);
  }

  // Drop anything that is no longer on sale.
  const live = await prisma.product.findMany({
    where: { id: { in: ids }, active: true },
    select: { id: true },
  });
  const liveIds = new Set(live.map((p) => p.id));
  const ordered = ids.filter((id) => liveIds.has(id));

  cached = { at: Date.now(), ids: ordered };
  return ordered.slice(0, limit);
}

/** Units sold per product in the window — used by the admin report. */
export async function bestSellerReport({ limit = 25 } = {}) {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60_000);
  const sold = await prisma.orderItem.groupBy({
    by: ['productId'],
    where: { order: { placedAt: { gte: since }, status: { in: SOLD_STATUSES } } },
    _sum: { quantity: true },
    _count: { _all: true },
    orderBy: { _sum: { quantity: 'desc' } },
    take: limit,
  });
  if (sold.length === 0) return [];

  const products = await prisma.product.findMany({
    where: { id: { in: sold.map((s) => s.productId) } },
    select: { id: true, name: true, brand: true, featuredRank: true, active: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  return sold.map((s) => ({
    productId: s.productId,
    name: byId.get(s.productId)?.name ?? s.productId,
    brand: byId.get(s.productId)?.brand ?? '',
    active: byId.get(s.productId)?.active ?? false,
    pinned: byId.get(s.productId)?.featuredRank != null,
    units: s._sum.quantity ?? 0,
    orders: s._count._all,
    windowDays: WINDOW_DAYS,
  }));
}
