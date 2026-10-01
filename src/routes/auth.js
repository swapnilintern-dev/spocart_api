import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { otpLimiter } from '../middleware/rateLimit.js';
import { ok } from '../utils/respond.js';
import * as auth from '../services/auth.js';
import { mobile, gstin, email, businessType } from './_schemas.js';

const r = Router();

r.post('/otp/send', otpLimiter, validate(z.object({ mobile })), asyncHandler(async (req, res) => {
  ok(res, await auth.sendOtp(req.body.mobile));
}));

r.post('/otp/verify', otpLimiter, validate(z.object({ mobile, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit OTP') })),
  asyncHandler(async (req, res) => {
    ok(res, await auth.verifyOtp(req.body.mobile, req.body.code));
  }));

r.get('/me', requireAuth, (req, res) => ok(res, auth.serializeUser(req.user)));

r.put('/profile', requireAuth, validate(z.object({
  businessName: z.string().trim().min(2, 'Business name is required'),
  gstin,
  businessType,
  contactName: z.string().trim().min(2, 'Contact name is required'),
  // Accepted for backwards compatibility with shipped apps and ignored:
  // saveProfile always stores the account's own verified number.
  mobile: mobile.optional(),
  email,
})), asyncHandler(async (req, res) => {
  ok(res, auth.serializeUser(await auth.saveProfile(req.user.id, req.body)));
}));

// ── Changing the registered mobile number ───────────────────────────────────
// Step 1 sends a code to the NEW number; step 2 verifies it and only then moves
// the account. Both are authenticated, so nobody can start this for someone
// else, and both sit behind the OTP rate limiter.
r.post('/mobile/change/send', requireAuth, otpLimiter, validate(z.object({ mobile })),
  asyncHandler(async (req, res) => {
    ok(res, await auth.requestMobileChange(req.user, req.body.mobile));
  }));

r.post('/mobile/change/verify', requireAuth, otpLimiter, validate(z.object({
  mobile,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit OTP'),
})), asyncHandler(async (req, res) => {
  ok(res, await auth.confirmMobileChange(req.user, req.body.mobile, req.body.code));
}));

r.post('/logout-all', requireAuth, asyncHandler(async (req, res) => {
  const { prisma } = await import('../db/prisma.js');
  await prisma.user.update({ where: { id: req.user.id }, data: { tokenVersion: { increment: 1 } } });
  ok(res, { signedOut: true });
}));

export default r;
