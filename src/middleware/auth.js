import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from './error.js';

async function userFromRequest(req) {
  const header = req.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const payload = jwt.verify(header.slice(7), env.JWT_SECRET);
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { profile: true } });
  if (!user || user.tokenVersion !== payload.v) return null;
  return user;
}

/** Rejects the request unless a valid bearer token is present. */
export async function requireAuth(req, _res, next) {
  try {
    const user = await userFromRequest(req);
    if (!user) throw new ApiError(401, 'Your session has expired. Please sign in again.');
    req.user = user;
    next();
  } catch (e) {
    next(e instanceof ApiError ? e : new ApiError(401, 'Your session has expired. Please sign in again.'));
  }
}

/** Attaches req.user when a valid token is present; continues either way (website quote forms). */
export async function optionalAuth(req, _res, next) {
  try {
    req.user = await userFromRequest(req);
  } catch {
    req.user = null;
  }
  next();
}

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') return next(new ApiError(403, 'Admin access only.'));
  next();
}
