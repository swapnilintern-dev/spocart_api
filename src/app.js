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
app.use(cors({ origin: corsOrigins.length ? corsOrigins : true }));
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
