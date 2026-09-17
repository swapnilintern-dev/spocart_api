# spocart-api

Node.js + Express 5 + PostgreSQL (Prisma) backend for the SPOCART Flutter app and spocart.in.
Payments via Razorpay. Mobile-OTP auth. See the blueprint doc for the full design.

## Run locally

```bash
brew services start postgresql@16      # once
cp .env.example .env                   # fill DATABASE_URL, JWT_SECRET, Razorpay test keys
npm install
npx prisma migrate dev                 # creates / updates tables
npm run seed                           # 11 categories, 36 products
npm run dev                            # http://localhost:3000
```

With `SMS_DRIVER=console` the OTP prints in the server log.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | start with auto-reload |
| `npm run studio` | Prisma Studio — browse / edit tables in the browser |
| `npm run migrate` | create + apply a migration after editing `prisma/schema.prisma` |
| `npm run deploy` | apply pending migrations in production (no prompts) |
| `npm run seed` | re-seed the catalogue (safe to re-run) |
| `npm test` | unit + API tests |

## Razorpay (test mode)

1. Dashboard → Settings → API Keys → generate test keys → `.env`.
2. `ngrok http 3000`, then Dashboard → Webhooks → `https://<ngrok>/api/v1/webhooks/razorpay`,
   events `payment.captured`, `payment.failed`, `refund.processed`, secret → `RAZORPAY_WEBHOOK_SECRET`.
3. Test UPI id `success@razorpay`, test card `4111 1111 1111 1111`.

## API map

`/api/v1` — `auth/*`, `catalog/*`, `addresses`, `team`, `orders` (+ `orders/payments/verify`),
`invoices`, `dashboard`, `quotes`, `uploads/design`, `notifications`, `leads`, `admin/*`,
`webhooks/razorpay`. Every response is `{ ok, data }` or `{ ok: false, message }`.

Admins = mobile numbers listed in `ADMIN_MOBILES`; they sign in with the same OTP flow.
