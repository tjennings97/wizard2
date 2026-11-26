import { createContext, useCallback, useContext, useEffect, useReducer, type ReactNode } from 'react';
import type {
  BidEntry,
  BidRule,
  Card,
  GameStateView,
  PlayEntry,
  PlayerSummary,
  RoundScoreEntry,
  ScoreEntry,
  Suit,
  TrumpSource,
} from '../api/types';
import type { Envelope } from '../socket/client';
import { useAuth } from './AuthContext';
import { useRealtime } from './SocketContext';

export interface SeatView {
  userId: string;
  displayName: string;
  seatIndex: number;
  bid: number | null;
  handCount: number;
  /** Tricks won this round. */
  tricksWon: number;
  /** Cumulative score. */
  score: number;
}

/** Where the round is, as the client renders it. */
export type RoundStage =
  /** Dealt; trump not settled yet (a Wizard was flipped and the dealer is choosing). */
  | 'choosing_trump'
  | 'bidding'
  /** Every bid is in; tricks are being played. */
  | 'playing'
  /** The game has ended (game_over). */
  | 'game_over'
  | 'waiting';

export interface TrickView {
  trickNumber: number;
  /** Who leads (plays first). */
  leaderId: string;
  cards: PlayEntry[];
}

/** One scored round, for the round summary and the full scoreboard. */
export interface RoundResult {
  roundNumber: number;
  /** Seat order. `score` is the round's delta. */
  players: { userId: string; bid: number; tricksWon: number; delta: number; total: number }[];
}

export interface GameOverView {
  finalScores: ScoreEntry[];
  winnerIds: string[];
  /** When the room closes and everyone returns to the lobby. Null until game_over arrives. */
  closesAt: string | null;
}

export interface GameView {
  gameId: string;
  roomId: string;
  roundCount: number;
  bidRule: BidRule;
  /** Seat order. */
  seats: SeatView[];
  isSpectator: boolean;
  roundNumber: number;
  dealerId: string | null;
  trumpCard: Card | null;
  trumpSuit: Suit | null;
  trumpSource: TrumpSource;
  stage: RoundStage;
  /** The viewer's hand; null for spectators. */
  hand: Card[] | null;
  /** Set while the server has asked this player to bid. */
  bidRequest: { allowedBids: number[] } | null;
  /** Set while the server has asked this player (the dealer) to declare trump. */
  trumpRequest: boolean;
  /** Set while the server has asked this player to play; only these cards may be played. */
  playRequest: { legalCards: Card[] } | null;
  /** The trick being played, or null outside trick play. */
  trick: TrickView | null;
  /** The trick just won, shown until the next card is played. */
  lastTrick: { winnerId: string; cards: PlayEntry[] } | null;
  /** Scored rounds, oldest first. */
  history: RoundResult[];
  /** The round just scored, shown briefly before the next round (dismissed by the page). */
  roundSummary: RoundResult | null;
  gameOver: GameOverView | null;
  error: string | null;
  /** Envelope seq of the last game event applied. */
  seq: number;
}

type State = GameView | null;

type Action =
  | { type: 'reset' }
  | { type: 'game_started'; seq: number; userId: string; gameId: string; roomId: string; roundCount: number; bidRule: BidRule; players: PlayerSummary[] }
  | { type: 'round_started'; seq: number; roundNumber: number; dealerId: string; trumpSuit: Suit | null; trumpCard: Card | null }
  | { type: 'hand_dealt'; seq: number; hand: Card[]; roundNumber: number }
  | { type: 'trump_revealed'; seq: number; trumpSuit: Suit | null; trumpCard: Card | null; trumpSource: TrumpSource }
  | { type: 'trump_selection_request'; seq: number }
  | { type: 'bid_request'; seq: number; allowedBids: number[] }
  | { type: 'bid_placed'; seq: number; userId: string; playerId: string; bid: number }
  | { type: 'all_bids_placed'; seq: number; bids: BidEntry[] }
  | { type: 'play_request'; seq: number; trickNumber: number; legalCards: Card[] }
  | { type: 'card_played'; seq: number; userId: string; playerId: string; card: Card; trickNumber: number }
  | { type: 'trick_complete'; seq: number; winnerId: string; cards: PlayEntry[]; trickNumber: number }
  | { type: 'round_complete'; seq: number; roundNumber: number; scores: RoundScoreEntry[]; totals: ScoreEntry[] }
  | { type: 'game_over'; seq: number; finalScores: ScoreEntry[]; winnerIds: string[]; closesAt: string }
  | { type: 'error'; seq: number; reason: string; allowedBids?: number[]; legalCards?: Card[] }
  | { type: 'state_snapshot'; seq: number; view: GameStateView }
  | { type: 'dismiss_summary' }
  | { type: 'clear_error' };

