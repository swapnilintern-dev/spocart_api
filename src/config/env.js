// Reads and validates .env once. The server refuses to start with a bad config
// instead of failing on the first request.
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('30d'),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  SMS_DRIVER: z.enum(['console', 'msg91']).default('console'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default(''),
  ADMIN_MOBILES: z.string().default(''),
  UNPAID_ORDER_TTL_MINUTES: z.coerce.number().default(30),
  // File storage. All three must be set to use Cloudinary; otherwise uploads
  // fall back to local disk (fine for development, wiped on every Render deploy).
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
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
