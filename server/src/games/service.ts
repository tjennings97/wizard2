import type { Knex } from 'knex';
import { db } from '../db/knex';
import {
  EngineError,
  Game,
  Player,
  type CardData,
  type CardPlayed,
  type DeckFactory,
  type GameState,
  type GameStateView,
  type PlayerDropped,
  type RandomSource,
  type RoundCompleted,
  type RoundStarted,
  type Suit,
  type Trick,
} from '../engine';
import { logger } from '../logger';
import { gamesCompletedTotal, gamesStartedTotal, wsReconnectionsTotal } from '../metrics/registry';
import type { RoomConfig } from '../rooms/rules';
import {
  bidRequestPayload,
  bidsSoFar,
  continueOrEndRequestPayload,
  gameAbandonedPayload,
  gameStartedPayload,
  gameTimeWarningPayload,
  gameStartingPayload,
  handDealtPayload,
  gameOverPayload,
  invalidBidPayload,
  invalidPlayPayload,
  invalidTrumpPayload,
  playEntries,
  playerDisconnectedPayload,
  playRequestPayload,
  roundCompletePayload,
  roundStartedPayload,
  trumpRevealedPayload,
} from './payloads';
import {
  eventsBetween,
  insertGameEvents,
  recordGameComplete,
  recordGameIncomplete,
  recordRound,
  type DropReason,
  type GameEventRow,
  type GameEventType,
  type GamePlayerRow,
  type GameResultRow,
  type ReplayedEvent,
  type RoundRecord,
} from './queries';
import { RECONNECT_WINDOW_MS } from '../shared/reconnect';

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
  /** Whether the user has a socket in the room's channel. */
  isInRoom(roomId: string, userId: string): boolean;
}

const noopNotifier: GameNotifier = { deliverToRoom: () => {}, deliverToUser: () => {}, isInRoom: () => true };

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
  /**
   * A disconnected player's 30-second seat hold ran out. Mark them left (room_members.left_at)
   * and broadcast user_left with reason "timeout", which applies the player-drop rules
   * (userLeft below).
   */
  playerTimedOut(roomId: string, userId: string): Promise<void>;
}

const noopLifecycle: GameLifecycle = { gameFinished: () => {}, playerTimedOut: async () => {} };

/** How long the room stays COMPLETING (the game-over screen) before it closes. */
export const COMPLETING_COUNTDOWN_MS = 30 * 1000;

/** Duplicate idempotency keys within this window are acknowledged without reprocessing. */
export const IDEMPOTENCY_WINDOW_MS = 60 * 1000;

/** How long the last two players have to answer continue_or_end_request. No answer counts as end. */
export const CONTINUE_DECISION_MS = 60 * 1000;

/** A game lasts at most this long from game_started. */
export const GAME_TIME_LIMIT_MS = 3 * 60 * 60 * 1000;

/** game_time_warning goes out this long before the limit. */
export const GAME_TIME_WARNING_LEAD_MS = 15 * 60 * 1000;

/** A reconnect that missed more events than this gets the state_snapshot without the replay. */
export const MAX_REPLAY_EVENTS = 200;

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
  /** When game_started went out; the time limit runs from here. */
  readonly startedAt = new Date();
  /**
   * The event that ended the game (game_over, or game_abandoned at the time limit) once it has
   * ended; re-sent after state_snapshot. Nothing else is applied to an ended game.
   */
  ended: { event: string; payload: unknown } | null = null;
  /** Seat holds of disconnected players (the 30-second reconnection window), by user id. */
  readonly away = new Map<string, NodeJS.Timeout>();
  /**
   * The held seats that follow a real dropped connection, which ws_reconnections_total counts.
   * Not the holds for players who had no socket in the room when the game started.
   */
  readonly reconnecting = new Set<string>();
  /** Players who quit or timed out, for their game_results row. */
  readonly departed = new Map<string, { dropReason: DropReason; roundsPlayed: number }>();
  /** Answers to continue_or_end_request so far, by user id. */
  readonly choices = new Map<string, 'continue' | 'end'>();
  continueTimer: NodeJS.Timeout | null = null;
  /** The continue_or_end_request payload while a decision is pending; re-sent after state_snapshot. */
  continueRequest: unknown = null;
  warningTimer: NodeJS.Timeout | null = null;
  limitTimer: NodeJS.Timeout | null = null;

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
  /** The disconnected player's seat hold. Tests shorten it. */
  reconnectWindowMs?: number;
  /** The continue-or-end decision window. Tests shorten it. */
  continueDecisionMs?: number;
  /** The game time limit, and how long before it the warning goes out. Tests shorten them. */
  timeLimitMs?: number;
  timeWarningLeadMs?: number;
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
 * Covers start through game_over, and the connection side: a disconnected player's seat is held
 * for 30 seconds, a player who quits or times out is dropped (the round is voided and re-dealt,
 * or the last two decide whether to continue), and a game is abandoned at the 3-hour limit.
 */