const sameCard = (a: Card, b: Card) => a.type === b.type && a.suit === b.suit && a.rank === b.rank;

function historyFromView(view: GameStateView): RoundResult[] {
  const totals = new Map<string, number>();
  return view.roundHistory.map((r) => ({
    roundNumber: r.roundNumber,
    players: [...view.players]
      .sort((a, b) => a.seatOrder - b.seatOrder)
      .map((p) => {
        const x = r.players.find((q) => q.userId === p.userId);
        const total = (totals.get(p.userId) ?? 0) + (x?.scoreDelta ?? 0);
        totals.set(p.userId, total);
        return { userId: p.userId, bid: x?.bid ?? 0, tricksWon: x?.tricksWon ?? 0, delta: x?.scoreDelta ?? 0, total };
      }),
  }));
}

function snapshotState(view: GameStateView, seq: number): GameView {
  const me = view.players.find((p) => p.userId === view.viewerUserId);
  const stage: RoundStage =
    view.phase === 'trump_declaration'
      ? 'choosing_trump'
      : view.phase === 'bidding'
        ? 'bidding'
        : view.phase === 'trick'
          ? 'playing'
          : view.phase === 'completed'
            ? 'game_over'
            : 'waiting';
  const open = view.tricksSoFar.at(-1);
  const trick =
    view.phase === 'trick' && open && open.winnerUserId === null
      ? { trickNumber: open.trickNumber, leaderId: open.leaderUserId, cards: open.cards.map((c) => ({ player_id: c.userId, card: c.card })) }
      : null;
  const seats = [...view.players]
    .sort((a, b) => a.seatOrder - b.seatOrder)
    .map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      seatIndex: p.seatOrder - 1,
      bid: p.bid,
      handCount: p.handCount,
      tricksWon: p.tricksWon,
      score: p.cumulativeScore,
    }));
  return {
    gameId: view.gameId,
    roomId: view.roomId,
    roundCount: view.config.roundCount,
    bidRule: view.config.bidRule,
    seats,
    isSpectator: view.viewerUserId === null,
    roundNumber: view.currentRound,
    dealerId: view.dealerUserId,
    trumpCard: view.trumpCard,
    trumpSuit: view.trumpSuit,
    trumpSource: view.trumpSource,
    stage,
    hand: me?.hand ?? null,
    // A pending bid_request, trump_selection_request, play_request or game_over follows the snapshot.
    bidRequest: null,
    trumpRequest: false,
    playRequest: null,
    trick,
    lastTrick: null,
    history: historyFromView(view),
    roundSummary: null,
    gameOver:
      view.phase === 'completed'
        ? { finalScores: seats.map((s) => ({ player_id: s.userId, score: s.score })), winnerIds: view.winnerUserIds, closesAt: null }
        : null,
    error: null,
    seq,
  };
}

/** The seat after `userId`, clockwise. */
function nextSeat(seats: SeatView[], userId: string): string {
  const i = seats.findIndex((s) => s.userId === userId);
  return seats[(i + 1) % seats.length].userId;
}

