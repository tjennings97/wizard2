import type { Knex } from 'knex';
import { db } from '../db/knex';
import { ApiError } from '../http/errors';
import { logger } from '../logger';
import { activeMembershipFor, getRoomView, type RoomRow, type RoomView } from './queries';
import {
  HOST_AWAY_MS,
  MIN_PLAYERS_TO_START,
  ROOM_TIMEOUT_MS,
  clampConfig,
  configFromStored,
  configToStored,
  defaultConfig,
  joinRejection,
  maxRounds,
  type BidRule,
  type MemberRole,
  type RoomClosedReason,
  type RoomConfig,
} from './rules';

/**
 * What the room service tells the real-time layer after each change has been committed.
 * Implemented by the socket layer (socket/realtime.ts); the service never touches sockets.
 * Calls are made in the order the events must reach clients.
 */
export interface RoomNotifier {
  /** Whether the user has a live socket. Used for RoomMember.connected. */
  isConnected(userId: string): boolean;
  /** Move the user's sockets from the lobby into the room, send room_snapshot, broadcast user_joined. */
  userEnteredRoom(userId: string, room: RoomView): Promise<void>;
  /** Broadcast user_left to the room, then return the user's sockets to the lobby. */
  userLeftRoom(userId: string, role: MemberRole, room: RoomView): Promise<void>;
  hostChanged(roomId: string, hostUserId: string): Promise<void>;
  configUpdated(roomId: string, config: RoomConfig): Promise<void>;
  /** Broadcast room_closed to the room, then return every socket still in it to the lobby. */
  roomClosed(roomId: string, reason: RoomClosedReason): Promise<void>;
  /** Broadcast rooms_updated and presence_updated to the lobby. */
  lobbyChanged(): Promise<void>;
}

export const noopNotifier: RoomNotifier = {
  isConnected: () => false,
  userEnteredRoom: async () => {},
  userLeftRoom: async () => {},
  hostChanged: async () => {},
  configUpdated: async () => {},
  roomClosed: async () => {},
  lobbyChanged: async () => {},
};

export interface ConfigPatch {
  roundCount?: number;
  bidRule?: BidRule;
}

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Room not found.');
const alreadyInRoom = () => new ApiError(409, 'ALREADY_IN_ROOM', 'You are already in an active room or game.');
const notHost = () => new ApiError(403, 'NOT_HOST', 'Only the host can do that.');
const gameStarted = () => new ApiError(403, 'GAME_ALREADY_STARTED', 'The game has already started.');
const roundCountTooHigh = (playerCount: number) =>
  new ApiError(
    400,
    'ROUND_COUNT_EXCEEDS_MAX',
    `Maximum rounds for ${playerCount} player${playerCount === 1 ? '' : 's'} is ${maxRounds(playerCount)}.`,
  );

/** Serialises every room-membership change a user makes (create, join, leave). */
async function lockUser(trx: Knex.Transaction, userId: string): Promise<void> {
  await trx('users').where({ id: userId }).forUpdate().first('id');
}

async function lockRoom(trx: Knex.Transaction, roomId: string): Promise<RoomRow | undefined> {
  return trx('rooms').where({ id: roomId }).forUpdate().first();
}

async function countActive(trx: Knex.Transaction, roomId: string): Promise<{ players: number; spectators: number }> {
  const rows: { role: MemberRole; n: string }[] = await trx('room_members')
    .where({ room_id: roomId })
    .whereNull('left_at')
    .groupBy('role')
    .select('role', trx.raw('count(*) as n'));
  const get = (role: MemberRole) => Number(rows.find((r) => r.role === role)?.n ?? 0);
  return { players: get('player'), spectators: get('spectator') };
}

/** Marks the room closed and every remaining member as left. The caller holds the room lock. */
async function closeRoomTx(trx: Knex.Transaction, roomId: string): Promise<void> {
  await trx('rooms').where({ id: roomId }).update({ state: 'closed', closed_at: trx.fn.now() });
  await trx('room_members').where({ room_id: roomId }).whereNull('left_at').update({ left_at: trx.fn.now() });
}

export interface RoomServiceOptions {
  notifier?: RoomNotifier;
  /** Inactivity timeout from creation. Tests shorten it. */
  timeoutMs?: number;
  /** How long a disconnected host of an open room keeps the role. Tests shorten it. */
  hostAwayMs?: number;
}

