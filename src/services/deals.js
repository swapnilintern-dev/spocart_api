// Deals: genuine price drops and genuinely low stock.
//
// Nothing here is invented. A product appears as a price drop only because we
// recorded the old and new price when an admin changed it, and it is only
// called low on stock when someone has actually entered a quantity. A product
// whose stock is not tracked says nothing about how many are left.
import { prisma } from '../db/prisma.js';
import { notify } from './notify.js';

/** How long a drop stays on the Deals shelf. */
const DROP_WINDOW_DAYS = 14;

/** At or below this many units, and only when stock is tracked. */
export const LOW_STOCK_THRESHOLD = 20;

const since = (days) => new Date(Date.now() - days * 24 * 60 * 60_000);

/** The price a buyer pays at the smallest quantity — what a "drop" is measured on. */
export function entryPrice(tiers) {
  if (!tiers?.length) return null;
  return tiers.reduce((low, t) => (t.minQty < low.minQty ? t : low), tiers[0]).unitPrice;
}

/**
 * Records a change in a product's entry price. Call inside the same transaction
 * that writes the tiers. A price that did not move records nothing.
 */
export async function recordPriceChange(tx, productId, oldPrice, newPrice) {
  if (oldPrice == null || newPrice == null) return null;
  if (BigInt(oldPrice) === BigInt(newPrice)) return null;
  return tx.priceChange.create({
    data: { productId, oldPrice: BigInt(oldPrice), newPrice: BigInt(newPrice) },
  });
}

/**
 * The most recent drop per product inside the window, as
 * { productId, oldPrice, newPrice, changedAt } in paise. Rises are ignored:
 * a product whose price went up is not a deal.
 */
export async function recentDrops({ days = DROP_WINDOW_DAYS } = {}) {
  const rows = await prisma.priceChange.findMany({
    where: { changedAt: { gte: since(days) } },
    orderBy: { changedAt: 'desc' },
  });

  const latest = new Map();
  for (const row of rows) {
    // findMany is newest first, so the first row seen per product is the latest.
    if (!latest.has(row.productId)) latest.set(row.productId, row);
  }
  return [...latest.values()].filter((r) => r.newPrice < r.oldPrice);
}

/**
 * Products to show on the Deals shelf: a real recent price drop, or a tracked
 * stock level at or below the threshold. Both facts are returned so the app can
 * label each one honestly.
 */
export async function deals({ limit = 20, days = DROP_WINDOW_DAYS } = {}) {
  const drops = await recentDrops({ days });
  const dropByProduct = new Map(drops.map((d) => [d.productId, d]));

  const candidates = await prisma.product.findMany({
    where: {
      active: true,
      OR: [
        { id: { in: [...dropByProduct.keys()] } },
        { stockQty: { not: null, lte: LOW_STOCK_THRESHOLD, gt: 0 } },
      ],
    },
    include: { tiers: { orderBy: { minQty: 'asc' } } },
  });

  return candidates
    .map((p) => {
      const drop = dropByProduct.get(p.id);
      return {
        product: p,
        // Only set when we recorded the change ourselves.
        previousPrice: drop ? drop.oldPrice : null,
        droppedAt: drop ? drop.changedAt : null,
        // Only set when an admin actually tracks this product's stock.
        stockLeft: p.stockQty != null && p.stockQty <= LOW_STOCK_THRESHOLD ? p.stockQty : null,
      };
    })
    .sort((a, b) => {
      // Biggest genuine saving first, then the scarcest tracked stock.
      const saving = (d) =>
        d.previousPrice == null ? 0n : d.previousPrice - BigInt(entryPrice(d.product.tiers) ?? 0n);
      const diff = saving(b) - saving(a);
      if (diff !== 0n) return diff > 0n ? 1 : -1;
      return (a.stockLeft ?? 1e9) - (b.stockLeft ?? 1e9);
    })
    .slice(0, limit);
}

/**
 * Tells buyers who have bought a product before that its price has dropped.
 * Each recorded change is used once — the `notified` flag is what stops a
 * second notification for the same drop.
 */
export async function notifyPriceDrops() {
  const pending = await prisma.priceChange.findMany({
    where: { notified: false, changedAt: { gte: since(DROP_WINDOW_DAYS) } },
    orderBy: { changedAt: 'asc' },
    take: 50,
  });

  let sent = 0;
  for (const change of pending) {
    // A rise is recorded for history but nobody is told about it.
    if (change.newPrice >= change.oldPrice) {
      await prisma.priceChange.update({ where: { id: change.id }, data: { notified: true } });
      continue;
    }

    const product = await prisma.product.findUnique({
      where: { id: change.productId },
      select: { id: true, name: true, active: true },
    });
    if (!product?.active) {
      await prisma.priceChange.update({ where: { id: change.id }, data: { notified: true } });
      continue;
    }

    const buyers = await prisma.orderItem.findMany({
      where: { productId: change.productId, order: { status: { not: 'cancelled' } } },
      select: { order: { select: { userId: true } } },
      distinct: ['orderId'],
    });
    const userIds = [...new Set(buyers.map((b) => b.order.userId))];

    const rupees = (paise) => (Number(paise) / 100).toLocaleString('en-IN');
    await prisma.$transaction(async (tx) => {
      for (const userId of userIds) {
        await notify(tx, userId, {
          type: 'priceDrop',
          title: `${product.name} is cheaper now`,
          body: `Down from ₹${rupees(change.oldPrice)} to ₹${rupees(change.newPrice)} per unit.`,
          productId: product.id,
        });
      }
      await tx.priceChange.update({ where: { id: change.id }, data: { notified: true } });
    });
    sent += userIds.length;
  }
  return { changes: pending.length, notifications: sent };
}
