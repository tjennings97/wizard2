/** Error body from the API (docs/api/openapi-spec.md, Error Catalogue). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Field errors from a 400 VALIDATION_ERROR (`details.fields`), keyed by request field. */
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** 401 codes that mean the client must show the login screen. */
export const SESSION_ENDED_CODES = ['UNAUTHORIZED', 'SESSION_INVALIDATED', 'REAUTH_REQUIRED'] as const;

let onSessionEnded: ((code: string) => void) | null = null;

/** AuthContext registers this so any request that finds the session over shows the login screen. */
export function setSessionEndedHandler(handler: ((code: string) => void) | null): void {
  onSessionEnded = handler;
}

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Do not treat a 401 as the end of the session (login, and the initial /users/me probe). */
  ignoreSessionEnd?: boolean;
}

export async function apiFetch<T>(path: string, { method = 'GET', body, ignoreSessionEnd = false }: Options = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code: string = data?.code ?? 'INTERNAL_ERROR';
    if (res.status === 401 && !ignoreSessionEnd && (SESSION_ENDED_CODES as readonly string[]).includes(code)) {
      onSessionEnded?.(code);
    }
    // Every route but the credential-change ones refuses a flagged user: show the change screen.
    if (res.status === 403 && code === 'CREDENTIAL_CHANGE_REQUIRED') onSessionEnded?.(code);
    const fields = data?.details?.fields && typeof data.details.fields === 'object' ? data.details.fields : {};
    throw new ApiRequestError(res.status, code, data?.message ?? `Request failed (${res.status}).`, fields);
  }
  return data as T;
}
