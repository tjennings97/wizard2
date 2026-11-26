import { apiFetch } from './http';
import type { User } from './types';

export const login = (username: string, password: string) =>
  apiFetch<User>('/auth/login', { method: 'POST', body: { username, password }, ignoreSessionEnd: true });

export const logout = () => apiFetch<void>('/auth/logout', { method: 'POST', ignoreSessionEnd: true });

export const fetchMe = () => apiFetch<User>('/users/me', { ignoreSessionEnd: true });
