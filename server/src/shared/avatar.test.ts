import {
  AVATAR_KEYS,
  AVATAR_OPTIONS,
  DEFAULT_AVATAR,
  HAIR_COLOUR,
  SKIN_COLOURS,
  avatarConfigError,
  isAvatarSlug,
  randomAvatarConfig,
} from './avatar';

const valid = { head: 'head-02', skin: 'skin-04', face: 'face-01', hair: 'hair-07' };

describe('avatar catalog', () => {
  it('has the option counts and slug format from avatar-system.md', () => {
    expect(AVATAR_OPTIONS.head).toHaveLength(4);
    expect(AVATAR_OPTIONS.skin).toHaveLength(6);
    expect(AVATAR_OPTIONS.face).toHaveLength(6);
    expect(AVATAR_OPTIONS.hair).toHaveLength(8);
    for (const key of AVATAR_KEYS) {
      for (const slug of AVATAR_OPTIONS[key]) expect(slug).toMatch(new RegExp(`^${key}-\\d{2}$`));
    }
    expect(AVATAR_OPTIONS.hair[7]).toBe('hair-08');
  });

  it('defines a hex colour for every skin slug, and the fixed hair colour', () => {
    expect(Object.keys(SKIN_COLOURS).sort()).toEqual([...AVATAR_OPTIONS.skin]);
    for (const hex of [...Object.values(SKIN_COLOURS), HAIR_COLOUR]) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('has a valid default', () => {
    expect(avatarConfigError(DEFAULT_AVATAR)).toBeNull();
  });
});

describe('avatarConfigError', () => {
  it('accepts a valid config', () => {
    expect(avatarConfigError(valid)).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', [valid]],
    ['a string', 'head-01'],
    ['a missing key', { head: 'head-01', skin: 'skin-01', face: 'face-01' }],
    ['an extra key', { ...valid, hat: 'hat-01' }],
    ['a valid slug under the wrong key', { ...valid, head: 'hair-01' }],
    ['a path', { ...valid, face: '../x' }],
    ['markup', { ...valid, hair: '<svg>' }],
    ['an old placeholder slug', { ...valid, head: 'Round' }],
    ['an out-of-range slug', { ...valid, head: 'head-05' }],
    ['a number', { ...valid, skin: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(avatarConfigError(value)).not.toBeNull();
  });

  it('does not treat inherited properties as slugs', () => {
    expect(isAvatarSlug('head', 'constructor')).toBe(false);
  });
});

describe('randomAvatarConfig', () => {
  it('always returns a valid config, at both ends of the random range', () => {
    expect(randomAvatarConfig(() => 0)).toEqual(DEFAULT_AVATAR);
    expect(randomAvatarConfig(() => 0.999999)).toEqual({ head: 'head-04', skin: 'skin-06', face: 'face-06', hair: 'hair-08' });
    for (let i = 0; i < 50; i++) expect(avatarConfigError(randomAvatarConfig())).toBeNull();
  });
});
