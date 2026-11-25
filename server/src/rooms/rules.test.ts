import { clampConfig, configFromStored, configToStored, defaultConfig, joinRejection, maxRounds } from './rules';

describe('maxRounds', () => {
  it.each([
    [1, 60],
    [2, 30],
    [3, 20],
    [4, 15],
    [5, 12],
    [6, 10],
    [7, 8],
    [8, 7],
    [9, 6],
    [10, 6],
  ])('%i players → %i rounds', (players, rounds) => {
    expect(maxRounds(players)).toBe(rounds);
  });
});

describe('clampConfig', () => {
  it('lowers roundCount to the new maximum', () => {
    expect(clampConfig(defaultConfig(1), 3).roundCount).toBe(20);
  });
  it('returns the same object when roundCount still fits', () => {
    const config = { ...defaultConfig(1), roundCount: 5 };
    expect(clampConfig(config, 10)).toBe(config);
  });
});

describe('joinRejection', () => {
  const none = { players: 1, spectators: 0 };
  it('lets players and spectators into an open room with space', () => {
    expect(joinRejection('open', 'player', none)).toBeNull();
    expect(joinRejection('open', 'spectator', none)).toBeNull();
  });
  it('enforces 10 players and 5 spectators', () => {
    expect(joinRejection('open', 'player', { players: 10, spectators: 0 })).toBe('ROOM_FULL');
    expect(joinRejection('open', 'spectator', { players: 1, spectators: 5 })).toBe('ROOM_FULL');
    expect(joinRejection('in_progress', 'spectator', { players: 3, spectators: 5 })).toBe('ROOM_FULL');
  });
  it('allows only spectators once the game is in progress', () => {
    expect(joinRejection('in_progress', 'player', none)).toBe('ROOM_NOT_JOINABLE');
    expect(joinRejection('in_progress', 'spectator', none)).toBeNull();
  });
  it.each(['completing', 'closed'] as const)('rejects everyone from a %s room', (state) => {
    expect(joinRejection(state, 'player', none)).toBe('ROOM_NOT_JOINABLE');
    expect(joinRejection(state, 'spectator', none)).toBe('ROOM_NOT_JOINABLE');
  });
});

describe('stored config', () => {
  it('round-trips through the snake_case JSONB shape', () => {
    const config = { roundCount: 7, bidRule: 'uneven' as const, deckType: 'standard' as const };
    expect(configToStored(config)).toEqual({ round_count: 7, bid_rule: 'uneven', deck_type: 'standard' });
    expect(configFromStored(configToStored(config), 3)).toEqual(config);
  });
  it('falls back to defaults for missing keys', () => {
    expect(configFromStored({}, 4)).toEqual({ roundCount: 15, bidRule: 'open', deckType: 'standard' });
  });
});
