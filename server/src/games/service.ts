import type { Knex } from 'knex';
import { db } from '../db/knex';
import {
  EngineError,
  Game,
  Player,
  type CardData,
  type CardPlayed,
  type DeckFactory,
  type GameStateView,
  type RandomSource,
  type RoundCompleted,
  type RoundStarted,
  type Suit,
  type Trick,
} from '../engine';
import { logger } from '../logger';
import type { RoomConfig } from '../rooms/rules';
import {
  bidRequestPayload,
  bidsSoFar,
  gameStartedPayload,
  gameStartingPayload,
  handDealtPayload,
  gameOverPayload,
  invalidBidPayload,
  invalidPlayPayload,
  invalidTrumpPayload,
  playEntries,
  playRequestPayload,
  roundCompletePayload,
  roundStartedPayload,
  trumpRevealedPayload,
} from './payloads';
import {
  insertGameEvents,
  recordGameComplete,
  recordRound,
  type GameEventRow,
  type GameEventType,
  type GamePlayerRow,
  type RoundRecord,
} from './queries';

/**
 * What the game service tells the real-time layer. Implemented by the socket layer
 * (socket/realtime.ts); the service never touches sockets. `seq` is the game's sequence number,
 * used as the envelope seq.
 */
export interface GameNotifier {
  /** Every socket in the room's channel (players and spectators). */
  deliverToRoom(roomId: string, event: string, payload: unknown, seq: number): void;
  /** Only this user's sockets in the room's channel. Never used for a room broadcast. */
  deliverToUser(roomId: string, userId: string, event: string, payload: unknown, seq: number): void;
}

const noopNotifier: GameNotifier = { deliverToRoom: () => {}, deliverToUser: () => {} };

/**
 * What the game service tells the room service. Implemented by RoomService, which owns the room
 * lifecycle; the game service never changes a room except for the in_progress → completing move
 * it writes with the game's results.
 */
export interface GameLifecycle {
  /**
   * The game has ended, game_over has been broadcast and the room is COMPLETING. Close the room
   * at `closesAt` (room_closed, everyone back to the lobby).
   */
  gameFinished(roomId: string, closesAt: Date): void;
}

const noopLifecycle: GameLifecycle = { gameFinished: () => {} };

/** How long the room stays COMPLETING (the game-over screen) before it closes. */
export const COMPLETING_COUNTDOWN_MS = 30 * 1000;

/** Duplicate idempotency keys within this window are acknowledged without reprocessing. */
export const IDEMPOTENCY_WINDOW_MS = 60 * 1000;

interface LogFields {
  eventType: GameEventType;
  actorUserId: string | null;
  /** Full-context snapshot for the log's `payload` column. Defaults to the sent payload. */
  context?: unknown;
  /** Defaults to the game's current round number at publish time. */
  roundNumber?: number;
  /** For trick-level events; null otherwise. */
  trickNumber?: number;
}

type Outbound =
  /** Broadcast to the room: takes the game's next seq and is logged. */
  | { to: 'room'; event: string; payload: unknown; log: LogFields }
  /** Unicast to one user: carries the current seq, is not logged (state_snapshot restores it). */
  | { to: 'user'; userId: string; event: string; payload: unknown };

class LiveGame {
  /** Seq of the last event broadcast to the room. */
  seq = 0;
  /** Actions on one game run one at a time, in arrival order. */
  queue: Promise<void> = Promise.resolve();
  /** `${userId}:${idempotencyKey}` → time first seen. */
  readonly keys = new Map<string, number>();
  /** When the current round was dealt, for rounds.started_at. */
  roundStartedAt = new Date();
  /** The game_over payload once the game has ended; re-sent after state_snapshot. */
  gameOver: unknown = null;

  constructor(readonly game: Game) {}
}

/** Thrown when someone who is not seated in the game sends a game action. */
export class NotAPlayerError extends Error {
  constructor() {
    super('Spectators cannot take game actions.');
    this.name = 'NotAPlayerError';
  }
}

