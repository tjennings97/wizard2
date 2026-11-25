import { Card } from './Card';
import { EngineError } from './errors';
import { Player } from './Player';
import { UserProps } from './User';

const props = (id: string): UserProps => ({
  id,
  username: `user_${id}`,
  displayName: `User ${id}`,
  avatarConfig: null,
  sessionId: `sess_${id}`,
});

describe('Player', () => {
  const hand = [Card.suited('hearts', 10), Card.wizard(), Card.jester()];

  it('starts empty, human, and connected', () => {
    const p = new Player(props('p'));
    expect(p.isBot).toBe(false);
    expect(p.connected).toBe(true);
    expect(p.hand).toEqual([]);
    expect(p.bid).toBeNull();
    expect(p.tricksWon).toBe(0);
    expect(p.score).toBe(0);
  });

  it('receives a hand and resets round state', () => {
    const p = new Player(props('p'));
    p.receiveHand(hand);
    p.placeBid(2);
    p.addTrickWon();
    p.receiveHand(hand);
    expect(p.hand).toHaveLength(3);
    expect(p.bid).toBeNull();
    expect(p.tricksWon).toBe(0);
  });

  it('keeps its own copy of the dealt hand', () => {
    const p = new Player(props('p'));
    const cards = [Card.wizard()];
    p.receiveHand(cards);
    cards.push(Card.jester());
    expect(p.hand).toHaveLength(1);
  });

  // A voided round is re-dealt with receiveHand; cumulative score must carry over.
  it('keeps its score across receiveHand and clearRound', () => {
    const p = new Player(props('p'));
    p.addScore(40);
    p.receiveHand(hand);
    expect(p.score).toBe(40);
    p.clearRound();
    expect(p.score).toBe(40);
  });

  it('clearRound empties the hand and resets bid and tricks won', () => {
    const p = new Player(props('p'));
    p.receiveHand(hand);
    p.placeBid(1);
    p.addTrickWon();
    p.clearRound();
    expect(p.hand).toEqual([]);
    expect(p.bid).toBeNull();
    expect(p.tricksWon).toBe(0);
  });

  it('placeBid validates range against hand size and locks the bid', () => {
    const p = new Player(props('p'));
    p.receiveHand(hand);
    expect(() => p.placeBid(4)).toThrow(EngineError);
    expect(() => p.placeBid(-1)).toThrow(EngineError);
    p.placeBid(3);
    expect(p.bid).toBe(3);
    expect(() => p.placeBid(1)).toThrow(expect.objectContaining({ code: 'ALREADY_BID' }));
  });

  it('placeBid rejects non-integer bids without recording them', () => {
    const p = new Player(props('p'));
    p.receiveHand(hand);
    for (const bad of [1.5, NaN, Infinity]) {
      expect(() => p.placeBid(bad)).toThrow(expect.objectContaining({ code: 'INVALID_BID' }));
    }
    expect(p.bid).toBeNull();
  });

  it('playCard removes exactly one matching card from hand', () => {
    const p = new Player(props('p'));
    p.receiveHand([Card.wizard(), Card.wizard(), Card.suited('clubs', 2)]);
    const played = p.playCard({ suit: null, rank: null, type: 'wizard' });
    expect(played.isWizard).toBe(true);
    expect(p.hand).toHaveLength(2);
    expect(p.hasCard(Card.wizard())).toBe(true);
  });

  it('hasCard is false for cards not held, including after the last copy is played', () => {
    const p = new Player(props('p'));
    p.receiveHand(hand);
    expect(p.hasCard(Card.suited('spades', 14))).toBe(false);
    p.playCard(Card.jester());
    expect(p.hasCard(Card.jester())).toBe(false);
  });

  it('playCard rejects a card not in hand', () => {
    const p = new Player(props('p'));
    p.receiveHand(hand);
    expect(() => p.playCard(Card.suited('spades', 14))).toThrow(
      expect.objectContaining({ code: 'CARD_NOT_IN_HAND' }),
    );
  });

  it('counts tricks won', () => {
    const p = new Player(props('p'));
    p.addTrickWon();
    p.addTrickWon();
    expect(p.tricksWon).toBe(2);
  });

  it('accumulates score, including below zero', () => {
    const p = new Player(props('p'));
    p.addScore(30);
    p.addScore(-50);
    expect(p.score).toBe(-20);
  });
});
