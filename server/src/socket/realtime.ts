import type { Server, Socket } from 'socket.io';
import { logger } from '../logger';
import {
  getRoomView,
  listLobbyRooms,
  toRoomDto,
  type PresenceSource,
  type RoomSummary,
  type RoomView,
  type UserSummary,
} from '../rooms/queries';
import type { MemberRole, RoomClosedReason, RoomConfig } from '../rooms/rules';
import type { RoomNotifier, UserLeftReason } from '../rooms/service';
import type { InvalidationReason } from '../auth/sessionEvents';
import type { AvatarConfig } from '../shared/avatar';
import type { GameNotifier, GameService } from '../games/service';

export interface SocketData {
  userId: string;
  /** The session this socket authenticated with (sessions.id). */
  sessionId: string;
  user: UserSummary;
  traceId: string;
  /** The room this socket is in, or null in the lobby. */
  roomId: string | null;
  /**
   * Envelope seq of the last event sent on this socket. Counted per socket in the lobby and an
   * open room; in a room with a game, it is the game's seq (see deliverToRoom).
   */
  seq: number;
  /** When the session was last validated (connect or a game action), in ms. Throttles re-checks. */
  authCheckedAt: number;
  /** Client events from this socket are handled one at a time, in arrival order. */
  inbox: Promise<void>;
  /** Bumped every time the socket is put in the lobby or a room, so a reader can tell it moved. */
  moves: number;
  /** True once connect handling has placed the socket (see placeSocket in socket/index.ts). */
  placed: boolean;
  /**
   * Disconnects the socket if no `ping` arrives in time. Armed by the client's first ping; a
   * client that never pings relies on Socket.io's own heartbeat.
   */
  pingWatchdog: NodeJS.Timeout | null;
}

/** Client→server events carry the same envelope; only `payload` is read. */
type ClientEvents = Record<string, (envelope: unknown) => void>;
type ServerEvents = Record<string, (envelope: Envelope) => void>;
export type AppServer = Server<ClientEvents, ServerEvents, Record<string, never>, SocketData>;
export type AppSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, SocketData>;

/** The message envelope from docs/api/websocket-events.md (Envelope Schema). */
export interface Envelope {
  event: string;
  seq: number;
  timestamp: string;
  payload: unknown;
}

export const LOBBY = 'lobby';
export const roomChannel = (roomId: string) => `room:${roomId}`;
/** Every socket of one user (several tabs share a session). */
export const userChannel = (userId: string) => `user:${userId}`;
/** Every socket authenticated with one session, so an ended session can disconnect them all. */
export const sessionChannel = (sessionId: string) => `session:${sessionId}`;

function counts(room: RoomView) {
  return { player_count: room.playerCount, spectator_count: room.spectatorCount };
}

/**
 * The real-time side of the lobby and rooms. All membership lives in Socket.io rooms on this
 * single instance: `lobby`, `room:<roomId>`, and `user:<userId>`.
 *
 * Events go out one socket at a time (not via io.to(room).emit) because `seq` is per socket
 * outside a game. In a room whose game is live, every socket gets the game's seq instead: room
 * broadcasts go through the game service, which numbers and logs them, and unicasts carry the
 * current game seq without advancing it.
 */
export class Realtime implements RoomNotifier, PresenceSource, GameNotifier {
  constructor(
    private readonly io: AppServer,
    private readonly games: GameService,
  ) {}

  // --- delivery ---------------------------------------------------------------------------

  private socketsIn(channel: string): AppSocket[] {
    const ids = this.io.sockets.adapter.rooms.get(channel);
    if (!ids) return [];
    return [...ids].map((id) => this.io.sockets.sockets.get(id)).filter((s): s is AppSocket => !!s);
  }

  /** A unicast. In a live game's room it carries the game's current seq; elsewhere the socket's next. */
  send(socket: AppSocket, event: string, payload: unknown): void {
    const gameSeq = socket.data.roomId ? this.games.currentSeq(socket.data.roomId) : null;
    this.sendStamped(socket, event, payload, gameSeq ?? (socket.data.seq ?? 0) + 1);
  }

  sendStamped(socket: AppSocket, event: string, payload: unknown, seq: number): void {
    socket.data.seq = seq;
    socket.emit(event, { event, seq, timestamp: new Date().toISOString(), payload });
  }

  private broadcast(channel: string, event: string, payload: unknown): void {
    for (const s of this.socketsIn(channel)) this.send(s, event, payload);
  }

  // --- presence ---------------------------------------------------------------------------

  isConnected(userId: string): boolean {
    return (this.io.sockets.adapter.rooms.get(userChannel(userId))?.size ?? 0) > 0;
  }

