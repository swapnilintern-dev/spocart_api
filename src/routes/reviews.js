import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { pendingReviews, upsertReview, deleteReview } from '../services/reviews.js';

const r = Router();

/** Products this buyer has received and not yet reviewed. */
r.get('/pending', requireAuth, asyncHandler(async (req, res) => {
  ok(res, await pendingReviews(req.user.id));
}));

const body = z.object({
  rating: z.number().int().min(1, 'Give at least one star').max(5),
  title: z.string().trim().max(120).default(''),
  body: z.string().trim().min(4, 'Tell other buyers a little about it').max(2000),
  photos: z.array(z.string()).max(5, 'Up to 5 photos').default([]),
});

/**
 * Writes this buyer's review of a product. Creating and editing are the same
 * call — one review per buyer per product. Eligibility is checked server-side
 * against their delivered orders.
 */
r.put('/:productId', requireAuth, validate(body), asyncHandler(async (req, res) => {
  ok(res, await upsertReview(req.user, req.params.productId, req.body));
}));

r.delete('/:reviewId', requireAuth, asyncHandler(async (req, res) => {
  ok(res, await deleteReview(req.user, req.params.reviewId));
}));

export default r;
