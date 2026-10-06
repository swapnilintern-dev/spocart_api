import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { otpLimiter } from '../middleware/rateLimit.js';
import { ok } from '../utils/respond.js';
import * as auth from '../services/auth.js';
import { mobileFromIdToken, firebaseEnabled } from '../services/firebase.js';
import { mobile, gstin, email, businessType } from './_schemas.js';
import { env, isProd } from '../config/env.js';

const r = Router();

/**
 * What the clients need to know about signing in, and nothing secret: which
 * methods work, how an OTP is delivered, and whether the code comes back on
 * screen instead of by SMS. The app uses the last one to say "the code is
 * below" rather than "check your messages", and it is the quickest way to see
 * how a deployed server is actually configured.
 */
r.get('/methods', (_req, res) => ok(res, {
  firebase: firebaseEnabled(),
  otp: true,
  smsDriver: env.SMS_DRIVER,
  otpOnScreen: env.SMS_DRIVER === 'console' && (!isProd || env.DEV_OTP_ECHO),
}));

r.post('/otp/send', otpLimiter, validate(z.object({ mobile })), asyncHandler(async (req, res) => {
  ok(res, await auth.sendOtp(req.body.mobile));
}));

r.post('/otp/verify', otpLimiter, validate(z.object({ mobile, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit OTP') })),
  asyncHandler(async (req, res) => {
    ok(res, await auth.verifyOtp(req.body.mobile, req.body.code));
  }));

/**
 * Firebase phone sign-in: the client completes the OTP with Firebase and posts
 * the resulting ID token here. Same response shape as /otp/verify.
 */
r.post('/firebase', otpLimiter, validate(z.object({ idToken: z.string().min(20) })), asyncHandler(async (req, res) => {
  const mobile = await mobileFromIdToken(req.body.idToken);
  ok(res, await auth.signIn(mobile));
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
