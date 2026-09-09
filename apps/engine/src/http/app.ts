import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { EventBus } from '../events/bus.js';
import type { ApprovalService } from '../executor/approvals.js';
import type { RunDispatcher } from '../executor/dispatcher.js';
import type { HaltController } from '../executor/halt.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { errorHandler, notFoundHandler, requestLogger } from './middleware.js';
import { protectedRoutes, publicRoutes } from './routes.js';

export interface AppDeps {
  config: Config;
  store: Store;
  bus: EventBus;
  halt: HaltController;
  approvals: ApprovalService;
  dispatcher: RunDispatcher;
  registry: ToolRegistry;
  log: Logger;
  clock: Clock;
  ids: () => string;
  redisPing: () => Promise<void>;
  /** Test hook; production uses SSE_HEARTBEAT_INTERVAL_MS. */
  sseHeartbeatMs?: number;
}

export const JSON_BODY_LIMIT = '256kb';

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use(helmet());
  app.use(
    cors({
      // Exact-match allow list. A request from any other origin gets no CORS headers at all.
      origin: (origin, cb) => {
        cb(null, origin !== undefined && config.corsOrigins.includes(origin) ? origin : false);
      },
      credentials: true,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Last-Event-ID'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));
  app.use(requestLogger(deps.log));

  app.use(publicRoutes(deps));
  app.use(protectedRoutes(deps));

  app.use(notFoundHandler());
  app.use(errorHandler(deps.log, config.isProduction));
  return app;
}
