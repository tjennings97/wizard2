import { apiFetch } from './http';

export type BugSeverity = 'low' | 'medium' | 'high';

/** Captured on the client when the report is sent (POST /bug-reports `context`). */
export interface BugReportContext {
  url: string;
  page: string;
  roomId: string | null;
  gameId: string | null;
  roundNumber: number | null;
  trickNumber: number | null;
  userAgent: string;
  clientTimestamp: string;
}

export interface BugReportInput {
  description: string;
  severity?: BugSeverity;
  context: BugReportContext;
}

/**
 * The server adds the user, their session's traceId and, if they are playing, their own view of
 * the game, so the client never sends game state.
 */
export const submitBugReport = (input: BugReportInput) =>
  apiFetch<{ reportId: string; message: string }>('/bug-reports', { method: 'POST', body: input });
