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
# spocart_api


## Admin database console (`/api/v1/admin/db`)

`src/routes/adminDb.js` exposes every table to admins (JWT with `role=admin`)
through one generic, validated CRUD surface used by the website's admin panel:

| Route | Purpose |
|---|---|
| `GET /admin/db` | table list with field metadata (types, enums, read-only, refs) — drives the UI forms |
| `GET /admin/db/_meta/stats` | row counts per table |
| `GET /admin/db/:table?q=&offset=&limit=` | search + paginate |
| `GET /admin/db/:table/:id` | one row (with relations, e.g. product tiers, order items/payments/history) |
| `POST /admin/db/:table` | create (zod-validated per table) |
| `PUT /admin/db/:table/:id` | partial update; money columns are rupees; product `tiers` and user `profile.*` are written through |
| `DELETE /admin/db/:table/:id` | delete with guards: category with products, product referenced by order lines, user with orders, non-cancelled orders or captured payments are refused |

Tables: categories, products, users, addresses, orders, payments, quotes,
leads, notifications, team, devices (read/delete), otp (read/delete).
System-generated tables (payments, quotes, devices, otp) cannot be created by hand.
