import { Card, CardData, Suit } from './Card';
import { Deck, RandomSource } from './Deck';
import { EngineError } from './errors';
import type {
  GameConfig,
  GamePhase,
  GameState,
  GameStateView,
  PendingContinue,
  RoundSummary,
} from './GameState';
import { Player } from './Player';
import { Round } from './Round';
import { DeckType, Ruleset, getRuleset } from './rulesets';
import { BidRule, MAX_PLAYERS, MIN_PLAYERS, TrumpSource, maxRounds } from './rules';
import type { Trick, WinningCardType } from './Trick';

/** Builds the deck for a round. Must return a deck that is ready to deal (shuffled). */
export type DeckFactory = (ruleset: Ruleset, roundNumber: number) => Deck;

export interface GameOptions {
  gameId: string;
  roomId: string;
  /** Players in seat order. Seat 1 deals round 1. */
  players: Player[];
  config: { roundCount: number; bidRule?: BidRule; deckType?: DeckType };
  /** Used by the default deck factory. */
  random?: RandomSource;
  /** Override deck construction (e.g. stacked decks in tests). */
  deckFactory?: DeckFactory;
}

export interface RoundStarted {
  roundNumber: number;
  dealerId: string;
  trumpCard: Card | null;
  trumpSuit: Suit | null;
  trumpSource: TrumpSource;
  requiresDeclaration: boolean;
  /** Bidder (or dealer, if declaration is required) who acts first. */
  nextTurnId: string;
}

export interface BidPlaced {
  playerId: string;
  bid: number;
  bidPosition: number;
  biddingComplete: boolean;
  nextTurnId: string;
}

export interface TrickCompleted {
  trickNumber: number;
  winnerId: string;
  winningCard: Card;
  winningCardType: WinningCardType;
}

export interface RoundCompleted {
  roundNumber: number;
  results: { playerId: string; bid: number; tricksWon: number; scoreDelta: number }[];
  scores: Record<string, number>;
  isFinalRound: boolean;
}

export interface CardPlayed {
  playerId: string;
  card: Card;
  trickNumber: number;
  trickCompleted: TrickCompleted | null;
  roundCompleted: RoundCompleted | null;
  /** Null once the round is over. */
  nextTurnId: string | null;
}

export interface GameResult {
  winnerIds: string[];
  scores: Record<string, number>;
}

export type DropOutcome =
  /** ≥3 players remain; the interrupted round was voided and re-dealt. */
  | 'round_redealt'
  /** ≥3 players remain; no round was in progress, nothing to re-deal. */
  | 'removed'
  /** Exactly 2 remain; call resolveContinueOrEnd(). */
  | 'continue_or_end'
  /** ≤1 remains; game is over with no winner. */
  | 'incomplete';

export interface PlayerDropped {
  playerId: string;
  outcome: DropOutcome;
  roundStarted: RoundStarted | null;
}

const ACTIVE_ROUND_PHASES: readonly GamePhase[] = ['trump_declaration', 'bidding', 'trick'];

/**
 * Orchestrates a game: dealing, trump, bidding, tricks, scoring, and player
 * drops. Emits nothing and performs no I/O — every method returns a result
 * describing what happened, which the socket layer broadcasts.
 */
export class Game {
  readonly gameId: string;
  readonly roomId: string;
  readonly config: Readonly<GameConfig>;

  private players: Player[];
  private readonly dropped: Player[] = [];
  private readonly ruleset: Ruleset;
  private readonly deckFactory: DeckFactory;
  private _phase: GamePhase = 'not_started';
  private roundNumber = 0;
  private dealerId: string | null = null;
  private round: Round | null = null;
  private readonly history: RoundSummary[] = [];
  private winnerIds: string[] = [];
  /** What happens if the two remaining players choose to continue. */
  private pendingContinue: PendingContinue | null = null;

  constructor(opts: GameOptions) {
    // Throws INVALID_CONFIG for an unknown deck type.
    const ruleset = getRuleset(opts.config.deckType ?? 'standard');
    const count = opts.players.length;
    if (count < MIN_PLAYERS || count > MAX_PLAYERS) {
      throw new EngineError('INVALID_CONFIG', `A game needs ${MIN_PLAYERS}–${MAX_PLAYERS} players; got ${count}`);
    }
    if (new Set(opts.players.map((p) => p.id)).size !== count) {
      throw new EngineError('INVALID_CONFIG', 'Player IDs must be unique');
    }
    const bidRule = opts.config.bidRule ?? 'open';
    if (bidRule !== 'open' && bidRule !== 'uneven') {
      throw new EngineError('INVALID_CONFIG', `Invalid bid rule: ${String(bidRule)}`);
    }
    const max = maxRounds(ruleset.deckSize, count);
    const { roundCount } = opts.config;
    if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > max) {
      throw new EngineError('INVALID_CONFIG', `Round count must be 1–${max} for ${count} players`);
    }

