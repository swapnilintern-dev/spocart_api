import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { mobile } from './_schemas.js';

const r = Router();
r.use(requireAuth);

r.get('/', asyncHandler(async (req, res) => {
  ok(res, await prisma.teamMember.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'asc' } }));
}));

r.post('/', validate(z.object({
  name: z.string().trim().min(2, 'Name is required'),
  mobile,
  role: z.enum(['purchaser', 'accounts', 'viewer']),
})), asyncHandler(async (req, res) => {
  ok(res, await prisma.teamMember.create({ data: { ...req.body, userId: req.user.id } }), 201);
}));

r.delete('/:id', asyncHandler(async (req, res) => {
  const { count } = await prisma.teamMember.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
  if (!count) throw new ApiError(404, 'Team member not found.');
  ok(res, { deleted: true });
}));

export default r;
