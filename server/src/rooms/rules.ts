/**
 * Room rules, kept free of I/O so they can be unit-tested.
 * See "Room and Pre-Game" in docs/product/prd.md and the Room Lifecycle in
 * docs/architecture/game-state-machine.md.
 */

export const MAX_PLAYERS = 10;
export const MAX_SPECTATORS = 5;
export const MIN_PLAYERS_TO_START = 3;
/** Standard deck: 4 suits × 13 ranks + 4 Wizards + 4 Jesters. */
export const STANDARD_DECK_SIZE = 60;
/** A room that has not started its game this long after creation is closed. */
export const ROOM_TIMEOUT_MS = 10 * 60 * 1000;
/** A host of an open room who has no connected socket this long loses the host role. */
export const HOST_AWAY_MS = 120 * 1000;

export type RoomState = 'open' | 'in_progress' | 'completing' | 'closed';
export type MemberRole = 'player' | 'spectator';
export type BidRule = 'open' | 'uneven';
export type DeckType = 'standard';
export type RoomClosedReason = 'inactivity' | 'game_finished' | 'empty' | 'host_closed';

/** The RoomConfig schema from docs/api/openapi-spec.md. */
export interface RoomConfig {
  roundCount: number;
  bidRule: BidRule;
  deckType: DeckType;
}

export const BID_RULES: readonly BidRule[] = ['open', 'uneven'];
export const DECK_TYPES: readonly DeckType[] = ['standard'];
export const MEMBER_ROLES: readonly MemberRole[] = ['player', 'spectator'];

/** States a user can be "in" a room for: membership in one of these blocks entering another. */
export const ACTIVE_ROOM_STATES: readonly RoomState[] = ['open', 'in_progress', 'completing'];
/** States listed in the lobby. */
export const LOBBY_ROOM_STATES: readonly RoomState[] = ['open', 'in_progress'];

/** Maximum rounds for a player count: floor(deckSize / playerCount). A room always has ≥ 1 player. */
export function maxRounds(playerCount: number, deckSize: number = STANDARD_DECK_SIZE): number {
  return Math.floor(deckSize / Math.max(1, playerCount));
}

export function defaultConfig(playerCount: number): RoomConfig {
  return { roundCount: maxRounds(playerCount), bidRule: 'open', deckType: 'standard' };
}

/**
 * The config after the player count changes: roundCount is lowered to the new maximum if it now
 * exceeds it. Returns the same object when nothing changes.
 */
export function clampConfig(config: RoomConfig, playerCount: number): RoomConfig {
  const max = maxRounds(playerCount);
  return config.roundCount > max ? { ...config, roundCount: max } : config;
}

/** Why a user may not join a room in a role, or null if they may. */
export function joinRejection(
  state: RoomState,
  role: MemberRole,
  counts: { players: number; spectators: number },
): 'ROOM_NOT_JOINABLE' | 'ROOM_FULL' | null {
  if (state === 'completing' || state === 'closed') return 'ROOM_NOT_JOINABLE';
  if (role === 'player') {
    if (state !== 'open') return 'ROOM_NOT_JOINABLE';
    if (counts.players >= MAX_PLAYERS) return 'ROOM_FULL';
    return null;
  }
  if (counts.spectators >= MAX_SPECTATORS) return 'ROOM_FULL';
  return null;
}

/** rooms.config is stored snake_case (docs/architecture/data-model.md, JSONB Payload Schemas). */
export interface StoredRoomConfig {
  round_count?: number;
  bid_rule?: BidRule;
  deck_type?: DeckType;
}

export function configFromStored(stored: StoredRoomConfig | null, playerCount: number): RoomConfig {
  const fallback = defaultConfig(playerCount);
  return {
    roundCount: stored?.round_count ?? fallback.roundCount,
    bidRule: stored?.bid_rule ?? fallback.bidRule,
    deckType: stored?.deck_type ?? fallback.deckType,
  };
}

export function configToStored(config: RoomConfig): StoredRoomConfig {
  return { round_count: config.roundCount, bid_rule: config.bidRule, deck_type: config.deckType };
}
