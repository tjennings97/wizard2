import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { leaveRoom } from '../api/rooms';
import { SUITS, type Card as CardData, type PlayEntry, type Suit } from '../api/types';
import { Card, SUIT_NAMES, SUIT_SYMBOLS, cardKey, cardLabel } from '../components/Card';
import { useAuth } from '../context/AuthContext';
import { ABANDON_MESSAGES, currentTurnId, isLegal, useGame, type GameView, type RoundResult, type SeatView } from '../context/GameContext';
import { useRealtime } from '../context/SocketContext';
import { AVATAR_SIZE, Avatar } from '../components/Avatar';

/** How long the round summary stays up before the next round shows (docs/design/ui-foundation.md). */
const ROUND_SUMMARY_MS = 3000;

/**
 * The game board. Mobile first, one column: opponents on top, the table (trump, the trick) in the
 * middle, the player's own hand and actions at the bottom, then the scoreboard. The round summary
 * is an overlay; the game-over screen replaces the board.
 */
export function GamePage() {
  const { id } = useParams<{ id: string }>();
  const { game } = useGame();
  const { connected } = useRealtime();

  if (!game || game.gameId !== id) {
    return (
      <main className="page">
        <p className="muted">{connected ? 'You are not in this game.' : 'Connecting…'}</p>
        <Link to="/">Back to lobby</Link>
      </main>
    );
  }
  if (game.abandoned) return <Abandoned game={game} />;
  if (game.gameOver) return <GameOver game={game} />;
  return (
    <>
      {!connected && (
        <p className="banner warn" role="status">
          Connection lost. Reconnecting… Your seat is held for 30 seconds.
        </p>
      )}
      <Board game={game} />
      {game.roundSummary && <RoundSummary game={game} result={game.roundSummary} />}
      {!game.roundSummary && game.decision && <ContinueOrEnd game={game} />}
    </>
  );
}