export interface GameServiceOptions {
  /** Stacked decks in tests. Defaults to a shuffled deck per round. */
  deckFactory?: DeckFactory;
  random?: RandomSource;
  /** How long the room stays COMPLETING after game_over. Tests shorten it. */
  countdownMs?: number;
}

/** Who caused an action, for log lines. Null for server-initiated work. */
export interface ActionContext {
  userId: string | null;
  traceId: string | null;
}

const SERVER_CONTEXT: ActionContext = { userId: null, traceId: null };

export interface NewGame {
  gameId: string;
  roomId: string;
  /** Seat order: join order. Seat 1 deals round 1. */
  players: GamePlayerRow[];
  config: RoomConfig;
}

/**
 * Runs the games in progress, in memory on this single instance. Calls the engine, logs each
 * broadcast to game_events with its seq, and hands events to the notifier in order.
 * See docs/architecture/game-state-machine.md and docs/api/websocket-events.md.
 *
 * Covers start through game_over. Disconnects, quits and player drops are not wired yet.
 */
export class GameService {
  private notifier: GameNotifier = noopNotifier;
  private lifecycle: GameLifecycle = noopLifecycle;
  private readonly byRoom = new Map<string, LiveGame>();
  readonly countdownMs: number;

  constructor(private readonly options: GameServiceOptions = {}) {
    this.countdownMs = options.countdownMs ?? COMPLETING_COUNTDOWN_MS;
  }

  /** The socket layer is created after the service, so it is set late. */
  setNotifier(notifier: GameNotifier): void {
    this.notifier = notifier;
  }

  /** Set by the room service, which is created after this one. */
  setLifecycle(lifecycle: GameLifecycle): void {
    this.lifecycle = lifecycle;
  }

  /**
   * Builds the engine game. Pure: nothing is registered or sent, so the caller can still roll back.
   * Throws EngineError INVALID_CONFIG if the room's config does not fit the players.
   */
  create({ gameId, roomId, players, config }: NewGame): Game {
    return new Game({
      gameId,
      roomId,
      players: players.map(
        (p) => new Player({ id: p.id, username: p.username, displayName: p.displayName, avatarConfig: p.avatarConfig, sessionId: null }),
      ),
      config: { roundCount: config.roundCount, bidRule: config.bidRule, deckType: config.deckType },
      deckFactory: this.options.deckFactory,
      random: this.options.random,
    });
  }

  /**
   * Registers a created game whose round 1 is already dealt (`started`, from game.startRound()
   * inside the start transaction, so an engine failure rolls the start back) and announces it:
   * game_starting, game_started, then the round opening (see openRound). Nothing here can leave
   * the game half-started: the event log write and each delivery are guarded in publish, and the
   * game is playable (state_snapshot, bids) from the moment it is registered.
   */
  async launch(game: Game, started: RoundStarted, ctx: ActionContext = SERVER_CONTEXT): Promise<void> {
    const live = new LiveGame(game);
    this.byRoom.set(game.roomId, live);
    await this.run(live, ctx, async () => {
      const context = {
        config: game.config,
        players: game.activePlayers.map((p, i) => ({ userId: p.id, displayName: p.displayName, seatOrder: i + 1 })),
      };
      const announce: Outbound[] = [
        { to: 'room', event: 'game_starting', payload: gameStartingPayload(game), log: { eventType: 'game_starting', actorUserId: null, context, roundNumber: 0 } },
        { to: 'room', event: 'game_started', payload: gameStartedPayload(game), log: { eventType: 'game_started', actorUserId: null, context, roundNumber: 0 } },
      ];
      await this.publish(live, ctx, [...announce, ...this.openRound(live, started)]);
    });
  }

  isLive(roomId: string): boolean {
    return this.byRoom.has(roomId);
  }

