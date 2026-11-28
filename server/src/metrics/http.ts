import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requestTraceId } from '../http/trace';
import { logger } from '../logger';
import { httpRequestDuration, httpRequestsTotal } from './registry';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The mount path of the router that handles this request (see markRouteBase). */
      routeBase?: string;
      /** The room the request is about (a valid :roomId route parameter), for the request log line. */
      logRoomId?: string;
    }
  }
}

/** Route label for a request that matched no route, so raw URLs never become label values. */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Remembers the router's mount path. Express resets req.baseUrl when a request falls out of a
 * router (for example, an error passed to the app-level error handler), so it is not reliable once
 * the response has finished. Mount this beside each router: `use('/rooms', markRouteBase, router)`.
 */
export const markRouteBase: RequestHandler = (req, _res, next) => {
  req.routeBase = req.baseUrl;
  next();
};

/** The route pattern, e.g. /api/v1/rooms/:roomId, never the raw URL. */
export function routeLabel(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string') return UNMATCHED_ROUTE;
  return `${req.routeBase ?? req.baseUrl}${routePath}`;
}

/** Only the API and the liveness check are measured; the static client bundle is not. */
function isMeasured(path: string): boolean {
  return path === '/health' || path.startsWith('/api/');
}

/** Probes polled every minute or so: logged at debug, so they do not flood the logs. */
const QUIET_ROUTES = new Set(['/health', '/api/v1/health', '/api/v1/metrics']);

/**
 * On every finished /api and /health response: http_requests_total and
 * http_request_duration_seconds (method, route pattern, status), and one log line with the
 * CLAUDE.md fields. Never logs the body, the query string or any header.
 */
export function requestMetrics(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isMeasured(req.path)) {
      next();
      return;
    }
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = routeLabel(req);
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, seconds);

      const fields = {
        event: 'http.request',
        traceId: requestTraceId(req),
        userId: req.user?.id ?? null,
        roomId: req.logRoomId ?? null,
        gameId: null,
        method: req.method,
        route,
        // originalUrl without the query string: ids only, never secrets.
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        durationMs: Math.round(seconds * 1000),
      };
      if (QUIET_ROUTES.has(route)) logger.debug(fields, 'request completed');
      else logger.info(fields, 'request completed');
    });
    next();
  };
}
