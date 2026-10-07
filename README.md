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


## File storage (Cloudinary)

Product photos, category tiles and customer uploads (jersey artwork from the app,
BOQ / tender documents from the website) go to Cloudinary under
`spocart/products`, `spocart/categories` and `spocart/quotes`.

Set in the Render dashboard (never in the repo):

```
CLOUDINARY_CLOUD_NAME   CLOUDINARY_API_KEY   CLOUDINARY_API_SECRET
```

Without those three the API falls back to local disk (`uploads/`), which is fine
for development but is wiped on every Render deploy.

Images are delivered through Cloudinary with `f_auto,q_auto` (WebP/AVIF, automatic
quality) — roughly 5–10× smaller than the originals. Raw files (PDF, CSV, XLSX)
are served unchanged.

One-time move of existing files and URLs:

```bash
npm run migrate:uploads             # dry run — shows what would change
npm run migrate:uploads -- --apply  # uploads and rewrites the stored URLs
```

Never delete a Cloudinary asset that an old order references: `order_items.image`
keeps the photo as it was when the order was placed.


## Sign-in methods

Two ways in, both ending in the same SPOCART JWT and the same `users` row:

| Method | Endpoint | Who sends the SMS |
|---|---|---|
| Built-in OTP | `POST /auth/otp/send` → `POST /auth/otp/verify` | this server (`SMS_DRIVER`) |
| Firebase phone auth | client completes OTP with Firebase → `POST /auth/firebase` with `{ idToken }` | Google |

`GET /auth/methods` reports which are available, so the clients do not hardcode it.

Firebase is enabled by setting `FIREBASE_SERVICE_ACCOUNT` (service-account JSON,
one line or base64) in the Render dashboard. The token is verified with the
Admin SDK — including revocation — and the phone number is read from the token,
never from the request body.


## OTP delivery (`SMS_DRIVER`)

The code is always created, hashed, expired (5 min) and attempt-limited (5) by
this server; the driver only carries it to the customer.

