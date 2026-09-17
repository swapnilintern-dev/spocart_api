import rateLimit from 'express-rate-limit';

const message = { ok: false, message: 'Too many requests. Please try again in a few minutes.' };

export const otpLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false, message });
export const publicFormLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message });
export const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, message });
