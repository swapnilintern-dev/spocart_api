import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { rewardsFor, ledger, checkIn, redeemable } from '../services/rewards.js';

const r = Router();
r.use(requireAuth);

/** Everything the Rewards screen shows: balance, progress, tiers, streak. */
r.get('/', asyncHandler(async (req, res) => {
  ok(res, await rewardsFor(req.user.id));
}));

/** The buyer's own ledger, so a balance can be explained line by line. */
r.get('/ledger', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  ok(res, await ledger(req.user.id, { offset, limit }));
}));

/**
 * Claims today's check-in. The day is the server's, in the business timezone,
 * so moving the phone's clock earns nothing, and claiming twice earns nothing
 * the second time.
 */
r.post('/check-in', asyncHandler(async (req, res) => {
  ok(res, await checkIn(req.user.id));
}));

/** How many credits may be spent on an order of this size. */
r.get('/redeemable', asyncHandler(async (req, res) => {
  const rupees = Math.max(Number(req.query.total) || 0, 0);
  ok(res, await redeemable(req.user.id, Math.round(rupees * 100)));
}));

export default r;