function reducer(state: State, action: Action): State {
  if (action.type === 'reset') return null;
  if (action.type === 'game_started') {
    return {
      gameId: action.gameId,
      roomId: action.roomId,
      roundCount: action.roundCount,
      bidRule: action.bidRule,
      seats: action.players.map((p) => ({
        userId: p.user_id,
        displayName: p.display_name,
        seatIndex: p.seat_index,
        bid: null,
        handCount: 0,
        tricksWon: 0,
        score: 0,
      })),
      isSpectator: !action.players.some((p) => p.user_id === action.userId),
      roundNumber: 0,
      dealerId: null,
      trumpCard: null,
      trumpSuit: null,
      trumpSource: null,
      stage: 'waiting',
      hand: null,
      bidRequest: null,
      trumpRequest: false,
      playRequest: null,
      trick: null,
      lastTrick: null,
      history: [],
      roundSummary: null,
      gameOver: null,
      error: null,
      seq: action.seq,
    };
  }
  if (action.type === 'state_snapshot') return snapshotState(action.view, action.seq);
  if (!state) return state;
  if (action.type === 'clear_error') return { ...state, error: null };
  if (action.type === 'dismiss_summary') return { ...state, roundSummary: null };

  const next = { ...state, seq: Math.max(state.seq, action.seq) };
  switch (action.type) {
    case 'round_started':
      return {
        ...next,
        roundNumber: action.roundNumber,
        dealerId: action.dealerId,
        trumpCard: action.trumpCard,
        trumpSuit: action.trumpSuit,
        trumpSource: null,
        stage: action.trumpCard?.type === 'wizard' ? 'choosing_trump' : 'waiting',
        seats: next.seats.map((s) => ({ ...s, bid: null, tricksWon: 0, handCount: action.roundNumber })),
        hand: next.isSpectator ? null : [],
        bidRequest: null,
        trumpRequest: false,
        playRequest: null,
        trick: null,
        lastTrick: null,
        error: null,
      };
    case 'hand_dealt':
      return { ...next, hand: action.hand };
    case 'trump_revealed':
      return {
        ...next,
        trumpSuit: action.trumpSuit,
        trumpCard: action.trumpCard,
        trumpSource: action.trumpSource,
        stage: 'bidding',
        trumpRequest: false,
        error: null,
      };
    case 'trump_selection_request':
      return { ...next, trumpRequest: true };
    case 'bid_request':
      return { ...next, stage: 'bidding', bidRequest: { allowedBids: action.allowedBids } };
    case 'bid_placed': {
      const mine = action.playerId === action.userId;
      return {
        ...next,
        seats: next.seats.map((s) => (s.userId === action.playerId ? { ...s, bid: action.bid } : s)),
        bidRequest: mine ? null : next.bidRequest,
        error: mine ? null : next.error,
      };
    }
    case 'all_bids_placed': {
      const bids = new Map(action.bids.map((b) => [b.player_id, b.bid]));
      return {
        ...next,
        stage: 'playing',
        bidRequest: null,
        seats: next.seats.map((s) => ({ ...s, bid: bids.get(s.userId) ?? s.bid })),
        // The first bidder (left of the dealer) leads the first trick.
        trick: { trickNumber: 1, leaderId: action.bids[0]?.player_id ?? '', cards: [] },
      };
    }
    case 'play_request':
      return { ...next, stage: 'playing', playRequest: { legalCards: action.legalCards } };
    case 'card_played': {
      const mine = action.playerId === action.userId;
      const trick = next.trick ?? { trickNumber: action.trickNumber, leaderId: action.playerId, cards: [] };
      let hand = next.hand;
      if (mine && hand) {
        const i = hand.findIndex((c) => sameCard(c, action.card));
        if (i >= 0) hand = [...hand.slice(0, i), ...hand.slice(i + 1)];
      }
      return {
        ...next,
        hand,
        seats: next.seats.map((s) => (s.userId === action.playerId ? { ...s, handCount: Math.max(0, s.handCount - 1) } : s)),
        trick: { ...trick, cards: [...trick.cards, { player_id: action.playerId, card: action.card }] },
        lastTrick: null,
        playRequest: mine ? null : next.playRequest,
        error: mine ? null : next.error,
      };
    }
    case 'trick_complete': {
      const more = action.trickNumber < next.roundNumber;
      return {
        ...next,
        seats: next.seats.map((s) => (s.userId === action.winnerId ? { ...s, tricksWon: s.tricksWon + 1 } : s)),
        lastTrick: { winnerId: action.winnerId, cards: action.cards },
        trick: more ? { trickNumber: action.trickNumber + 1, leaderId: action.winnerId, cards: [] } : null,
      };
    }
    case 'round_complete': {
      const totals = new Map(action.totals.map((t) => [t.player_id, t.score]));
      const result: RoundResult = {
        roundNumber: action.roundNumber,
        players: next.seats.map((s) => {
          const x = action.scores.find((e) => e.player_id === s.userId);
          return { userId: s.userId, bid: x?.bid ?? 0, tricksWon: x?.tricks_won ?? 0, delta: x?.score ?? 0, total: totals.get(s.userId) ?? s.score };
        }),
      };
      return {
        ...next,
        stage: 'waiting',
        seats: next.seats.map((s) => ({ ...s, score: totals.get(s.userId) ?? s.score })),
        history: [...next.history.filter((h) => h.roundNumber !== action.roundNumber), result],
        roundSummary: result,
        playRequest: null,
        trick: null,
      };
    }
    case 'game_over':
      return {
        ...next,
        stage: 'game_over',
        roundSummary: null,
        playRequest: null,
        bidRequest: null,
        gameOver: { finalScores: action.finalScores, winnerIds: action.winnerIds, closesAt: action.closesAt },
      };
    case 'error':
      return {
        ...next,
        error: action.reason,
        bidRequest: next.bidRequest && action.allowedBids?.length ? { allowedBids: action.allowedBids } : next.bidRequest,
        playRequest: next.playRequest && action.legalCards?.length ? { legalCards: action.legalCards } : next.playRequest,
      };
  }
}