export class RoomService {
  private notifier: RoomNotifier;
  private readonly timeoutMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly hostAwayMs: number;
  /** Host-away grace timers, keyed by the disconnected user's id. */
  private readonly awayTimers = new Map<string, NodeJS.Timeout>();

  constructor({ notifier = noopNotifier, timeoutMs = ROOM_TIMEOUT_MS, hostAwayMs = HOST_AWAY_MS }: RoomServiceOptions = {}) {
    this.notifier = notifier;
    this.timeoutMs = timeoutMs;
    this.hostAwayMs = hostAwayMs;
  }

  /**
   * The user's last socket closed while they were in `roomId`. If they are that open room's host
   * and still have no socket after the grace period, the host role passes on (transferHostIfAway).
   * Cheap to call for non-hosts: everything is checked when the timer fires.
   */
  userDisconnected(userId: string, roomId: string): void {
    this.cancelAway(userId);
    const timer = setTimeout(() => {
      this.awayTimers.delete(userId);
      this.transferHostIfAway(userId, roomId).catch((err) =>
        logger.error({ err, userId, roomId }, 'host-away transfer failed'),
      );
    }, this.hostAwayMs);
    timer.unref();
    this.awayTimers.set(userId, timer);
  }

  /** The user has a socket again: they keep the host role. */
  userReconnected(userId: string): void {
    this.cancelAway(userId);
  }

  hasAwayTimer(userId: string): boolean {
    return this.awayTimers.has(userId);
  }

  /**
   * Gives the host role to the connected player with the lowest join order, if `userId` is still
   * the disconnected host of the open room. The old host stays a member. With no other connected
   * player, nothing changes (the inactivity timeout still closes the room).
   */
  async transferHostIfAway(userId: string, roomId: string): Promise<string | null> {
    const newHostId = await db.transaction(async (trx) => {
      const row = await lockRoom(trx, roomId);
      if (!row || row.state !== 'open' || row.host_user_id !== userId) return null;
      if (this.notifier.isConnected(userId)) return null;
      const candidates: { user_id: string }[] = await trx('room_members')
        .where({ room_id: roomId, role: 'player' })
        .whereNull('left_at')
        .whereNot({ user_id: userId })
        .orderBy('join_order', 'asc')
        .select('user_id');
      const next = candidates.find((c) => this.notifier.isConnected(c.user_id));
      if (!next) return null;
      await trx('rooms').where({ id: roomId }).update({ host_user_id: next.user_id });
      return next.user_id;
    });
    if (!newHostId) return null;

    logger.info({ userId, roomId, newHostId }, 'host disconnected: role transferred');
    await this.notify(async () => {
      await this.notifier.hostChanged(roomId, newHostId);
      await this.notifier.lobbyChanged();
    });
    return newHostId;
  }

  private cancelAway(userId: string): void {
    const timer = this.awayTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.awayTimers.delete(userId);
  }

  /** The socket layer is created after the service (it reads rooms on connect), so it is set late. */
  setNotifier(notifier: RoomNotifier): void {
    this.notifier = notifier;
  }

  isConnected(userId: string): boolean {
    return this.notifier.isConnected(userId);
  }

  async createRoom(userId: string, config: Partial<RoomConfig> = {}): Promise<RoomView> {
    const fullConfig = { ...defaultConfig(1), ...config };
    if (fullConfig.roundCount > maxRounds(1)) throw roundCountTooHigh(1);

    const room = await db.transaction(async (trx) => {
      await lockUser(trx, userId);
      if (await activeMembershipFor(userId, trx)) throw alreadyInRoom();

      const [row]: RoomRow[] = await trx('rooms')
        .insert({ host_user_id: userId, config: configToStored(fullConfig) })
        .returning('*');
      await trx('room_members').insert({ room_id: row.id, user_id: userId, role: 'player', join_order: 1 });
      return (await getRoomView(row.id, trx))!;
    });

    logger.info({ userId, roomId: room.id }, 'room created');
    this.scheduleTimeout(room.id, room.createdAt);
    await this.notify(async () => {
      await this.notifier.userEnteredRoom(userId, room);
      await this.notifier.lobbyChanged();
    });
    return room;
  }

