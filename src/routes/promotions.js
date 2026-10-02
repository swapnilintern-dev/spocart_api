import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { activePromotion } from '../services/promotions.js';

const r = Router();

/**
 * The one offer to show this buyer right now, or null. Optional auth: the home
 * screen renders before sign-in, and a signed-in buyer may match a narrower
 * audience. The app decides when to show it; the server decides what is live.
 */
r.get('/active', optionalAuth, asyncHandler(async (req, res) => {
  ok(res, { promotion: await activePromotion(req.user) });
}));

export default r;
