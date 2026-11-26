import rateLimit, { type Options } from 'express-rate-limit';
import { requestTraceId } from '../http/trace';
import { logger } from '../logger';

/**
 * Per-IP limits on auth endpoints, from §6 of docs/architecture/security.md.
 * State is in memory, which is correct for the single Railway instance.
 */
function authLimiter(
  name: string,
  limit: number,
  windowMs: number,
  message: string,
  extra: Pick<Partial<Options>, 'skip' | 'skipSuccessfulRequests'> = {},
) {
  return rateLimit({
    ...extra,
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: true, // X-RateLimit-Remaining, per the OpenAPI error catalogue notes
    handler: (req, res, _next, options) => {
      logger.warn({ endpoint: name, ip: req.ip, traceId: requestTraceId(req) }, 'auth rate limit hit');
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
 * PATCH /users/me requests that carry currentPassword. Only failed attempts count, so a
 * stolen session cannot be used to guess the password, while normal changes are never blocked.
 */
export const currentPasswordLimiter = authLimiter(
  'users-me-current-password',
  10,
  15 * MINUTE,
  'Too many incorrect password attempts. Please try again later.',
  {
    skip: (req) => !(req.body && typeof req.body === 'object' && 'currentPassword' in req.body),
    skipSuccessfulRequests: true,
  },
);
