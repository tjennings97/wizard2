/** Shapes from docs/api/openapi-spec.md, reused as the nested objects of socket payloads. */

export interface AvatarConfig {
  head: string;
  skin: string;
  face: string;
  hair: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'player' | 'admin';
  avatarConfig: AvatarConfig | null;
  avatarSvg: string | null;
  createdAt: string;
  requiresCredentialChange: boolean;
}

export type RoomState = 'open' | 'in_progress' | 'completing' | 'closed';
export type MemberRole = 'player' | 'spectator';
export type BidRule = 'open' | 'uneven';

export interface RoomConfig {
  roundCount: number;
  bidRule: BidRule;
  deckType: 'standard';
}

export interface RoomSummary {
  id: string;
  state: RoomState;
  hostUserId: string;
  config: RoomConfig;
  playerCount: number;
  spectatorCount: number;
  maxPlayers: number;
  maxSpectators: number;
  createdAt: string;
}

export interface UserSummary {
  userId: string;
  displayName: string;
  avatarConfig: AvatarConfig | null;
}

export interface RoomMember extends UserSummary {
  role: MemberRole;
  joinOrder: number;
  isHost: boolean;
  connected: boolean;
}

export interface Room {
  id: string;
  state: RoomState;
  hostUserId: string;
  config: RoomConfig;
  members: RoomMember[];
  createdAt: string;
  closedAt: string | null;
}

/** Standard deck size; max rounds is floor(60 / playerCount). */
export const DECK_SIZE = 60;
export const MIN_PLAYERS_TO_START = 3;
export const MAX_PLAYERS = 10;
export const MAX_SPECTATORS = 5;
export const maxRounds = (playerCount: number) => Math.floor(DECK_SIZE / Math.max(1, playerCount));
