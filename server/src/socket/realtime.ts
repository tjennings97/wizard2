import type { Server, Socket } from 'socket.io';
import { logger } from '../logger';
import {
  listLobbyRooms,
  toRoomDto,
  type PresenceSource,
  type RoomSummary,
  type RoomView,
  type UserSummary,
} from '../rooms/queries';
import type { MemberRole, RoomClosedReason, RoomConfig } from '../rooms/rules';
import type { RoomNotifier } from '../rooms/service';
import type { InvalidationReason } from '../auth/sessionEvents';

export interface SocketData {
  userId: string;
  /** The session this socket authenticated with (sessions.id). */
  sessionId: string;
  user: UserSummary;
  traceId: string;
  /** The room this socket is in, or null in the lobby. */
  roomId: string | null;
  /** Outbound sequence number of the last event sent on this socket. */
  seq: number;
  /** Bumped every time the socket is put in the lobby or a room, so a reader can tell it moved. */
  moves: number;
  /** True once connect handling has placed the socket (see placeSocket in socket/index.ts). */
  placed: boolean;
}

export type AppServer = Server<Record<string, never>, Record<string, (envelope: Envelope) => void>, Record<string, never>, SocketData>;
export type AppSocket = Socket<Record<string, never>, Record<string, (envelope: Envelope) => void>, Record<string, never>, SocketData>;

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
 * Events go out one socket at a time (not via io.to(room).emit) because `seq` is per socket.
 */
export class Realtime implements RoomNotifier, PresenceSource {
  constructor(private readonly io: AppServer) {}

  // --- delivery ---------------------------------------------------------------------------

  private socketsIn(channel: string): AppSocket[] {
    const ids = this.io.sockets.adapter.rooms.get(channel);
    if (!ids) return [];
    return [...ids].map((id) => this.io.sockets.sockets.get(id)).filter((s): s is AppSocket => !!s);
  }

  send(socket: AppSocket, event: string, payload: unknown): void {
    socket.data.seq = (socket.data.seq ?? 0) + 1;
    socket.emit(event, { event, seq: socket.data.seq, timestamp: new Date().toISOString(), payload });
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

  // --- RoomNotifier -----------------------------------------------------------------------

  async userEnteredRoom(userId: string, room: RoomView): Promise<void> {
    for (const s of this.socketsIn(userChannel(userId))) this.enterRoom(s, room);
    const member = room.members.find((m) => m.userId === userId);
    if (!member) return;
    const seatIndex =
      member.role === 'player' ? room.members.filter((m) => m.role === 'player').findIndex((m) => m.userId === userId) : null;
    this.broadcast(roomChannel(room.id), 'user_joined', {
      user_id: userId,
      display_name: member.displayName,
      role: member.role,
      seat_index: seatIndex,
      ...counts(room),
    });
  }

  async userLeftRoom(userId: string, role: MemberRole, room: RoomView): Promise<void> {
    this.broadcast(roomChannel(room.id), 'user_left', { user_id: userId, role, reason: 'voluntary', ...counts(room) });
    const sockets = this.socketsIn(userChannel(userId));
    if (sockets.length === 0) return;
    const rooms = await listLobbyRooms();
    for (const s of sockets) this.enterLobby(s, rooms);
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
