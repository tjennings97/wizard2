import { Card, CardData, Suit, isSuit } from './Card';
import { EngineError } from './errors';
import { BidRule, TrumpSource, scoreRound } from './rules';
import type { Ruleset } from './rulesets';
import { STANDARD_RULESET } from './rulesets/standard';
import { Trick } from './Trick';

export interface RoundOptions {
  roundNumber: number;
  /** All players in seat order. */
  seatOrder: readonly string[];
  dealerId: string;
  bidRule: BidRule;
  /** Flipped trump card, or null when every card was dealt. */
  trumpCard: Card | null;
  /** Hands as dealt, keyed by player ID. Kept for history/event logging. */
  dealtHands?: Record<string, readonly Card[]>;
  /** Edition rules for trump and tricks. Defaults to standard. */
  ruleset?: Ruleset;
}

export interface RoundPlayerResult {
  playerId: string;
  bid: number;
  tricksWon: number;
  scoreDelta: number;
}

/**
 * One round's ledger: trump, bids, tricks won, and score deltas. Bids are
 * taken clockwise from the player left of the dealer; the dealer bids last.
 * Becomes read-only once `computeScores()` is called.
 */
export class Round {
  readonly roundNumber: number;
  readonly dealerId: string;
  readonly bidRule: BidRule;
  readonly trumpCard: Card | null;
  /** Player IDs in bidding order (left of dealer first, dealer last). */
  readonly bidOrder: readonly string[];
  readonly dealtHands: Readonly<Record<string, readonly CardData[]>>;
  readonly ruleset: Ruleset;

  private _trumpSuit: Suit | null;
  private _trumpSource: TrumpSource;
  private _awaitingDeclaration: boolean;
  private readonly bids = new Map<string, number>();
  private readonly tricksWon = new Map<string, number>();
  private readonly _tricks: Trick[] = [];
  private scores: Record<string, number> | null = null;

  constructor(opts: RoundOptions) {
    const dealerIndex = opts.seatOrder.indexOf(opts.dealerId);
    if (dealerIndex === -1) {
      throw new EngineError('UNKNOWN_PLAYER', `Dealer ${opts.dealerId} is not seated`);
    }
    this.roundNumber = opts.roundNumber;
    this.dealerId = opts.dealerId;
    this.bidRule = opts.bidRule;
    this.trumpCard = opts.trumpCard;
    this.ruleset = opts.ruleset ?? STANDARD_RULESET;
    const n = opts.seatOrder.length;
    this.bidOrder = opts.seatOrder.map((_, i) => opts.seatOrder[(dealerIndex + 1 + i) % n]);
    for (const id of this.bidOrder) this.tricksWon.set(id, 0);

    const hands: Record<string, CardData[]> = {};
    for (const [id, cards] of Object.entries(opts.dealtHands ?? {})) {
      hands[id] = cards.map((c) => c.toData());
    }
    this.dealtHands = hands;

    const trump = this.ruleset.determineTrump(opts.trumpCard);
    this._trumpSuit = trump.trumpSuit;
    this._trumpSource = trump.trumpSource;
    this._awaitingDeclaration = trump.requiresDeclaration;
  }

  get trumpSuit(): Suit | null {
    return this._trumpSuit;
  }

  get trumpSource(): TrumpSource {
    return this._trumpSource;
  }

  /** True while a flipped Wizard is waiting for the dealer to declare trump. */
  get awaitingDeclaration(): boolean {
    return this._awaitingDeclaration;
  }

  get tricks(): readonly Trick[] {
    return this._tricks;
  }

  get currentTrick(): Trick | null {
    return this._tricks[this._tricks.length - 1] ?? null;
  }

  get isScored(): boolean {
    return this.scores !== null;
  }

  get allBidsPlaced(): boolean {
    return this.bids.size === this.bidOrder.length;
  }

  /** Next player to bid, or null once bidding is complete. */
  get currentBidderId(): string | null {
    return this.bidOrder[this.bids.size] ?? null;
  }

  get bidTotal(): number {
    let total = 0;
    for (const b of this.bids.values()) total += b;
    return total;
  }

  getBid(playerId: string): number | null {
    return this.bids.get(playerId) ?? null;
  }

  getTricksWon(playerId: string): number {
    this.assertPlayer(playerId);
    return this.tricksWon.get(playerId) as number;
  }

  /** 1-based position in the bidding order. */
  bidPosition(playerId: string): number {
    this.assertPlayer(playerId);
    return this.bidOrder.indexOf(playerId) + 1;
  }

  declareTrump(playerId: string, suit: Suit): void {
    this.assertOpen();
    if (!this._awaitingDeclaration) {
      throw new EngineError('INVALID_PHASE', 'Trump is not awaiting declaration');
    }
    if (playerId !== this.dealerId) {
      throw new EngineError('NOT_YOUR_TURN', 'Only the dealer may declare trump');
    }
    if (!isSuit(suit)) {
      throw new EngineError('INVALID_SUIT', `Invalid suit: ${String(suit)}`);
    }
    this._trumpSuit = suit;
    this._trumpSource = 'declaration';
    this._awaitingDeclaration = false;
  }

