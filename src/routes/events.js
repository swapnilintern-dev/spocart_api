import { Router } from 'express';
import { z } from 'zod';
import { optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { record } from '../services/analytics.js';

const r = Router();

const body = z.object({
  // Stable per install, so an anonymous visitor is counted once rather than
  // on every launch. The app generates it; it identifies a device, not a person.
  deviceId: z.string().trim().min(8).max(64),
  platform: z.string().trim().max(32).default(''),
  events: z.array(z.object({
    name: z.string().trim().min(2).max(32),
    at: z.string().optional(),
    productId: z.string().trim().max(64).optional(),
    orderId: z.string().trim().max(64).optional(),
    // Whole numbers only; the service drops anything else, so no text a buyer
    // typed can reach the database.
    meta: z.record(z.string(), z.any()).optional(),
  })).max(100),
});

/**
 * The app reports what it did, in batches. Optional auth: the home screen is
 * browsable before sign-in and those visits still count.
 */
r.post('/', optionalAuth, validate(body), asyncHandler(async (req, res) => {
  ok(res, await record(req.body.events, {
    user: req.user,
    deviceId: req.body.deviceId,
    platform: req.body.platform,
  }));
}));

export default r;
