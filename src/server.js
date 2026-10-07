import app from './app.js';
import { env, isProd } from './config/env.js';
import { prisma } from './db/prisma.js';
import { startExpireUnpaidJob } from './jobs/expireUnpaid.js';

// Safety net: any BigInt that slips into a JSON response serialises as paise
// instead of crashing the request. Serialisers still convert to rupees explicitly.
BigInt.prototype.toJSON = function toJSON() { return Number(this); };

await prisma.$connect();
startExpireUnpaidJob();

// Loud and every single boot: with this on, anyone who knows a mobile number
// can sign in as it, because the code comes back in the response instead of an
// SMS. It exists so the app can be tested before DLT approval, and it has to go
// off the day real SMS is live.
if (env.DEV_OTP_ECHO) {
  console.warn(
    `\n*** DEV_OTP_ECHO is ON${isProd ? ' in production' : ''}. OTPs are returned ` +
    'to the caller, so anyone who knows a mobile number can sign in as it. ' +
    'Turn this off as soon as SMS delivery works. ***',
  );
  if (env.SMS_DRIVER !== 'console') {
    console.warn(
      `*** SMS_DRIVER is "${env.SMS_DRIVER}", so every code is ALSO sent as a real ` +
      'SMS and charged. Set SMS_DRIVER=console while testing. ***\n',
    );
  } else {
    console.warn('');
  }
}

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`SPOCART API listening on http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