  gameIdFor(roomId: string): string | null {
    return this.byRoom.get(roomId)?.game.gameId ?? null;
  }

  /**
   * Runs `fn` in the game's queue with the viewer's filtered state, the current seq and the
   * prompt the viewer still owes (trump_selection_request, bid_request or play_request when it is
   * their turn; game_over to everyone once the game has ended),
   * so what it sends is ordered with the game's events. Players get their own view, everyone else
   * the spectator view. Returns false (without calling `fn`) if the room has no live game.
   */
  async withView(
    roomId: string,
    userId: string,
    fn: (view: GameStateView, seq: number, prompt: { event: string; payload: unknown } | null) => void,
  ): Promise<boolean> {
    const live = this.byRoom.get(roomId);
    if (!live) return false;
    await this.run(live, SERVER_CONTEXT, async () => fn(this.viewFor(live.game, userId), live.seq, this.pendingPrompt(live, userId)));
    return true;
  }

  /** Current seq of the room's game, or null if there is none. For unicasts from other layers. */
  currentSeq(roomId: string): number | null {
    return this.byRoom.get(roomId)?.seq ?? null;
  }

  /**
   * Broadcasts a room event (a spectator joining or leaving) as part of the game's sequence, so
   * it is numbered and logged like any other. Returns false if the room has no live game.
   */
  async publishRoomEvent(roomId: string, event: 'user_joined' | 'user_left', actorUserId: string, payload: unknown): Promise<boolean> {
    const live = this.byRoom.get(roomId);
    if (!live) return false;
    const ctx: ActionContext = { userId: actorUserId, traceId: null };
    await this.run(live, ctx, () => this.publish(live, ctx, [{ to: 'room', event, payload, log: { eventType: event, actorUserId } }]));
    return true;
  }

  /** The dealer declares trump after a Wizard flip. */
  async selectTrump(roomId: string, ctx: ActionContext & { userId: string }, suit: unknown, idempotencyKey?: unknown): Promise<void> {
    const { userId } = ctx;
    const live = this.liveFor(roomId, userId);
    await this.run(live, ctx, () => this.once(live, userId, idempotencyKey, async () => {
      const game = live.game;
      const dealerHand = game.getPlayer(userId).hand.map((c) => c.toData());
      const scoresBeforeRound = game.scores;
      try {
        game.declareTrump(userId, suit as Suit);
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        await this.publish(live, ctx, [
          { to: 'user', userId, event: 'invalid_trump_error', payload: invalidTrumpPayload(userId, err.code, err.message) },
        ]);
        return;
      }
      const round = game.currentRound!;
      await this.publish(live, ctx, [
        {
          to: 'room',
          event: 'trump_revealed',
          payload: trumpRevealedPayload(round.roundNumber, round.trumpSuit, round.trumpCard?.toData() ?? null, round.trumpSource),
          log: {
            eventType: 'trump_declared',
            actorUserId: userId,
            context: { dealerUserId: userId, declaredSuit: round.trumpSuit, dealerHand, roundNumber: round.roundNumber, scoresBeforeRound },
          },
        },
        this.bidRequest(game),
      ]);
    }));
  }

