import { createContext, useCallback, useContext, useEffect, useReducer, type ReactNode } from 'react';
import type { BidEntry, BidRule, Card, GameStateView, PlayerSummary, Suit, TrumpSource } from '../api/types';
import type { Envelope } from '../socket/client';
import { useAuth } from './AuthContext';
import { useRealtime } from './SocketContext';

export interface SeatView {
  userId: string;
  displayName: string;
  seatIndex: number;
  bid: number | null;
  handCount: number;
}

/** Where the round is, as the client renders it. */
export type RoundStage =
  /** Dealt; trump not settled yet (a Wizard was flipped and the dealer is choosing). */
  | 'choosing_trump'
  | 'bidding'
  /** Every bid is in; trick play is next. */
  | 'bids_complete'
  | 'waiting';

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
  | { type: 'error'; seq: number; reason: string; allowedBids?: number[] }
  | { type: 'state_snapshot'; seq: number; view: GameStateView }
  | { type: 'clear_error' };

function snapshotState(view: GameStateView, seq: number): GameView {
  const me = view.players.find((p) => p.userId === view.viewerUserId);
  const stage: RoundStage =
    view.phase === 'trump_declaration'
      ? 'choosing_trump'
      : view.phase === 'bidding'
        ? 'bidding'
        : view.phase === 'trick'
          ? 'bids_complete'
          : 'waiting';
  return {
    gameId: view.gameId,
    roomId: view.roomId,
    roundCount: view.config.roundCount,
    bidRule: view.config.bidRule,
    seats: [...view.players]
      .sort((a, b) => a.seatOrder - b.seatOrder)
      .map((p) => ({ userId: p.userId, displayName: p.displayName, seatIndex: p.seatOrder - 1, bid: p.bid, handCount: p.handCount })),
    isSpectator: view.viewerUserId === null,
    roundNumber: view.currentRound,
    dealerId: view.dealerUserId,
    trumpCard: view.trumpCard,
    trumpSuit: view.trumpSuit,
    trumpSource: view.trumpSource,
    stage,
    hand: me?.hand ?? null,
    // A pending bid_request or trump_selection_request follows the snapshot.
    bidRequest: null,
    trumpRequest: false,
    error: null,
    seq,
  };
}

function reducer(state: State, action: Action): State {
  if (action.type === 'reset') return null;
  if (action.type === 'game_started') {
    return {
      gameId: action.gameId,
      roomId: action.roomId,
      roundCount: action.roundCount,
      bidRule: action.bidRule,
      seats: action.players.map((p) => ({ userId: p.user_id, displayName: p.display_name, seatIndex: p.seat_index, bid: null, handCount: 0 })),
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
      error: null,
      seq: action.seq,
    };
  }
  if (action.type === 'state_snapshot') return snapshotState(action.view, action.seq);
  if (!state) return state;
  if (action.type === 'clear_error') return { ...state, error: null };

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
        seats: next.seats.map((s) => ({ ...s, bid: null, handCount: action.roundNumber })),
        hand: next.isSpectator ? null : [],
        bidRequest: null,
        trumpRequest: false,
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
      return { ...next, stage: 'bids_complete', bidRequest: null, seats: next.seats.map((s) => ({ ...s, bid: bids.get(s.userId) ?? s.bid })) };
    }
    case 'error':
      return {
        ...next,
        error: action.reason,
        bidRequest: next.bidRequest && action.allowedBids?.length ? { allowedBids: action.allowedBids } : next.bidRequest,
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

interface GameValue {
  game: GameView | null;
  selectTrump(suit: Suit): void;
  placeBid(bid: number): void;
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
  invalid_bid_error: { reason: string; allowed_bids: number[] };
  invalid_trump_error: { reason: string };
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
    on('invalid_bid_error', (p, seq) => dispatch({ type: 'error', seq, reason: p.reason, allowedBids: p.allowed_bids }));
    on('invalid_trump_error', (p, seq) => dispatch({ type: 'error', seq, reason: p.reason }));
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
    clearError: () => dispatch({ type: 'clear_error' }),
  };
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside GameProvider');
  return ctx;
}
