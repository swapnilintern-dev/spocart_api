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
const RESEND_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 5;

// The purpose is part of the hash as well as the key, so a code issued for one
// purpose can never satisfy the other even if both rows exist.
const hashCode = (code, mobile, purpose) =>
  crypto.createHash('sha256').update(`${code}:${mobile}:${purpose}`).digest('hex');

const otpKey = (mobile, purpose) => ({ mobile_purpose: { mobile, purpose } });

/// Issues a code for [mobile] and returns when it expires. Never returns the
/// code itself: it only leaves through sendSms.
export async function issueOtp(mobile, purpose = 'login') {
  const existing = await prisma.otpCode.findUnique({ where: otpKey(mobile, purpose) });
  if (existing) {
    const waitedMs = Date.now() - existing.sentAt.getTime();
    if (waitedMs < RESEND_COOLDOWN_MS) {
      const seconds = Math.ceil((RESEND_COOLDOWN_MS - waitedMs) / 1000);
      throw new ApiError(429, `Please wait ${seconds} second${seconds === 1 ? '' : 's'} before asking for another OTP.`);
    }
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = hashCode(code, mobile, purpose);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const sentAt = new Date();
  await prisma.otpCode.upsert({
    where: otpKey(mobile, purpose),
    create: { mobile, purpose, codeHash, expiresAt, sentAt },
    update: { codeHash, expiresAt, sentAt, attempts: 0 },
  });
  await sendSms(mobile, { otp: code });
  return { mobile, expiresAt };
}

export const sendOtp = (mobile) => issueOtp(mobile, 'login');

/// Burns a correct code and returns. Throws with a message meant for the buyer
/// on an expired, wrong or exhausted code.
export async function consumeOtp(mobile, code, purpose = 'login') {
  const row = await prisma.otpCode.findUnique({ where: otpKey(mobile, purpose) });
  if (!row || row.expiresAt < new Date()) {
    throw new ApiError(400, 'This OTP has expired. Please request a new one.');
  }
  if (row.codeHash !== hashCode(code, mobile, purpose)) {
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      await prisma.otpCode.delete({ where: otpKey(mobile, purpose) });
      throw new ApiError(400, 'Too many wrong attempts. Please request a new OTP.');
    }
    await prisma.otpCode.update({ where: otpKey(mobile, purpose), data: { attempts: { increment: 1 } } });
    throw new ApiError(400, 'Incorrect OTP. Please check and try again.');
  }
  await prisma.otpCode.delete({ where: otpKey(mobile, purpose) });
}

export async function verifyOtp(mobile, code) {
  await consumeOtp(mobile, code, 'login');
  return signIn(mobile);
}

/**
 * Creates or fetches the user for a mobile number we have just proven the
 * caller owns, and returns our own session. Used by both the built-in OTP
 * flow and Firebase phone sign-in.
 */
export async function signIn(mobile) {
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

/// Writes the business profile. The contact mobile is never taken from the
/// request: it is always the account's own verified number, so it cannot be
/// changed without going through the OTP flow in changeMobile().
export async function saveProfile(userId, data) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const fields = { ...data, mobile: user.mobile };
  await prisma.businessProfile.upsert({
    where: { userId },
    create: { userId, ...fields },
    update: fields,
  });
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
}

//==============================================================================
// Changing the account's mobile number
//------------------------------------------------------------------------------
// Two steps, both authenticated: ask for a code on the new number, then verify
// it. Nothing is written until the code is correct. A successful change bumps
// tokenVersion so other devices are signed out, and hands this device a fresh
// token for the new number.
//==============================================================================

async function assertMobileAvailable(userId, newMobile) {
  const owner = await prisma.user.findUnique({ where: { mobile: newMobile }, select: { id: true } });
  if (owner && owner.id !== userId) {
    throw new ApiError(409, 'That number already has a SPOCART account. Sign in with it instead.');
  }
}

export async function requestMobileChange(user, newMobile) {
  if (newMobile === user.mobile) {
    throw new ApiError(400, 'That is already your registered number.');
  }
  await assertMobileAvailable(user.id, newMobile);
  return issueOtp(newMobile, 'mobileChange');
}

export async function confirmMobileChange(user, newMobile, code) {
  if (newMobile === user.mobile) {
    throw new ApiError(400, 'That is already your registered number.');
  }
  await consumeOtp(newMobile, code, 'mobileChange');
  // Re-check after the code was burned: someone may have claimed the number
  // while this buyer was reading the SMS.
  await assertMobileAvailable(user.id, newMobile);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.user.update({
      where: { id: user.id },
      data: { mobile: newMobile, tokenVersion: { increment: 1 } },
    });
    // The profile's contact number tracks the verified account number.
    await tx.businessProfile.updateMany({ where: { userId: user.id }, data: { mobile: newMobile } });
    return tx.user.findUniqueOrThrow({ where: { id: row.id }, include: { profile: true } });
  });

  return { token: signToken(updated), user: serializeUser(updated) };
}
