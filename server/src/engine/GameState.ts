/**
 * Plain, JSON-serializable snapshot of a game, produced by `game.toGameState()`.
 * Used for the `games.state` checkpoint (a record for history) and bug reports.
 *
 * Contains every player's hand, so it is server-side only. Send clients
 * `game.toPlayerView(userId)` or `game.toSpectatorView()` instead.
 */
import type { CardData, Suit } from './Card';
import type { BidRule, TrumpSource } from './rules';
import type { DeckType } from './rulesets';
import type { WinningCardType } from './Trick';
import type { AvatarConfig } from './User';

export type GamePhase =
  | 'not_started'
  /** Wizard flipped; waiting for the dealer to declare trump. */
  | 'trump_declaration'
  | 'bidding'
  | 'trick'
  /** Round scored; call startRound() or, after the final round, endGame(). */
  | 'round_end'
  /** A drop left exactly two players; waiting on continue-or-end. */
  | 'awaiting_continue_decision'
  | 'completed'
  | 'incomplete';

export interface GameConfig {
  roundCount: number;
  bidRule: BidRule;
  deckType: DeckType;
  /** Derived from deckType; stored for convenience. */
  deckSize: number;
}

export interface PlayerState {
  userId: string;
  username: string;
  displayName: string;
  avatarConfig: AvatarConfig | null;
  /** 1-based seat among active players. */
  seatOrder: number;
  isBot: boolean;
  connected: boolean;
  hand: CardData[];
  bid: number | null;
  tricksWon: number;
  cumulativeScore: number;
}

export interface TrickState {
  trickNumber: number;
  leaderUserId: string;
  cards: { userId: string; card: CardData }[];
  winnerUserId: string | null;
  winningCardType: WinningCardType | null;
}

export interface RoundPlayerSummary {
  userId: string;
  bid: number;
  tricksWon: number;
  scoreDelta: number;
}

export interface RoundSummary {
  roundNumber: number;
  dealerUserId: string;
  trumpSuit: Suit | null;
  trumpSource: TrumpSource;
  players: RoundPlayerSummary[];
}

/** A player who quit or timed out. Kept so scoreboards can still name them. */
export interface DroppedPlayerState {
  userId: string;
  username: string;
  displayName: string;
  avatarConfig: AvatarConfig | null;
  isBot: boolean;
  /** Cumulative score when they left. */
  finalScore: number;
}

/** What happens if the two remaining players choose to continue. */
export interface PendingContinue {
  /** Phase the game returns to when no re-deal is needed. */
  resumePhase: GamePhase;
  /** True when a round was voided by the drop and must be re-dealt. */
  redeal: boolean;
}

export interface GameState {
  gameId: string;
  roomId: string;
  config: GameConfig;
  phase: GamePhase;
  /** 0 before the first round starts. */
  currentRound: number;
  /** 0 when no trick is in progress or complete this round. */
  currentTrick: number;
  dealerUserId: string | null;
  trumpCard: CardData | null;
  trumpSuit: Suit | null;
  trumpSource: TrumpSource;
  currentTurnUserId: string | null;
  players: PlayerState[];
  /** Tricks of the current round in play order; the last may be in progress. */
  tricksSoFar: TrickState[];
  /** Scored rounds, oldest first (for the full scoreboard). */
  roundHistory: RoundSummary[];
  /** Cumulative score by userId, active players only. */
  scores: Record<string, number>;
  /** Players who left, in the order they left. */
  droppedPlayers: DroppedPlayerState[];
  /** Set only when phase is `awaiting_continue_decision`. */
  pendingContinue: PendingContinue | null;
  /** Populated when phase is `completed`; ties produce several winners. */
  winnerUserIds: string[];
}

/** A player as one viewer sees them: only the viewer's own hand is included. */
export interface PlayerStateView extends Omit<PlayerState, 'hand'> {
  /** The cards, for the viewer's own entry; null for everyone else. */
  hand: CardData[] | null;
  handCount: number;
}

/**
 * `GameState` filtered for one client, produced by `game.toPlayerView(userId)`
 * or `game.toSpectatorView()`. Safe to send to that client.
 */
export interface GameStateView extends Omit<GameState, 'players'> {
  /** The player this view was made for; null for a spectator. */
  viewerUserId: string | null;
  players: PlayerStateView[];
}