/** Whose turn it is to bid: the first seat after the dealer, clockwise, without a bid. */
export function currentBidderId(game: GameView): string | null {
  if (game.stage !== 'bidding' || game.dealerId === null) return null;
  const n = game.seats.length;
  const dealer = game.seats.findIndex((s) => s.userId === game.dealerId);
  for (let i = 1; i <= n; i++) {
    const seat = game.seats[(dealer + i) % n];
    if (seat.bid === null) return seat.userId;
  }
  return null;
}

/** Whose turn it is to play: the leader, then clockwise. Null once everyone has played. */
export function currentPlayerId(game: GameView): string | null {
  const trick = game.trick;
  if (game.stage !== 'playing' || !trick || trick.cards.length >= game.seats.length) return null;
  const last = trick.cards.at(-1);
  return last ? nextSeat(game.seats, last.player_id) : trick.leaderId;
}

/** Whoever the game is waiting on. */
export function currentTurnId(game: GameView): string | null {
  if (game.stage === 'choosing_trump') return game.dealerId;
  if (game.stage === 'bidding') return currentBidderId(game);
  return currentPlayerId(game);
}

export function isLegal(game: GameView, card: Card): boolean {
  return !!game.playRequest?.legalCards.some((c) => sameCard(c, card));
}

interface GameValue {
  game: GameView | null;
  selectTrump(suit: Suit): void;
  placeBid(bid: number): void;
  playCard(card: Card): void;
  dismissSummary(): void;
  clearError(): void;
}

const GameContext = createContext<GameValue | null>(null);

type Payloads = {
  game_started: { game_id: string; room_id: string; round_count: number; bid_rule: BidRule; players: PlayerSummary[] };
  round_started: { round_number: number; dealer_id: string; trump_suit: Suit | null; trump_card: Card | null };
  hand_dealt: { hand: Card[]; round_number: number };
  trump_revealed: { trump_suit: Suit | null; trump_card: Card | null; trump_source: TrumpSource };
  trump_selection_request: { player_id: string; round_number: number };
  bid_request: { allowed_bids: number[] };
  bid_placed: { player_id: string; bid: number };
  all_bids_placed: { bids: BidEntry[] };
  play_request: { player_id: string; trick_number: number; trick_so_far: PlayEntry[]; legal_cards: Card[] };
  card_played: { player_id: string; card: Card; trick_number: number };
  trick_complete: { winner_id: string; cards_played: PlayEntry[]; trick_number: number };
  round_complete: { round_number: number; scores_this_round: RoundScoreEntry[]; cumulative_scores: ScoreEntry[] };
  game_over: { final_scores: ScoreEntry[]; winner_ids: string[]; closes_at: string };
  invalid_bid_error: { reason: string; allowed_bids: number[] };
  invalid_trump_error: { reason: string };
  invalid_play_error: { reason: string; legal_cards: Card[] };
  state_snapshot: { game_state: GameStateView; seq: number };
  session_error: { code: string; message: string; fatal: boolean };
  lobby_snapshot: unknown;
  room_snapshot: unknown;
};

function newKey(): string | undefined {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : undefined;
}

/**
 * Live game state from socket events (players and spectators). Reset when the server puts the
 * socket back in the lobby or an open room.
 */
