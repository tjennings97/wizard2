import { Link, useParams } from 'react-router';
import { closeRoom, leaveRoom, startGame, updateRoomConfig } from '../api/rooms';
import { MAX_PLAYERS, MAX_SPECTATORS, MIN_PLAYERS_TO_START, maxRounds, type BidRule, type RoomMember } from '../api/types';
import { useAuth } from '../context/AuthContext';
import { useRealtime } from '../context/SocketContext';
import { useAction } from '../hooks/useAction';

export function RoomPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { room, connected } = useRealtime();
  const { busy, error, run } = useAction();

  if (!room || room.roomId !== id) {
    return (
      <main className="page">
        <p className="muted">{connected ? 'You are not in this room.' : 'Connecting…'}</p>
        <Link to="/">Back to lobby</Link>
      </main>
    );
  }

  const players = room.members.filter((m) => m.role === 'player');
  const spectators = room.members.filter((m) => m.role === 'spectator');
  const isHost = room.hostId === user?.id;
  const max = maxRounds(players.length);
  const roundOptions = Array.from({ length: max }, (_, i) => i + 1);
  const canStart = players.length >= MIN_PLAYERS_TO_START;

  const setRounds = (roundCount: number) => run(() => updateRoomConfig(room.roomId, { roundCount }));
  const setBidRule = (bidRule: BidRule) => run(() => updateRoomConfig(room.roomId, { bidRule }));
  // The server answers with lobby_snapshot, which takes us back to the lobby (useLocationSync).
  const leave = () => run(() => leaveRoom(room.roomId));
  const close = () => run(() => closeRoom(room.roomId));
  // The game arrives over the socket (game_started), which takes everyone to the game page.
  const start = () => run(() => startGame(room.roomId));

  const memberRow = (m: RoomMember, label: string) => (
    <li key={m.userId}>
      <span className="order">{label}</span>
      <span className="avatar" aria-hidden="true">
        {m.displayName.slice(0, 1).toUpperCase()}
      </span>
      <span className="grow">
        {m.displayName}
        {m.userId === user?.id && <span className="muted"> (you)</span>}
      </span>
      {m.userId === room.hostId && <span className="badge host">Host</span>}
    </li>
  );

  return (
    <main className="page">
      <header className="bar">
        <h1>
          Room <code title={room.roomId}>{room.roomId.slice(0, 8)}</code>
        </h1>
        <button type="button" onClick={leave} disabled={busy}>
          Leave
        </button>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      <section>
        <h2>
          Players ({players.length}/{MAX_PLAYERS})
        </h2>
        {/* Members arrive in join order; seat numbers follow it. */}
        <ol className="people">{players.map((m, i) => memberRow(m, `#${i + 1}`))}</ol>
      </section>

      <section>
        <h2>
          Spectators ({spectators.length}/{MAX_SPECTATORS})
        </h2>
        {spectators.length === 0 ? (
          <p className="muted">No spectators.</p>
        ) : (
          <ul className="people">{spectators.map((m) => memberRow(m, '–'))}</ul>
        )}
      </section>

      <section>
        <h2>Settings</h2>
        {isHost ? (
          <div className="stack">
            <label>
              Rounds (1–{max})
              <select value={room.config.roundCount} onChange={(e) => setRounds(Number(e.target.value))} disabled={busy}>
                {roundOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="toggle">
              <legend>Bid rule</legend>
              {(['open', 'uneven'] as const).map((rule) => (
                <button
                  key={rule}
                  type="button"
                  aria-pressed={room.config.bidRule === rule}
                  className={room.config.bidRule === rule ? 'selected' : undefined}
                  onClick={() => setBidRule(rule)}
                  disabled={busy || room.config.bidRule === rule}
                >
                  {rule === 'open' ? 'Open' : 'Uneven'}
                </button>
              ))}
            </fieldset>
            <button type="button" className="primary" onClick={start} disabled={busy || !canStart}>
              Start Game
            </button>
            {!canStart && <p className="muted">At least {MIN_PLAYERS_TO_START} players are needed to start.</p>}
            <button type="button" className="danger" onClick={close} disabled={busy}>
              Close Room
            </button>
          </div>
        ) : (
          <dl className="facts">
            <div>
              <dt>Rounds</dt>
              <dd>{room.config.roundCount}</dd>
            </div>
            <div>
              <dt>Bid rule</dt>
              <dd>{room.config.bidRule === 'open' ? 'Open' : 'Uneven'}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}