  async placeBid(roomId: string, ctx: ActionContext & { userId: string }, bid: unknown, idempotencyKey?: unknown): Promise<void> {
    const { userId } = ctx;
    const live = this.liveFor(roomId, userId);
    await this.run(live, ctx, () => this.once(live, userId, idempotencyKey, async () => {
      const game = live.game;
      const priorBids = bidsSoFar(game).map((b) => ({ playerId: b.player_id, bid: b.bid }));
      const handAtBid = game.getPlayer(userId).hand.map((c) => c.toData());
      const scoresBeforeBid = game.scores;

      let result;
      try {
        result = game.placeBid(userId, bid as number);
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        await this.publish(live, ctx, [
          { to: 'user', userId, event: 'invalid_bid_error', payload: invalidBidPayload(game, userId, err.code, err.message) },
        ]);
        return;
      }

      const round = game.currentRound!;
      const out: Outbound[] = [
        {
          to: 'room',
          event: 'bid_placed',
          payload: { player_id: userId, bid: result.bid },
          log: {
            eventType: 'bid_placed',
            actorUserId: userId,
            context: {
              playerId: userId,
              bid: result.bid,
              bidPosition: result.bidPosition,
              handAtBid,
              trumpSuit: round.trumpSuit,
              trumpSource: round.trumpSource,
              priorBids,
              roundNumber: round.roundNumber,
              scoresBeforeBid,
            },
          },
        },
      ];
      if (result.biddingComplete) {
        const bids = bidsSoFar(game);
        out.push({
          to: 'room',
          event: 'all_bids_placed',
          payload: { bids },
          log: {
            eventType: 'all_bids_placed',
            actorUserId: null,
            context: {
              roundNumber: round.roundNumber,
              bids: Object.fromEntries(bids.map((b) => [b.player_id, b.bid])),
              bidTotal: round.bidTotal,
              trickCount: round.roundNumber,
            },
          },
        });
        out.push(this.playRequest(game));
      } else {
        out.push(this.bidRequest(game));
      }
      await this.publish(live, ctx, out);
    }));
  }

  async playCard(roomId: string, ctx: ActionContext & { userId: string }, card: unknown, idempotencyKey?: unknown): Promise<void> {
    const { userId } = ctx;
    const live = this.liveFor(roomId, userId);
    await this.run(live, ctx, () => this.once(live, userId, idempotencyKey, async () => {
      const game = live.game;
      const round = game.currentRound;
      // Context for the log, as it stood before the card left the hand.
      const trick = game.phase === 'trick' ? round?.currentTrick ?? null : null;
      const before = round && trick
        ? {
            playPosition: trick.size + 1,
            handBeforePlay: game.getPlayer(userId).hand.map((c) => c.toData()),
            cardsPlayedInTrick: logEntries(trick),
            tricksWonPerPlayer: tricksWonPerPlayer(game),
            bidsThisRound: Object.fromEntries(round.bidOrder.map((id) => [id, round.getBid(id)])),
          }
        : null;

      let played: CardPlayed;
      try {
        played = game.playCard(userId, toCardData(card));
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        await this.publish(live, ctx, [
          { to: 'user', userId, event: 'invalid_play_error', payload: invalidPlayPayload(game, userId, err.code, err.message) },
        ]);
        return;
      }

      // The round the card was played in (still current: the next one is dealt below).
      const r = game.currentRound!;
      const playedTrick = r.tricks[played.trickNumber - 1];
      const roundNumber = r.roundNumber;
      const trickNumber = played.trickNumber;
      const out: Outbound[] = [
        {
          to: 'room',
          event: 'card_played',
          payload: { player_id: userId, card: played.card.toData(), trick_number: trickNumber },
          log: {
            eventType: 'card_played',
            actorUserId: userId,
            roundNumber,
            trickNumber,
            context: {
              playerId: userId,
              card: played.card.toData(),
              ...before,
              ledSuit: playedTrick.ledSuit,
              trumpSuit: r.trumpSuit,
              roundNumber,
              trickNumber,
            },
          },
        },
      ];
      const tc = played.trickCompleted;
      if (tc) {
        out.push({
          to: 'room',
          event: 'trick_complete',
          payload: { winner_id: tc.winnerId, cards_played: playEntries(playedTrick), trick_number: tc.trickNumber },
          log: {
            eventType: 'trick_completed',
            actorUserId: null,
            roundNumber,
            trickNumber,
            context: {
              trickNumber,
              roundNumber,
              winnerUserId: tc.winnerId,
              winningCard: tc.winningCard.toData(),
              winningCardType: tc.winningCardType,
              allCardsPlayed: logEntries(playedTrick),
              tricksWonPerPlayer: tricksWonPerPlayer(game),
            },
          },
        });
      }

      let closesAt: Date | null = null;
      if (played.roundCompleted) {
        const end = await this.endRound(live, ctx, played.roundCompleted);
        out.push(...end.out);
        closesAt = end.closesAt;
      } else {
        out.push(this.playRequest(game));
      }
      await this.publish(live, ctx, out);
      if (closesAt) {
        try {
          this.lifecycle.gameFinished(game.roomId, closesAt);
        } catch (err) {
          logger.error({ err, ...this.logFields(live, ctx) }, 'game finished handling failed');
        }
      }
    }));
  }

