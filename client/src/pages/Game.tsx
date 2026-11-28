import { useEffect, useState, type CSSProperties } from 'react';
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
 * The game board: everyone seated around an oval table, you at the bottom, trump in the middle and
 * each played card in front of its player. Your actions and hand sit under the table, then the
 * scoreboard (beside the table on wide screens). The round summary is an overlay; the game-over
 * screen replaces the board.
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

/** A point on the table's oval: `--x`/`--y` in -1..1, read by the seat and trick-card CSS. */
type TablePos = CSSProperties & { '--x': number; '--y': number };

/**
 * Where each player sits. You sit at the bottom; the rest follow in seat order, clockwise, so the
 * next player (the one on your left) is on the left of the screen. Spectators see seat 1 at the
 * bottom. Returns the seats in that order with their position on the oval.
 *
 * Seats are spaced evenly by distance around the rim, not by angle: on a tall phone oval, equal
 * angles bunch the seats at the top and bottom, where the curve is tight. `aspect` is the felt's
 * height / width (1 until it has been measured).
 */
function tableOrder(game: GameView, me: string, aspect: number): { seat: SeatView; pos: TablePos }[] {
  const n = game.seats.length;
  const mine = game.isSpectator ? -1 : game.seats.findIndex((s) => s.userId === me);
  const start = mine < 0 ? 0 : mine;
  const angles = evenAngles(n, aspect);
  return Array.from({ length: n }, (_, i) => {
    const seat = game.seats[(start + i) % n];
    const pos = { '--x': round3(Math.cos(angles[i])), '--y': round3(Math.sin(angles[i])) } as TablePos;
    return { seat, pos };
  });
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * `n` parameter angles t on the ellipse (cos t, aspect·sin t), equally spaced by arc length,
 * starting at the bottom (t = 90°; screen y points down) and running bottom → left → top → right.
 */
function evenAngles(n: number, aspect: number): number[] {
  const steps = 720;
  const dt = (2 * Math.PI) / steps;
  const at = (k: number) => Math.PI / 2 + k * dt;
  // Cumulative arc length at each sample.
  const cum = [0];
  for (let k = 1; k <= steps; k++) {
    const t = at(k - 0.5);
    cum.push(cum[k - 1] + Math.hypot(Math.sin(t), aspect * Math.cos(t)) * dt);
  }
  const total = cum[steps];
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const target = (i * total) / n;
    while (cum[k + 1] < target) k++;
    const frac = cum[k + 1] === cum[k] ? 0 : (target - cum[k]) / (cum[k + 1] - cum[k]);
    out.push(at(k + frac));
  }
  return out;
}

/** The felt's height / width, kept current as the table resizes. */
function useAspect(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [aspect, setAspect] = useState(1);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setAspect(el.clientHeight / el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, aspect];
}

