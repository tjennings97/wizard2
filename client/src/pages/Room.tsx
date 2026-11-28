import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router';
import { closeRoom, leaveRoom, startGame, updateRoomConfig } from '../api/rooms';
import { MAX_PLAYERS, MAX_SPECTATORS, MIN_PLAYERS_TO_START, maxRounds, type BidRule, type RoomMember } from '../api/types';
import { useAuth } from '../context/AuthContext';
import { useRealtime, type RoomView } from '../context/SocketContext';
import { useAction } from '../hooks/useAction';
import { AVATAR_SIZE, Avatar } from '../components/Avatar';
import { useToast } from '../components/Toast';

/**
 * The room before the game (docs/design/ui-foundation.md, "Room / Pre-Game"): the players are the
 * hero, large and in join order. The host's controls sit in a panel beside them (below on phones);
 * everyone else sees the same panel greyed out, waiting for the host.
 */
export function RoomPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { room, connected } = useRealtime();
  const { busy, error, run } = useAction();
  useHostChangeToast(room, user?.id ?? '');

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
  const openSeats = Math.max(0, MIN_PLAYERS_TO_START - players.length);
  const locked = busy || !isHost;

  const setRounds = (roundCount: number) => run(() => updateRoomConfig(room.roomId, { roundCount }));
  const setBidRule = (bidRule: BidRule) => run(() => updateRoomConfig(room.roomId, { bidRule }));
  // The server answers with lobby_snapshot, which takes us back to the lobby (useLocationSync).
  const leave = () => run(() => leaveRoom(room.roomId));
  const close = () => run(() => closeRoom(room.roomId));
  // The game arrives over the socket (game_started), which takes everyone to the game page.
  const start = () => run(() => startGame(room.roomId));

  const isMe = (m: RoomMember) => m.userId === user?.id;

  return (
    <main className="page wide">
      <header className="bar">
        <h1>
          Room <code title={room.roomId}>{room.roomId.slice(0, 8)}</code>
        </h1>
        <button type="button" onClick={leave} disabled={busy}>
          Leave room
        </button>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="room">
        <div className="room-main">
          <section className="panel" aria-labelledby="players-title">
            <h2 id="players-title">
              Players <span className="count">{players.length}/{MAX_PLAYERS}</span>
            </h2>
            {/* Members arrive in join order; seat numbers follow it. */}
            <ol className="player-grid">
              {players.map((m, i) => (
                <li key={m.userId} className={isMe(m) ? 'player-tile you' : 'player-tile'}>
                  <span className="tile-avatar">
                    <Avatar config={m.avatarConfig} size={AVATAR_SIZE.room} />
                    {m.userId === room.hostId && (
                      <span className="host-crown" title="Host">
                        <span aria-hidden="true">♛</span>
                        <span className="visually-hidden">Host</span>
                      </span>
                    )}
                  </span>
                  <span className="tile-name">{m.displayName}</span>
                  <span className="tile-meta">
                    <span className="visually-hidden">Seat </span>#{i + 1}
                    {isMe(m) && ' · You'}
                  </span>
                </li>
              ))}
              {Array.from({ length: openSeats }, (_, i) => (
                <li key={`open-${i}`} className="player-tile open" aria-label="Open seat">
                  <span className="tile-avatar empty-seat" aria-hidden="true" />
                  <span className="tile-name muted" aria-hidden="true">
                    Open seat
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel" aria-labelledby="spectators-title">
            <h2 id="spectators-title">
              Spectators <span className="count">{spectators.length}/{MAX_SPECTATORS}</span>
            </h2>
            {spectators.length === 0 ? (
              <p className="muted">No one is watching yet.</p>
            ) : (
              <ul className="people">
                {spectators.map((m) => (
                  <li key={m.userId}>
                    <Avatar config={m.avatarConfig} size={AVATAR_SIZE.chip} />
                    <span className="grow name">{m.displayName}</span>
                    {isMe(m) && <span className="badge you">You</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className={isHost ? 'panel host-panel' : 'panel host-panel waiting'} aria-labelledby="settings-title">
          <h2 id="settings-title">Game settings</h2>
          {!isHost && (
            <p className="waiting-line" role="status">
              <span className="spinner" aria-hidden="true" /> Waiting for host…
            </p>
          )}
          <div className="stack">
            <label>
              Rounds (1–{max})
              <select value={room.config.roundCount} onChange={(e) => setRounds(Number(e.target.value))} disabled={locked}>
                {roundOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="toggle" disabled={!isHost}>
              <legend>Bid rule</legend>
              {(['open', 'uneven'] as const).map((rule) => (
                <button
                  key={rule}
                  type="button"
                  aria-pressed={room.config.bidRule === rule}
                  className={room.config.bidRule === rule ? 'selected' : undefined}
                  onClick={() => setBidRule(rule)}
                  disabled={locked || room.config.bidRule === rule}
                >
                  {rule === 'open' ? 'Open' : 'Uneven'}
                </button>
              ))}
            </fieldset>
            <p className="hint">
              {room.config.bidRule === 'uneven'
                ? "Uneven: the dealer can't bid a number that makes the bids add up to the tricks."
                : 'Open: any bid is allowed.'}
            </p>
            <button type="button" className="primary" onClick={start} disabled={locked || !canStart}>
              Start game
            </button>
            {!canStart && (
              <p className="hint">
                At least {MIN_PLAYERS_TO_START} players are needed to start ({MIN_PLAYERS_TO_START - players.length} more).
              </p>
            )}
            {isHost && (
              <button type="button" className="danger" onClick={close} disabled={busy}>
                Close room
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/** A toast when the host role moves (ui-foundation.md, "Toast": host transfer alert). */
function useHostChangeToast(room: RoomView | null, me: string) {
  const { toast } = useToast();
  const last = useRef<{ roomId: string; hostId: string } | null>(null);
  useEffect(() => {
    if (!room) {
      last.current = null;
      return;
    }
    const prev = last.current;
    last.current = { roomId: room.roomId, hostId: room.hostId };
    if (!prev || prev.roomId !== room.roomId || prev.hostId === room.hostId) return;
    const host = room.members.find((m) => m.userId === room.hostId);
    toast(room.hostId === me ? 'You are now the host.' : `${host?.displayName ?? 'Someone'} is now the host.`, 'info');
  }, [room, me, toast]);
}
