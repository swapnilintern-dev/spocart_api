// Admin sign-in: password, then OTP. The guarantees worth protecting are that
// an admin cannot get in with only one of the two, that the customer route —
// the only one the mobile app knows — refuses them outright, and that a wrong
// password reveals nothing about which numbers are admins.
//
// Runs against the local database and cleans up after itself.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../src/services/password.js';

const ADMIN = '9000000801';
const BUYER = '9000000802';
const PASSWORD = 'correct-horse-battery';

// ADMIN_MOBILES is read once at import, so it has to be set before the auth
// service loads — hence the dynamic import below.
process.env.ADMIN_MOBILES = ADMIN;
const auth = await import('../src/services/auth.js');

/// The code never leaves the server, so tests read the row and re-derive it.
/// Mirrors the hashing in services/auth.js.
async function currentCode(mobile, purpose) {
  const row = await prisma.otpCode.findUnique({ where: { mobile_purpose: { mobile, purpose } } });
  if (!row) return null;
  const crypto = await import('node:crypto');
  for (let i = 100000; i < 1000000; i++) {
    const guess = String(i);
    const hash = crypto.createHash('sha256').update(`${guess}:${mobile}:${purpose}`).digest('hex');
    if (hash === row.codeHash) return guess;
  }
  return null;
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { mobile: { in: [ADMIN, BUYER] } } });
  await prisma.user.create({
    data: { mobile: ADMIN, role: 'admin', passwordHash: await hashPassword(PASSWORD) },
  });
  await prisma.user.create({ data: { mobile: BUYER, role: 'buyer' } });
});

afterAll(async () => {
  await prisma.otpCode.deleteMany({ where: { mobile: { in: [ADMIN, BUYER] } } });
  await prisma.user.deleteMany({ where: { mobile: { in: [ADMIN, BUYER] } } });
});

beforeEach(async () => {
  await prisma.otpCode.deleteMany({ where: { mobile: { in: [ADMIN, BUYER] } } });
});

describe('password hashing', () => {
  it('accepts the right password and rejects everything else', async () => {
    const stored = await hashPassword('a-long-enough-password');
    expect(await verifyPassword('a-long-enough-password', stored)).toBe(true);
    expect(await verifyPassword('a-long-enough-passworD', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('never stores the password itself', async () => {
    const stored = await hashPassword('a-long-enough-password');
    expect(stored).not.toContain('a-long-enough-password');
    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('a-long-enough-password');
    const b = await hashPassword('a-long-enough-password');
    expect(a).not.toBe(b);
  });

  it('refuses a password short enough to guess', async () => {
    await expect(hashPassword('short')).rejects.toThrow(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH}`),
    );
  });

  it('treats an account with no password as unsignable', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false);
  });
});

describe('admin sign-in', () => {
  it('needs the password before it will send a code', async () => {
    await expect(auth.adminLogin(ADMIN, 'wrong-password')).rejects.toThrow(
      'Incorrect mobile number or password.',
    );
    expect(await prisma.otpCode.count({ where: { mobile: ADMIN } })).toBe(0);
  });

  it('sends a code once the password is right, and no session yet', async () => {
    const res = await auth.adminLogin(ADMIN, PASSWORD);
    expect(res.token).toBeUndefined();
    expect(await prisma.otpCode.count({ where: { mobile: ADMIN, purpose: 'adminLogin' } })).toBe(1);
  });

  it('issues the session only after the code', async () => {
    await auth.adminLogin(ADMIN, PASSWORD);
    const code = await currentCode(ADMIN, 'adminLogin');
    const res = await auth.adminVerify(ADMIN, code);
    expect(res.token).toBeTruthy();
    expect(res.user.role).toBe('admin');
  });

  it('tells a wrong password and an unknown number apart to nobody', async () => {
    // Same message either way, so this cannot be used to enumerate admins.
    const wrongPassword = auth.adminLogin(ADMIN, 'wrong-password').catch((e) => e.message);
    const notAnAdmin = auth.adminLogin(BUYER, PASSWORD).catch((e) => e.message);
    expect(await wrongPassword).toBe(await notAnAdmin);
  });

  it('will not accept a customer login code as the second factor', async () => {
    // A code issued for `login` must not satisfy `adminLogin`, even for the
    // same number — the purpose is inside the hash, not just the key.
    await auth.issueOtp(ADMIN, 'login');
    const loginCode = await currentCode(ADMIN, 'login');
    await expect(auth.adminVerify(ADMIN, loginCode)).rejects.toThrow();
  });
});

describe('admins are kept off the app', () => {
  it('refuses an admin on the customer OTP route', async () => {
    await expect(auth.assertNotAdmin(ADMIN)).rejects.toThrow(/admin website/i);
    await expect(auth.verifyOtp(ADMIN, '123456')).rejects.toThrow(/admin website/i);
  });

  it('lets a buyer through that same route', async () => {
    await expect(auth.assertNotAdmin(BUYER)).resolves.toBeUndefined();
  });
});

describe('changing an admin password', () => {
  it('requires the current one, and signs other sessions out', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { mobile: ADMIN } });

    await expect(auth.changeAdminPassword(before, 'not-it', 'a-brand-new-password'))
      .rejects.toThrow('Your current password is incorrect.');

    await auth.changeAdminPassword(before, PASSWORD, 'a-brand-new-password');

    const after = await prisma.user.findUniqueOrThrow({ where: { mobile: ADMIN } });
    expect(await verifyPassword('a-brand-new-password', after.passwordHash)).toBe(true);
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);

    // Put it back for the other tests in this file.
    await prisma.user.update({
      where: { mobile: ADMIN },
      data: { passwordHash: await hashPassword(PASSWORD) },
    });
  });
});
