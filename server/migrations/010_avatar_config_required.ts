import type { Knex } from 'knex';

/**
 * Avatars are built from catalog slugs only (docs/architecture/avatar-system.md; decided in
 * docs/development/auth-follow-ups.md §8). The server no longer stores client SVG.
 *
 * 1. Drops users.avatar_svg.
 * 2. Gives every user whose avatar_config is null, or is not exactly { head, skin, face, hair }
 *    with each a slug from the catalog below, a random valid config.
 * 3. Makes avatar_config NOT NULL.
 *
 * Self-contained like every migration: the catalog below is a frozen copy of the one in
 * src/shared/avatar.ts as of this migration, so later catalog changes cannot change what this
 * migration does. A later rename or removal of slugs needs its own migration.
 *
 * down() re-adds avatar_svg (empty) and makes avatar_config nullable again. The backfilled
 * configs stay: the old placeholder values they replaced are not kept.
 *
 * Follows 009_credential_change_tracking.ts.
 */

type Key = 'head' | 'skin' | 'face' | 'hair';
type Config = Record<Key, string>;

const KEYS: readonly Key[] = ['head', 'skin', 'face', 'hair'];
const COUNTS: Readonly<Record<Key, number>> = { head: 4, skin: 6, face: 6, hair: 8 };
const slugs = (key: Key) => Array.from({ length: COUNTS[key] }, (_, i) => `${key}-${String(i + 1).padStart(2, '0')}`);
const CATALOG: Readonly<Record<Key, readonly string[]>> = {
  head: slugs('head'),
  skin: slugs('skin'),
  face: slugs('face'),
  hair: slugs('hair'),
};

function isValidConfig(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  return (
    keys.length === KEYS.length &&
    KEYS.every((k) => typeof obj[k] === 'string' && CATALOG[k].includes(obj[k] as string))
  );
}

function randomConfig(random: () => number): Config {
  const pick = (k: Key) => CATALOG[k][Math.min(CATALOG[k].length - 1, Math.floor(random() * CATALOG[k].length))];
  return { head: pick('head'), skin: pick('skin'), face: pick('face'), hair: pick('hair') };
}

/** The users whose stored config must be replaced, each with a new random valid config. */
export function avatarBackfill(
  rows: { id: string; avatar_config: unknown }[],
  random: () => number = Math.random,
): { id: string; avatar_config: Config }[] {
  return rows.filter((r) => !isValidConfig(r.avatar_config)).map((r) => ({ id: r.id, avatar_config: randomConfig(random) }));
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('avatar_svg');
  });

  const rows: { id: string; avatar_config: unknown }[] = await knex('users').select('id', 'avatar_config').forUpdate();
  for (const { id, avatar_config } of avatarBackfill(rows)) {
    await knex('users').where({ id }).update({ avatar_config: JSON.stringify(avatar_config) });
  }

  await knex.schema.alterTable('users', (t) => {
    t.jsonb('avatar_config').notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.jsonb('avatar_config').nullable().alter();
    t.text('avatar_svg').nullable();
  });
}
