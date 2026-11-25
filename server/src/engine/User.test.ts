import { BotPlayer } from './BotPlayer';
import { Card } from './Card';
import { NotImplementedError } from './errors';
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
