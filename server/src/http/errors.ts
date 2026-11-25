import type { ErrorRequestHandler, Response } from 'express';
import { logger } from '../logger';
import { requestTraceId } from './trace';

/** Error response body. See the Error Catalogue in docs/api/openapi-spec.md. */
export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** An expected, client-facing error. Thrown from route handlers and turned into a response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendError(res: Response, status: number, body: ErrorBody): void {
  res.status(status).json(body);
}

/** Error codes for client errors raised by express.json() (body-parser), keyed by status. */
const BODY_PARSER_CODES: Record<number, ErrorBody> = {
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Request body encoding or charset is not supported.' },
};

/** A client error that a library (e.g. body-parser) marked safe to report: 4xx with expose. */
function exposedClientStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && e.expose === true ? status : undefined;
}

/** Final error handler: ApiErrors map to their status; everything else is a 500 with a traceId. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // A response is already being streamed (e.g. sendFile): let Express close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiError) {
    sendError(res, err.status, { code: err.code, message: err.message, details: err.details });
    return;
  }

  // Malformed JSON body from express.json().
  if (err?.type === 'entity.parse.failed') {
    sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' });
    return;
  }

  // Other client errors from express.json(): body too large, unsupported encoding or charset.
  const clientStatus = exposedClientStatus(err);
  if (clientStatus !== undefined) {
    sendError(
      res,
      clientStatus,
      BODY_PARSER_CODES[clientStatus] ?? { code: 'VALIDATION_ERROR', message: 'Request body could not be read.' },
    );
    return;
  }

  const traceId = requestTraceId(req);
  // Never log the request body: auth routes carry passwords and passphrases.
  logger.error(
    { err, traceId, userId: req.user?.id, method: req.method, path: req.path },
    'unhandled request error',
  );
  sendError(res, 500, {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred.',
    details: { traceId },
  });
};
