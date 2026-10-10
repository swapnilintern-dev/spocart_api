// Mobile-OTP sign-in. Codes are hashed at rest, expire in 5 minutes and burn
// after 5 wrong attempts. A successful verify upserts the user and returns a
// JWT the app stores; `tokenVersion` lets an admin invalidate every device.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../db/prisma.js';
import { env, adminMobiles, isProd } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { nextId } from './ids.js';
import { hashPassword, verifyPassword } from './password.js';
import { sendSms } from './sms.js';
import { deleteFile } from './storage.js';
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

  // The code goes back to the app so it can be shown on screen, instead of an
  // SMS the buyer may never receive.
  //
  // DEV_OTP_ECHO is deliberate and wins wherever it is set, including over a
  // real SMS gateway: the shop asked to be able to sign in while delivery is
  // still being sorted out. Without it, only a development server on the
  // console driver echoes. server.js warns about this on every boot.
  const echo = env.DEV_OTP_ECHO || (!isProd && env.SMS_DRIVER === 'console');
  return { mobile, expiresAt, ...(echo && { devCode: code }) };
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
  await assertNotAdmin(mobile);
  await consumeOtp(mobile, code, 'login');
  return signIn(mobile);
}

/**
 * Keeps admins out of the customer sign-in, which is the only one the mobile
 * app knows how to call. An admin therefore cannot sign in on the app at all:
 * their route is `adminSignIn` below, and only the website calls it.
 *
 * Checked against ADMIN_MOBILES rather than the stored role, so it holds even
 * for a number that has been listed but never signed in yet.
 */
export async function assertNotAdmin(mobile) {
  if (!adminMobiles.has(mobile)) return;
  throw new ApiError(403, 'Admin accounts sign in on the SPOCART admin website, not here.');
}

/**
 * Step 1 of the admin sign-in: the password. Correct password issues the
 * second factor; nothing is returned that could be used as a session.
 *
 * The failure message is deliberately identical for an unknown number, a
 * number with no password set and a wrong password, so this cannot be used to
 * work out which mobile numbers are admins.
 */
export async function adminLogin(mobile, password) {
  const user = adminMobiles.has(mobile)
    ? await prisma.user.findUnique({ where: { mobile } })
    : null;

  const ok = user?.role === 'admin' && (await verifyPassword(password, user.passwordHash));
  if (!ok) throw new ApiError(401, 'Incorrect mobile number or password.');

  return issueOtp(mobile, 'adminLogin');
}

/** Step 2 of the admin sign-in: the code sent after the password checked out. */
export async function adminVerify(mobile, code) {
  await consumeOtp(mobile, code, 'adminLogin');
  const user = await prisma.user.findUnique({ where: { mobile }, include: { profile: true } });
  if (user?.role !== 'admin') throw new ApiError(403, 'This account is not an admin.');
  return { token: signToken(user), user: serializeUser(user) };
}

/**
 * An admin changing their own password. The current one is required, so a
 * borrowed unlocked browser cannot be used to lock the real admin out, and
 * every other session is dropped because a password change is exactly when
 * you want any session you did not start to end.
 */
export async function changeAdminPassword(user, currentPassword, newPassword) {
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ApiError(401, 'Your current password is incorrect.');
  }
  if (currentPassword === newPassword) {
    throw new ApiError(400, 'The new password must be different from the current one.');
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword), tokenVersion: { increment: 1 } },
  });
  return { changed: true };
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

/**
 * Closes a buyer's account, as Google Play and the App Store require.
 *
 * The account is anonymised rather than dropped, because two obligations pull
 * in opposite directions: the buyer may withdraw their data, but a GST tax
 * invoice has to be kept for years and must carry the recipient's details.
 * Both stores allow exactly this carve-out — data the law requires you to
 * hold — provided the retention is spelled out in the privacy policy.
 *
 *   gone     — business profile (name, email, GSTIN), saved addresses, team
 *              members, device tokens, notifications, reviews, pending OTPs,
 *              quotations with the notes and artwork the buyer uploaded, and
 *              enquiries they submitted from the website
 *   scrubbed — the delivery mobile inside each stored invoice address: a GST
 *              invoice needs the name, address and GSTIN, never the phone
 *   neutered — the user row keeps its id so invoices still join, but the
 *              mobile becomes a number nobody can dial or sign in with, every
 *              session is invalidated and the credit line is closed
 *   kept     — orders, their items, payments and the invoice address, which is
 *              the legal record and no longer reaches a living account
 *
 * The freed mobile number can be registered again, as a brand-new account with
 * none of the old history.
 */
export async function deleteAccount(user) {
  const userId = user.id;

  const result = await prisma.$transaction(async (tx) => {
    // A placeholder that is unique, exactly 10 characters, and cannot be a real
    // Indian mobile (those start 6-9). The shared counter makes it collision
    // free without a second round trip.
    const [, year, seq] = (await nextId(tx, 'DEL')).split('-');
    const retiredMobile = `0${year.slice(2)}${seq.padStart(7, '0')}`;

    // Collected before the rows go, so the files can be removed afterwards.
    const quotes = await tx.quote.findMany({
      where: { userId },
      select: { id: true, designFileUrl: true },
    });
    const files = quotes.map((q) => q.designFileUrl).filter(Boolean);

    await tx.quoteItem.deleteMany({ where: { quoteId: { in: quotes.map((q) => q.id) } } });
    await tx.quote.deleteMany({ where: { userId } });

    await tx.businessProfile.deleteMany({ where: { userId } });
    await tx.address.deleteMany({ where: { userId } });
    await tx.teamMember.deleteMany({ where: { userId } });
    await tx.deviceToken.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.review.deleteMany({ where: { userId } });
    // Enquiries carry a name and number but no account, so they match on the
    // number being released.
    await tx.lead.deleteMany({ where: { mobile: user.mobile } });
    // Any half-finished sign-in for that number.
    await tx.otpCode.deleteMany({ where: { mobile: user.mobile } });

    // The invoice address stays for GST, minus the phone number it does not
    // need. Each row is rewritten individually because it is a JSON snapshot.
    const orders = await tx.order.findMany({
      where: { userId },
      select: { id: true, address: true },
    });
    for (const order of orders) {
      if (order.address && typeof order.address === 'object' && 'mobile' in order.address) {
        const { mobile, ...rest } = order.address;
        await tx.order.update({ where: { id: order.id }, data: { address: rest } });
      }
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        mobile: retiredMobile,
        creditLimit: 0n,
        // Signs every device out, including the one that asked.
        tokenVersion: { increment: 1 },
      },
    });

    return { deleted: true, files };
  });

  // Outside the transaction: Cloudinary is a third party, and a failure there
  // must not roll back a deletion the database has already committed.
  for (const file of result.files) {
    await deleteFile(file);
  }

  return { deleted: true };
}
