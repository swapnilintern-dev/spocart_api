// Firebase phone sign-in. The app and website run the OTP flow with Firebase
// (Google sends the SMS) and hand us the resulting ID token; we verify it,
// take the phone number out of it and issue our own JWT — so every other
// endpoint keeps working exactly as before.
//
// Set FIREBASE_SERVICE_ACCOUNT (the service-account JSON, single line) in the
// Render dashboard. Without it this route is disabled and the built-in OTP
// flow stays in charge.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';

let auth = null;

if (env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const raw = env.FIREBASE_SERVICE_ACCOUNT.trim();
    // Accept either the raw JSON or a base64 copy of it (easier to paste).
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(json);
    const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
    auth = getAuth(app);
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON — Firebase sign-in is disabled.', e.message);
  }
}

export const firebaseEnabled = () => auth !== null;

/**
 * Verifies a Firebase ID token and returns the 10-digit Indian mobile number.
 * Rejects tokens that are expired, revoked, or not from a phone sign-in.
 */
export async function mobileFromIdToken(idToken) {
  if (!auth) throw new ApiError(503, 'Firebase sign-in is not configured on the server.');

  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken, true);   // true → also check revocation
  } catch (e) {
    const expired = e.code === 'auth/id-token-expired';
    throw new ApiError(401, expired ? 'That sign-in has expired. Please request a new OTP.' : 'Could not verify this sign-in. Please try again.');
  }

  const phone = decoded.phone_number;
  if (!phone) throw new ApiError(400, 'This sign-in has no phone number attached.');

  const digits = String(phone).replace(/\D/g, '');
  const mobile = digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits;
  if (!/^[6-9]\d{9}$/.test(mobile)) throw new ApiError(400, 'Only Indian mobile numbers can be used to sign in.');

  return mobile;
}
