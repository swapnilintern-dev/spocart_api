// Sets or resets an admin's password. There is deliberately no route for this:
// the first password has to come from someone with server access, and a
// forgotten one has to be reset the same way. An admin changes their own
// password through POST /auth/admin/password once they can sign in.
//
//   npm run admin:password -- 9876543210
//   npm run admin:password:neon -- 9876543210      (against production)
//
// The password is typed at the prompt, never passed as an argument, so it does
// not end up in your shell history or in the process list.
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { prisma } from '../src/db/prisma.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/services/password.js';
import { adminMobiles } from '../src/config/env.js';

/** Reads a line without echoing it to the terminal. */
function askHidden(question) {
  let muted = false;
  const mutedOut = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: mutedOut, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const fail = (message) => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

const mobile = process.argv[2];

if (!/^[6-9]\d{9}$/.test(mobile ?? '')) {
  fail('Usage: npm run admin:password -- <10-digit mobile>');
}

if (!adminMobiles.has(mobile)) {
  fail(
    `${mobile} is not in ADMIN_MOBILES, so it would sign in as a buyer.\n` +
    '  Add it to ADMIN_MOBILES first (Render → Environment), then run this again.',
  );
}

const password = await askHidden(`  New password for ${mobile}: `);
const again = await askHidden('  Type it again: ');

if (password !== again) fail('The two passwords do not match. Nothing was changed.');
if (password.length < MIN_PASSWORD_LENGTH) {
  fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
}

// Upsert, so this works whether or not the admin has ever signed in. The role
// is set here too: it normally lands on first sign-in, and an admin who has
// not signed in yet would otherwise fail the role check at step 2.
const user = await prisma.user.upsert({
  where: { mobile },
  create: { mobile, role: 'admin', passwordHash: await hashPassword(password) },
  update: { role: 'admin', passwordHash: await hashPassword(password), tokenVersion: { increment: 1 } },
});

console.log(`\n  Password set for ${mobile} (role: ${user.role}).`);
console.log('  Any session that admin already had is now signed out.\n');

await prisma.$disconnect();
