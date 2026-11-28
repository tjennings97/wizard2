import { createHash, timingSafeEqual } from 'crypto';
import { Router, type Request } from 'express';
import { config } from '../config';
import { asyncHandler } from '../http/asyncHandler';
import { ApiError } from '../http/errors';
import { registry } from '../metrics/registry';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time check of `Authorization: Bearer <PROMETHEUS_TOKEN>`. */
export function hasMetricsToken(req: Request, token: string = config.prometheusToken): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
  if (!match) return false;
  // Hash both sides so the comparison is the same length whatever the caller sent.
  return timingSafeEqual(digest(match[1].trim()), digest(token));
}

/**
 * GET /metrics: the Prometheus text exposition for Grafana Cloud's scraper. Protected by the
 * bearer token, not a session (docs/operations/observability-alerting.md, Metrics Registry).
 */
export const metricsRouter = Router();

metricsRouter.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    if (!hasMetricsToken(req)) {
      res.set('WWW-Authenticate', 'Bearer');
      throw new ApiError(401, 'UNAUTHORIZED', 'A valid metrics bearer token is required.');
    }
    const body = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.set('Cache-Control', 'no-store');
    res.status(200).send(body);
  }),
);
