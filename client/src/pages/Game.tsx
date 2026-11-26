import { Link, useParams } from 'react-router';
import { SUITS, type Suit } from '../api/types';
import { Card, SUIT_NAMES, SUIT_SYMBOLS, cardKey } from '../components/Card';
import { useAuth } from '../context/AuthContext';
import { currentBidderId, useGame, type GameView, type SeatView } from '../context/GameContext';
import { useRealtime } from '../context/SocketContext';

/**
 * The game board. Mobile first, one column: opponents on top, the table (trump, status) in the
 * middle, the player's own hand and actions at the bottom. Covers dealing, trump and bidding;
 * trick play comes next.
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
  return <Board game={game} />;
}

function Board({ game }: { game: GameView }) {
  const { user } = useAuth();
  const me = user?.id ?? '';
  const bidder = currentBidderId(game);
  const dealer = game.seats.find((s) => s.userId === game.dealerId);
  const turnId = game.stage === 'choosing_trump' ? game.dealerId : bidder;
  // Opponents in seat order, starting with the seat after mine, so the table reads clockwise.
  const myIndex = game.seats.findIndex((s) => s.userId === me);
  const others = game.isSpectator
    ? game.seats
    : [...game.seats.slice(myIndex + 1), ...game.seats.slice(0, myIndex)];
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
      </header>

      <section className="opponents" aria-label={game.isSpectator ? 'Players' : 'Opponents'}>
        {others.map((s) => (
          <Seat key={s.userId} seat={s} isDealer={s.userId === game.dealerId} isTurn={s.userId === turnId} />
        ))}
      </section>

      <section className="table" aria-label="Table">
        <Trump game={game} />
        <p className="status" role="status">
          {statusLine(game, me, turnId, dealer)}
        </p>
        {/* The current trick goes here once trick play is wired. */}
      </section>

      {mySeat && (
        <section className="me" aria-label="Your hand">
          <div className="me-head">
            <span className="grow">
              <strong>{mySeat.displayName}</strong> <span className="muted">(you)</span>
              {game.dealerId === me && <span className="badge"> Dealer</span>}
            </span>
            <span>{mySeat.bid === null ? 'No bid yet' : `Bid ${mySeat.bid}`}</span>
          </div>
          <Actions game={game} />
          <ul className="hand">
            {(game.hand ?? []).map((c, i) => (
              <li key={cardKey(c, i)}>
                <Card card={c} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Seat({ seat, isDealer, isTurn }: { seat: SeatView; isDealer: boolean; isTurn: boolean }) {
  return (
    <div className={isTurn ? 'seat turn' : 'seat'} aria-current={isTurn ? 'true' : undefined}>
      <span className="avatar" aria-hidden="true">
        {seat.displayName.slice(0, 1).toUpperCase()}
      </span>
      <span className="seat-name">{seat.displayName}</span>
      <span className="seat-bid">{seat.bid === null ? '–' : `Bid ${seat.bid}`}</span>
      <span className="muted seat-meta">
        {seat.handCount} card{seat.handCount === 1 ? '' : 's'}
        {isDealer && ' · Dealer'}
      </span>
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

function statusLine(game: GameView, me: string, turnId: string | null, dealer: SeatView | undefined): string {
  const name = (id: string | null) => (id === me ? 'you' : game.seats.find((s) => s.userId === id)?.displayName ?? 'someone');
  switch (game.stage) {
    case 'choosing_trump':
      return game.dealerId === me ? 'Choose the trump suit.' : `Waiting for ${dealer?.displayName ?? 'the dealer'} to choose trump.`;
    case 'bidding':
      return turnId === me ? 'Your bid.' : `Waiting for ${name(turnId)} to bid.`;
    case 'bids_complete':
      return 'All bids are in. Trick play is coming soon.';
    default:
      return 'Dealing…';
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
  return error || null;
}
