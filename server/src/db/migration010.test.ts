import { avatarBackfill } from '../../migrations/010_avatar_config_required';
import { avatarConfigError } from '../shared/avatar';

const valid = { head: 'head-02', skin: 'skin-04', face: 'face-01', hair: 'hair-07' };

describe('avatarBackfill (migration 010)', () => {
  it('keeps valid configs and replaces null, placeholder and malformed ones', () => {
    const rows = [
      { id: 'ok', avatar_config: valid },
      { id: 'null', avatar_config: null },
      { id: 'placeholder', avatar_config: { head: 'round', skin: 'medium', face: 'smile-01', hair: 'curly-short-brown' } },
      { id: 'partial', avatar_config: { head: 'head-01' } },
      { id: 'wrong-key', avatar_config: { ...valid, head: 'hair-01' } },
      { id: 'extra-key', avatar_config: { ...valid, hat: 'hat-01' } },
      { id: 'string', avatar_config: 'head-01' },
    ];
    const out = avatarBackfill(rows);
    expect(out.map((r) => r.id)).toEqual(['null', 'placeholder', 'partial', 'wrong-key', 'extra-key', 'string']);
    for (const r of out) expect(avatarConfigError(r.avatar_config)).toBeNull();
  });

  it('draws a fresh config per user', () => {
    // Four draws per config: the first user gets all zeros, the second all 0.99s.
    let n = 0;
    const random = () => (n++ < 4 ? 0 : 0.99);
    const out = avatarBackfill(
      [
        { id: 'a', avatar_config: null },
        { id: 'b', avatar_config: null },
      ],
      random,
    );
    expect(out[0].avatar_config).not.toEqual(out[1].avatar_config);
  });

  it('returns nothing when every config is valid', () => {
    expect(avatarBackfill([{ id: 'ok', avatar_config: valid }])).toEqual([]);
  });
});