function Board({ game }: { game: GameView }) {
  const { user } = useAuth();
  const me = user?.id ?? '';
  const turnId = currentTurnId(game);
  const [feltRef, aspect] = useAspect();
  const order = tableOrder(game, me, aspect);
  const positions = new Map(order.map(({ seat, pos }) => [seat.userId, pos]));
  const mySeat = game.isSpectator ? null : (game.seats.find((s) => s.userId === me) ?? null);
  const bidTotal = game.seats.reduce((sum, s) => sum + (s.bid ?? 0), 0);
  const status = statusLine(game, me, turnId);
  const myMove = !!(game.trumpRequest || game.bidRequest || game.playRequest);

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
      {(game.timeWarning || game.notice) && (
        <div className="game-notices">
          {game.timeWarning && <TimeWarning endsAt={game.timeWarning.endsAt} />}
          {game.notice && <GameNotice text={game.notice} />}
        </div>
      )}

      <section className={order.length >= 7 ? 'round-table crowded' : 'round-table'} aria-label="Table">
        <div className="felt" aria-hidden="true" ref={feltRef} />
        <Trump game={game} />
        <TrickArea game={game} me={me} positions={positions} />
        <ol className="seats" aria-label="Players, clockwise">
          {order.map(({ seat, pos }) => (
            <Seat
              key={seat.userId}
              seat={seat}
              pos={pos}
              isMe={seat.userId === me}
              isDealer={seat.userId === game.dealerId}
              isTurn={seat.userId === turnId}
            />
          ))}
        </ol>
      </section>

      <p className={myMove ? 'status mine' : 'status'} role="status">
        {status}
      </p>

      {mySeat && (
        <section className="me" aria-label="Your hand">
          <div className="me-head">
            <span className="grow muted">Your hand</span>
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
function Disconnected({ deadline, compact = false }: { deadline: string | null; compact?: boolean }) {
  const left = useSecondsLeft(deadline, 30_000);
  const time = deadline ? `0:${String(left).padStart(2, '0')}` : null;
  if (compact) {
    // Short enough for a seat on a full phone table; the full wording is for screen readers.
    return (
      <span className="badge away" title="Reconnecting">
        <span aria-hidden="true">Away{time ? ` ${time}` : ''}</span>
        <span className="visually-hidden">Reconnecting{time ? `, ${left} seconds left` : ''}</span>
      </span>
    );
  }
  return <span className="badge away">Reconnecting{time ? ` · ${time}` : '…'}</span>;
}

/** One player's place at the table: avatar, name, bid and tricks, cards left, dealer button. */
function Seat({ seat, pos, isMe, isDealer, isTurn }: { seat: SeatView; pos: TablePos; isMe: boolean; isDealer: boolean; isTurn: boolean }) {
  const cls = ['seat', isMe && 'you', isTurn && 'turn', !seat.connected && 'away'].filter(Boolean).join(' ');
  const cards = `${seat.handCount} card${seat.handCount === 1 ? '' : 's'}`;
  return (
    <li className={cls} style={pos} aria-current={isTurn ? 'true' : undefined}>
      <span className="seat-avatar">
        <Avatar config={seat.avatarConfig} size={AVATAR_SIZE.chip} />
        {isDealer && (
          <span className="dealer-chip" title="Dealer">
            D<span className="visually-hidden">ealer</span>
          </span>
        )}
        {seat.handCount > 0 && !isMe && (
          <span className="card-count" title={cards}>
            <span aria-hidden="true">{seat.handCount}</span>
            <span className="visually-hidden">{cards}</span>
          </span>
        )}
      </span>
      <span className="seat-name">{isMe ? 'You' : seat.displayName}</span>
      <span className={seat.bid === null ? 'seat-bid pending' : 'seat-bid'}>
        {seat.bid === null ? (
          <>
            Bid <span aria-hidden="true">?</span>
            <span className="visually-hidden">not placed yet</span>
          </>
        ) : (
          <>
            Won {seat.tricksWon}/{seat.bid}
          </>
        )}
      </span>
      {!seat.connected && <Disconnected deadline={seat.reconnectDeadline} compact />}
    </li>
  );
}

/** The trump card, in the middle of the table. */
function Trump({ game }: { game: GameView }) {
  if (game.roundNumber === 0) return null;
  const card = game.trumpCard;
  let label: string;
  let detail: string | null = null;
  if (game.stage === 'choosing_trump') {
    label = 'Wizard!';
    detail = 'Dealer picks trump';
  } else if (game.trumpSuit) {
    label = `${SUIT_SYMBOLS[game.trumpSuit]} ${SUIT_NAMES[game.trumpSuit]}`;
    if (game.trumpSource === 'declaration') detail = 'declared';
  } else {
    label = 'No trump';
    if (!card) detail = 'all cards dealt';
  }
  const red = game.trumpSuit === 'hearts' || game.trumpSuit === 'diamonds';
  return (
    <div className="trump" aria-label={`Trump: ${label}${detail ? `, ${detail}` : ''}`} role="group">
      {card ? <Card card={card} size="small" /> : <span className="playing-card small empty" aria-hidden="true" />}
      <span className="trump-text" aria-hidden="true">
        <span className="trump-kicker">Trump</span>
        <strong className={red ? 'red' : undefined}>{label}</strong>
        {detail && <span className="trump-detail">{detail}</span>}
      </span>
    </div>
  );
}

/**
 * The trick being played or, until the next card, the one just won (winner highlighted). Each card
 * lies on the felt in front of the player who played it; later cards stack on top.
 */
function TrickArea({ game, me, positions }: { game: GameView; me: string; positions: Map<string, TablePos> }) {
  const live = game.trick && game.trick.cards.length > 0 ? game.trick : null;
  const shown: PlayEntry[] | null = live ? live.cards : (game.lastTrick?.cards ?? null);
  if (!shown) return null;
  const winner = live ? null : game.lastTrick!.winnerId;
  return (
    <ol className="trick" aria-label={live ? `Trick ${live.trickNumber}` : 'Last trick'}>
      {shown.map((e, i) => {
        // A card from a player no longer seated has no place; lay it at the centre.
        const pos = positions.get(e.player_id) ?? ({ '--x': 0, '--y': 0 } as TablePos);
        const won = e.player_id === winner;
        return (
          <li key={cardKey(e.card, i)} className={won ? 'trick-card won' : 'trick-card'} style={{ ...pos, zIndex: i + 1 }}>
            <Card card={e.card} size="small" />
            <span className="visually-hidden">
              {' '}
              played by {nameOf(game, e.player_id, me)}
              {i === 0 ? ', led' : ''}
              {won ? ', won the trick' : ''}
            </span>
          </li>
        );
      })}
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
    // The status line already says it's your turn; only explain why some cards are dimmed.
    if (legal === all && !error) return null;
    return (
      <div className="action-panel">
        {legal < all && <p className="muted play-hint">You must follow the suit led, so only the highlighted cards can be played.</p>}
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
