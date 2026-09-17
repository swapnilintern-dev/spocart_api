import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { mobile, pincode } from './_schemas.js';

const body = z.object({
  contactName: z.string().trim().min(2, 'Contact name is required'),
  businessName: z.string().trim().default(''),
  line1: z.string().trim().min(4, 'Address line 1 is required'),
  line2: z.string().trim().default(''),
  city: z.string().trim().min(1, 'City is required'),
  state: z.string().trim().min(1, 'State is required'),
  pincode,
  mobile,
  label: z.enum(['home', 'office', 'warehouse', 'ground', 'other']).default('home'),
  isDefault: z.boolean().default(false),
});

const r = Router();
r.use(requireAuth);

r.get('/', asyncHandler(async (req, res) => {
  ok(res, await prisma.address.findMany({ where: { userId: req.user.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }));
}));

async function save(userId, data, id) {
  return prisma.$transaction(async (tx) => {
    if (id) {
      const exists = await tx.address.findFirst({ where: { id, userId } });
      if (!exists) throw new ApiError(404, 'Address not found.');
    }
    const count = await tx.address.count({ where: { userId } });
    const isDefault = data.isDefault || count === 0;
    if (isDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    return id
      ? tx.address.update({ where: { id }, data: { ...data, isDefault } })
      : tx.address.create({ data: { ...data, isDefault, userId } });
  });
}

r.post('/', validate(body), asyncHandler(async (req, res) => ok(res, await save(req.user.id, req.body), 201)));
r.put('/:id', validate(body), asyncHandler(async (req, res) => ok(res, await save(req.user.id, req.body, req.params.id))));

r.post('/:id/default', asyncHandler(async (req, res) => {
  const a = await prisma.address.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!a) throw new ApiError(404, 'Address not found.');
  await prisma.$transaction([
    prisma.address.updateMany({ where: { userId: req.user.id, isDefault: true }, data: { isDefault: false } }),
    prisma.address.update({ where: { id: a.id }, data: { isDefault: true } }),
  ]);
  ok(res, { id: a.id, isDefault: true });
}));

r.delete('/:id', asyncHandler(async (req, res) => {
  const a = await prisma.address.findFirst({ where: { id: req.params.id, userId: req.user.id } });
  if (!a) throw new ApiError(404, 'Address not found.');
  await prisma.$transaction(async (tx) => {
    await tx.address.delete({ where: { id: a.id } });
    if (a.isDefault) {
      const next = await tx.address.findFirst({ where: { userId: req.user.id }, orderBy: { createdAt: 'asc' } });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
  ok(res, { deleted: true });
}));

export default r;
