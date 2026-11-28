import rateLimit, { type Options } from 'express-rate-limit';
import { requestTraceId } from '../http/trace';
import { logger } from '../logger';
import { rateLimitHitsTotal } from '../metrics/registry';

/**
 * Per-IP limits on auth endpoints, from §6 of docs/architecture/security.md.
 * State is in memory, which is correct for the single Railway instance.
 */
function authLimiter(
  name: string,
  limit: number,
  windowMs: number,
  message: string,
  extra: Pick<Partial<Options>, 'skip' | 'skipSuccessfulRequests' | 'requestWasSuccessful'> = {},
) {
  return rateLimit({
    ...extra,
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: true, // X-RateLimit-Remaining, per the OpenAPI error catalogue notes
    handler: (req, res, _next, options) => {
      rateLimitHitsTotal.inc({ endpoint: name });
      logger.warn({ event: 'auth.rate_limited', endpoint: name, ip: req.ip, traceId: requestTraceId(req) }, 'auth rate limit hit');
      res.status(options.statusCode).json({ code: 'RATE_LIMITED', message });
    },
  });
}

const MINUTE = 60 * 1000;

export const loginLimiter = authLimiter(
  'login',
  10,
  15 * MINUTE,
  'Too many login attempts. Please try again later.',
);
export const registerLimiter = authLimiter(
  'register',
  5,
  60 * MINUTE,
  'Too many registration attempts. Please try again later.',
);
export const resetPasswordLimiter = authLimiter(
  'reset-password',
  5,
  60 * MINUTE,
  'Too many password reset attempts. Please try again later.',
);

/**
 * POST /bug-reports: 10 per hour per user (docs/architecture/security.md §6), to stop report
 * flooding. Stacks after requireAuth, so the key is the user id; one user cannot dodge it by
 * changing IP, and players sharing an IP do not share a budget.
 */
export const bugReportLimiter = rateLimit({
  windowMs: 60 * MINUTE,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: true,
  keyGenerator: (req) => `user:${req.user?.id ?? ''}`,
  handler: (req, res, _next, options) => {
    rateLimitHitsTotal.inc({ endpoint: 'bug-reports' });
    logger.warn({ event: 'rate_limited', endpoint: 'bug-reports', ip: req.ip, userId: req.user?.id, traceId: requestTraceId(req) }, 'rate limit hit');
    res.status(options.statusCode).json({ code: 'RATE_LIMITED', message: 'Too many bug reports. Please try again later.' });
  },
});

/**
 * PATCH /users/me requests that carry currentPassword. Only wrong-password responses (401)
 * count, so a stolen session cannot be used to guess the password, while typos in the new
 * secrets (400) and normal changes never use up the budget.
 */
export const currentPasswordLimiter = authLimiter(
  'users-me-current-password',
  10,
  15 * MINUTE,
  'Too many incorrect password attempts. Please try again later.',
  {
    skip: (req) => !(req.body && typeof req.body === 'object' && 'currentPassword' in req.body),
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  },
);