    this.gameId = opts.gameId;
    this.roomId = opts.roomId;
    this.ruleset = ruleset;
    this.config = Object.freeze({
      roundCount,
      bidRule,
      deckType: ruleset.deckType,
      deckSize: ruleset.deckSize,
    });
    this.players = [...opts.players];
    const random = opts.random ?? Math.random;
    this.deckFactory = opts.deckFactory ?? ((r) => new Deck(r.deckType, random).shuffle());
  }

  // --- Queries -----------------------------------------------------------

  get phase(): GamePhase {
    return this._phase;
  }

  get currentRoundNumber(): number {
    return this.roundNumber;
  }

  get currentRound(): Round | null {
    return this.round;
  }

  get activePlayers(): readonly Player[] {
    return this.players;
  }

  get currentDealerId(): string | null {
    return this.dealerId;
  }

  get hasMoreRounds(): boolean {
    return this.roundNumber < this.config.roundCount;
  }

  get currentTurnId(): string | null {
    const round = this.round;
    if (!round) return null;
    switch (this._phase) {
      case 'trump_declaration':
        return round.dealerId;
      case 'bidding':
        return round.currentBidderId;
      case 'trick': {
        const trick = round.currentTrick as Trick;
        const leader = this.seatIndex(trick.leaderId);
        return this.players[(leader + trick.size) % this.players.length].id;
      }
      default:
        return null;
    }
  }

  getPlayer(playerId: string): Player {
    const p = this.players.find((x) => x.id === playerId);
    if (!p) throw new EngineError('UNKNOWN_PLAYER', `Player ${playerId} is not in this game`);
    return p;
  }

  get scores(): Record<string, number> {
    return Object.fromEntries(this.players.map((p) => [p.id, p.score]));
  }

  // --- Lifecycle ---------------------------------------------------------

  /** Deals the next round. Allowed before round 1 and after each round is scored. */
  startRound(): RoundStarted {
    this.assertPhase('not_started', 'round_end');
    if (!this.hasMoreRounds) {
      throw new EngineError('INVALID_PHASE', 'All rounds have been played; call endGame()');
    }
    this.roundNumber++;
    this.dealerId =
      this.roundNumber === 1 || this.dealerId === null
        ? this.players[0].id
        : this.nextSeat(this.dealerId);
    return this.deal();
  }

  declareTrump(playerId: string, suit: Suit): void {
    this.assertPhase('trump_declaration');
    this.activeRound().declareTrump(playerId, suit);
    this._phase = 'bidding';
  }

  placeBid(playerId: string, bid: number): BidPlaced {
    this.assertPhase('bidding');
    const round = this.activeRound();
    const player = this.getPlayer(playerId);
    round.validateBid(playerId, bid);
    player.placeBid(bid);
    round.recordBid(playerId, bid);

    const biddingComplete = round.allBidsPlaced;
    if (biddingComplete) {
      this._phase = 'trick';
      round.startTrick(round.bidOrder[0]);
    }
    return {
      playerId,
      bid,
      bidPosition: round.bidPosition(playerId),
      biddingComplete,
      nextTurnId: this.currentTurnId as string,
    };
  }

  playCard(playerId: string, cardData: CardData): CardPlayed {
    this.assertPhase('trick');
    const round = this.activeRound();
    const trick = round.currentTrick as Trick;
    const player = this.getPlayer(playerId);
    if (this.currentTurnId !== playerId) {
      throw new EngineError('NOT_YOUR_TURN', `It is ${this.currentTurnId}'s turn to play`);
    }
    if (!player.hasCard(cardData)) {
      throw new EngineError('CARD_NOT_IN_HAND', `Player ${playerId} does not hold that card`);
    }
    const card = Card.fromData(cardData);
    if (!trick.isLegalPlay(player.hand, card)) {
      throw new EngineError('ILLEGAL_CARD', `Must follow ${trick.suitToFollow}`);
    }

    player.playCard(card);
    trick.playCard(playerId, card);

    let trickCompleted: TrickCompleted | null = null;
    let roundCompleted: RoundCompleted | null = null;

    if (trick.size === this.players.length) {
      const winnerId = trick.resolve(round.trumpSuit);
      this.getPlayer(winnerId).addTrickWon();
      round.recordTrickWon(winnerId);
      const w = trick.winner!;
      trickCompleted = {
        trickNumber: trick.trickNumber,
        winnerId,
        winningCard: w.winningCard,
        winningCardType: w.winningCardType,
      };
      if (round.tricks.length < round.roundNumber) {
        round.startTrick(winnerId);
      } else {
        roundCompleted = this.endRound();
      }
    }

    return {
      playerId,
      card,
      trickNumber: trick.trickNumber,
      trickCompleted,
      roundCompleted,
      nextTurnId: this.currentTurnId,
    };
  }

  /**
   * The cards the player may play right now, in hand order: on their turn in the trick phase,
   * the cards the follow-suit rule allows; otherwise none.
   */
  legalCards(playerId: string): Card[] {
    const player = this.getPlayer(playerId);
    if (this._phase !== 'trick' || this.currentTurnId !== playerId) return [];
    const trick = this.activeRound().currentTrick as Trick;
    return player.hand.filter((c) => trick.isLegalPlay(player.hand, c));
  }

  /** Ends the game after the final round has been scored. */
  endGame(): GameResult {
    this.assertPhase('round_end');
    if (this.hasMoreRounds) {
      throw new EngineError('INVALID_PHASE', `Round ${this.roundNumber} of ${this.config.roundCount}; game is not over`);
    }
    const top = Math.max(...this.players.map((p) => p.score));
    this.winnerIds = this.players.filter((p) => p.score === top).map((p) => p.id);
    this._phase = 'completed';
    return { winnerIds: [...this.winnerIds], scores: this.scores };
  }

  /**
   * Removes a player who quit or timed out. An in-progress round is voided:
   * with ≥3 players left it is re-dealt at the same round number.
   */
  removePlayer(playerId: string): PlayerDropped {
    this.assertPhase('not_started', 'trump_declaration', 'bidding', 'trick', 'round_end', 'awaiting_continue_decision');
    const player = this.getPlayer(playerId);
    const roundInProgress =
      ACTIVE_ROUND_PHASES.includes(this._phase) ||
      (this._phase === 'awaiting_continue_decision' && this.pendingContinue?.redeal === true);

    if (this.dealerId === playerId) {
      // The deal passes to the next seat. If the round is re-dealt, that seat
      // deals it now; otherwise point at the previous seat so the rotation in
      // startRound() lands on the next seat.
      this.dealerId = roundInProgress ? this.nextSeat(playerId) : this.prevSeat(playerId);
    }
    this.players = this.players.filter((p) => p.id !== playerId);
    this.dropped.push(player);

    if (roundInProgress) this.voidRound();

    const remaining = this.players.length;
    if (remaining <= 1) {
      this._phase = 'incomplete';
      this.pendingContinue = null;
      return { playerId, outcome: 'incomplete', roundStarted: null };
    }
    if (remaining === 2) {
      if (this._phase !== 'awaiting_continue_decision') {
        this.pendingContinue = { resumePhase: this._phase, redeal: roundInProgress };
      }
      this._phase = 'awaiting_continue_decision';
      return { playerId, outcome: 'continue_or_end', roundStarted: null };
    }
    if (roundInProgress) {
      return { playerId, outcome: 'round_redealt', roundStarted: this.deal() };
    }
    return { playerId, outcome: 'removed', roundStarted: null };
  }

  /** Two remaining players chose to continue (true) or end (false). */
  resolveContinueOrEnd(continueGame: boolean): RoundStarted | null {
    this.assertPhase('awaiting_continue_decision');
    const pending = this.pendingContinue as PendingContinue;
    this.pendingContinue = null;
    if (!continueGame) {
      this._phase = 'incomplete';
      return null;
    }
    if (pending.redeal) return this.deal();
    this._phase = pending.resumePhase;
    return null;
  }

  // --- Serialization -----------------------------------------------------

  toGameState(): GameState {
    const round = this.round;
    return {
      gameId: this.gameId,
      roomId: this.roomId,
      config: { ...this.config },
      phase: this._phase,
      currentRound: this.roundNumber,
      currentTrick: round?.currentTrick?.trickNumber ?? 0,
      dealerUserId: this.dealerId,
      trumpCard: round?.trumpCard?.toData() ?? null,
      trumpSuit: round?.trumpSuit ?? null,
      trumpSource: round?.trumpSource ?? null,
      currentTurnUserId: this.currentTurnId,
      players: this.players.map((p, i) => ({
        userId: p.id,
        username: p.username,
        displayName: p.displayName,
        avatarConfig: p.avatarConfig ? { ...p.avatarConfig } : null,
        seatOrder: i + 1,
        isBot: p.isBot,
        connected: p.connected,
        hand: p.hand.map((c) => c.toData()),
        bid: p.bid,
        tricksWon: p.tricksWon,
        cumulativeScore: p.score,
      })),
      tricksSoFar: (round?.tricks ?? []).map((t) => {
        const d = t.toData();
        return {
          trickNumber: d.trickNumber,
          leaderUserId: d.leaderId,
          cards: d.cards.map((c) => ({ userId: c.playerId, card: c.card })),
          winnerUserId: d.winnerId,
          winningCardType: d.winningCardType,
        };
      }),
      roundHistory: this.history.map((r) => ({ ...r, players: r.players.map((p) => ({ ...p })) })),
      scores: this.scores,
      droppedPlayers: this.dropped.map((p) => ({
        userId: p.id,
        username: p.username,
        displayName: p.displayName,
        avatarConfig: p.avatarConfig ? { ...p.avatarConfig } : null,
        isBot: p.isBot,
        finalScore: p.score,
      })),
      pendingContinue: this.pendingContinue ? { ...this.pendingContinue } : null,
      winnerUserIds: [...this.winnerIds],
    };
  }

  /**
   * Snapshot for one player's client: every other player's hand is replaced
   * by a card count. Send this, never `toGameState()`, in
   * `state_snapshot`.
   */
  toPlayerView(userId: string): GameStateView {
    this.getPlayer(userId); // throws UNKNOWN_PLAYER for non-players
    return this.toView(userId);
  }

  /** Snapshot for a spectator: no hands at all, only card counts. */
  toSpectatorView(): GameStateView {
    return this.toView(null);
  }

  // --- Internals ---------------------------------------------------------

  private toView(viewerUserId: string | null): GameStateView {
    const { players, ...rest } = this.toGameState();
    return {
      ...rest,
      viewerUserId,
      players: players.map(({ hand, ...p }) => ({
        ...p,
        hand: p.userId === viewerUserId ? hand : null,
        handCount: hand.length,
      })),
    };
  }

  /** Shuffles and deals the current round number, then determines trump. */
  private deal(): RoundStarted {
    const dealerId = this.dealerId as string;
    const n = this.roundNumber;
    const deck = this.deckFactory(this.ruleset, n);
    const seatOrder = this.players.map((p) => p.id);
    const dealerIndex = seatOrder.indexOf(dealerId);

    const hands: Record<string, Card[]> = {};
    for (let i = 1; i <= seatOrder.length; i++) {
      const id = seatOrder[(dealerIndex + i) % seatOrder.length];
      hands[id] = deck.deal(n);
      this.getPlayer(id).receiveHand(hands[id]);
    }
    // Every card dealt → nothing to flip → no trump.
    const trumpCard = deck.remaining > 0 ? deck.flip() : null;

    const round = new Round({
      roundNumber: n,
      seatOrder,
      dealerId,
      bidRule: this.config.bidRule,
      trumpCard,
      dealtHands: hands,
      ruleset: this.ruleset,
    });
    this.round = round;
    this._phase = round.awaitingDeclaration ? 'trump_declaration' : 'bidding';

    return {
      roundNumber: n,
      dealerId,
      trumpCard,
      trumpSuit: round.trumpSuit,
      trumpSource: round.trumpSource,
      requiresDeclaration: round.awaitingDeclaration,
      nextTurnId: this.currentTurnId as string,
    };
  }

  private endRound(): RoundCompleted {
    const round = this.activeRound();
    const results = round.results();
    for (const r of results) this.getPlayer(r.playerId).addScore(r.scoreDelta);
    this.history.push({
      roundNumber: round.roundNumber,
      dealerUserId: round.dealerId,
      trumpSuit: round.trumpSuit,
      trumpSource: round.trumpSource,
      players: results.map((r) => ({
        userId: r.playerId,
        bid: r.bid,
        tricksWon: r.tricksWon,
        scoreDelta: r.scoreDelta,
      })),
    });
    this._phase = 'round_end';
    return {
      roundNumber: round.roundNumber,
      results,
      scores: this.scores,
      isFinalRound: !this.hasMoreRounds,
    };
  }

  private voidRound(): void {
    this.round = null;
    for (const p of this.players) p.clearRound();
  }

  private activeRound(): Round {
    if (!this.round) throw new EngineError('INVALID_PHASE', 'No round in progress');
    return this.round;
  }

  private seatIndex(playerId: string): number {
    const i = this.players.findIndex((p) => p.id === playerId);
    if (i === -1) throw new EngineError('UNKNOWN_PLAYER', `Player ${playerId} is not in this game`);
    return i;
  }

  private nextSeat(playerId: string): string {
    return this.players[(this.seatIndex(playerId) + 1) % this.players.length].id;
  }

  private prevSeat(playerId: string): string {
    const n = this.players.length;
    return this.players[(this.seatIndex(playerId) - 1 + n) % n].id;
  }

  private assertPhase(...allowed: GamePhase[]): void {
    if (!allowed.includes(this._phase)) {
      throw new EngineError('INVALID_PHASE', `Action not allowed in phase ${this._phase}`);
    }
  }
}