| Driver | Needs | Notes |
|---|---|---|
| `console` | — | prints the code in the server log (development) |
| `2factor` | `TWOFACTOR_API_KEY` | 2Factor.in; no DLT registration of your own. `TWOFACTOR_TEMPLATE_NAME` optional, `TWOFACTOR_VOICE_FALLBACK=true` retries as a voice call when the SMS fails |
| `msg91` | `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | your own DLT-registered template |

Switching providers is an environment change — the app and website are untouched.


## Changing the registered mobile number (`/api/v1/auth/mobile/change`)

The contact number used to change without verification. It cannot any more:
`PUT /auth/profile` ignores any `mobile` in the body and always stores the
account's own verified number, so the only way to move an account is:

| Route | Purpose |
|---|---|
| `POST /auth/mobile/change/send` | authenticated; sends a code to the **new** number. Refuses your current number (400) and a number another account owns (409) |
| `POST /auth/mobile/change/verify` | authenticated; on the correct code updates `users.mobile` and the profile's contact mobile in one transaction, bumps `tokenVersion` (other devices are signed out) and returns a fresh token |

OTP codes are now bound to what they were issued for (`otp_codes.purpose`,
`login` or `mobileChange`), and the purpose is part of the hash — a sign-in code
can never complete a number change. Each code lives 5 minutes, dies after 5
wrong attempts, and cannot be re-sent within 60 seconds (`otp_codes.sent_at`).
The OTP endpoints are rate limited twice: generously per IP (a shop shares one)
and per mobile number, which is the limit that matters.

## PIN code lookup (`GET /api/v1/addresses/pincode/:pincode`)

Authenticated. Returns `{ pincode, city, district, state }` from India Post
(`api.postalpincode.in`), cached in the `pincodes` table — the second lookup of
a PIN is served from our own database. A PIN that does not exist answers 404; a
PIN we have never seen while the upstream service is unreachable answers 503, and
a stale cached row is preferred over failing. No API key and no new environment
variable: the service is free and unauthenticated. The address form always
allows typing the city and state by hand.


## Best sellers (`/api/v1/catalog/best-sellers`)

Ranked from real order lines, not a hand-set flag.

| Route | Purpose |
|---|---|
| `GET /catalog/best-sellers?limit=10` | public; product ids in rank order for the home rail |
| `GET /admin/best-sellers?limit=25` | admin; units and order count per product over the window |
| `PUT /admin/products/:id/pin` `{rank}` | pins a product to the front (a new launch has no sales to rank on) |
| `DELETE /admin/products/:id/pin` | unpins it |

Counted over the last 30 days from `order_items`, and only for orders that are a
real sale — `placed`, `packed`, `dispatched`, `outForDelivery`, `delivered`.
Cancelled and still-unpaid orders are excluded, so an abandoned checkout cannot
push a product up the list. Inactive products are dropped from the result.

Pinned products (`products.featured_rank`, lower first) come before the sales
ranking. The ranking is held in process for 10 minutes and cleared immediately
whenever a product is pinned, unpinned or edited through the admin console.

The endpoint returns ids only: the app already holds the catalogue and resolves
them itself, so the rail costs one small request.


## Offers, deals and product video

| Route | Purpose |
|---|---|
| `GET /promotions/active` | the one live offer for this buyer (optional auth); null when none |
| `GET /catalog/deals` | products with a recorded price drop or a tracked low stock |
| `GET /catalog/new-launches` | newest products, for a range with no sales history yet |
| `POST /admin/price-drops/notify` | sends the pending drop notifications now instead of waiting for the cron |

Offers live in `promotions` and are edited in the admin console: title, body,
image, audience (`all` / `registered` / `unregistered`), a start and end time,
a priority and an on/off switch. Where one leads is checked **on write** — a
product or category id must exist, and a plain link must be `https`, so a
buyer's app never has to judge whether a destination is safe.

**Nothing on the Deals shelf is invented.** A product shows a saving only
because `price_changes` recorded the old and new entry price when an admin
changed it (through either the product screen or the database console), and a
price that went *up* is kept as history but never shown as a deal. "Only N left"
appears only when someone actually set `products.stock_qty`; a product with
untracked stock says nothing about quantity. Each recorded drop notifies the
buyers who bought that product before, once — the `notified` flag is what stops
a second round, and the 5-minute cron sends them.

Product video is an official YouTube link. Any `watch` / `youtu.be` / `embed` /
`shorts` / `m.youtube` form is accepted on write, stored canonically, and served
with its thumbnail; anything else is refused.


## Reviews (`/api/v1/reviews`, `/api/v1/catalog/products/:id/reviews`)

| Route | Who |
|---|---|
| `GET /catalog/products/:id/reviews` | public (optional auth marks which one is yours); approved reviews, newest first, with the star breakdown |
| `GET /reviews/pending` | buyer; products they have received and not yet reviewed |
| `PUT /reviews/:productId` | buyer; writes **or edits** their one review of that product |
| `DELETE /reviews/:reviewId` | the author, or an admin |
| `GET /admin/reviews?status=` | moderation queue |
| `PUT /admin/reviews/:id/status` | approve / hide, with an optional note |

**Eligibility is proved, not claimed.** A review is only accepted when the buyer
has a **delivered** order of their own containing that product; the order id is
stored on the review, which is what makes "Verified buyer" a fact rather than a
flag the client sent. One review per buyer per product — submitting again
replaces it, so there is no way to stuff the rating.

`products.rating` and `products.review_count` are **recomputed from the approved
reviews** on every write, moderation change and delete, so the stars on a
product card always match the reviews behind them. A product with no approved
reviews reads 0 rather than keeping a stale average.

`REVIEW_MODERATION` chooses the starting state: `auto` (the default) publishes a
verified buyer's review immediately and lets an admin hide it; `manual` holds
every review for approval. Reviewer names show the business name, or a masked
mobile number — never the full number.


## Barcode lookup (`GET /api/v1/catalog/barcode/:code`)

Public, so a buyer can scan before signing in. `products.barcode` is unique and
nullable: a code nobody has entered yet answers 404 and the app says so rather
than guessing at a product. Admins enter the code on the product screen or in
the database console, which also searches by it.

**No product carries a barcode yet** — scanning will keep reporting "no SPOCART
product carries that barcode" until real codes are entered.


## Rewards and credits (`/api/v1/rewards`)

**The business decision is not made yet, so it is a setting, not code.** The CEO
proposed a daily streak; purchase-based credits suit a trade buyer who orders
once a week. `reward_settings` supports `purchase`, `streak` or `both`, and
**every value starts at zero with `active` false** — nothing is earned or
redeemed, and the app hides rewards entirely, until someone sets real numbers in
the admin panel.

| Route | Who |
|---|---|
| `GET /rewards` | buyer; balance, qualifying purchases, streak, gift tiers and progress |
| `GET /rewards/ledger` | buyer; every movement, so a balance can be explained line by line |
| `POST /rewards/check-in` | buyer; today's credits, once |
| `GET /rewards/redeemable?total=` | buyer; how many credits may be spent on an order that size |
| `GET` / `PUT /admin/rewards/settings` | the rules |
| `GET` / `PUT /admin/rewards/claims` | who reached a gift tier, and marking it delivered |
| `POST /admin/rewards/adjust` | a manual correction, which lands in the ledger like any other entry |

Gift tiers and the ledger are also in the database console (`rewardTiers`,
`rewardClaims`, `credits` — the ledger is read-only there, because history is
not edited; corrections go through `/admin/rewards/adjust`).

**A balance is always the sum of the ledger**, never a column that could drift.
Every entry carries an `event_key` naming what it was for, written with
`ON CONFLICT DO NOTHING`, so the same order, the same day's check-in or the same
redemption can only ever count once — whether it arrives from the payment
verify, the Razorpay webhook or the reconciler. Cancelling an order writes a
reversing entry rather than deleting history. The check-in day is the server's,
in Asia/Kolkata, so changing a phone's clock earns nothing. Redeeming is capped
by the balance and by `max_redeem_percent` of the order, and the balance is
re-read inside the transaction so two taps cannot spend the same credits.

**Still needed from the business:** the gift slabs from the rewards spreadsheet,
and the decision between a streak and purchase-based credits.


## Analytics (`POST /api/v1/events`, `GET /api/v1/admin/analytics/*`)

Two kinds of number, never mixed:

| | Source | Labelled |
|---|---|---|
| Active users, the cart funnel, product interest, search health | `usage_events`, reported by the app | `estimate: true` |
| Sales, GST, buyer activity | the `orders` themselves | `estimate: false` |

A phone's report can be lost offline or sent twice, so counts of behaviour are
estimates and say so. **Money is never read from an event** — a sales figure is
an accounting fact and cannot depend on whether a report arrived.

| Route | Returns |
|---|---|
| `POST /events` | the app's batch (optional auth — visits before sign-in count) |
| `GET /admin/analytics/active-users?days=` | DAU, MAU and the ratio, by device and by signed-in buyer, with a daily series |
| `GET /admin/analytics/funnel?days=` | opened → viewed → added → checkout → ordered, by device |
| `GET /admin/analytics/products?days=` | most-viewed products and how often a view becomes a cart line |
| `GET /admin/analytics/search?days=` | how often a search comes back empty |
| `GET /admin/analytics/sales?from=&to=` | orders, buyers, subtotal, GST, total, average, daily series |
| `GET /admin/analytics/buyers?quietDays=` | who orders, what they spend, and who has gone quiet |

**Nothing a buyer typed is stored.** An event's `meta` is filtered down to whole
numbers under four known keys (`results`, `queryLength`, `quantity`,
`position`); a search records how long the query was and whether it matched,
never the query. An unrecognised event name is dropped rather than stored, so a
later app version cannot write junk into the table. `deviceId` identifies an
install so an anonymous visitor is counted once — it is not a person.


## AI-assisted search (`POST /api/v1/catalog/assist`)

A buyer describes what they need — "kit for 50 kids under 12" — and gets
products from our own catalogue.

**Off by default.** It runs only when `AI_SEARCH_ENABLED` is true **and**
`ANTHROPIC_API_KEY` is set, so no paid call can happen before the business has
approved the per-search cost. `GET /catalog/assist/status` says whether it is on
and, if not, which of the two is missing.

When it is off — or the model fails, times out after 12 s, or answers with
something that is not JSON — the ordinary search answers instead. The response
carries `source: 'ai' | 'search'`, so a buyer always gets products and the app
can say where they came from.

Two rules make it safe to switch on:

1. **Grounded.** The model is given the catalogue and may only answer with ids
   from it. Any id it invents is dropped before anything is returned, so a
   product that does not exist cannot reach a buyer.
2. **It never speaks about money or stock.** The catalogue sent to the model
   carries no prices at all; prices, MOQ and availability are attached from the
   database afterwards. A wrong number cannot be quoted even if the model
   claims one.

Limited to 10 searches a minute per caller, capped at 8 suggestions per answer
and 300 products of context. `AI_SEARCH_MODEL` defaults to `claude-sonnet-5-5`.


## Signing in before DLT approval (`DEV_OTP_ECHO`)

Until the DLT template is approved there is no way to deliver an SMS, so the OTP
comes back in the response and the app shows it on its own screen. This happens
only with `SMS_DRIVER=console`, and **in production only when `DEV_OTP_ECHO` is
explicitly set true** — the server then prints a warning on every boot.

```
*** DEV_OTP_ECHO is ON in production. OTPs are returned to the caller and
anyone who knows a mobile number can sign in as it. Turn this off as soon as
SMS delivery works. ***
```

That warning is the whole point: while this is on, **anyone who knows a mobile
number can sign in as that buyer.** It is for testing the app end to end while
SMS delivery is still being sorted out, and it must be turned off the day real
SMS works.

`DEV_OTP_ECHO` wins wherever it is set, **including over a real SMS gateway** —
the shop needs to be able to sign in even when delivery is unreliable. On a real
driver every code is then *also* sent as a paid SMS, so the server says so on
boot and `SMS_DRIVER=console` is the cheaper way to test. Without the flag,
only a development server on the console driver echoes.


## Sample data (`npm run seed:samples`)

Fills the empty parts of the catalogue so every feature can be seen working
before the real data arrives. Safe to run more than once — each step checks what
is already there.

```bash
npm run seed:samples                  # say what it would do
npm run seed:samples -- --apply       # do it
npm run seed:samples -- --apply --remove   # take the samples back out
npm run seed:samples:neon -- --apply  # the same, against the Neon database
```

It sets a catalogue photo on every product that lacks one, a valid EAN-13
barcode on each (generated from the id — **not** the code on your cartons), a
stock count on four products with two low enough to show "Only N left", a
placeholder video on one product, two genuine price drops so the Deals shelf has
something real, one live offer, three gift tiers with the rewards programme
switched on, and two reviews written by the buyer of a delivered order.

It also clears the **made-up ratings** the original seed shipped with: 34
products showed "4.5 ★ (124 reviews)" with no reviews behind them. After this a
product's stars always come from real reviews, and a product with none says
"No reviews yet".

Everything it writes is a stand-in meant to be replaced — above all the
barcodes and the video link.
