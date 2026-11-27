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

export interface UserPage {
  data: User[];
  total: number;
  page: number;
  limit: number;
}

export interface TemporaryCredentials {
  temporaryPassword: string;
  temporaryPassphrase: string;
  note: string;
}

export const listInvites = () => apiFetch<Invite[]>('/admin/invites');

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
