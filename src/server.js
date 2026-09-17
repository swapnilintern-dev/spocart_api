import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { startExpireUnpaidJob } from './jobs/expireUnpaid.js';

// Safety net: any BigInt that slips into a JSON response serialises as paise
// instead of crashing the request. Serialisers still convert to rupees explicitly.
BigInt.prototype.toJSON = function toJSON() { return Number(this); };

await prisma.$connect();
startExpireUnpaidJob();

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