/** Leaves the room (POST /rooms/{roomId}/leave). The server then moves the socket to the lobby. */
function useLeave(roomId: string) {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leave = async () => {
    setLeaving(true);
    setError(null);
    try {
      await leaveRoom(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not leave the room.');
      setLeaving(false);
    }
  };
  return { leave, leaving, error };
}

/** "Leave game": a quit. The player cannot come back as a player, so confirm first. */
function LeaveGame({ game }: { game: GameView }) {
  const { leave, leaving, error } = useLeave(game.roomId);
  const label = game.isSpectator ? 'Stop watching' : 'Leave game';
  const onClick = () => {
    if (game.isSpectator || window.confirm('Leave this game? You cannot rejoin it as a player (you may watch it as a spectator).')) {
      void leave();
    }
  };
  return (
    <>
      <button type="button" className="link" onClick={onClick} disabled={leaving}>
        {label}
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

const nameOf = (game: GameView, id: string | null, me: string) =>
  id === me ? 'You' : ((id && game.names[id]) ?? 'Someone');

function Board({ game }: { game: GameView }) {
  const { user } = useAuth();
  const me = user?.id ?? '';
  const turnId = currentTurnId(game);
  // Opponents in seat order, starting with the seat after mine, so the table reads clockwise.
  const myIndex = game.seats.findIndex((s) => s.userId === me);
  const others = game.isSpectator ? game.seats : [...game.seats.slice(myIndex + 1), ...game.seats.slice(0, myIndex)];
  const mySeat = game.isSpectator ? null : game.seats[myIndex];
  const bidTotal = game.seats.reduce((sum, s) => sum + (s.bid ?? 0), 0);

  return (
    <main className="game">
      <header className="game-bar">
        <span>
          Round <strong>{game.roundNumber}</strong> of {game.roundCount}
        </span>
        <span>
          Bids <strong>{bidTotal}</strong> / {game.roundNumber} trick{game.roundNumber === 1 ? '' : 's'}
        </span>
        <span className="muted">{game.bidRule === 'uneven' ? 'Uneven bidding' : 'Open bidding'}</span>
        {game.isSpectator && <span className="badge">Spectating</span>}
        <LeaveGame game={game} />
      </header>
      {game.timeWarning && <TimeWarning endsAt={game.timeWarning.endsAt} />}
      {game.notice && <GameNotice text={game.notice} />}

      <section className="opponents" aria-label={game.isSpectator ? 'Players' : 'Opponents'}>
        {others.map((s) => (
          <Seat key={s.userId} seat={s} isDealer={s.userId === game.dealerId} isTurn={s.userId === turnId} />
        ))}
      </section>

      <section className="table" aria-label="Table">
        <Trump game={game} />
        <TrickArea game={game} me={me} />
        <p className="status" role="status">
          {statusLine(game, me, turnId)}
        </p>
      </section>

      {mySeat && (
        <section className="me" aria-label="Your hand">
          <div className="me-head">
            <span className="grow">
              <strong>{mySeat.displayName}</strong> <span className="muted">(you)</span>
              {game.dealerId === me && <span className="badge"> Dealer</span>}
            </span>
            <span>{bidProgress(mySeat)}</span>
          </div>
          <Actions game={game} />
          <Hand game={game} />
        </section>
      )}

      <Scoreboard game={game} turnId={turnId} />
    </main>
  );
}

/** "Bid 3 · Won 1 · Need 2 more", the over/under status from docs/product/prd.md. */
function bidProgress(seat: SeatView): string {
  if (seat.bid === null) return 'No bid yet';
  const base = `Bid ${seat.bid} · Won ${seat.tricksWon}`;
  const need = seat.bid - seat.tricksWon;
  if (need > 0) return `${base} · Need ${need} more`;
  if (need < 0) return `${base} · ${-need} over`;
  return `${base} · On target`;
}

function TimeWarning({ endsAt }: { endsAt: string }) {
  const left = useSecondsLeft(endsAt, 0);
  const at = new Date(endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <p className="banner warn" role="status">
      Time limit: this game stops at {at} ({Math.ceil(left / 60)} min left) and will not be scored.
    </p>
  );
}

function GameNotice({ text }: { text: string }) {
  const { clearNotice } = useGame();
  return (
    <p className="banner" role="status">
      {text}{' '}
      <button type="button" className="link" onClick={clearNotice}>
        Dismiss
      </button>
    </p>
  );
}

/** "Reconnecting · 0:23" on a player whose seat is held for them. */
function Disconnected({ deadline }: { deadline: string | null }) {
  const left = useSecondsLeft(deadline, 30_000);
  return (
    <span className="badge away">
      Reconnecting{deadline ? ` · 0:${String(left).padStart(2, '0')}` : '…'}
    </span>
  );
}

function Seat({ seat, isDealer, isTurn }: { seat: SeatView; isDealer: boolean; isTurn: boolean }) {
  const cls = ['seat', isTurn && 'turn', !seat.connected && 'away'].filter(Boolean).join(' ');
  return (
    <div className={cls} aria-current={isTurn ? 'true' : undefined}>
      <Avatar config={seat.avatarConfig} size={AVATAR_SIZE.chip} />
      <span className="seat-name">{seat.displayName}</span>
      <span className="seat-bid">{seat.bid === null ? '–' : `Bid ${seat.bid} · Won ${seat.tricksWon}`}</span>
      <span className="muted seat-meta">
        {seat.handCount} card{seat.handCount === 1 ? '' : 's'}
        {isDealer && ' · Dealer'}
      </span>
      {!seat.connected && <Disconnected deadline={seat.reconnectDeadline} />}
    </div>
  );
}

function Trump({ game }: { game: GameView }) {
  if (game.roundNumber === 0) return null;
  const card = game.trumpCard;
  let text: string;
  if (game.stage === 'choosing_trump') text = 'Wizard turned up: the dealer chooses trump';
  else if (game.trumpSuit) text = `Trump: ${SUIT_SYMBOLS[game.trumpSuit]} ${SUIT_NAMES[game.trumpSuit]}`;
  else if (!card) text = 'No trump: every card was dealt';
  else text = 'No trump';
  return (
    <div className="trump">
      {card ? <Card card={card} size="small" /> : <span className="playing-card small empty" aria-hidden="true" />}
      <span>
        <strong>{text}</strong>
        {game.trumpSource === 'declaration' && <span className="muted"> (declared by the dealer)</span>}
      </span>
    </div>
  );
}

/** The trick being played or, until the next card, the one just won (winner highlighted). */
function TrickArea({ game, me }: { game: GameView; me: string }) {
  const live = game.trick && game.trick.cards.length > 0 ? game.trick : null;
  const shown: PlayEntry[] | null = live ? live.cards : (game.lastTrick?.cards ?? null);
  if (!shown) return null;
  const winner = live ? null : game.lastTrick!.winnerId;
  return (
    <ol className="trick" aria-label={live ? `Trick ${live.trickNumber}` : 'Last trick'}>
      {shown.map((e, i) => (
        <li key={cardKey(e.card, i)} className={e.player_id === winner ? 'trick-card won' : 'trick-card'}>
          <Card card={e.card} size="small" />
          <span className="trick-name">{nameOf(game, e.player_id, me)}</span>
        </li>
      ))}
    </ol>
  );
}

function statusLine(game: GameView, me: string, turnId: string | null): string {
  const name = (id: string | null) => (id === me ? 'you' : ((id && game.names[id]) ?? 'someone'));
  switch (game.stage) {
    case 'choosing_trump':
      return game.dealerId === me ? 'Choose the trump suit.' : `Waiting for ${name(game.dealerId)} to choose trump.`;
    case 'bidding':
      return turnId === me ? 'Your bid.' : `Waiting for ${name(turnId)} to bid.`;
    case 'deciding':
      return 'Only two players are left. Waiting to hear whether the game goes on.';
    case 'playing': {
      const won = game.lastTrick && !(game.trick && game.trick.cards.length > 0) ? `${nameOf(game, game.lastTrick.winnerId, me)} won the trick. ` : '';
      return won + (turnId === me ? 'Your turn: play a card.' : `Waiting for ${name(turnId)} to play.`);
    }
    default:
      return game.lastTrick ? `${nameOf(game, game.lastTrick.winnerId, me)} won the last trick.` : 'Dealing…';
  }
}

function Actions({ game }: { game: GameView }) {
  const { selectTrump, placeBid } = useGame();
  const error = game.error && (
    <p className="error" role="alert">
      {game.error}
    </p>
  );

  if (game.trumpRequest) {
    return (
      <div className="action-panel">
        <p className="action-title">Choose trump</p>
        <div className="choice-grid suits">
          {SUITS.map((suit: Suit) => (
            <button key={suit} type="button" onClick={() => selectTrump(suit)} className={`suit-btn ${suit}`}>
              <span aria-hidden="true">{SUIT_SYMBOLS[suit]}</span> {SUIT_NAMES[suit]}
            </button>
          ))}
        </div>
        {error}
      </div>
    );
  }
  if (game.bidRequest) {
    const allowed = new Set(game.bidRequest.allowedBids);
    const options = Array.from({ length: game.roundNumber + 1 }, (_, i) => i);
    const blocked = options.filter((b) => !allowed.has(b));
    return (
      <div className="action-panel">
        <p className="action-title">How many tricks will you win?</p>
        <div className="choice-grid">
          {options.map((b) => (
            <button key={b} type="button" className="primary" onClick={() => placeBid(b)} disabled={!allowed.has(b)}>
              {b}
            </button>
          ))}
        </div>
        {blocked.length > 0 && (
          <p className="muted">
            Uneven bidding: you can't bid {blocked.join(' or ')}, because the total would equal the {game.roundNumber} trick
            {game.roundNumber === 1 ? '' : 's'}.
          </p>
        )}
        {error}
      </div>
    );
  }
  if (game.playRequest) {
    const all = (game.hand ?? []).length;
    const legal = game.playRequest.legalCards.length;
    return (
      <div className="action-panel">
        <p className="action-title">Your turn: tap a card to play it.</p>
        {legal < all && <p className="muted">You must follow the suit led, so only the highlighted cards can be played.</p>}
        {error}
      </div>
    );
  }
  return error || null;
}

/** The player's hand. On their turn the legal cards are buttons; the rest are dimmed and disabled. */
function Hand({ game }: { game: GameView }) {
  const { playCard } = useGame();
  const [sent, setSent] = useState<CardData | null>(null);
  // A new prompt (or an error re-enabling the hand) clears the pending play.
  useEffect(() => setSent(null), [game.playRequest, game.error]);
  const myTurn = !!game.playRequest && !sent;
  return (
    <ul className="hand">
      {(game.hand ?? []).map((c, i) => {
        const legal = myTurn && isLegal(game, c);
        return (
          <li key={cardKey(c, i)}>
            <button
              type="button"
              className={game.playRequest ? (isLegal(game, c) ? 'card-btn legal' : 'card-btn unplayable') : 'card-btn'}
              disabled={!legal}
              aria-label={legal ? `Play ${cardLabel(c)}` : cardLabel(c)}
              onClick={() => {
                setSent(c);
                playCard(c);
              }}
            >
              <Card card={c} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Running scores, with this round's bid and tricks; the round-by-round table on demand. */
function Scoreboard({ game, turnId }: { game: GameView; turnId: string | null }) {
  const [full, setFull] = useState(false);
  const leader = Math.max(...game.seats.map((s) => s.score));
  return (
    <section className="scoreboard" aria-label="Scoreboard">
      <div className="scoreboard-head">
        <h2>Scores</h2>
        {game.history.length > 0 && (
          <button type="button" className="link" onClick={() => setFull((f) => !f)} aria-expanded={full}>
            {full ? 'Hide rounds' : 'Round by round'}
          </button>
        )}
      </div>
      <table className="score-table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Bid</th>
            <th scope="col">Won</th>
            <th scope="col">Score</th>
          </tr>
        </thead>
        <tbody>
          {game.seats.map((s) => (
            <tr key={s.userId} className={s.userId === turnId ? 'turn' : undefined}>
              <th scope="row">
                <span className="score-player">
                  <Avatar config={s.avatarConfig} size={AVATAR_SIZE.scoreboard} />
                  <span>
                    {s.displayName}
                    {s.score === leader && game.history.length > 0 && <span className="muted"> · leads</span>}
                  </span>
                </span>
              </th>
              <td>{s.bid ?? '–'}</td>
              <td>{s.bid === null ? '–' : s.tricksWon}</td>
              <td className="num">{s.score}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {full && <RoundTable game={game} history={game.history} />}
    </section>
  );
}

/** Every scored round: bid / won and the score change per player, with running totals. */
function RoundTable({ game, history }: { game: GameView; history: RoundResult[] }) {
  // A column for everyone who played a round: current seats first, then players who left.
  const seated = new Set(game.seats.map((s) => s.userId));
  const columns = [...game.seats.map((s) => s.userId)];
  for (const r of history) for (const p of r.players) if (!columns.includes(p.userId)) columns.push(p.userId);
  return (
    <div className="table-scroll">
      <table className="score-table rounds">
        <thead>
          <tr>
            <th scope="col">Round</th>
            {columns.map((id) => (
              <th key={id} scope="col">
                {game.names[id] ?? 'Someone'}
                {!seated.has(id) && <span className="muted"> (left)</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.map((r) => (
            <tr key={r.roundNumber}>
              <th scope="row">{r.roundNumber}</th>
              {columns.map((id) => {
                const p = r.players.find((q) => q.userId === id);
                return p ? (
                  <td key={id}>
                    <span className="muted">
                      {p.bid}/{p.tricksWon}
                    </span>{' '}
                    <Delta value={p.delta} /> <strong className="num">{p.total}</strong>
                  </td>
                ) : (
                  <td key={id} className="muted">
                    —
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Delta({ value }: { value: number }) {
  return <span className={value >= 0 ? 'delta pos' : 'delta neg'}>{value > 0 ? `+${value}` : value}</span>;
}

/** Seconds left until `iso`, ticking. */
function useSecondsLeft(iso: string | null, fallbackMs: number): number {
  const [target] = useState(() => (iso ? Date.parse(iso) : Date.now() + fallbackMs));
  const end = iso ? Date.parse(iso) : target;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/** The round just scored, over the board, for a few seconds (tap to close sooner). */
function RoundSummary({ game, result }: { game: GameView; result: RoundResult }) {
  const { dismissSummary } = useGame();
  const left = useSecondsLeft(null, ROUND_SUMMARY_MS);
  useEffect(() => {
    const t = setTimeout(dismissSummary, ROUND_SUMMARY_MS);
    return () => clearTimeout(t);
  }, [result, dismissSummary]);
  const last = result.roundNumber >= game.roundCount;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="round-summary-title">
      <div className="modal">
        <h2 id="round-summary-title">Round {result.roundNumber} scores</h2>
        <table className="score-table">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Bid</th>
              <th scope="col">Won</th>
              <th scope="col">Points</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {result.players.map((p) => (
              <tr key={p.userId}>
                <th scope="row">{game.names[p.userId] ?? 'Someone'}</th>
                <td>{p.bid}</td>
                <td>{p.tricksWon}</td>
                <td>
                  <Delta value={p.delta} />
                </td>
                <td className="num">{p.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-foot">
          <span className="countdown">{last ? 'Final scores…' : `Next round in ${left}…`}</span>
          <button type="button" className="primary" onClick={dismissSummary}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * continue_or_end_request: a drop left two players. They choose (no answer by the deadline counts
 * as end); everyone else waits.
 */
function ContinueOrEnd({ game }: { game: GameView }) {
  const { user } = useAuth();
  const { chooseContinueOrEnd } = useGame();
  const decision = game.decision!;
  const left = useSecondsLeft(decision.deadline, 60_000);
  const mine = decision.remainingIds.includes(user?.id ?? '');
  const others = decision.remainingIds.filter((id) => id !== user?.id).map((id) => nameOf(game, id, user?.id ?? ''));
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="decide-title">
      <div className="modal">
        <h2 id="decide-title">Only two players left</h2>
        {mine ? (
          decision.myChoice ? (
            <p>
              You chose to {decision.myChoice === 'continue' ? 'keep playing' : 'end the game'}. Waiting for {others.join(' and ')}…
            </p>
          ) : (
            <p>
              Keep playing with {others.join(' and ')}, or end the game now? Ending records it as unfinished, with no winner. If
              either of you ends it, or nobody answers in time, the game ends.
            </p>
          )
        ) : (
          <p>The two remaining players are deciding whether to keep playing.</p>
        )}
        {game.error && (
          <p className="error" role="alert">
            {game.error}
          </p>
        )}
        <div className="modal-foot">
          <span className="countdown" role="timer">
            {left}s left
          </span>
          {mine && !decision.myChoice && (
            <>
              <button type="button" onClick={() => chooseContinueOrEnd('end')}>
                End game
              </button>
              <button type="button" className="primary" onClick={() => chooseContinueOrEnd('continue')}>
                Keep playing
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** game_abandoned: the server stopped the game (time limit). The room closes after the countdown. */
function Abandoned({ game }: { game: GameView }) {
  const { leave, leaving, error } = useLeave(game.roomId);
  return (
    <main className="page game-over">
      <p className="muted">Game stopped</p>
      <h1>No result</h1>
      <p>{ABANDON_MESSAGES[game.abandoned!]}</p>
      <div className="game-over-foot">
        <span className="muted">You will be returned to the lobby shortly.</span>
        <button type="button" className="primary" onClick={() => void leave()} disabled={leaving}>
          Back to lobby
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

/** Winners, final standings and every round, with the countdown back to the lobby. */
function GameOver({ game }: { game: GameView }) {
  const over = game.gameOver!;
  const left = useSecondsLeft(over.closesAt, 30_000);
  // The server then moves this socket to the lobby (lobby_snapshot), which navigates away.
  const { leave, leaving, error } = useLeave(game.roomId);
  const name = (id: string) => game.names[id] ?? 'Someone';
  const standings = [...over.finalScores].sort((a, b) => b.score - a.score);
  const winners = over.winnerIds.map(name);
  const early = over.status === 'incomplete';

  return (
    <main className="page game-over">
      <p className="muted">{early ? 'Game ended early' : 'Game over'}</p>
      {early ? (
        <h1>No winner: the game was not finished</h1>
      ) : (
        <h1 className="winner">
          <span aria-hidden="true">♛ </span>
          {winners.length > 1 ? `${winners.join(' and ')} tie for the win` : `${winners[0]} wins`}
        </h1>
      )}

      <ol className="standings">
        {standings.map((e, i) => (
          <li key={e.player_id} className={over.winnerIds.includes(e.player_id) ? 'won' : undefined}>
            <span className="order">{i + 1}</span>
            <span className="grow">{name(e.player_id)}</span>
            <strong className="num">{e.score}</strong>
          </li>
        ))}
      </ol>

      {game.history.length > 0 && (
        <section aria-label="Round by round">
          <h2>Round by round</h2>
          <RoundTable game={game} history={game.history} />
        </section>
      )}

      <div className="game-over-foot">
        <span className="countdown" role="timer">
          Returning to lobby in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}…
        </span>
        <button type="button" className="primary" onClick={() => void leave()} disabled={leaving}>
          Leave now
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
