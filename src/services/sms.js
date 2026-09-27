// OTP delivery behind one function, chosen with SMS_DRIVER:
//   console  — prints the code to the server log (local development)
//   2factor  — 2Factor.in; no DLT registration of your own, optional voice fallback
//   msg91    — MSG91 flow against your own DLT-registered template
//
// The OTP itself is always generated, hashed and verified by this server
// (see services/auth.js) — these drivers only carry it to the customer.
import { env } from '../config/env.js';

const timeout = (ms) => AbortSignal.timeout(ms);

/**
 * 2Factor: send our own code so expiry and attempt limits stay with us.
 * The SMS attempt is retried once before any voice fallback, because a slow
 * first call from a cold instance should not turn a text into a phone call.
 */
async function send2Factor(mobile, otp) {
  if (!env.TWOFACTOR_API_KEY) throw new Error('TWOFACTOR_API_KEY is required when SMS_DRIVER=2factor');
  const template = env.TWOFACTOR_TEMPLATE_NAME ? `/${encodeURIComponent(env.TWOFACTOR_TEMPLATE_NAME)}` : '';
  const url = `https://2factor.in/API/V1/${env.TWOFACTOR_API_KEY}/SMS/${mobile}/${otp}${template}`;

  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { signal: timeout(20_000) });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.Status === 'Success') {
        console.log(`[2factor] SMS queued for +91${mobile}${template ? ` (template ${env.TWOFACTOR_TEMPLATE_NAME})` : ' (no template)'} — session ${body.Details}`);
        return;
      }
      lastReason = body?.Details ?? `HTTP ${res.status}`;
    } catch (e) {
      lastReason = e.name === 'TimeoutError' ? 'timed out after 20s' : e.message;
    }
    console.warn(`[2factor] SMS attempt ${attempt} failed for +91${mobile}: ${lastReason}`);
  }

  if (env.TWOFACTOR_VOICE_FALLBACK) {
    console.warn(`[2factor] falling back to a voice call for +91${mobile}`);
    try {
      const voice = await fetch(`https://2factor.in/API/V1/${env.TWOFACTOR_API_KEY}/VOICE/${mobile}/${otp}`, { signal: timeout(20_000) });
      const vb = await voice.json().catch(() => null);
      if (voice.ok && vb?.Status === 'Success') return;
      lastReason = `${lastReason}; voice also failed: ${vb?.Details ?? voice.status}`;
    } catch (e) {
      lastReason = `${lastReason}; voice also failed: ${e.message}`;
    }
  }
  throw new Error(`2Factor could not deliver the OTP: ${lastReason}`);
}

async function sendMsg91(mobile, variables) {
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
    signal: timeout(10_000),
  });
  if (!res.ok) throw new Error(`MSG91 responded ${res.status}: ${await res.text()}`);
}

export async function sendSms(mobile, variables) {
  switch (env.SMS_DRIVER) {
    case '2factor': return send2Factor(mobile, variables.otp);
    case 'msg91': return sendMsg91(mobile, variables);
    default:
      console.log(`\n[SMS → +91${mobile}] OTP ${variables.otp} (valid 5 minutes)\n`);
  }
}
