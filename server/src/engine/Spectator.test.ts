import { Player } from './Player';
import { Spectator } from './Spectator';
import { User, UserProps } from './User';

const props = (id: string): UserProps => ({
  id,
  username: `user_${id}`,
  displayName: `User ${id}`,
  avatarConfig: null,
  sessionId: `sess_${id}`,
});

describe('Spectator', () => {
  it('is a User but not a Player', () => {
    const s = new Spectator(props('s'));
    expect(s).toBeInstanceOf(User);
    expect(s).not.toBeInstanceOf(Player);
  });

  it('is flagged as a spectator', () => {
    expect(new Spectator(props('s')).isSpectator).toBe(true);
  });

  it('exposes no hand or action methods', () => {
    const s = new Spectator(props('s')) as unknown as Record<string, unknown>;
    expect(s.hand).toBeUndefined();
    expect(s.placeBid).toBeUndefined();
    expect(s.playCard).toBeUndefined();
  });
});
