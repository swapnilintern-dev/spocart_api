// Checks a 2Factor API key end to end: sends a real OTP to a phone and prints
// the account balance.
//
// Put the key in .env (it is gitignored) and run:
//   node scripts/test-otp.js <mobile> [template-name]
//
// Without a template 2Factor uses the account default, which on a fresh trial
// may be delivered as a voice call — pass the approved SMS template name to
// force a text message.
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const key = (process.env.TWOFACTOR_API_KEY || '').trim();
if (!key) {
  console.error(`
❌ No API key found.

Add this line to the .env file in this folder (it is gitignored, never committed):

    TWOFACTOR_API_KEY=your-key-here

then run: npm run test:otp
`);
  process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const mobile = (process.argv[2] || await rl.question('Your 10-digit mobile: ')).trim();
rl.close();
const template = (process.argv[3] || '').trim();

if (!/^[6-9]\d{9}$/.test(mobile)) {
  console.error('❌ That is not a valid 10-digit Indian mobile number.');
  process.exit(1);
}

const get = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return await res.json().catch(() => ({ Status: 'Error', Details: `HTTP ${res.status}` }));
  } catch (e) {
    return { Status: 'Error', Details: e.message };
  }
};

console.log(`\nKey loaded (${key.length} characters, ends in …${key.slice(-4)})`);
console.log(`Sending OTP 123456 to +91${mobile}${template ? ` using template "${template}"` : ' (account default template)'} …`);

const sms = await get(`https://2factor.in/API/V1/${key}/SMS/${mobile}/123456${template ? `/${encodeURIComponent(template)}` : ''}`);
console.log(sms.Status === 'Success' ? '✅ Sent — check your phone' : `❌ ${sms.Status}: ${sms.Details}`);

const bal = await get(`https://2factor.in/API/V1/${key}/ADDON_SERVICES/BAL/SMS`);
console.log(`💰 Balance: ${typeof bal.Details === 'object' ? JSON.stringify(bal.Details) : bal.Details}`);

if (sms.Status === 'Success') {
  console.log(`
Next — Render → spocart-api → Environment:
  SMS_DRIVER=2factor
  TWOFACTOR_API_KEY=<the same key>${template ? `\n  TWOFACTOR_TEMPLATE_NAME=${template}` : ''}
  TWOFACTOR_VOICE_FALLBACK=true`);
}
