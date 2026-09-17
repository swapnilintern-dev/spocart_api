import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { ok } from '../utils/respond.js';

const r = Router();
r.use(requireAuth);

r.get('/', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const rows = await prisma.notification.findMany({
    where: { userId: req.user.id, ...(before && !Number.isNaN(before.getTime()) && { createdAt: { lt: before } }) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const unread = await prisma.notification.count({ where: { userId: req.user.id, read: false } });
  ok(res, { items: rows.map((n) => ({ ...n, time: n.createdAt })), unreadCount: unread });
}));

r.post('/read-all', asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, read: false }, data: { read: true } });
  ok(res, { read: true });
}));

r.post('/:id/read', asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: { read: true } });
  ok(res, { read: true });
}));

r.delete('/', asyncHandler(async (req, res) => {
  await prisma.notification.deleteMany({ where: { userId: req.user.id } });
  ok(res, { cleared: true });
}));

export default r;
