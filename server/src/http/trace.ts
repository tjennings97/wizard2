import { randomUUID } from 'crypto';
import type { Request } from 'express';

const fallbackTraceIds = new WeakMap<Request, string>();
const issuedTraceIds = new WeakMap<Request, string>();

/**
 * For a request that issued a new session (login, register, a credential change): from here on its
 * log lines, the request log line included, carry the new session's traceId.
 */
export function useIssuedTraceId(req: Request, traceId: string): void {
  issuedTraceIds.set(req, traceId);
}

/**
 * The traceId to log for this request: the trace_id of a session the request just issued, else
 * the session's trace_id when authenticated, otherwise a random UUID that stays the same for every log line of this request.
 */
export function requestTraceId(req: Request): string {
  const issued = issuedTraceIds.get(req);
  if (issued) return issued;
  if (req.authSession) return req.authSession.traceId;
  let id = fallbackTraceIds.get(req);
  if (!id) {
    id = randomUUID();
    fallbackTraceIds.set(req, id);
  }
  return id;
}
