/**
 * The avatar option catalog (docs/architecture/avatar-system.md, "Option catalog").
 *
 * Shared by the server (validation, migration backfill, first admin) and the client (picker,
 * rendering): the client imports this file directly, so it must stay pure TypeScript with no
 * imports and no Node or DOM APIs.
 *
 * Adding options is safe. Removing or renaming a slug needs a migration that rewrites stored
 * configs, because the server rejects unknown slugs.
 */

export const AVATAR_KEYS = ['head', 'skin', 'face', 'hair'] as const;
export type AvatarKey = (typeof AVATAR_KEYS)[number];

/** One slug per key, each from that key's catalog. Stored in users.avatar_config. */
export interface AvatarConfig {
  head: string;
  skin: string;
  face: string;
  hair: string;
}

const slugs = (key: AvatarKey, count: number): readonly string[] =>
  Array.from({ length: count }, (_, i) => `${key}-${String(i + 1).padStart(2, '0')}`);

/** Valid slugs per key, in display order. */
export const AVATAR_OPTIONS: Readonly<Record<AvatarKey, readonly string[]>> = {
  head: slugs('head', 4),
  skin: slugs('skin', 6),
  face: slugs('face', 6),
  hair: slugs('hair', 8),
};

/** Fill colour of the head layer for each skin slug. */
export const SKIN_COLOURS: Readonly<Record<string, string>> = {
  'skin-01': '#f7dcc8',
  'skin-02': '#ecc19c',
  'skin-03': '#d6a077',
  'skin-04': '#b47c52',
  'skin-05': '#93613f',
  'skin-06': '#6e4630',
};

/** Hair colour is fixed in v1: every hairstyle is filled with this. */
export const HAIR_COLOUR = '#1f1712';

/** Drawn, layer by layer, in place of any slug the client does not know. */
export const DEFAULT_AVATAR: Readonly<AvatarConfig> = {
  head: 'head-01',
  skin: 'skin-01',
  face: 'face-01',
  hair: 'hair-01',
};

export const isAvatarSlug = (key: AvatarKey, value: unknown): value is string =>
  typeof value === 'string' && AVATAR_OPTIONS[key].includes(value);

/**
 * Why `value` is not a valid avatarConfig, or null if it is: an object with exactly the four
 * keys, each a slug from that key's catalog (a valid slug under the wrong key is rejected).
 */
export function avatarConfigError(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Must be an object with head, skin, face and hair.';
  }
  const obj = value as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => !(AVATAR_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) return `Unknown key: ${extra.join(', ')}. Use exactly head, skin, face and hair.`;
  const bad = AVATAR_KEYS.filter((k) => !isAvatarSlug(k, obj[k]));
  if (bad.length > 0) return `Not a valid option: ${bad.join(', ')}.`;
  return null;
}

/** A uniformly random valid config. `random` returns a number in [0, 1), like Math.random. */
export function randomAvatarConfig(random: () => number = Math.random): AvatarConfig {
  const pick = (key: AvatarKey) => {
    const options = AVATAR_OPTIONS[key];
    return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
  };
  return { head: pick('head'), skin: pick('skin'), face: pick('face'), hair: pick('hair') };
}
