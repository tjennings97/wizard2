import type { Knex } from 'knex';
import { avatarBackfill } from '../src/db/avatarBackfill';

/**
 * Avatars are built from catalog slugs only (docs/architecture/avatar-system.md; decided in
 * docs/development/auth-follow-ups.md §8). The server no longer stores client SVG.
 *
 * 1. Drops users.avatar_svg.
 * 2. Gives every user whose avatar_config is null, or is not exactly { head, skin, face, hair }
 *    with each a slug from the catalog in src/shared/avatar.ts, a random valid config.
 * 3. Makes avatar_config NOT NULL.
 *
 * down() re-adds avatar_svg (empty) and makes avatar_config nullable again. The backfilled
 * configs stay: the old placeholder values they replaced are not kept.
 *
 * Follows 009_credential_change_tracking.ts.
 */

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