  lobbyUsers(): UserSummary[] {
    const byId = new Map<string, UserSummary>();
    for (const s of this.socketsIn(LOBBY)) byId.set(s.data.userId, s.data.user);
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  isInLobby(userId: string): boolean {
    return this.socketsIn(LOBBY).some((s) => s.data.userId === userId);
  }

  broadcastPresence(): void {
    this.broadcast(LOBBY, 'presence_updated', { online_users: this.lobbyUsers() });
  }

  // --- moving sockets ---------------------------------------------------------------------

  /** Puts the socket in the lobby (out of any room) and sends it lobby_snapshot. */
  enterLobby(socket: AppSocket, rooms: RoomSummary[]): void {
    if (socket.data.roomId) socket.leave(roomChannel(socket.data.roomId));
    socket.data.roomId = null;
    socket.data.moves += 1;
    socket.join(LOBBY);
    this.send(socket, 'lobby_snapshot', { rooms, online_users: this.lobbyUsers() });
  }

  /** Puts the socket in the room's channel (out of the lobby) and sends it room_snapshot. */
  enterRoom(socket: AppSocket, room: RoomView): void {
    this.joinRoomChannel(socket, room.id);
    this.sendRoomSnapshot(socket, room);
  }

  private sendRoomSnapshot(socket: AppSocket, room: RoomView): void {
    this.send(socket, 'room_snapshot', {
      room_id: room.id,
      config: room.config,
      members: toRoomDto(room, (id) => this.isConnected(id)).members,
      host_id: room.hostUserId,
    });
  }

  /** Room channel membership without a snapshot (a room whose game has started). */
  joinRoomChannel(socket: AppSocket, roomId: string): void {
    socket.leave(LOBBY);
    if (socket.data.roomId && socket.data.roomId !== roomId) socket.leave(roomChannel(socket.data.roomId));
    socket.data.roomId = roomId;
    socket.data.moves += 1;
    socket.join(roomChannel(roomId));
  }

  // --- GameNotifier -----------------------------------------------------------------------

  deliverToRoom(roomId: string, event: string, payload: unknown, seq: number): void {
    for (const s of this.socketsIn(roomChannel(roomId))) this.sendStamped(s, event, payload, seq);
  }

  deliverToUser(roomId: string, userId: string, event: string, payload: unknown, seq: number): void {
    for (const s of this.socketsIn(userChannel(userId))) {
      if (s.data.roomId === roomId) this.sendStamped(s, event, payload, seq);
    }
  }

  /** Whether the user has a socket in the room's channel. */
  isInRoom(roomId: string, userId: string): boolean {
    return this.socketsIn(userChannel(userId)).some((s) => s.data.roomId === roomId);
  }

  /**
   * Puts the socket in the channel of a room whose game has started and, if that game is live,
   * sends it state_snapshot (the player's own view, or the spectator view with no hands), then
   * the bid or trump request the player still owes, if it is their turn. A player whose seat was
   * being held is back: player_reconnected follows.
   */
  async enterGame(socket: AppSocket, roomId: string): Promise<void> {
    this.joinRoomChannel(socket, roomId);
    await this.resyncGame(socket, roomId, null);
  }

  /**
   * state_snapshot for the socket's game, then (with `lastSeqSeen`) the logged broadcasts it
   * missed, each with its own seq, then its pending prompt. join_game and sync_request. Returns
   * false if the room has no live game.
   */
  async resyncGame(socket: AppSocket, roomId: string, lastSeqSeen: number | null): Promise<boolean> {
    const userId = socket.data.userId;
    const live = await this.games.withView(
      roomId,
      userId,
      (view, seq, prompt, replay) => {
        if (!socket.connected || socket.data.roomId !== roomId) return;
        this.sendStamped(socket, 'state_snapshot', { game_state: view, seq }, seq);
        for (const e of replay) this.sendStamped(socket, e.event, e.payload, e.seq);
        if (prompt) this.sendStamped(socket, prompt.event, prompt.payload, seq);
      },
      lastSeqSeen,
    );
    if (live && socket.connected && socket.data.roomId === roomId) await this.games.playerReconnected(roomId, userId);
    return live;
  }

  // --- RoomNotifier -----------------------------------------------------------------------

  async userEnteredRoom(userId: string, room: RoomView): Promise<void> {
    // A spectator joining a game in progress gets the game, not the room.
    const live = this.games.isLive(room.id);
    for (const s of this.socketsIn(userChannel(userId))) {
      if (live) await this.enterGame(s, room.id);
      else this.enterRoom(s, room);
    }
    const member = room.members.find((m) => m.userId === userId);
    if (!member) return;
    const seatIndex =
      member.role === 'player' ? room.members.filter((m) => m.role === 'player').findIndex((m) => m.userId === userId) : null;
    await this.roomBroadcast(room.id, 'user_joined', userId, {
      user_id: userId,
      display_name: member.displayName,
      avatar_config: member.avatarConfig,
      role: member.role,
      seat_index: seatIndex,
      ...counts(room),
    });
  }

  async userLeftRoom(userId: string, role: MemberRole, room: RoomView, reason: UserLeftReason = 'voluntary'): Promise<void> {
    const payload = { user_id: userId, role, reason, ...counts(room) };
    // In a room with a live game, user_left is part of the game's sequence, and a player leaving
    // it is a drop: the game service broadcasts it and applies the player-drop rules.
    if (!(await this.games.userLeft(room.id, userId, reason, payload))) this.broadcast(roomChannel(room.id), 'user_left', payload);
    const sockets = this.socketsIn(userChannel(userId));
    if (sockets.length === 0) return;
    const rooms = await listLobbyRooms();
    for (const s of sockets) this.enterLobby(s, rooms);
  }

  /** A membership broadcast: part of the game's numbered, logged sequence if the room's game is live. */
  private async roomBroadcast(roomId: string, event: 'user_joined', userId: string, payload: unknown): Promise<void> {
    if (await this.games.publishRoomEvent(roomId, event, userId, payload)) return;
    this.broadcast(roomChannel(roomId), event, payload);
  }

  async hostChanged(roomId: string, hostUserId: string): Promise<void> {
    this.broadcast(roomChannel(roomId), 'host_changed', { room_id: roomId, host_id: hostUserId });
  }

  async configUpdated(roomId: string, config: RoomConfig): Promise<void> {
    this.broadcast(roomChannel(roomId), 'room_config_updated', { room_id: roomId, config });
  }

  async roomClosed(roomId: string, reason: RoomClosedReason): Promise<void> {
    const channel = roomChannel(roomId);
    this.broadcast(channel, 'room_closed', { room_id: roomId, reason });
    const sockets = this.socketsIn(channel);
    if (sockets.length === 0) return;
    const rooms = await listLobbyRooms();
    for (const s of sockets) this.enterLobby(s, rooms);
  }

  /**
   * A user renamed themselves (PATCH /users/me). Their sockets carry the new name from now on;
   * the lobby gets presence_updated and an open room they are in gets room_snapshot again.
   * A started game keeps the names it started with (seats are fixed for the game).
   */
  async displayNameChanged(userId: string, displayName: string): Promise<void> {
    const sockets = this.socketsIn(userChannel(userId));
    if (sockets.length === 0) return;
    for (const s of sockets) s.data.user = { ...s.data.user, displayName };
    if (this.isInLobby(userId)) this.broadcastPresence();
    const roomIds = new Set(sockets.map((s) => s.data.roomId).filter((id): id is string => id !== null));
    for (const roomId of roomIds) {
      if (this.games.isLive(roomId)) continue;
      const room = await getRoomView(roomId);
      if (!room || room.state !== 'open') continue;
      for (const s of this.socketsIn(roomChannel(roomId))) this.sendRoomSnapshot(s, room);
    }
  }

  /**
   * A user changed their avatar (PATCH /users/me). Nothing is broadcast (avatar-system.md,
   * "Changing an Avatar"): their sockets carry the new config, so the next lobby_snapshot or
   * presence_updated shows it. Room snapshots read members from the database already.
   */
  avatarChanged(userId: string, avatarConfig: AvatarConfig): void {
    for (const s of this.socketsIn(userChannel(userId))) s.data.user = { ...s.data.user, avatarConfig: { ...avatarConfig } };
  }

  async lobbyChanged(): Promise<void> {
    const rooms = await listLobbyRooms();
    this.broadcast(LOBBY, 'rooms_updated', { rooms });
    this.broadcastPresence();
  }

  // --- connection lifecycle ---------------------------------------------------------------

  /**
   * Sends session_error and disconnects. Emitted packets are flushed before the close.
   * `extra` adds payload fields (the invalidation `reason`).
   */
  rejectSocket(socket: AppSocket, code: string, message: string, extra: Record<string, unknown> = {}): void {
    this.send(socket, 'session_error', { code, message, fatal: true, ...extra });
    socket.disconnect(true);
  }

  /**
   * Disconnects every socket using one of these sessions with session_error SESSION_INVALIDATED,
   * carrying the reason so the client can say what happened.
   */
  sessionsInvalidated(sessionIds: string[], reason: InvalidationReason, message: string): void {
    for (const id of sessionIds) {
      for (const s of this.socketsIn(sessionChannel(id))) {
        logger.info({ ...this.logContext(s), reason }, 'socket displaced: session invalidated');
        this.rejectSocket(s, 'SESSION_INVALIDATED', message, { reason });
      }
    }
  }

  logContext(socket: AppSocket) {
    return { socketId: socket.id, userId: socket.data.userId, traceId: socket.data.traceId, roomId: socket.data.roomId };
  }

  logError(socket: AppSocket, err: unknown, message: string): void {
    logger.error({ err, ...this.logContext(socket) }, message);
  }
}
