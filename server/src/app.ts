import express from 'express';
import fs from 'fs';
import path from 'path';
import { apiRouter } from './routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Liveness check at the root as well as under /api/v1
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api/v1', apiRouter);

  // In production, serve the built React app from the same origin.
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}
