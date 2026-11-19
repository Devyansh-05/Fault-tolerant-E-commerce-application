import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/env.js';
import apiRoutes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

/** Builds the Express application (no network listeners — see server.js). */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || config.frontendUrls.includes(origin)),
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposedHeaders: ['Idempotent-Replayed', 'Retry-After'],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    })
  );
  app.use(express.json({ limit: '100kb' }));

  if (!config.isTest) {
    app.use((req, res, next) => {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
      });
      next();
    });
  }

  app.use('/api', apiRoutes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
