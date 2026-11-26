import { apiFetch } from './http';
import type { AvatarConfig, User } from './types';

export const login = (username: string, password: string) =>
  apiFetch<User>('/auth/login', { method: 'POST', body: { username, password }, ignoreSessionEnd: true });

export const logout = () => apiFetch<void>('/auth/logout', { method: 'POST', ignoreSessionEnd: true });

export const fetchMe = () => apiFetch<User>('/users/me', { ignoreSessionEnd: true });

export interface RegisterBody {
  inviteCode: string;
  username: string;
  displayName: string;
  password: string;
  recoveryPassphrase: string;
  avatarConfig: AvatarConfig;
  avatarSvg: string | null;
}

export const register = (body: RegisterBody) =>
  apiFetch<User>('/auth/register', { method: 'POST', body, ignoreSessionEnd: true });

export const resetPassword = (username: string, recoveryPassphrase: string, newPassword: string) =>
  apiFetch<void>('/auth/reset-password', {
    method: 'POST',
    body: { username, recoveryPassphrase, newPassword },
    ignoreSessionEnd: true,
  });

/** PATCH /users/me. A password or passphrase change needs currentPassword and rotates the session. */
export interface ProfileUpdate {
  displayName?: string;
  password?: string;
  recoveryPassphrase?: string;
  currentPassword?: string;
}

export const updateMe = (body: ProfileUpdate) => apiFetch<User>('/users/me', { method: 'PATCH', body });
