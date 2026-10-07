import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { corsOrigins, env, isProd } from './config/env.js';
import { errorHandler, notFound } from './middleware/error.js';
import { apiLimiter } from './middleware/rateLimit.js';
import webhooks from './routes/webhooks.js';
import routes from './routes/index.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
/**
 * Which browsers may call this API.
 *
 * CORS_ORIGINS lists the real sites. Loopback is always allowed on top of it,
 * on any port: `flutter run -d chrome` picks a fresh random port every time, so
 * a fixed list can never contain it and every request from a developer's own
 * browser was being blocked.
 *
 * This is not the security boundary — the API is authenticated with a bearer
 * token, not a cookie, so a page on someone else's site cannot borrow a
 * session. And a loopback origin means code already running on that person's
 * own machine.
 */
const isLoopback = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

app.use(cors({
  origin(origin, done) {
    // No Origin at all: curl, a mobile app, a webhook. Nothing to check.
    if (!origin) return done(null, true);
    if (isLoopback(origin)) return done(null, true);
    if (corsOrigins.length === 0 || corsOrigins.includes(origin)) return done(null, true);
    done(null, false);
  },
}));
app.use(pinoHttp({
  level: env.NODE_ENV === 'test' ? 'silent' : isProd ? 'info' : 'debug',
  autoLogging: { ignore: (req) => req.url === '/health' },
}));

// Webhooks first: they need the raw body, before express.json() consumes it.
app.use('/api/v1/webhooks', webhooks);

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static('uploads', { maxAge: '7d', immutable: true }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'spocart-api', time: new Date().toISOString() }));
app.use('/api/v1', apiLimiter, routes);
app.use(notFound);
app.use(errorHandler);

export default app;