  /** Drops the room's game from memory once its room has closed. */
  forget(roomId: string): void {
    this.byRoom.delete(roomId);
  }

  /** Forgets every game (shutdown and tests). Does not touch the database. */
  stop(): void {
    this.byRoom.clear();
  }

  // --- internals --------------------------------------------------------------------------

  /**
   * After the last trick of a round: round_complete, the round written to rounds and
   * round_players with the games.state checkpoint, then either the next round's opening events
   * or, after the final round, the game's results and game_over. A failed write is logged and
   * the game carries on, as for the event log: the database is the record, not the game.
   */
  private async endRound(
    live: LiveGame,
    ctx: ActionContext,
    rc: RoundCompleted,
  ): Promise<{ out: Outbound[]; closesAt: Date | null }> {
    const game = live.game;
    const round = game.currentRound!;
    const out: Outbound[] = [
      {
        to: 'room',
        event: 'round_complete',
        payload: roundCompletePayload(game, rc),
        log: {
          eventType: 'round_completed',
          actorUserId: null,
          roundNumber: rc.roundNumber,
          context: {
            roundNumber: rc.roundNumber,
            results: rc.results.map((x) => ({
              userId: x.playerId,
              bid: x.bid,
              tricksWon: x.tricksWon,
              scoreDelta: x.scoreDelta,
              cumulativeScore: rc.scores[x.playerId],
            })),
          },
        },
      },
    ];
    const record: RoundRecord = {
      gameId: game.gameId,
      roundNumber: rc.roundNumber,
      dealerUserId: round.dealerId,
      trumpSuit: round.trumpSuit,
      trumpSource: round.trumpSource,
      startedAt: live.roundStartedAt,
      players: rc.results.map((x) => ({
        userId: x.playerId,
        bid: x.bid,
        tricksWon: x.tricksWon,
        scoreDelta: x.scoreDelta,
        bidPosition: round.bidPosition(x.playerId),
      })),
    };

    if (!rc.isFinalRound) {
      await this.persist(live, ctx, 'round record', (trx) => recordRound(trx, record, game.toGameState()));
      let started: RoundStarted;
      try {
        started = game.startRound();
      } catch (err) {
        // Not expected (the deck is built fresh each round). The round's results still go out;
        // the game waits in round_end until it is abandoned.
        logger.error({ err, ...this.logFields(live, ctx), roundNumber: rc.roundNumber + 1 }, 'next round deal failed');
        return { out, closesAt: null };
      }
      out.push(...this.openRound(live, started));
      return { out, closesAt: null };
    }

    const result = game.endGame();
    const closesAt = new Date(Date.now() + this.countdownMs);
    const payload = gameOverPayload(game, result, closesAt, this.countdownMs);
    live.gameOver = payload;
    const state = game.toGameState();
    const winners = new Set(result.winnerIds);
    await this.persist(live, ctx, 'game result', async (trx) => {
      await recordRound(trx, record, state);
      await recordGameComplete(trx, {
        gameId: game.gameId,
        roomId: game.roomId,
        state,
        results: game.activePlayers.map((p) => ({
          userId: p.id,
          finalScore: result.scores[p.id],
          outcome: winners.has(p.id) ? 'win' : 'loss',
          roundsPlayed: state.roundHistory.length,
        })),
      });
    });
    out.push({
      to: 'room',
      event: 'game_over',
      payload,
      log: {
        eventType: 'game_completed',
        actorUserId: null,
        roundNumber: rc.roundNumber,
        context: {
          finalScores: result.scores,
          winners: result.winnerIds,
          status: 'complete',
          roundCount: game.config.roundCount,
          playerCount: game.activePlayers.length,
        },
      },
    });
    return { out, closesAt };
  }