  /** Bids the player may legally place right now (empty if it is not their turn). */
  allowedBids(playerId: string): number[] {
    if (this.isScored || this._awaitingDeclaration || this.currentBidderId !== playerId) return [];
    const all = Array.from({ length: this.roundNumber + 1 }, (_, i) => i);
    const isLast = this.bids.size === this.bidOrder.length - 1;
    if (this.bidRule === 'uneven' && isLast) {
      const forbidden = this.roundNumber - this.bidTotal;
      return all.filter((b) => b !== forbidden);
    }
    return all;
  }

  recordBid(playerId: string, bid: number): void {
    this.validateBid(playerId, bid);
    this.bids.set(playerId, bid);
  }

  /** Throws if `recordBid(playerId, bid)` would be rejected; changes nothing. */
  validateBid(playerId: string, bid: number): void {
    this.assertOpen();
    this.assertPlayer(playerId);
    if (this._awaitingDeclaration) {
      throw new EngineError('INVALID_PHASE', 'Trump must be declared before bidding');
    }
    if (this.bids.has(playerId)) {
      throw new EngineError('ALREADY_BID', `Player ${playerId} has already bid`);
    }
    if (this.currentBidderId !== playerId) {
      throw new EngineError('NOT_YOUR_TURN', `It is ${this.currentBidderId}'s turn to bid`);
    }
    if (!Number.isInteger(bid) || bid < 0 || bid > this.roundNumber) {
      throw new EngineError('INVALID_BID', `Bid must be an integer from 0 to ${this.roundNumber}`);
    }
    if (!this.allowedBids(playerId).includes(bid)) {
      throw new EngineError(
        'INVALID_BID',
        `Uneven bidding: total bids may not equal ${this.roundNumber}`,
      );
    }
  }

  /** Opens the next trick. Game decides who leads. */
  startTrick(leaderId: string): Trick {
    this.assertOpen();
    this.assertPlayer(leaderId);
    if (!this.allBidsPlaced) {
      throw new EngineError('INVALID_PHASE', 'All bids must be placed before tricks are played');
    }
    const current = this.currentTrick;
    if (current && !current.isResolved) {
      throw new EngineError('INVALID_PHASE', 'Current trick is not finished');
    }
    if (this._tricks.length >= this.roundNumber) {
      throw new EngineError('INVALID_PHASE', 'All tricks in this round have been played');
    }
    const trick = new Trick(this._tricks.length + 1, leaderId, this.ruleset);
    this._tricks.push(trick);
    return trick;
  }

  recordTrickWon(playerId: string): void {
    this.assertOpen();
    this.assertPlayer(playerId);
    if (this.totalTricksWon() >= this.roundNumber) {
      throw new EngineError('INVALID_PHASE', `Round ${this.roundNumber} has only ${this.roundNumber} tricks`);
    }
    this.tricksWon.set(playerId, (this.tricksWon.get(playerId) as number) + 1);
  }

  /**
   * Computes and locks per-player score deltas. Requires every bid placed and
   * every trick in the round won. Safe to call again; returns the same result.
   */
  computeScores(): Record<string, number> {
    if (this.scores) return { ...this.scores };
    if (!this.allBidsPlaced) {
      throw new EngineError('INVALID_PHASE', 'Cannot score a round before all bids are placed');
    }
    if (this.totalTricksWon() !== this.roundNumber) {
      throw new EngineError('INVALID_PHASE', 'Cannot score a round before all tricks are played');
    }
    const scores: Record<string, number> = {};
    for (const id of this.bidOrder) {
      scores[id] = scoreRound(this.bids.get(id) as number, this.tricksWon.get(id) as number);
    }
    this.scores = scores;
    return { ...scores };
  }

  /** Per-player results; only available after scoring. */
  results(): RoundPlayerResult[] {
    const scores = this.computeScores();
    return this.bidOrder.map((id) => ({
      playerId: id,
      bid: this.bids.get(id) as number,
      tricksWon: this.tricksWon.get(id) as number,
      scoreDelta: scores[id],
    }));
  }

  private totalTricksWon(): number {
    let total = 0;
    for (const t of this.tricksWon.values()) total += t;
    return total;
  }

  private assertOpen(): void {
    if (this.scores) {
      throw new EngineError('ROUND_CLOSED', `Round ${this.roundNumber} has already been scored`);
    }
  }

  private assertPlayer(playerId: string): void {
    if (!this.tricksWon.has(playerId)) {
      throw new EngineError('UNKNOWN_PLAYER', `Player ${playerId} is not in this round`);
    }
  }
}
