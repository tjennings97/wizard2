import { apiFetch } from './http';
import type { User } from './types';

/** Admin routes (docs/api/openapi-spec.md, Admin Endpoints). Every one requires the admin role. */

export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface Invite {
  id: string;
  label: string | null;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: string | null;
  redeemedByUsername: string | null;
}

export interface CreatedInvite {
  invite: Invite;
  /** The raw code. Returned once and never stored: show it, then forget it. */
  code: string;
}

/** GET /admin/users rows: the public User fields. */
export type AdminUser = User;

export interface UserPage {
  data: AdminUser[];
  total: number;
  page: number;
  limit: number;
}

export interface TemporaryCredentials {
  temporaryPassword: string;
  temporaryPassphrase: string;
  note: string;
}

export const listInvites = (status?: InviteStatus) =>
  apiFetch<Invite[]>(`/admin/invites${status ? `?status=${status}` : ''}`);

export const createInvite = (label: string) =>
  apiFetch<CreatedInvite>('/admin/invites', { method: 'POST', body: label ? { label } : {} });

export const revokeInvite = (inviteId: string) =>
  apiFetch<void>(`/admin/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' });

export const listUsers = (page: number, limit: number) =>
  apiFetch<UserPage>(`/admin/users?page=${page}&limit=${limit}`);

export const setUserRole = (userId: string, role: User['role']) =>
  apiFetch<User>(`/admin/users/${encodeURIComponent(userId)}/role`, { method: 'PATCH', body: { role } });

export const resetCredentials = (userId: string) =>
  apiFetch<TemporaryCredentials>(`/admin/users/${encodeURIComponent(userId)}/reset-credentials`, { method: 'POST' });

export type BugSeverity = 'low' | 'medium' | 'high';

/** Why an admin dismissed a report. A report with no resolution is open. */
export type BugResolution = 'resolved' | 'not_a_bug' | 'cannot_reproduce' | 'wont_fix';

export const BUG_RESOLUTION_LABELS: Record<BugResolution, string> = {
  resolved: 'Resolved',
  not_a_bug: 'Not a bug',
  cannot_reproduce: 'Cannot reproduce',
  wont_fix: "Won't fix",
};

/** `open`: not yet dismissed. `dismissed`: has a resolution. */
export type BugStatus = 'open' | 'dismissed';

/** GET /admin/bug-reports rows (the `AdminBugReport` schema). */
export interface AdminBugReport {
  id: string;
  createdAt: string;
  severity: BugSeverity | null;
  description: string;
  /** Null when the report has no user_id (not expected: the submit route always sets it). */
  reporter: { id: string; username: string | null; displayName: string | null } | null;
  roomId: string | null;
  gameId: string | null;
  /** Search the server logs for this (docs/operations/observability-alerting.md). */
  traceId: string;
  /** bug_reports.context: url, page, round_number, trick_number, game_state_summary, user_agent, client_timestamp. */
  context: Record<string, unknown>;
  /** Null while the report is open. */
  resolution: BugResolution | null;
  resolvedAt: string | null;
  resolvedBy: { id: string; username: string | null; displayName: string | null } | null;
}

export interface BugReportPage {
  data: AdminBugReport[];
  total: number;
  page: number;
  limit: number;
}

export const listBugReports = (page: number, limit: number, severity?: BugSeverity, status?: BugStatus) =>
  apiFetch<BugReportPage>(
    `/admin/bug-reports?page=${page}&limit=${limit}${severity ? `&severity=${severity}` : ''}${status ? `&status=${status}` : ''}`,
  );

/** Dismiss a handled report with why, or reopen it with null. */
export const setBugResolution = (reportId: string, resolution: BugResolution | null) =>
  apiFetch<AdminBugReport>(`/admin/bug-reports/${encodeURIComponent(reportId)}`, { method: 'PATCH', body: { resolution } });