  private async persist(live: LiveGame, ctx: ActionContext, what: string, fn: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
    try {
      await db.transaction(fn);
    } catch (err) {
      logger.error({ err, ...this.logFields(live, ctx), roundNumber: live.game.currentRoundNumber }, `${what} write failed`);
    }
  }

  /**
   * The events that open a dealt round: round_started, hand_dealt to each player, then either
   * trump_selection_request to the dealer (Wizard flipped) or trump_revealed and the first
   * bid_request (suited card, Jester, or no card left to flip).
   */
  private openRound(live: LiveGame, started: RoundStarted): Outbound[] {
    const game = live.game;
    const round = game.currentRound!;
    live.roundStartedAt = new Date();
    const trumpCard = started.trumpCard?.toData() ?? null;
    const out: Outbound[] = [
      {
        to: 'room',
        event: 'round_started',
        payload: roundStartedPayload(started),
        log: {
          eventType: 'round_started',
          actorUserId: null,
          context: {
            roundNumber: started.roundNumber,
            dealerUserId: started.dealerId,
            trumpCard,
            trumpSuit: started.trumpSuit,
            trumpSource: started.trumpSource,
            requiresDeclaration: started.requiresDeclaration,
            dealtHands: round.dealtHands,
            scoresBeforeRound: game.scores,
          },
        },
      },
      ...game.activePlayers.map(
        (p): Outbound => ({ to: 'user', userId: p.id, event: 'hand_dealt', payload: handDealtPayload(game, p.id) }),
      ),
    ];
    if (started.requiresDeclaration) {
      out.push({
        to: 'user',
        userId: started.dealerId,
        event: 'trump_selection_request',
        payload: { player_id: started.dealerId, round_number: started.roundNumber },
      });
    } else {
      out.push(
        {
          to: 'room',
          event: 'trump_revealed',
          payload: trumpRevealedPayload(started.roundNumber, started.trumpSuit, trumpCard, started.trumpSource),
          log: { eventType: 'trump_revealed', actorUserId: null },
        },
        this.bidRequest(game),
      );
    }
    return out;
  }

  /** The request a player would have been sent for the current turn, if it is theirs. */
  private pendingPrompt(live: LiveGame, userId: string): { event: string; payload: unknown } | null {
    const game = live.game;
    if (live.gameOver) return { event: 'game_over', payload: live.gameOver };
    if (game.currentTurnId !== userId) return null;
    if (game.phase === 'trump_declaration') {
      return { event: 'trump_selection_request', payload: { player_id: userId, round_number: game.currentRoundNumber } };
    }
    if (game.phase === 'bidding') return { event: 'bid_request', payload: bidRequestPayload(game, userId) };
    if (game.phase === 'trick') return { event: 'play_request', payload: playRequestPayload(game, userId) };
    return null;
  }

  private playRequest(game: Game): Outbound {
    const player = game.currentTurnId!;
    return { to: 'user', userId: player, event: 'play_request', payload: playRequestPayload(game, player) };
  }

  private bidRequest(game: Game): Outbound {
    const bidder = game.currentRound!.currentBidderId!;
    return { to: 'user', userId: bidder, event: 'bid_request', payload: bidRequestPayload(game, bidder) };
  }

  private viewFor(game: Game, userId: string): GameStateView {
    return game.activePlayers.some((p) => p.id === userId) ? game.toPlayerView(userId) : game.toSpectatorView();
  }

