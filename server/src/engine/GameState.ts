/**
 * Plain, JSON-serializable snapshot of a game, produced by `game.toGameState()`.
 * Used for the `games.state` checkpoint, reconnection restore, and bug reports.
 *
 * Contains every player's hand. Never broadcast it to a room as-is: send each
 * player only their own hand.
 */
import type { CardData, Suit } from './Card';
import type { BidRule, TrumpSource } from './rules';
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
  droppedUserIds: string[];
  /** Populated when phase is `completed`; ties produce several winners. */
  winnerUserIds: string[];
}
