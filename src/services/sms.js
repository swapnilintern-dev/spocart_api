// SMS delivery behind one function. `console` prints the OTP to the server log
// (local dev); `msg91` sends through a DLT-registered template in production.
import { env } from '../config/env.js';

export async function sendSms(mobile, variables) {
  if (env.SMS_DRIVER === 'console') {
    console.log(`\n[SMS → +91${mobile}] OTP ${variables.otp} (valid 5 minutes)\n`);
    return;
  }

  if (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID) {
    throw new Error('MSG91_AUTH_KEY / MSG91_TEMPLATE_ID are required when SMS_DRIVER=msg91');
  }

  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authkey: env.MSG91_AUTH_KEY },
    body: JSON.stringify({
      template_id: env.MSG91_TEMPLATE_ID,
      short_url: '0',
      recipients: [{ mobiles: `91${mobile}`, ...variables }],
    }),
  });
  if (!res.ok) throw new Error(`MSG91 responded ${res.status}: ${await res.text()}`);
}
