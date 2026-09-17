// Website contact form → leads table. Public, rate-limited, honeypot-protected.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../middleware/error.js';
import { publicFormLimiter } from '../middleware/rateLimit.js';
import { ok } from '../utils/respond.js';
import { mobile } from './_schemas.js';

const r = Router();

r.post('/', publicFormLimiter, validate(z.object({
  name: z.string().trim().min(2, 'Name is required'),
  business: z.string().trim().optional(),
  mobile,
  email: z.email().optional().or(z.literal('')),
  message: z.string().trim().min(5, 'Tell us a little about what you need').max(2000),
  sourcePage: z.string().optional(),
  website: z.string().max(0).optional(), // honeypot
})), asyncHandler(async (req, res) => {
  const { website, ...data } = req.body;
  if (website === undefined) {
    await prisma.lead.create({ data: { ...data, email: data.email || null } });
  }
  ok(res, { received: true }, 201);
}));

export default r;
