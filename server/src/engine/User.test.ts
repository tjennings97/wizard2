import { BotPlayer } from './BotPlayer';
import { Card } from './Card';
import { EngineError, NotImplementedError } from './errors';
import { Player } from './Player';
import { Spectator } from './Spectator';
import { User, UserProps } from './User';

const props = (id: string): UserProps => ({
  id,
  username: `user_${id}`,
  displayName: `User ${id}`,
  avatarConfig: { head: 'round', skin: 'tone-2', face: 'smile', hair: 'short' },
  sessionId: `sess_${id}`,
});

describe('User hierarchy', () => {
  it('Player, Spectator, and BotPlayer are Users', () => {
    expect(new Player(props('p'))).toBeInstanceOf(User);
    expect(new Spectator(props('s'))).toBeInstanceOf(User);
    const bot = new BotPlayer(props('b'));
    expect(bot).toBeInstanceOf(Player);
    expect(bot).toBeInstanceOf(User);
  });

  it('User carries identity fields', () => {
    const u = new User(props('u'));
    expect(u).toMatchObject({ id: 'u', username: 'user_u', displayName: 'User u', sessionId: 'sess_u' });
    expect(u.avatarConfig).toEqual({ head: 'round', skin: 'tone-2', face: 'smile', hair: 'short' });
  });

  it('Spectator exposes no hand or action methods', () => {
    const s = new Spectator(props('s')) as unknown as Record<string, unknown>;
    expect(s.hand).toBeUndefined();
    expect(s.placeBid).toBeUndefined();
    expect(s.playCard).toBeUndefined();
  });
});

describe('Player', () => {
  const hand = [Card.suited('hearts', 10), Card.wizard(), Card.jester()];

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

  it('placeBid validates range against hand size and locks the bid', () => {
    const p = new Player(props('p'));
    p.receiveHand(hand);
    expect(() => p.placeBid(4)).toThrow(EngineError);
    expect(() => p.placeBid(-1)).toThrow(EngineError);
    p.placeBid(3);
    expect(p.bid).toBe(3);
    expect(() => p.placeBid(1)).toThrow(expect.objectContaining({ code: 'ALREADY_BID' }));
  });

  it('playCard removes exactly one matching card from hand', () => {
    const p = new Player(props('p'));
    p.receiveHand([Card.wizard(), Card.wizard(), Card.suited('clubs', 2)]);
    const played = p.playCard({ suit: null, rank: null, type: 'wizard' });
    expect(played.isWizard).toBe(true);
    expect(p.hand).toHaveLength(2);
    expect(p.hasCard(Card.wizard())).toBe(true);
  });

  it('playCard rejects a card not in hand', () => {
    const p = new Player(props('p'));
    p.receiveHand(hand);
    expect(() => p.playCard(Card.suited('spades', 14))).toThrow(
      expect.objectContaining({ code: 'CARD_NOT_IN_HAND' }),
    );
  });

  it('accumulates score, including below zero', () => {
    const p = new Player(props('p'));
    p.addScore(30);
    p.addScore(-50);
    expect(p.score).toBe(-20);
  });
});

describe('BotPlayer', () => {
  it('is flagged as a bot and its actions throw NotImplementedError', () => {
    const bot = new BotPlayer(props('b'));
    bot.receiveHand([Card.jester()]);
    expect(bot.isBot).toBe(true);
    expect(() => bot.placeBid(0)).toThrow(NotImplementedError);
    expect(() => bot.playCard(Card.jester())).toThrow(NotImplementedError);
  });
});
