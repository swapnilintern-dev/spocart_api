import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const message = { ok: false, message: 'Too many requests. Please try again in a few minutes.' };

const base = { windowMs: 10 * 60_000, standardHeaders: true, legacyHeaders: false, message };

/// Coarse shield against one host hammering the OTP endpoints. Generous,
/// because a whole shop or academy can share a single office IP.
export const otpIpLimiter = rateLimit({ ...base, limit: 40 });

/// The limit that actually matters: how often one number may be targeted.
/// Keyed by the mobile in the request, falling back to the default per-IP key
/// when a request arrives without one.
export const otpMobileLimiter = rateLimit({
  ...base,
  limit: 8,
  keyGenerator: (req) => {
    const mobile = typeof req.body?.mobile === 'string' ? req.body.mobile.trim() : '';
    if (/^[6-9]\d{9}$/.test(mobile)) return `mobile:${mobile}`;
    // ipKeyGenerator normalises IPv6 into a /56 subnet, so one client cannot
    // walk through addresses to get a fresh budget.
    return `ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
});

/// Applied together wherever an OTP is sent or checked.
export const otpLimiter = [otpIpLimiter, otpMobileLimiter];

/// AI search costs money per call, so it is limited more tightly than the rest.
export const aiAssistLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many searches. Please wait a moment.' },
});

export const publicFormLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message });
export const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, message });
