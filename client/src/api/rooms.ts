import { apiFetch } from './http';
import type { BidRule, MemberRole, Room, RoomConfig } from './types';

export const createRoom = () => apiFetch<Room>('/rooms', { method: 'POST', body: {} });

export const joinRoom = (roomId: string, role: MemberRole) =>
  apiFetch<Room>(`/rooms/${roomId}/join`, { method: 'POST', body: { role } });

export const leaveRoom = (roomId: string) => apiFetch<void>(`/rooms/${roomId}/leave`, { method: 'POST' });

export const updateRoomConfig = (roomId: string, patch: { roundCount?: number; bidRule?: BidRule }) =>
  apiFetch<RoomConfig>(`/rooms/${roomId}/config`, { method: 'PATCH', body: patch });

export const closeRoom = (roomId: string) => apiFetch<void>(`/rooms/${roomId}`, { method: 'DELETE' });

/** Applies the start checks server-side; returns 501 NOT_IMPLEMENTED until the game engine is wired. */
export const startGame = (roomId: string) => apiFetch<void>(`/rooms/${roomId}/start`, { method: 'POST' });
