import rateLimit from 'express-rate-limit';

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
  keyGenerator: (req, res) => {
    const mobile = typeof req.body?.mobile === 'string' ? req.body.mobile.trim() : '';
    return /^[6-9]\d{9}$/.test(mobile) ? `mobile:${mobile}` : `ip:${rateLimit.ipKeyGenerator(req, res)}`;
  },
});

/// Applied together wherever an OTP is sent or checked.
export const otpLimiter = [otpIpLimiter, otpMobileLimiter];

export const publicFormLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message });
export const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, message });