  async joinRoom(userId: string, roomId: string, role: MemberRole): Promise<RoomView> {
    const { room, configChanged } = await db.transaction(async (trx) => {
      await lockUser(trx, userId);
      const row = await lockRoom(trx, roomId);
      if (!row) throw notFound();
      if (await activeMembershipFor(userId, trx)) throw alreadyInRoom();

      const counts = await countActive(trx, roomId);
      const rejection = joinRejection(row.state, role, counts);
      if (rejection === 'ROOM_NOT_JOINABLE') {
        throw new ApiError(
          403,
          'ROOM_NOT_JOINABLE',
          role === 'player' ? 'This room is not accepting new players.' : 'This room is not accepting spectators.',
        );
      }
      if (rejection === 'ROOM_FULL') {
        throw new ApiError(
          409,
          'ROOM_FULL',
          role === 'player' ? 'This room has reached its player limit.' : 'This room has reached its spectator limit.',
        );
      }

      const { max } = (await trx('room_members').where({ room_id: roomId }).max('join_order as max').first()) as {
        max: number | null;
      };
      const joinOrder = (max ?? 0) + 1;
      // A user who left and rejoins reuses their row (docs/architecture/data-model.md, Rejoining).
      const reused = await trx('room_members')
        .where({ room_id: roomId, user_id: userId })
        .update({ role, join_order: joinOrder, joined_at: trx.fn.now(), left_at: null });
      if (reused === 0) {
        await trx('room_members').insert({ room_id: roomId, user_id: userId, role, join_order: joinOrder });
      }

      // More players lowers the maximum round count; bring the configured count down with it.
      let changed = false;
      if (role === 'player') {
        const current = configFromStored(row.config, counts.players);
        const clamped = clampConfig(current, counts.players + 1);
        if (clamped !== current) {
          await trx('rooms').where({ id: roomId }).update({ config: configToStored(clamped) });
          changed = true;
        }
      }
      return { room: (await getRoomView(roomId, trx))!, configChanged: changed };
    });

    logger.info({ userId, roomId, role }, 'user joined room');
    await this.notify(async () => {
      await this.notifier.userEnteredRoom(userId, room);
      if (configChanged) await this.notifier.configUpdated(roomId, room.config);
      await this.notifier.lobbyChanged();
    });
    return room;
  }

  async leaveRoom(userId: string, roomId: string): Promise<void> {
    const outcome = await db.transaction(async (trx) => {
      await lockUser(trx, userId);
      const row = await lockRoom(trx, roomId);
      if (!row) throw notFound();
      const member: { role: MemberRole } | undefined = await trx('room_members')
        .where({ room_id: roomId, user_id: userId })
        .whereNull('left_at')
        .first('role');
      if (!member || row.state === 'closed') throw new ApiError(404, 'NOT_FOUND', 'You are not in this room.');
      if (member.role === 'player' && row.state !== 'open') {
        // Quitting a started game applies the player-drop rules, which need the game engine.
        throw new ApiError(403, 'GAME_ALREADY_STARTED', 'Leaving a game in progress is not supported yet.');
      }

      await trx('room_members').where({ room_id: roomId, user_id: userId }).update({ left_at: trx.fn.now() });

      let newHostId: string | null = null;
      let closed = false;
      if (row.state === 'open' && member.role === 'player') {
        const next: { user_id: string } | undefined = await trx('room_members')
          .where({ room_id: roomId, role: 'player' })
          .whereNull('left_at')
          .orderBy('join_order', 'asc')
          .first('user_id');
        if (!next) {
          await closeRoomTx(trx, roomId);
          closed = true;
        } else if (row.host_user_id === userId) {
          await trx('rooms').where({ id: roomId }).update({ host_user_id: next.user_id });
          newHostId = next.user_id;
        }
      }
      return { role: member.role, newHostId, closed, room: (await getRoomView(roomId, trx))! };
    });

    logger.info({ userId, roomId, role: outcome.role, newHostId: outcome.newHostId, closed: outcome.closed }, 'user left room');
    if (outcome.closed) this.cancelTimeout(roomId);
    await this.notify(async () => {
      await this.notifier.userLeftRoom(userId, outcome.role, outcome.room);
      if (outcome.newHostId) await this.notifier.hostChanged(roomId, outcome.newHostId);
      if (outcome.closed) await this.notifier.roomClosed(roomId, 'empty');
      await this.notifier.lobbyChanged();
    });
  }

