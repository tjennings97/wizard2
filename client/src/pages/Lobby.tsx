import { createRoom, joinRoom } from '../api/rooms';
import type { MemberRole, RoomSummary } from '../api/types';
import { useAuth } from '../context/AuthContext';
import { useGame } from '../context/GameContext';
import { useRealtime } from '../context/SocketContext';
import { useAction } from '../hooks/useAction';

const STATE_LABELS: Record<RoomSummary['state'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  completing: 'Completing',
  closed: 'Closed',
};

export function LobbyPage() {
  const { user, logout } = useAuth();
  const { rooms, onlineUsers, connected, location, notice, clearNotice } = useRealtime();
  const { busy, error, run } = useAction();
  // Why the last game this client showed was stopped (e.g. a server restart).
  const { lobbyNotice, clearLobbyNotice } = useGame();

  // Navigation to the room happens when room_snapshot arrives (useLocationSync).
  const open = () => run(createRoom);
  const join = (roomId: string, role: MemberRole) => run(() => joinRoom(roomId, role));

  return (
    <main className="page">
      <header className="bar">
        <h1>Lobby</h1>
        <span className="muted">{user?.displayName}</span>
        <button type="button" onClick={() => void logout()}>
          Log out
        </button>
      </header>

      {!connected && <p className="muted">Connecting…</p>}
      {notice && (
        <p className="notice">
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
      {error && <p className="error" role="alert">{error}</p>}

      <button type="button" className="primary" onClick={open} disabled={busy || location !== 'lobby'}>
        Open Room
      </button>

      <section>
        <h2>Rooms</h2>
        {rooms.length === 0 ? (
          <p className="muted">No rooms yet. Open one to start.</p>
        ) : (
          <ul className="cards">
            {rooms.map((r) => {
              const canPlay = r.state === 'open' && r.playerCount < r.maxPlayers;
              const canWatch = (r.state === 'open' || r.state === 'in_progress') && r.spectatorCount < r.maxSpectators;
              return (
                <li key={r.id} className="card">
                  <div className="card-head">
                    <code title={r.id}>{r.id.slice(0, 8)}</code>
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
                      <dt>Spectators</dt>
                      <dd>
                        {r.spectatorCount}/{r.maxSpectators}
                      </dd>
                    </div>
                    <div>
                      <dt>Rounds</dt>
                      <dd>{r.config.roundCount}</dd>
                    </div>
                  </dl>
                  <div className="actions">
                    <button type="button" onClick={() => join(r.id, 'player')} disabled={busy || !canPlay}>
                      Join
                    </button>
                    <button type="button" onClick={() => join(r.id, 'spectator')} disabled={busy || !canWatch}>
                      Spectate
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2>In the lobby ({onlineUsers.length})</h2>
        <ul className="people">
          {onlineUsers.map((u) => (
            <li key={u.userId}>
              <span className="avatar" aria-hidden="true">
                {u.displayName.slice(0, 1).toUpperCase()}
              </span>
              {u.displayName}
              {u.userId === user?.id && <span className="muted"> (you)</span>}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
