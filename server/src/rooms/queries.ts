import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { AvatarConfig } from '../auth/users';
import {
  ACTIVE_ROOM_STATES,
  LOBBY_ROOM_STATES,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  configFromStored,
  type MemberRole,
  type RoomConfig,
  type RoomState,
  type StoredRoomConfig,
} from './rules';

type Conn = Knex | Knex.Transaction;

export interface RoomRow {
  id: string;
  state: RoomState;
  host_user_id: string;
  config: StoredRoomConfig | null;
  created_at: Date;
  closed_at: Date | null;
}

/** An active member (left_at IS NULL), joined with the user's public fields. */
export interface MemberView {
  userId: string;
  displayName: string;
  avatarConfig: AvatarConfig;
  role: MemberRole;
  joinOrder: number;
  isHost: boolean;
}

/** A room as read from the database. `connected` is added by the presenter (see toRoomDto). */
export interface RoomView {
  id: string;
  state: RoomState;
  hostUserId: string;
  config: RoomConfig;
  members: MemberView[];
  playerCount: number;
  spectatorCount: number;
  createdAt: Date;
  closedAt: Date | null;
}

/** One item of GET /lobby/rooms and of the rooms_updated / lobby_snapshot `rooms` array. */
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

/** The RoomMember schema from docs/api/openapi-spec.md. */
export interface RoomMemberDto extends MemberView {
  connected: boolean;
}

/** The Room schema from docs/api/openapi-spec.md. */
export interface RoomDto {
  id: string;
  state: RoomState;
  hostUserId: string;
  config: RoomConfig;
  members: RoomMemberDto[];
  createdAt: string;
  closedAt: string | null;
}

export type IsConnected = (userId: string) => boolean;

export function toRoomDto(room: RoomView, isConnected: IsConnected): RoomDto {
  return {
    id: room.id,
    state: room.state,
    hostUserId: room.hostUserId,
    config: room.config,
    members: room.members.map((m) => ({ ...m, connected: isConnected(m.userId) })),
    createdAt: room.createdAt.toISOString(),
    closedAt: room.closedAt ? room.closedAt.toISOString() : null,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Room ids are UUIDs; anything else cannot name a room (and would make Postgres throw). */
export function isRoomId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

async function activeMembers(conn: Conn, roomId: string, hostUserId: string): Promise<MemberView[]> {
  const rows: {
    user_id: string;
    display_name: string;
    avatar_config: AvatarConfig;
    role: MemberRole;
    join_order: number;
  }[] = await conn('room_members as rm')
    .join('users as u', 'u.id', 'rm.user_id')
    .where('rm.room_id', roomId)
    .whereNull('rm.left_at')
    .orderBy('rm.join_order', 'asc')
    .select('rm.user_id', 'u.display_name', 'u.avatar_config', 'rm.role', 'rm.join_order');
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    avatarConfig: r.avatar_config,
    role: r.role,
    joinOrder: r.join_order,
    isHost: r.user_id === hostUserId,
  }));
}

export function roomViewFrom(row: RoomRow, members: MemberView[]): RoomView {
  const playerCount = members.filter((m) => m.role === 'player').length;
  return {
    id: row.id,
    state: row.state,
    hostUserId: row.host_user_id,
    config: configFromStored(row.config, playerCount),
    members,
    playerCount,
    spectatorCount: members.length - playerCount,
    createdAt: new Date(row.created_at),
    closedAt: row.closed_at ? new Date(row.closed_at) : null,
  };
}

export async function getRoomView(roomId: string, conn: Conn = db): Promise<RoomView | null> {
  if (!isRoomId(roomId)) return null;
  const row: RoomRow | undefined = await conn('rooms').where({ id: roomId }).first();
  if (!row) return null;
  return roomViewFrom(row, await activeMembers(conn, row.id, row.host_user_id));
}

/** How many rooms are open or in_progress (the rooms_active gauge). */
export async function countLobbyRooms(conn: Conn = db): Promise<number> {
  const row = await conn('rooms').whereIn('state', LOBBY_ROOM_STATES as RoomState[]).count<{ count: string }[]>('* as count').first();
  return Number(row?.count ?? 0);
}

/** Rooms shown in the lobby (open or in_progress), oldest first. */
export async function listLobbyRooms(conn: Conn = db): Promise<RoomSummary[]> {
  const rows: (RoomRow & { player_count: string; spectator_count: string })[] = await conn('rooms as r')
    .leftJoin('room_members as rm', (j) => j.on('rm.room_id', 'r.id').andOnNull('rm.left_at'))
    .whereIn('r.state', LOBBY_ROOM_STATES as RoomState[])
    .groupBy('r.id')
    .orderBy('r.created_at', 'asc')
    .select(
      'r.*',
      conn.raw(`count(rm.user_id) filter (where rm.role = 'player') as player_count`),
      conn.raw(`count(rm.user_id) filter (where rm.role = 'spectator') as spectator_count`),
    );
  return rows.map((r) => {
    const playerCount = Number(r.player_count);
    return {
      id: r.id,
      state: r.state,
      hostUserId: r.host_user_id,
      config: configFromStored(r.config, playerCount),
      playerCount,
      spectatorCount: Number(r.spectator_count),
      maxPlayers: MAX_PLAYERS,
      maxSpectators: MAX_SPECTATORS,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
}

export interface ActiveMembership {
  roomId: string;
  roomState: RoomState;
  role: MemberRole;
}

/** The room (open, in_progress or completing) the user is currently in, if any. */
export async function activeMembershipFor(userId: string, conn: Conn = db): Promise<ActiveMembership | null> {
  const row: { room_id: string; state: RoomState; role: MemberRole } | undefined = await conn('room_members as rm')
    .join('rooms as r', 'r.id', 'rm.room_id')
    .where('rm.user_id', userId)
    .whereNull('rm.left_at')
    .whereIn('r.state', ACTIVE_ROOM_STATES as RoomState[])
    .first('rm.room_id', 'r.state', 'rm.role');
  return row ? { roomId: row.room_id, roomState: row.state, role: row.role } : null;
}

/** One item of GET /lobby/presence and of the presence_updated / lobby_snapshot `online_users` array. */
export interface UserSummary {
  userId: string;
  displayName: string;
  avatarConfig: AvatarConfig;
}

/** Who is in the lobby right now. Answered by the socket layer, which knows who is connected. */
export interface PresenceSource {
  lobbyUsers(): UserSummary[];
}