  async updateConfig(userId: string, roomId: string, patch: ConfigPatch): Promise<RoomConfig> {
    const config = await db.transaction(async (trx) => {
      const row = await lockRoom(trx, roomId);
      if (!row || row.state === 'closed') throw notFound();
      if (row.state !== 'open') throw gameStarted();
      if (row.host_user_id !== userId) throw notHost();

      const { players } = await countActive(trx, roomId);
      if (patch.roundCount !== undefined && patch.roundCount > maxRounds(players)) throw roundCountTooHigh(players);
      const next: RoomConfig = { ...configFromStored(row.config, players), ...patch };
      await trx('rooms').where({ id: roomId }).update({ config: configToStored(next) });
      return next;
    });

    logger.info({ userId, roomId, config }, 'room config updated');
    await this.notify(async () => {
      await this.notifier.configUpdated(roomId, config);
      await this.notifier.lobbyChanged();
    });
    return config;
  }

  /**
   * POST /rooms/{roomId}/start. Applies every start guard, then refuses with 501: starting needs
   * the game engine wiring (docs/development/remaining-work.md), and an in_progress room with no
   * game behind it would trap its players. Nothing is changed.
   */
  async startGame(userId: string, roomId: string): Promise<never> {
    await db.transaction(async (trx) => {
      const row = await lockRoom(trx, roomId);
      if (!row || row.state === 'closed') throw notFound();
      if (row.state !== 'open') throw gameStarted();
      if (row.host_user_id !== userId) throw notHost();
      const { players } = await countActive(trx, roomId);
      if (players < MIN_PLAYERS_TO_START) {
        throw new ApiError(400, 'NOT_ENOUGH_PLAYERS', `At least ${MIN_PLAYERS_TO_START} players are required to start.`);
      }
    });
    throw new ApiError(501, 'NOT_IMPLEMENTED', 'Starting a game is not available yet.');
  }

  async closeByHost(userId: string, roomId: string): Promise<void> {
    await db.transaction(async (trx) => {
      const row = await lockRoom(trx, roomId);
      if (!row || row.state === 'closed') throw notFound();
      if (row.state !== 'open') throw gameStarted();
      if (row.host_user_id !== userId) throw notHost();
      await closeRoomTx(trx, roomId);
    });
    logger.info({ userId, roomId }, 'room closed by host');
    await this.afterClose(roomId, 'host_closed');
  }

  /** Closes the room if its game still has not started. Fired by the inactivity timer. */
  async closeForInactivity(roomId: string): Promise<void> {
    this.timers.delete(roomId);
    const closed = await db.transaction(async (trx) => {
      const row = await lockRoom(trx, roomId);
      if (!row || row.state !== 'open') return false;
      await closeRoomTx(trx, roomId);
      return true;
    });
    if (!closed) return;
    logger.info({ roomId }, 'room closed for inactivity');
    await this.afterClose(roomId, 'inactivity');
  }

  /**
   * Timers live in memory, so after a restart the open rooms have none. Re-arm them from
   * created_at; rooms already past the timeout close straight away.
   */
  async restoreTimeouts(): Promise<void> {
    const rows: { id: string; created_at: Date }[] = await db('rooms').where({ state: 'open' }).select('id', 'created_at');
    for (const r of rows) this.scheduleTimeout(r.id, new Date(r.created_at));
  }

  /** Clears every pending timer (shutdown and tests). */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const t of this.awayTimers.values()) clearTimeout(t);
    this.awayTimers.clear();
  }

  hasTimeout(roomId: string): boolean {
    return this.timers.has(roomId);
  }

  private scheduleTimeout(roomId: string, createdAt: Date): void {
    this.cancelTimeout(roomId);
    const delay = Math.max(0, createdAt.getTime() + this.timeoutMs - Date.now());
    const timer = setTimeout(() => {
      this.closeForInactivity(roomId).catch((err) => logger.error({ err, roomId }, 'room inactivity close failed'));
    }, delay);
    timer.unref();
    this.timers.set(roomId, timer);
  }

  private cancelTimeout(roomId: string): void {
    const timer = this.timers.get(roomId);
    if (timer) clearTimeout(timer);
    this.timers.delete(roomId);
  }

  private async afterClose(roomId: string, reason: RoomClosedReason): Promise<void> {
    this.cancelTimeout(roomId);
    await this.notify(async () => {
      await this.notifier.roomClosed(roomId, reason);
      await this.notifier.lobbyChanged();
    });
  }

  /** The change is committed; a failed broadcast must not turn the request into an error. */
  private async notify(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, 'room notification failed');
    }
  }
}
