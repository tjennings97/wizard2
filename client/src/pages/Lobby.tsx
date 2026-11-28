import { Link } from 'react-router';
import { createRoom, joinRoom } from '../api/rooms';
import type { MemberRole, RoomSummary } from '../api/types';
import { useAuth } from '../context/AuthContext';
import { useGame } from '../context/GameContext';
import { useRealtime } from '../context/SocketContext';
import { useAction } from '../hooks/useAction';
import { AVATAR_SIZE, Avatar } from '../components/Avatar';
import { CardBack } from '../components/Card';

const STATE_LABELS: Record<RoomSummary['state'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  completing: 'Completing',
  closed: 'Closed',
};

/**
 * The lobby (docs/design/ui-foundation.md, "Lobby"): open rooms on the left (~65%) and who's in the
 * lobby on the right (~35%), stacked on phones. Both lists update live; new rooms slide in.
 */
export function LobbyPage() {
  const { user, logout } = useAuth();
  const { rooms, onlineUsers, connected, location, notice, clearNotice } = useRealtime();
  const { busy, error, run } = useAction();
  // Why the last game this client showed was stopped (e.g. a server restart).
  const { lobbyNotice, clearLobbyNotice } = useGame();
  // Opening or joining a room needs the server to have placed this socket in the lobby: not while
  // connecting, and not while already in a room or game (docs/product/ui-ux-flows.md, Flow 2).
  const ready = connected && location === 'lobby';
  const blockedReason = !connected || location === null ? 'Connecting…' : location !== 'lobby' ? 'You are already in a room.' : null;

  // Navigation to the room happens when room_snapshot arrives (useLocationSync).
  const open = () => run(createRoom);
  const join = (roomId: string, role: MemberRole) => run(() => joinRoom(roomId, role));
  const openButton = (
    <button type="button" className="primary" onClick={open} disabled={busy || !ready}>
      Open a room
    </button>
  );

  return (
    <main className="page wide">
      <header className="bar">
        <h1 className="brand">
          Wizard<span className="visually-hidden"> lobby</span>
        </h1>
        <nav className="bar-actions" aria-label="Account">
          {user?.role === 'admin' && (
            <Link to="/admin" className="button ghost">
              Admin
            </Link>
          )}
          <Link to="/profile" className="button ghost profile-link" aria-label={`Profile: ${user?.displayName ?? ''}`}>
            <Avatar config={user?.avatarConfig} size={28} />
            <span className="profile-name">{user?.displayName ?? 'Profile'}</span>
          </Link>
          <button type="button" className="ghost" onClick={() => void logout()}>
            Log out
          </button>
        </nav>
      </header>

      <div className="banners">
        {notice && (
          <p className="notice" role="status">
            {notice}{' '}
            <button type="button" className="link" onClick={clearNotice}>
              Dismiss
            </button>
          </p>
        )}
        {lobbyNotice && (
          <p className="notice" role="status">
            {lobbyNotice}{' '}
            <button type="button" className="link" onClick={clearLobbyNotice}>
              Dismiss
            </button>
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="lobby">
        <section className="panel lobby-rooms" aria-labelledby="rooms-title">
          <div className="panel-head">
            <h2 id="rooms-title">Rooms</h2>
            {rooms.length > 0 && openButton}
          </div>
          {blockedReason && (
            <p className="muted hint-line" role="status">
              {blockedReason}
            </p>
          )}
          {rooms.length === 0 ? (
            <div className="empty-state">
              <div className="empty-art" aria-hidden="true">
                <CardBack />
                <CardBack />
                <CardBack />
              </div>
              <p>No rooms open. Create one?</p>
              {openButton}
            </div>
          ) : (
            <ul className="cards room-list">
              {rooms.map((r) => (
                <RoomCard key={r.id} room={r} disabled={busy || !ready} onJoin={join} />
              ))}
            </ul>
          )}
        </section>

        <section className="panel lobby-people" aria-labelledby="people-title">
          <h2 id="people-title">
            In the lobby <span className="count">{onlineUsers.length}</span>
          </h2>
          <ul className="people">
            {onlineUsers.map((u) => (
              <li key={u.userId}>
                <Avatar config={u.avatarConfig} size={AVATAR_SIZE.chip} />
                <span className="grow name">{u.displayName}</span>
                {u.userId === user?.id && <span className="badge you">You</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

/** One room: its code and state, seats taken, settings, and Join / Spectate. */
function RoomCard({ room: r, disabled, onJoin }: { room: RoomSummary; disabled: boolean; onJoin: (id: string, role: MemberRole) => void }) {
  const full = r.playerCount >= r.maxPlayers;
  const canPlay = r.state === 'open' && !full;
  const canWatch = (r.state === 'open' || r.state === 'in_progress') && r.spectatorCount < r.maxSpectators;
  // Said on the card, not in a tooltip: a phone can't hover.
  const why = canPlay ? null : r.state === 'in_progress' ? 'Game in progress' : full ? 'Table full' : null;
  return (
    <li className="card room-card">
      <div className="card-head">
        <h3 className="room-name">
          Room <code title={r.id}>{r.id.slice(0, 8)}</code>
        </h3>
        <span className={`badge ${r.state}`}>{STATE_LABELS[r.state]}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Players</dt>
          <dd>
            {r.playerCount}/{r.maxPlayers}
          </dd>
        </div>
        <div>
          <dt>Watching</dt>
          <dd>
            {r.spectatorCount}/{r.maxSpectators}
          </dd>
        </div>
        <div>
          <dt>Rounds</dt>
          <dd>{r.config.roundCount}</dd>
        </div>
        <div>
          <dt>Bidding</dt>
          <dd>{r.config.bidRule === 'uneven' ? 'Uneven' : 'Open'}</dd>
        </div>
      </dl>
      <div className="actions">
        <button type="button" className={canPlay ? 'primary' : undefined} onClick={() => onJoin(r.id, 'player')} disabled={disabled || !canPlay}>
          Join
        </button>
        <button type="button" onClick={() => onJoin(r.id, 'spectator')} disabled={disabled || !canWatch}>
          Spectate
        </button>
      </div>
      {why && <p className="muted card-note">{why}</p>}
    </li>
  );
}
