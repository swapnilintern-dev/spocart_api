// Reads and validates .env once. The server refuses to start with a bad config
// instead of failing on the first request.
import 'dotenv/config';
import { z } from 'zod';

/**
 * An on/off setting from the environment.
 *
 * `z.coerce.boolean()` is a trap here: it is `Boolean(string)`, so "false",
 * "0" and "no" all come out **true**. Someone turning a flag off by setting it
 * to false would switch it on — which for DEV_OTP_ECHO means handing out OTPs,
 * and for AI_SEARCH_ENABLED means paying per search. Only the words below mean
 * on; everything else, including nothing at all, means off.
 */
export const boolish = (fallback = false) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      if (typeof v === 'boolean') return v;
      return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('30d'),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  SMS_DRIVER: z.enum(['console', '2factor', 'msg91']).default('console'),
  TWOFACTOR_API_KEY: z.string().optional(),
  TWOFACTOR_TEMPLATE_NAME: z.string().optional(),
  TWOFACTOR_VOICE_FALLBACK: boolish(false),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default(''),
  ADMIN_MOBILES: z.string().default(''),
  UNPAID_ORDER_TTL_MINUTES: z.coerce.number().default(30),
  // 'auto' publishes a verified buyer's review straight away and lets an admin
  // hide it; 'manual' holds every review until an admin approves it.
  REVIEW_MODERATION: z.enum(['auto', 'manual']).default('auto'),
  // Shows the OTP on the app's own screen instead of sending an SMS, so the
  // whole app can be tested before DLT approval comes through. Anyone who knows
  // a mobile number can sign in as it while this is on, so it must be turned
  // off the moment real SMS is live. The server says so loudly at startup.
  DEV_OTP_ECHO: boolish(false),
  // AI-assisted search. Off unless the business has approved the per-search
  // cost AND a key is set; the ordinary typo-tolerant search answers otherwise.
  AI_SEARCH_ENABLED: boolish(false),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_SEARCH_MODEL: z.string().default('claude-sonnet-5-5'),
  // File storage. All three must be set to use Cloudinary; otherwise uploads
  // fall back to local disk (fine for development, wiped on every Render deploy).
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  // Firebase phone sign-in (app + website). Paste the service-account JSON
  // (or its base64) in the Render dashboard; leave empty to keep the built-in
  // OTP flow as the only way in.
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
export const adminMobiles = new Set(env.ADMIN_MOBILES.split(',').map((s) => s.trim()).filter(Boolean));