  /** The room's live game, if `userId` is seated in it. */
  private liveFor(roomId: string, userId: string): LiveGame {
    const live = this.byRoom.get(roomId);
    if (!live || !live.game.activePlayers.some((p) => p.id === userId)) throw new NotAPlayerError();
    return live;
  }

  /**
   * Runs an action once per idempotency key. The key is recorded only after the action has been
   * processed and published (an invalid_*_error reply counts), so if the action throws, a retry
   * with the same key is processed rather than silently acknowledged.
   */
  private async once(live: LiveGame, userId: string, key: unknown, fn: () => Promise<void>): Promise<void> {
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) return fn();
    const now = Date.now();
    for (const [k, at] of live.keys) if (now - at > IDEMPOTENCY_WINDOW_MS) live.keys.delete(k);
    const id = `${userId}:${key}`;
    if (live.keys.has(id)) return;
    await fn();
    live.keys.set(id, Date.now());
  }

  private logFields(live: LiveGame, ctx: ActionContext) {
    return { userId: ctx.userId, traceId: ctx.traceId, gameId: live.game.gameId, roomId: live.game.roomId };
  }

  private run<T>(live: LiveGame, ctx: ActionContext, fn: () => Promise<T>): Promise<T> {
    const result = live.queue.then(fn);
    live.queue = result.then(
      () => undefined,
      (err) => logger.error({ err, ...this.logFields(live, ctx) }, 'game action failed'),
    );
    return result;
  }

  /**
   * Numbers the broadcasts, appends them to game_events, then delivers everything in order. A
   * failed log write is logged and the events are still delivered: the game must not stall on
   * the audit log. A failed delivery is logged and the remaining ones still go out.
   */
  private async publish(live: LiveGame, ctx: ActionContext, items: Outbound[]): Promise<void> {
    const { game } = live;
    const rows: GameEventRow[] = [];
    const deliveries: (() => void)[] = [];
    for (const item of items) {
      if (item.to === 'room') {
        const seq = ++live.seq;
        rows.push({
          gameId: game.gameId,
          seq,
          event: item.event,
          eventType: item.log.eventType,
          roundNumber: item.log.roundNumber ?? game.currentRoundNumber,
          trickNumber: item.log.trickNumber ?? null,
          actorUserId: item.log.actorUserId,
          payload: item.log.context ?? item.payload,
          sentPayload: item.payload,
        });
        deliveries.push(() => this.notifier.deliverToRoom(game.roomId, item.event, item.payload, seq));
      } else {
        const seq = live.seq;
        deliveries.push(() => this.notifier.deliverToUser(game.roomId, item.userId, item.event, item.payload, seq));
      }
    }
    try {
      await insertGameEvents(rows);
    } catch (err) {
      logger.error({ err, ...this.logFields(live, ctx), seqs: rows.map((r) => r.seq) }, 'game event log write failed');
    }
    // One failed delivery must not stop the rest: the game state has already moved on.
    for (const deliver of deliveries) {
      try {
        deliver();
      } catch (err) {
        logger.error({ err, ...this.logFields(live, ctx) }, 'game event delivery failed');
      }
    }
  }
}

/** A trick's cards in the event log's camelCase shape. */
function logEntries(trick: Trick): { playerId: string; card: CardData }[] {
  return trick.cards.map((c) => ({ playerId: c.playerId, card: c.card.toData() }));
}

function tricksWonPerPlayer(game: Game): Record<string, number> {
  return Object.fromEntries(game.activePlayers.map((p) => [p.id, p.tricksWon]));
}

/**
 * The card a client named, in the engine's shape. Anything that is not a card comes out as one
 * nobody holds, so the engine answers CARD_NOT_IN_HAND. Wizards and Jesters have no suit or rank,
 * whatever the client sent.
 */
function toCardData(value: unknown): CardData {
  const o = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  if (o.type === 'wizard' || o.type === 'jester') return { type: o.type, suit: null, rank: null };
  return { type: o.type, suit: o.suit, rank: o.rank } as CardData;
}
