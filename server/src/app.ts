import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { errorHandler } from './http/errors';
import { requestMetrics } from './metrics/http';
import { createApiRouter, type ApiDeps } from './routes';

export function createApp(deps: ApiDeps) {
  const app = express();
  app.disable('x-powered-by');
  // Needed for per-IP rate limiting behind Railway's proxy; 0 (local) ignores X-Forwarded-For.
  app.set('trust proxy', config.trustProxyHops);

  // Production allows only the production origin; development allows the Vite dev server.
  // First, so it times the whole request and sees every response, errors included.
  app.use(requestMetrics());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(cookieParser(config.sessionSecret));
  app.use(express.json());

  // Liveness check at the root as well as under /api/v1
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api/v1', createApiRouter(deps));

  // In production, serve the built React app from the same origin.
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