export function GameProvider({ children }: { children: ReactNode }) {
  const { socket } = useRealtime();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const [game, dispatch] = useReducer(reducer, null);

  useEffect(() => {
    if (!socket) return;
    const handlers: [string, (envelope: Envelope<never>) => void][] = [];
    const on = <E extends keyof Payloads>(event: E, handle: (payload: Payloads[E], seq: number) => void) => {
      const h = (envelope: Envelope<Payloads[E]>) => handle(envelope.payload, envelope.seq);
      socket.on(event as string, h);
      handlers.push([event as string, h as (envelope: Envelope<never>) => void]);
    };

    on('game_started', (p, seq) =>
      dispatch({ type: 'game_started', seq, userId, gameId: p.game_id, roomId: p.room_id, roundCount: p.round_count, bidRule: p.bid_rule, players: p.players }),
    );
    on('round_started', (p, seq) =>
      dispatch({ type: 'round_started', seq, roundNumber: p.round_number, dealerId: p.dealer_id, trumpSuit: p.trump_suit, trumpCard: p.trump_card }),
    );
    on('hand_dealt', (p, seq) => dispatch({ type: 'hand_dealt', seq, hand: p.hand, roundNumber: p.round_number }));
    on('trump_revealed', (p, seq) =>
      dispatch({ type: 'trump_revealed', seq, trumpSuit: p.trump_suit, trumpCard: p.trump_card, trumpSource: p.trump_source }),
    );
    on('trump_selection_request', (_p, seq) => dispatch({ type: 'trump_selection_request', seq }));
    on('bid_request', (p, seq) => dispatch({ type: 'bid_request', seq, allowedBids: p.allowed_bids }));
    on('bid_placed', (p, seq) => dispatch({ type: 'bid_placed', seq, userId, playerId: p.player_id, bid: p.bid }));
    on('all_bids_placed', (p, seq) => dispatch({ type: 'all_bids_placed', seq, bids: p.bids }));
    on('play_request', (p, seq) => dispatch({ type: 'play_request', seq, trickNumber: p.trick_number, legalCards: p.legal_cards }));
    on('card_played', (p, seq) =>
      dispatch({ type: 'card_played', seq, userId, playerId: p.player_id, card: p.card, trickNumber: p.trick_number }),
    );
    on('trick_complete', (p, seq) =>
      dispatch({ type: 'trick_complete', seq, winnerId: p.winner_id, cards: p.cards_played, trickNumber: p.trick_number }),
    );
    on('round_complete', (p, seq) =>
      dispatch({ type: 'round_complete', seq, roundNumber: p.round_number, scores: p.scores_this_round, totals: p.cumulative_scores }),
    );
    on('game_over', (p, seq) =>
      dispatch({ type: 'game_over', seq, finalScores: p.final_scores, winnerIds: p.winner_ids, closesAt: p.closes_at }),
    );
    on('invalid_bid_error', (p, seq) => dispatch({ type: 'error', seq, reason: p.reason, allowedBids: p.allowed_bids }));
    on('invalid_trump_error', (p, seq) => dispatch({ type: 'error', seq, reason: p.reason }));
    on('invalid_play_error', (p, seq) => dispatch({ type: 'error', seq, reason: p.reason, legalCards: p.legal_cards }));
    on('session_error', (p, seq) => {
      if (!p.fatal) dispatch({ type: 'error', seq, reason: p.message });
    });
    on('state_snapshot', (p) => dispatch({ type: 'state_snapshot', seq: p.seq, view: p.game_state }));
    on('lobby_snapshot', () => dispatch({ type: 'reset' }));
    on('room_snapshot', () => dispatch({ type: 'reset' }));

    return () => {
      for (const [event, h] of handlers) socket.off(event, h);
      dispatch({ type: 'reset' });
    };
  }, [socket, userId]);

  const send = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      socket?.emit(event, {
        event,
        seq: 0,
        timestamp: new Date().toISOString(),
        payload: { player_id: userId, ...payload, idempotency_key: newKey() },
      });
    },
    [socket, userId],
  );

  const dismissSummary = useCallback(() => dispatch({ type: 'dismiss_summary' }), []);
  const value: GameValue = {
    game,
    selectTrump: (suit) => {
      dispatch({ type: 'clear_error' });
      send('select_trump', { suit });
    },
    placeBid: (bid) => {
      dispatch({ type: 'clear_error' });
      send('place_bid', { bid });
    },
    playCard: (card) => {
      dispatch({ type: 'clear_error' });
      send('play_card', { card });
    },
    dismissSummary,
    clearError: () => dispatch({ type: 'clear_error' }),
  };
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside GameProvider');
  return ctx;
}
