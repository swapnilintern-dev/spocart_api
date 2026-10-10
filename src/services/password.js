// Admin passwords. Buyers never have one — they sign in with an OTP alone.
//
// scrypt from node:crypto rather than bcrypt or argon2: it is a memory-hard
// KDF designed for exactly this, it ships with Node, and it adds no native
// build step to the Render image. The same reasoning as the OTP hashing next
// door, which also uses node:crypto and nothing else.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from '../middleware/error.js';

const scrypt = promisify(crypto.scrypt);

const KEY_LEN = 64;
const SALT_LEN = 16;
// Node's defaults (N=16384, r=8, p=1) at 64 bytes take a few tens of
// milliseconds — slow enough to make guessing expensive, fast enough that a
// sign-in does not feel stuck.
const PREFIX = 'scrypt';

/** The shortest password we will store. Admin accounts hold refunds and credit limits. */
export const MIN_PASSWORD_LENGTH = 12;

/** Hashes a password into the single string the users.password_hash column holds. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, KEY_LEN);
  return `${PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * True when [password] matches [stored]. Never throws on a malformed or
 * missing hash — an account with no password simply cannot be signed into
 * this way, which is the correct answer for every buyer.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const [prefix, saltHex, keyHex] = stored.split('$');
  if (prefix !== PREFIX || !saltHex || !keyHex) return false;

  let expected;
  try {
    expected = Buffer.from(keyHex, 'hex');
    if (expected.length !== KEY_LEN) return false;
  } catch {
    return false;
  }

  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), KEY_LEN);
  // Constant time: a length check first, because timingSafeEqual throws when
  // the two buffers differ in size.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
