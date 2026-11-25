import { randomUUID } from 'crypto';
import type { Request } from 'express';

const fallbackTraceIds = new WeakMap<Request, string>();

/**
 * The traceId to log for this request: the session's trace_id when authenticated, otherwise a
 * random UUID that stays the same for every log line of this request.
 */
export function requestTraceId(req: Request): string {
  if (req.authSession) return req.authSession.traceId;
  let id = fallbackTraceIds.get(req);
  if (!id) {
    id = randomUUID();
    fallbackTraceIds.set(req, id);
  }
  return id;
}
