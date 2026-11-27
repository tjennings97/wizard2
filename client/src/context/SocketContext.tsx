import { createContext, useContext, useEffect, useReducer, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import type { AvatarConfig, MemberRole, RoomConfig, RoomMember, RoomSummary, UserSummary } from '../api/types';
import { createSocket, type Envelope } from '../socket/client';
import { useAuth } from './AuthContext';

/** The user's current room, as last pushed by the server. */
export interface RoomView {
  roomId: string;
  hostId: string;
  config: RoomConfig;
  /** Active members in join order. */
  members: RoomMember[];
}

interface RealtimeState {
  /** Where the server last placed this socket. null until the first snapshot. */
  location: 'lobby' | 'room' | null;
  rooms: RoomSummary[];
  onlineUsers: UserSummary[];
  room: RoomView | null;
  /** A one-off message to show, e.g. why the room closed. */
  notice: string | null;
}

const initialState: RealtimeState = { location: null, rooms: [], onlineUsers: [], room: null, notice: null };

type Action =
  | { type: 'lobby_snapshot'; rooms: RoomSummary[]; onlineUsers: UserSummary[] }
  | { type: 'rooms_updated'; rooms: RoomSummary[] }
  | { type: 'presence_updated'; onlineUsers: UserSummary[] }
  | { type: 'room_snapshot'; room: RoomView }
  | { type: 'user_joined'; userId: string; displayName: string; avatarConfig: AvatarConfig; role: MemberRole }
  | { type: 'user_left'; userId: string }
  | { type: 'host_changed'; roomId: string; hostId: string }
  | { type: 'room_config_updated'; roomId: string; config: RoomConfig }
  | { type: 'room_closed'; roomId: string; reason: string }
  | { type: 'clear_notice' }
  | { type: 'reset' };

const CLOSED_NOTICES: Record<string, string> = {
  inactivity: 'The room closed because its game did not start within 10 minutes.',
  empty: 'The room closed because every player left.',
  host_closed: 'The host closed the room.',
  game_finished: 'The game has finished.',
};

function withHost(members: RoomMember[], hostId: string): RoomMember[] {
  return members.map((m) => ({ ...m, isHost: m.userId === hostId }));
}

function reducer(state: RealtimeState, action: Action): RealtimeState {
  switch (action.type) {
    case 'lobby_snapshot':
      return { ...state, location: 'lobby', rooms: action.rooms, onlineUsers: action.onlineUsers, room: null };
    case 'rooms_updated':
      return { ...state, rooms: action.rooms };
    case 'presence_updated':
      return { ...state, onlineUsers: action.onlineUsers };
    case 'room_snapshot':
      return { ...state, location: 'room', room: action.room, notice: null };
    case 'user_joined': {
      const room = state.room;
      if (!room) return state;
      // The server gives each (re)joiner the next join_order, so they always go last.
      const others = room.members.filter((m) => m.userId !== action.userId);
      const last = others.at(-1)?.joinOrder ?? 0;
      const member: RoomMember = {
        userId: action.userId,
        displayName: action.displayName,
        avatarConfig: action.avatarConfig,
        role: action.role,
        joinOrder: room.members.find((m) => m.userId === action.userId)?.joinOrder ?? last + 1,
        isHost: action.userId === room.hostId,
        connected: true,
      };
      return { ...state, room: { ...room, members: [...others, member] } };
    }
    case 'user_left':
      if (!state.room) return state;
      return { ...state, room: { ...state.room, members: state.room.members.filter((m) => m.userId !== action.userId) } };
    case 'host_changed':
      if (state.room?.roomId !== action.roomId) return state;
      return { ...state, room: { ...state.room, hostId: action.hostId, members: withHost(state.room.members, action.hostId) } };
    case 'room_config_updated':
      if (state.room?.roomId !== action.roomId) return state;
      return { ...state, room: { ...state.room, config: action.config } };
    case 'room_closed':
      // lobby_snapshot follows and moves us back to the lobby.
      return { ...state, notice: CLOSED_NOTICES[action.reason] ?? 'The room closed.' };
    case 'clear_notice':
      return { ...state, notice: null };
    case 'reset':
      return initialState;
  }
}

interface SocketValue extends RealtimeState {
  socket: Socket | null;
  connected: boolean;
  clearNotice(): void;
}

const SocketContext = createContext<SocketValue | null>(null);

type Payloads = {
  lobby_snapshot: { rooms: RoomSummary[]; online_users: UserSummary[] };
  rooms_updated: { rooms: RoomSummary[] };
  presence_updated: { online_users: UserSummary[] };
  room_snapshot: { room_id: string; config: RoomConfig; members: RoomMember[]; host_id: string };
  user_joined: { user_id: string; display_name: string; avatar_config: AvatarConfig; role: MemberRole };
  user_left: { user_id: string };
  host_changed: { room_id: string; host_id: string };
  room_config_updated: { room_id: string; config: RoomConfig };
  room_closed: { room_id: string; reason: string };
  session_error: { code: string; message: string; fatal: boolean; reason?: string };
};

/**
 * Owns the single Socket.io client: created when the user is authenticated, disconnected on
 * logout. Keeps the lobby and room state the server pushes.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { user, endSession, sessionEpoch } = useAuth();
  const userId = user?.id ?? null;
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (!userId) return;
    const s = createSocket();
    const on = <E extends keyof Payloads>(event: E, handler: (payload: Payloads[E]) => void) => {
      s.on(event as string, (envelope: Envelope<Payloads[E]>) => handler(envelope.payload));
    };

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));

    on('lobby_snapshot', (p) => dispatch({ type: 'lobby_snapshot', rooms: p.rooms, onlineUsers: p.online_users }));
    on('rooms_updated', (p) => dispatch({ type: 'rooms_updated', rooms: p.rooms }));
    on('presence_updated', (p) => dispatch({ type: 'presence_updated', onlineUsers: p.online_users }));
    on('room_snapshot', (p) =>
      dispatch({ type: 'room_snapshot', room: { roomId: p.room_id, hostId: p.host_id, config: p.config, members: p.members } }),
    );
    on('user_joined', (p) =>
      dispatch({ type: 'user_joined', userId: p.user_id, displayName: p.display_name, avatarConfig: p.avatar_config, role: p.role }),
    );
    on('user_left', (p) => dispatch({ type: 'user_left', userId: p.user_id }));
    on('host_changed', (p) => dispatch({ type: 'host_changed', roomId: p.room_id, hostId: p.host_id }));
    on('room_config_updated', (p) => dispatch({ type: 'room_config_updated', roomId: p.room_id, config: p.config }));
    on('room_closed', (p) => dispatch({ type: 'room_closed', roomId: p.room_id, reason: p.reason }));
    on('session_error', (p) => {
      if (!p.fatal) return;
      s.disconnect();
      endSession(p.code, p.reason);
    });

    setSocket(s);
    return () => {
      s.removeAllListeners();
      s.disconnect();
      setSocket(null);
      setConnected(false);
      dispatch({ type: 'reset' });
    };
    // sessionEpoch: a password/passphrase change gave this device a new session cookie; reconnect with it.
  }, [userId, endSession, sessionEpoch]);

  const value: SocketValue = { ...state, socket, connected, clearNotice: () => dispatch({ type: 'clear_notice' }) };
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useRealtime(): SocketValue {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useRealtime must be used inside SocketProvider');
  return ctx;
}
