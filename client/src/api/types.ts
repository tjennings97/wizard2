/** Shapes from docs/api/openapi-spec.md, reused as the nested objects of socket payloads. */

import type { AvatarConfig } from '../../../server/src/shared/avatar';

/** Four catalog slugs (server/src/shared/avatar.ts, shared with the server). */
export type { AvatarConfig };

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'player' | 'admin';
  avatarConfig: AvatarConfig;
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
  avatarConfig: AvatarConfig;
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

// --- Game (docs/api/websocket-events.md) -------------------------------------------------

export type Suit = 'hearts' | 'diamonds' | 'spades' | 'clubs';
export const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'spades', 'clubs'];
export type TrumpSource = 'flip' | 'declaration' | null;

/** Wizards and Jesters have no suit or rank. Rank 2–14 (Ace = 14). */
export interface Card {
  suit: Suit | null;
  rank: number | null;
  type: 'suited' | 'wizard' | 'jester';
}

export interface PlayerSummary {
  user_id: string;
  display_name: string;
  avatar_config: AvatarConfig;
  seat_index: number;
}

export interface BidEntry {
  player_id: string;
  bid: number;
}

export type GamePhase =
  | 'not_started'
  | 'trump_declaration'
  | 'bidding'
  | 'trick'
  | 'round_end'
  | 'awaiting_continue_decision'
  | 'completed'
  | 'incomplete';

/** One card in a trick, in play order. */
export interface PlayEntry {
  player_id: string;
  card: Card;
}

/** A player's score: the running total, or (in scores_this_round) the round's delta. */
export interface ScoreEntry {
  player_id: string;
  score: number;
}

export interface RoundScoreEntry extends ScoreEntry {
  bid: number;
  tricks_won: number;
}

/** One player in a state_snapshot: only the viewer's own entry has `hand`. */
export interface PlayerStateView {
  userId: string;
  displayName: string;
  avatarConfig: AvatarConfig;
  seatOrder: number;
  hand: Card[] | null;
  handCount: number;
  bid: number | null;
  tricksWon: number;
  cumulativeScore: number;
  /** False while the player's seat is held for them to reconnect. */
  connected: boolean;
}

/** The fields of GameStateView (game.toPlayerView / toSpectatorView) the client reads. */
export interface GameStateView {
  gameId: string;
  roomId: string;
  viewerUserId: string | null;
  config: { roundCount: number; bidRule: BidRule };
  phase: GamePhase;
  currentRound: number;
  dealerUserId: string | null;
  trumpCard: Card | null;
  trumpSuit: Suit | null;
  trumpSource: TrumpSource;
  currentTurnUserId: string | null;
  players: PlayerStateView[];
  /** Tricks of the current round in play order; the last may be in progress (winnerUserId null). */
  tricksSoFar: { trickNumber: number; leaderUserId: string; cards: { userId: string; card: Card }[]; winnerUserId: string | null }[];
  /** Scored rounds, oldest first. */
  roundHistory: { roundNumber: number; players: { userId: string; bid: number; tricksWon: number; scoreDelta: number }[] }[];
  /** Players who left, in the order they left (kept so scoreboards can still name them). */
  droppedPlayers: { userId: string; displayName: string }[];
  winnerUserIds: string[];
}