export class GameService {
  private notifier: GameNotifier = noopNotifier;
  private lifecycle: GameLifecycle = noopLifecycle;
  private readonly byRoom = new Map<string, LiveGame>();
  readonly countdownMs: number;
  readonly reconnectWindowMs: number;
  readonly continueDecisionMs: number;
  readonly timeLimitMs: number;
  readonly timeWarningLeadMs: number;

  constructor(private readonly options: GameServiceOptions = {}) {
    this.countdownMs = options.countdownMs ?? COMPLETING_COUNTDOWN_MS;
    this.reconnectWindowMs = options.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
    this.continueDecisionMs = options.continueDecisionMs ?? CONTINUE_DECISION_MS;
    this.timeLimitMs = options.timeLimitMs ?? GAME_TIME_LIMIT_MS;
    this.timeWarningLeadMs = options.timeWarningLeadMs ?? GAME_TIME_WARNING_LEAD_MS;
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
   *
   * Starts the 3-hour time limit. A player with no socket in the room right now is treated as
   * disconnected (player_disconnected and the seat hold), so a game never waits forever on someone
   * who never shows up.
   */
  async launch(game: Game, started: RoundStarted, ctx: ActionContext = SERVER_CONTEXT): Promise<void> {
    const live = new LiveGame(game);
    this.byRoom.set(game.roomId, live);
    gamesStartedTotal.inc();
    this.armTimeLimit(live);
    await this.run(live, ctx, async () => {
      const context = {
        config: game.config,
        players: game.activePlayers.map((p, i) => ({ userId: p.id, displayName: p.displayName, seatOrder: i + 1 })),
      };
      const announce: Outbound[] = [
        { to: 'room', event: 'game_starting', payload: gameStartingPayload(game), log: { eventType: 'game_starting', actorUserId: null, context, roundNumber: 0 } },
        { to: 'room', event: 'game_started', payload: gameStartedPayload(game), log: { eventType: 'game_started', actorUserId: null, context, roundNumber: 0 } },
      ];
      const absent = game.activePlayers
        .filter((p) => !this.notifier.isInRoom(game.roomId, p.id))
        .map((p) => this.holdSeat(live, p.id, { afterDisconnect: false }));
      await this.publish(live, ctx, [...announce, ...this.openRound(live, started), ...absent]);
    });
  }

  isLive(roomId: string): boolean {
    return this.byRoom.has(roomId);
  }

  gameIdFor(roomId: string): string | null {
    return this.byRoom.get(roomId)?.game.gameId ?? null;
  }

  /** Games registered and not yet ended (the games_active gauge). */
  activeCount(): number {
    let n = 0;
    for (const live of this.byRoom.values()) if (!live.ended) n++;
    return n;
  }

  /**
   * Runs `fn` in the game's queue with the viewer's filtered state, the current seq and the
   * prompt the viewer still owes (trump_selection_request, bid_request or play_request when it is
   * their turn; game_over or game_abandoned to everyone once the game has ended),
   * so what it sends is ordered with the game's events. Players get their own view, everyone else
   * the spectator view. Returns false (without calling `fn`) if the room has no live game.
   *
   * With `replayAfter` (a reconnect's last_seq_seen), `replay` is the logged broadcasts after it, up
   * to the view's seq, read from game_events: what the client missed. Empty if it missed more than
   * MAX_REPLAY_EVENTS (the view alone restores the state) or the log could not be read.
   */
  async withView(
    roomId: string,
    userId: string,
    fn: (view: GameStateView, seq: number, prompt: { event: string; payload: unknown } | null, replay: ReplayedEvent[]) => void,
    replayAfter: number | null = null,
  ): Promise<boolean> {
    const live = this.byRoom.get(roomId);
    if (!live) return false;
    await this.run(live, SERVER_CONTEXT, async () => {
      const seq = live.seq;
      let replay: ReplayedEvent[] = [];
      if (replayAfter !== null && replayAfter < seq && seq - replayAfter <= MAX_REPLAY_EVENTS) {
        try {
          replay = await eventsBetween(live.game.gameId, replayAfter, seq);
        } catch (err) {
          logger.error({ err, ...this.logFields(live, { userId, traceId: null }), replayAfter }, 'replay read failed');
        }
      }
      fn(this.viewFor(live.game, userId), seq, this.pendingPrompt(live, userId), replay);
    });
    return true;
  }

  /**
   * The user's own view of the room's live game (game.toPlayerView: their hand only), or null if
   * the room has no live game or the user holds no seat in it. Read outside the game's queue: a
   * point-in-time snapshot for bug reports, never sent to a client.
   */
  playerView(roomId: string, userId: string): GameStateView | null {
    const live = this.byRoom.get(roomId);
    if (!live || !live.game.activePlayers.some((p) => p.id === userId)) return null;
    return live.game.toPlayerView(userId);
  }

  /** Whether the user holds a seat in the room's live game (has not quit or timed out). */
  isSeated(roomId: string, userId: string): boolean {
    return this.byRoom.get(roomId)?.game.activePlayers.some((p) => p.id === userId) ?? false;
  }

  /** Current seq of the room's game, or null if there is none. For unicasts from other layers. */
  currentSeq(roomId: string): number | null {
    return this.byRoom.get(roomId)?.seq ?? null;
  }

  /**
   * Broadcasts user_joined (a spectator joining) as part of the game's sequence, so it is numbered
   * and logged like any other. Returns false if the room has no live game.
   */
  async publishRoomEvent(roomId: string, event: 'user_joined', actorUserId: string, payload: unknown): Promise<boolean> {
    const live = this.byRoom.get(roomId);
    if (!live) return false;
    const ctx: ActionContext = { userId: actorUserId, traceId: null };
    await this.run(live, ctx, () => this.publish(live, ctx, [{ to: 'room', event, payload, log: { eventType: event, actorUserId } }]));
    return true;
  }

  /**
   * A member has left the room (their room_members.left_at is set): broadcasts user_left in the
   * game's sequence. If they held a seat in a game still being played, that is a drop
   * (`voluntary` = quit, `timeout` = the seat hold ran out) and the player-drop rules follow, in
   * the same step: with 3 or more players left the round is voided and re-dealt (round_started,
   * hand_dealt, ...); with 2, continue_or_end_request; with 1, the game ends incomplete
   * (game_over). Anyone else leaving (a spectator, or anyone once the game is over) is not a
   * drop. Returns false if the room has no live game.
   */
  async userLeft(roomId: string, userId: string, reason: 'voluntary' | 'timeout', payload: unknown): Promise<boolean> {
    const live = this.byRoom.get(roomId);
    if (!live) return false;
    const ctx: ActionContext = { userId, traceId: null };
    await this.run(live, ctx, async () => {
      this.clearSeatHold(live, userId);
      const game = live.game;
      const out: Outbound[] = [{ to: 'room', event: 'user_left', payload, log: { eventType: 'user_left', actorUserId: userId } }];
      if (live.ended || !game.activePlayers.some((p) => p.id === userId)) {
        await this.publish(live, ctx, out);
        return;
      }

      const dropReason: DropReason = reason === 'voluntary' ? 'player_quit' : 'player_timeout';
      const roundsPlayed = game.toGameState().roundHistory.length;
      let dropped: PlayerDropped;
      try {
        dropped = game.removePlayer(userId);
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        logger.error({ err, ...this.logFields(live, ctx) }, 'player drop refused by the engine');
        await this.publish(live, ctx, out);
        return;
      }
      live.departed.set(userId, { dropReason, roundsPlayed });
      logger.info({ ...this.logFields(live, ctx), dropReason, outcome: dropped.outcome, remaining: game.activePlayers.length }, 'player dropped');

      let closesAt: Date | null = null;
      switch (dropped.outcome) {
        case 'round_redealt':
          out.push(...this.openRound(live, dropped.roundStarted!));
          break;
        case 'removed':
          out.push(...this.resumeAfterDrop(live, ctx));
          break;
        case 'continue_or_end':
          out.push(this.askContinueOrEnd(live));
          break;
        case 'incomplete': {
          const end = await this.endEarly(live, ctx, dropReason);
          out.push(end.item);
          closesAt = end.closesAt;
          break;
        }
      }
      await this.publish(live, ctx, out);
      if (closesAt) this.finished(live, ctx, closesAt);
    });
    return true;
  }

  /**
   * The user's last socket in the room has closed. A player still seated in a game being played
   * keeps their seat for the reconnection window: player_disconnected goes out and the hold
   * starts. If it runs out, the room service is told (GameLifecycle.playerTimedOut).
   */
  async playerDisconnected(roomId: string, userId: string): Promise<void> {
    const live = this.byRoom.get(roomId);
    if (!live) return;
    const ctx: ActionContext = { userId, traceId: null };
    await this.run(live, ctx, async () => {
      if (live.ended || live.away.has(userId) || !live.game.activePlayers.some((p) => p.id === userId)) return;
      // A socket that came back while this waited in the queue.
      if (this.notifier.isInRoom(roomId, userId)) return;
      await this.publish(live, ctx, [this.holdSeat(live, userId, { afterDisconnect: true })]);
    });
  }

  /**
   * A player whose seat is held has a socket in the room again (after it was sent state_snapshot):
   * the hold is cleared and player_reconnected goes out. A no-op for anyone else.
   */
  async playerReconnected(roomId: string, userId: string): Promise<void> {
    const live = this.byRoom.get(roomId);
    if (!live) return;
    const ctx: ActionContext = { userId, traceId: null };
    await this.run(live, ctx, async () => {
      const reconnecting = live.reconnecting.has(userId);
      const held = this.clearSeatHold(live, userId);
      if (held && reconnecting) wsReconnectionsTotal.inc({ outcome: 'success' });
      const player = live.game.activePlayers.find((p) => p.id === userId);
      // Also a player whose hold ran out but who was not dropped (the timeout could not be
      // recorded): they are back, so they are connected again.
      if (!player || (!held && player.connected)) return;
      player.connected = true;
      if (live.ended) return;
      await this.publish(live, ctx, [
        { to: 'room', event: 'player_reconnected', payload: { player_id: userId }, log: { eventType: 'player_reconnected', actorUserId: userId } },
      ]);
    });
  }

  /** Whether the user's seat is being held for them (tests). */
  isHoldingSeat(roomId: string, userId: string): boolean {
    return this.byRoom.get(roomId)?.away.has(userId) ?? false;
  }

  /**
   * One of the last two players answers continue_or_end_request. `end` from either ends the game
   * incomplete (mutual_end) at once; once both have said `continue`, the voided round is re-dealt
   * for the two of them. Anything else (no decision pending, not a choice) is ignored.
   */
  async chooseContinueOrEnd(roomId: string, ctx: ActionContext & { userId: string }, choice: unknown, idempotencyKey?: unknown): Promise<void> {
    const { userId } = ctx;
    const live = this.liveFor(roomId, userId);
    await this.run(live, ctx, () => this.once(live, userId, idempotencyKey, async () => {
      const game = live.game;
      if (live.ended || game.phase !== 'awaiting_continue_decision' || (choice !== 'continue' && choice !== 'end')) {
        logger.debug({ ...this.logFields(live, ctx), choice, phase: game.phase }, 'choose_continue_or_end ignored');
        return;
      }
      live.choices.set(userId, choice);
      logger.info({ ...this.logFields(live, ctx), choice }, 'continue or end chosen');
      if (choice === 'end') {
        const end = await this.endEarly(live, ctx, 'mutual_end');
        await this.publish(live, ctx, [end.item]);
        this.finished(live, ctx, end.closesAt);
        return;
      }
      if (!game.activePlayers.every((p) => live.choices.get(p.id) === 'continue')) return;
      this.clearContinueTimer(live);
      live.choices.clear();
      const started = game.resolveContinueOrEnd(true);
      await this.publish(live, ctx, started ? this.openRound(live, started) : this.resumeAfterDrop(live, ctx));
    }));
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
      if (closesAt) this.finished(live, ctx, closesAt);
    }));
  }

  /** Drops the room's game from memory once its room has closed. */
  forget(roomId: string): void {
    const live = this.byRoom.get(roomId);
    if (live) this.clearTimers(live);
    this.byRoom.delete(roomId);
  }

  /** Forgets every game and clears its timers (shutdown and tests). Does not touch the database. */
  stop(): void {
    for (const live of this.byRoom.values()) this.clearTimers(live);
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
    this.clearTimers(live);
    gamesCompletedTotal.inc({ status: 'complete' });
    const closesAt = new Date(Date.now() + this.countdownMs);
    const payload = gameOverPayload(game, result, closesAt, this.countdownMs);
    live.ended = { event: 'game_over', payload };
    const state = game.toGameState();
    await this.persist(live, ctx, 'game result', async (trx) => {
      await recordRound(trx, record, state);
      await recordGameComplete(trx, {
        gameId: game.gameId,
        roomId: game.roomId,
        state,
        results: this.resultRows(live, state, { winners: new Set(result.winnerIds) }),
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

  /**
   * Ends the game early: the round in progress is not scored, nobody wins. Writes games.status =
   * incomplete with `dropReason`, game_results (outcome incomplete) and the final checkpoint, and
   * moves the room to completing. Returns the event that announces it: game_over (status
   * incomplete) after a drop or a mutual end, game_abandoned at the time limit. The caller
   * publishes it, then calls finished().
   */
  private async endEarly(live: LiveGame, ctx: ActionContext, dropReason: DropReason): Promise<{ item: Outbound; closesAt: Date }> {
    const game = live.game;
    const phaseBefore = game.phase;
    const roundNumber = game.currentRoundNumber;
    if (game.phase === 'awaiting_continue_decision' && dropReason === 'mutual_end') game.resolveContinueOrEnd(false);
    else if (game.phase !== 'incomplete') game.abandon();
    this.clearTimers(live);
    gamesCompletedTotal.inc({ status: 'incomplete' });

    const closesAt = new Date(Date.now() + this.countdownMs);
    const state = game.toGameState();
    await this.persist(live, ctx, 'incomplete game result', (trx) =>
      recordGameIncomplete(trx, {
        gameId: game.gameId,
        roomId: game.roomId,
        state,
        dropReason,
        playerCountAtDrop: game.activePlayers.length,
        results: this.resultRows(live, state, { dropReason }),
      }),
    );
    logger.info({ ...this.logFields(live, ctx), dropReason, phaseBefore, roundNumber }, 'game ended incomplete');

    let item: Outbound;
    if (dropReason === 'time_limit' || dropReason === 'server_restart') {
      const payload = gameAbandonedPayload(game.gameId, dropReason);
      item = {
        to: 'room',
        event: 'game_abandoned',
        payload,
        log: { eventType: 'game_abandoned', actorUserId: null, context: { ...payload, phase: phaseBefore, roundNumber, scores: game.scores } },
      };
    } else {
      const payload = gameOverPayload(game, { winnerIds: [], scores: game.scores }, closesAt, this.countdownMs, 'incomplete');
      item = {
        to: 'room',
        event: 'game_over',
        payload,
        log: {
          eventType: 'game_completed',
          actorUserId: null,
          context: {
            finalScores: game.scores,
            winners: [],
            status: 'incomplete',
            dropReason,
            roundCount: game.config.roundCount,
            playerCount: game.activePlayers.length,
          },
        },
      };
    }
    live.ended = { event: item.event, payload: item.payload };
    return { item, closesAt };
  }

  /**
   * game_results rows: the players still seated (win / loss, or incomplete with the game's
   * `dropReason`), and everyone who quit or timed out (incomplete, with their own reason and
   * their score and rounds when they left).
   */
  private resultRows(
    live: LiveGame,
    state: GameState,
    end: { winners: Set<string> } | { dropReason: DropReason },
  ): GameResultRow[] {
    const rows: GameResultRow[] = state.players.map((p) => ({
      userId: p.userId,
      finalScore: p.cumulativeScore,
      outcome: 'winners' in end ? (end.winners.has(p.userId) ? 'win' : 'loss') : 'incomplete',
      dropReason: 'winners' in end ? null : end.dropReason,
      roundsPlayed: state.roundHistory.length,
    }));
    for (const d of state.droppedPlayers) {
      const departed = live.departed.get(d.userId);
      rows.push({
        userId: d.userId,
        finalScore: d.finalScore,
        outcome: 'incomplete',
        dropReason: departed?.dropReason ?? 'player_quit',
        roundsPlayed: departed?.roundsPlayed ?? 0,
      });
    }
    return rows;
  }

  /** The game has ended: hand the room to the room service for the COMPLETING countdown. */
  private finished(live: LiveGame, ctx: ActionContext, closesAt: Date): void {
    try {
      this.lifecycle.gameFinished(live.game.roomId, closesAt);
    } catch (err) {
      logger.error({ err, ...this.logFields(live, ctx) }, 'game finished handling failed');
    }
  }

  /**
   * After a drop that voided no round (the game was between rounds): deal the next round. Only
   * reachable if dealing failed earlier, since the next round is normally dealt in the same step.
   */
  private resumeAfterDrop(live: LiveGame, ctx: ActionContext): Outbound[] {
    const game = live.game;
    if (game.phase !== 'round_end' || !game.hasMoreRounds) return [];
    try {
      return this.openRound(live, game.startRound());
    } catch (err) {
      logger.error({ err, ...this.logFields(live, ctx) }, 'deal after drop failed');
      return [];
    }
  }

  /** continue_or_end_request to the room, starting the decision window. */
  private askContinueOrEnd(live: LiveGame): Outbound {
    live.choices.clear();
    this.clearContinueTimer(live);
    const deadline = new Date(Date.now() + this.continueDecisionMs);
    const timer = setTimeout(() => {
      if (live.continueTimer !== timer) return;
      live.continueTimer = null;
      this.runTimer(live, 'continue decision timeout', async () => {
        if (live.ended || live.game.phase !== 'awaiting_continue_decision') return;
        const end = await this.endEarly(live, SERVER_CONTEXT, 'mutual_end');
        await this.publish(live, SERVER_CONTEXT, [end.item]);
        this.finished(live, SERVER_CONTEXT, end.closesAt);
      });
    }, this.continueDecisionMs);
    timer.unref();
    live.continueTimer = timer;
    live.continueRequest = continueOrEndRequestPayload(live.game, deadline);
    return {
      to: 'room',
      event: 'continue_or_end_request',
      payload: live.continueRequest,
      log: { eventType: 'continue_or_end_request', actorUserId: null },
    };
  }

  /**
   * Holds a disconnected player's seat: marks them disconnected and starts the reconnection
   * window. Returns the player_disconnected broadcast for the caller to publish. `afterDisconnect`
   * is false for a player who was absent when the game started: their hold is not a reconnection.
   */
  private holdSeat(live: LiveGame, userId: string, { afterDisconnect }: { afterDisconnect: boolean }): Outbound {
    this.clearSeatHold(live, userId);
    if (afterDisconnect) live.reconnecting.add(userId);
    const deadline = new Date(Date.now() + this.reconnectWindowMs);
    const timer = setTimeout(() => {
      if (live.away.get(userId) !== timer || this.byRoom.get(live.game.roomId) !== live) return;
      live.away.delete(userId);
      if (live.reconnecting.delete(userId)) wsReconnectionsTotal.inc({ outcome: 'timeout' });
      logger.warn({ ...this.logFields(live, { userId, traceId: null }), event: 'game.reconnect_timeout' }, 'reconnection window expired');
      this.lifecycle
        .playerTimedOut(live.game.roomId, userId)
        .catch((err) => logger.error({ err, ...this.logFields(live, { userId, traceId: null }) }, 'player timeout handling failed'));
    }, this.reconnectWindowMs);
    timer.unref();
    live.away.set(userId, timer);
    live.game.getPlayer(userId).connected = false;
    return {
      to: 'room',
      event: 'player_disconnected',
      payload: playerDisconnectedPayload(userId, deadline),
      log: { eventType: 'player_disconnected', actorUserId: userId },
    };
  }

  /** Clears the user's seat hold. Returns whether there was one. */
  private clearSeatHold(live: LiveGame, userId: string): boolean {
    live.reconnecting.delete(userId);
    const timer = live.away.get(userId);
    if (!timer) return false;
    clearTimeout(timer);
    live.away.delete(userId);
    return true;
  }

  private clearContinueTimer(live: LiveGame): void {
    if (live.continueTimer) clearTimeout(live.continueTimer);
    live.continueTimer = null;
  }

  /** The 3-hour limit: game_time_warning shortly before, then the game is abandoned. */
  private armTimeLimit(live: LiveGame): void {
    const endsAt = new Date(live.startedAt.getTime() + this.timeLimitMs);
    const warnIn = this.timeLimitMs - this.timeWarningLeadMs;
    if (warnIn > 0) {
      live.warningTimer = setTimeout(() => {
        live.warningTimer = null;
        this.runTimer(live, 'game time warning', async () => {
          if (live.ended) return;
          await this.publish(live, SERVER_CONTEXT, [
            {
              to: 'room',
              event: 'game_time_warning',
              payload: gameTimeWarningPayload(live.game, endsAt, Math.round(this.timeWarningLeadMs / 60000)),
              log: { eventType: 'game_time_warning', actorUserId: null },
            },
          ]);
        });
      }, warnIn);
      live.warningTimer.unref();
    }
    live.limitTimer = setTimeout(() => {
      live.limitTimer = null;
      this.runTimer(live, 'game time limit', async () => {
        if (live.ended) return;
        const end = await this.endEarly(live, SERVER_CONTEXT, 'time_limit');
        await this.publish(live, SERVER_CONTEXT, [end.item]);
        this.finished(live, SERVER_CONTEXT, end.closesAt);
      });
    }, this.timeLimitMs);
    live.limitTimer.unref();
  }

  /** Every timer of the game: seat holds, the continue decision and the time limit. */
  private clearTimers(live: LiveGame): void {
    for (const t of live.away.values()) clearTimeout(t);
    live.away.clear();
    this.clearContinueTimer(live);
    if (live.warningTimer) clearTimeout(live.warningTimer);
    if (live.limitTimer) clearTimeout(live.limitTimer);
    live.warningTimer = null;
    live.limitTimer = null;
  }

  /** Runs a timer's work in the game's queue, unless the game has been forgotten meanwhile. */
  private runTimer(live: LiveGame, what: string, fn: () => Promise<void>): void {
    if (this.byRoom.get(live.game.roomId) !== live) return;
    this.run(live, SERVER_CONTEXT, fn).catch((err) => logger.error({ err, ...this.logFields(live, SERVER_CONTEXT) }, `${what} failed`));
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
    if (live.ended) return live.ended;
    if (game.phase === 'awaiting_continue_decision' && live.continueRequest) {
      return { event: 'continue_or_end_request', payload: live.continueRequest };
    }
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
