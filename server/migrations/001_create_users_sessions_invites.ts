import type { Knex } from 'knex';

/**
 * Identity & access: users, sessions, invites.
 * See docs/architecture/data-model.md.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('username', 32).notNullable().unique({ indexName: 'users_username_idx' });
    t.string('display_name', 64).notNullable();
    t.string('password_hash', 255).notNullable();
    t.string('recovery_hash', 255).notNullable();
    t.string('role', 16)
      .notNullable()
      .defaultTo('player')
      .checkIn(['player', 'admin'], 'users_role_check');
    // Avatar part selections, e.g. {"head","skin","face","hair"} slugs. Null = no avatar set.
    t.jsonb('avatar_config').nullable();
    // Cached composited SVG. Null until avatar is first set.
    t.text('avatar_svg').nullable();
    // Set by admin credential reset; client forces change-password flow on next login.
    t.boolean('requires_credential_change').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // One active session per user is enforced at the application layer (a new login sets
  // invalidated_at on any prior session). Intentionally NO unique constraint on user_id —
  // invalidated/expired rows are retained.
  await knex.schema.createTable('sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users');
    // SHA-256 of the session token. Raw token lives only in the HTTP-only cookie.
    t.string('token_hash', 255).notNullable().unique({ indexName: 'sessions_token_hash_idx' });
    t.uuid('trace_id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('invalidated_at', { useTz: true }).nullable();

    t.index(['user_id'], 'sessions_user_id_idx');
  });

  await knex.schema.createTable('invites', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // SHA-256 of the invite code. Raw code shown to admin once only.
    t.string('code_hash', 255).notNullable().unique({ indexName: 'invites_code_hash_idx' });
    t.string('label', 128).nullable();
    t.uuid('created_by').notNullable().references('id').inTable('users');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('redeemed_at', { useTz: true }).nullable();
    t.uuid('redeemed_by').nullable().references('id').inTable('users');
    t.string('status', 16)
      .notNullable()
      .defaultTo('pending')
      .checkIn(['pending', 'accepted', 'expired', 'revoked'], 'invites_status_check');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('invites');
  await knex.schema.dropTable('sessions');
  await knex.schema.dropTable('users');
}
