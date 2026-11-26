import { Card, Deck, Game, Player } from '../engine';
import { bidRequestPayload, bidsSoFar, gameStartedPayload, handDealtPayload, invalidBidPayload, roundStartedPayload } from './payloads';

const player = (id: string) => new Player({ id, username: id, displayName: id.toUpperCase(), avatarConfig: null, sessionId: null });

function game(bidRule: 'open' | 'uneven' = 'open'): Game {
  const top = [Card.suited('hearts', 5), Card.suited('spades', 9), Card.wizard(), Card.suited('clubs', 12)];
  const rest = new Deck().peekAll().filter((c) => !top.some((t) => t.equals(c)));
  return new Game({
    gameId: 'g1',
    roomId: 'r1',
    players: ['a', 'b', 'c'].map(player),
    config: { roundCount: 3, bidRule },
    deckFactory: () => Deck.fromCards([...top, ...rest]),
  });
}

describe('game payloads', () => {
  it('game_started lists players in seat order with 0-based seats', () => {
    expect(gameStartedPayload(game())).toEqual({
      game_id: 'g1',
      room_id: 'r1',
      round_count: 3,
      bid_rule: 'open',
      players: [
        { user_id: 'a', display_name: 'A', seat_index: 0 },
        { user_id: 'b', display_name: 'B', seat_index: 1 },
        { user_id: 'c', display_name: 'C', seat_index: 2 },
      ],
    });
  });

  it('round_started carries the dealer and flipped card; hand_dealt only the addressed hand', () => {
    const g = game();
    const started = g.startRound();
    expect(roundStartedPayload(started)).toEqual({
      round_number: 1,
      dealer_id: 'a',
      trump_suit: 'clubs',
      trump_card: { suit: 'clubs', rank: 12, type: 'suited' },
    });
    expect(handDealtPayload(g, 'b')).toEqual({ hand: [{ suit: 'hearts', rank: 5, type: 'suited' }], round_number: 1 });
  });

  it('bid_request lists bids so far in bidding order and the allowed bids', () => {
    const g = game('uneven');
    g.startRound();
    g.placeBid('b', 1);
    expect(bidsSoFar(g)).toEqual([{ player_id: 'b', bid: 1 }]);
    g.placeBid('c', 0);
    // Uneven, but round 1 is exempt: the dealer may bring the total to 1.
    expect(bidRequestPayload(g, 'a')).toEqual({
      player_id: 'a',
      round_number: 1,
      bids_so_far: [
        { player_id: 'b', bid: 1 },
        { player_id: 'c', bid: 0 },
      ],
      hand_size: 1,
      allowed_bids: [0, 1],
    });
  });

  it('invalid_bid_error gives the bid range, and no allowed bids when it is not your turn', () => {
    const g = game();
    expect(invalidBidPayload(g, 'b', 'INVALID_PHASE', 'x')).toEqual({
      player_id: 'b',
      code: 'INVALID_PHASE',
      reason: 'x',
      min_bid: 0,
      max_bid: 0,
      allowed_bids: [],
    });
    g.startRound();
    expect(invalidBidPayload(g, 'c', 'NOT_YOUR_TURN', 'x')).toMatchObject({ max_bid: 1, allowed_bids: [] });
    expect(invalidBidPayload(g, 'b', 'INVALID_BID', 'x')).toMatchObject({ allowed_bids: [0, 1] });
  });
});
