// Product reviews.
//
// Only a buyer who actually received a product may review it, and that is
// proved against their own delivered orders — never by a flag the client sends.
// A product's star rating and review count are recomputed from the approved
// reviews on every write, so the number on a product card is always the number
// behind the reviews you can read.
import { prisma } from '../db/prisma.js';
import { ApiError } from '../middleware/error.js';
import { env } from '../config/env.js';
import { absoluteUrl } from './orders.js';

/** Order states in which the buyer has the goods in hand. */
const DELIVERED = ['delivered'];

export const serializeReview = (r) => ({
  id: r.id,
  productId: r.productId,
  rating: r.rating,
  title: r.title,
  body: r.body,
  photos: (r.photos ?? []).map(absoluteUrl),
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  // Every review here was earned by a delivered order, so this is a fact.
  verifiedBuyer: true,
  author: r.user?.profile?.businessName || maskMobile(r.user?.mobile),
  mine: false,
});

/** "98765 43210" → "98765•••10", so a reviewer is recognisable but not exposed. */
function maskMobile(mobile) {
  if (!mobile || mobile.length < 10) return 'SPOCART buyer';
  return `${mobile.slice(0, 2)}•••••${mobile.slice(-3)}`;
}

/**
 * The delivered order that entitles [userId] to review [productId], or null.
 * The newest one wins, so a repeat buyer always has a valid claim.
 */
export async function eligibleOrderId(userId, productId) {
  const line = await prisma.orderItem.findFirst({
    where: {
      productId,
      order: { userId, status: { in: DELIVERED } },
    },
    orderBy: { order: { placedAt: 'desc' } },
    select: { orderId: true },
  });
  return line?.orderId ?? null;
}

/** Products this buyer may review but has not yet, newest delivery first. */
export async function pendingReviews(userId, { limit = 20 } = {}) {
  const delivered = await prisma.orderItem.findMany({
    where: { order: { userId, status: { in: DELIVERED } } },
    orderBy: { order: { placedAt: 'desc' } },
    select: { productId: true, orderId: true, name: true, image: true },
  });

  const already = await prisma.review.findMany({
    where: { userId },
    select: { productId: true },
  });
  const reviewed = new Set(already.map((r) => r.productId));

  const seen = new Set();
  const out = [];
  for (const line of delivered) {
    if (reviewed.has(line.productId) || seen.has(line.productId)) continue;
    seen.add(line.productId);
    out.push({
      productId: line.productId,
      orderId: line.orderId,
      name: line.name,
      image: absoluteUrl(line.image),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Approved reviews for a product, newest first, with the rating breakdown. */
export async function reviewsFor(productId, { offset = 0, limit = 10, userId } = {}) {
  const where = { productId, status: 'approved' };
  const [rows, total, breakdown] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      include: { user: { select: { mobile: true, profile: { select: { businessName: true } } } } },
    }),
    prisma.review.count({ where }),
    prisma.review.groupBy({ by: ['rating'], where, _count: { _all: true } }),
  ]);

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const b of breakdown) counts[b.rating] = b._count._all;
  const sum = Object.entries(counts).reduce((t, [star, n]) => t + Number(star) * n, 0);

  return {
    reviews: rows.map((r) => ({ ...serializeReview(r), mine: r.userId === userId })),
    total,
    offset,
    limit,
    average: total ? Number((sum / total).toFixed(1)) : 0,
    breakdown: counts,
  };
}

/**
 * Recomputes the product's rating and review count from its approved reviews.
 * A product with none goes back to 0 rather than keeping a stale average.
 */
export async function refreshProductRating(tx, productId) {
  const agg = await tx.review.aggregate({
    where: { productId, status: 'approved' },
    _avg: { rating: true },
    _count: { _all: true },
  });
  await tx.product.update({
    where: { id: productId },
    data: {
      rating: agg._count._all ? Number(agg._avg.rating.toFixed(1)) : 0,
      reviewCount: agg._count._all,
    },
  });
}

/**
 * Writes a buyer's review. Creating and editing are the same call: one review
 * per buyer per product, so a second submission replaces the first.
 */
export async function upsertReview(user, productId, { rating, title, body, photos }) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, active: true },
  });
  if (!product) throw new ApiError(404, 'Product not found.');

  const orderId = await eligibleOrderId(user.id, productId);
  if (!orderId) {
    throw new ApiError(403, 'You can review a product once your order for it has been delivered.');
  }

  // Reviews from verified buyers publish straight away unless the business
  // asked for every one to be read first.
  const status = env.REVIEW_MODERATION === 'manual' ? 'pending' : 'approved';

  return prisma.$transaction(async (tx) => {
    const saved = await tx.review.upsert({
      where: { productId_userId: { productId, userId: user.id } },
      create: { productId, userId: user.id, orderId, rating, title, body, photos, status },
      update: { rating, title, body, photos, status, orderId },
      include: { user: { select: { mobile: true, profile: { select: { businessName: true } } } } },
    });
    await refreshProductRating(tx, productId);
    return { ...serializeReview(saved), mine: true };
  });
}

/** Removes a review. The author may delete their own; an admin may delete any. */
export async function deleteReview(user, reviewId) {
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review) throw new ApiError(404, 'Review not found.');
  if (review.userId !== user.id && user.role !== 'admin') {
    throw new ApiError(403, 'You can only delete your own review.');
  }
  await prisma.$transaction(async (tx) => {
    await tx.review.delete({ where: { id: reviewId } });
    await refreshProductRating(tx, review.productId);
  });
  return { deleted: reviewId };
}

/** Admin moderation: approve or hide, then recompute the product's rating. */
export async function moderateReview(reviewId, status, adminNote) {
  const review = await prisma.review.findUnique({ where: { id: reviewId } });
  if (!review) throw new ApiError(404, 'Review not found.');
  return prisma.$transaction(async (tx) => {
    const saved = await tx.review.update({
      where: { id: reviewId },
      data: { status, adminNote: adminNote ?? review.adminNote },
      include: { user: { select: { mobile: true, profile: { select: { businessName: true } } } } },
    });
    await refreshProductRating(tx, review.productId);
    return serializeReview(saved);
  });
}

/** Moderation queue. */
export async function reviewQueue({ status, offset = 0, limit = 25 } = {}) {
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      include: {
        user: { select: { mobile: true, profile: { select: { businessName: true } } } },
        product: { select: { name: true } },
      },
    }),
    prisma.review.count({ where }),
  ]);
  return {
    reviews: rows.map((r) => ({ ...serializeReview(r), productName: r.product.name, adminNote: r.adminNote })),
    total,
    offset,
    limit,
  };
}
