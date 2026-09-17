// Mobile-OTP sign-in. Codes are hashed at rest, expire in 5 minutes and burn
// after 5 wrong attempts. A successful verify upserts the user and returns a
// JWT the app stores; `tokenVersion` lets an admin invalidate every device.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../db/prisma.js';
import { env, adminMobiles } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { sendSms } from './sms.js';
import { toRupees } from '../utils/money.js';

const OTP_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

const hashCode = (code, mobile) => crypto.createHash('sha256').update(`${code}:${mobile}`).digest('hex');

export async function sendOtp(mobile) {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await prisma.otpCode.upsert({
    where: { mobile },
    create: { mobile, codeHash: hashCode(code, mobile), expiresAt },
    update: { codeHash: hashCode(code, mobile), expiresAt, attempts: 0 },
  });
  await sendSms(mobile, { otp: code });
  return { mobile, expiresAt };
}

export async function verifyOtp(mobile, code) {
  const row = await prisma.otpCode.findUnique({ where: { mobile } });
  if (!row || row.expiresAt < new Date()) {
    throw new ApiError(400, 'This OTP has expired. Please request a new one.');
  }
  if (row.codeHash !== hashCode(code, mobile)) {
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      await prisma.otpCode.delete({ where: { mobile } });
      throw new ApiError(400, 'Too many wrong attempts. Please request a new OTP.');
    }
    await prisma.otpCode.update({ where: { mobile }, data: { attempts: { increment: 1 } } });
    throw new ApiError(400, 'Incorrect OTP. Please check and try again.');
  }
  await prisma.otpCode.delete({ where: { mobile } });

  const user = await prisma.user.upsert({
    where: { mobile },
    create: { mobile, role: adminMobiles.has(mobile) ? 'admin' : 'buyer' },
    update: adminMobiles.has(mobile) ? { role: 'admin' } : {},
    include: { profile: true },
  });
  return { token: signToken(user), user: serializeUser(user) };
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, v: user.tokenVersion, role: user.role }, env.JWT_SECRET, {
    expiresIn: env.JWT_TTL,
  });
}

/** Shape the Flutter app's UserSession.fromJson expects. */
export function serializeUser(user) {
  return {
    id: user.id,
    mobile: user.mobile,
    role: user.role,
    signedInAt: new Date().toISOString(),
    creditLimit: toRupees(user.creditLimit),
    profile: user.profile
      ? {
          businessName: user.profile.businessName,
          gstin: user.profile.gstin,
          businessType: user.profile.businessType,
          contactName: user.profile.contactName,
          mobile: user.profile.mobile,
          email: user.profile.email,
        }
      : null,
  };
}

export async function saveProfile(userId, data) {
  await prisma.businessProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
}
