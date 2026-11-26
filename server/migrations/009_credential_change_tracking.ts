import type { Knex } from 'knex';

/**
 * Records when the user last chose each secret themselves, so PATCH /users/me can clear
 * requires_credential_change only once BOTH the password and the recovery passphrase have been
 * changed since an admin reset (docs/architecture/data-model.md, users).
 *
 * - password_changed_at: set by PATCH /users/me (password) and POST /auth/reset-password.
 * - recovery_changed_at: set by PATCH /users/me (recoveryPassphrase).
 *
 * An admin credential reset sets both back to NULL along with the flag. Existing rows start NULL,
 * so an account that is already flagged still has to change both.
 *
 * Also records why a session ended (sessions.invalidated_reason: the InvalidationReason in
 * server/src/auth/sessionEvents.ts), so a REST 401 SESSION_INVALIDATED can say why, as the
 * socket session_error already does. NULL for rows ended before this migration.
 *
 * Numbered 009 because 008 is taken by the Phase 6c branch (game_events connection types).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.timestamp('password_changed_at', { useTz: true }).nullable();
    t.timestamp('recovery_changed_at', { useTz: true }).nullable();
  });
  await knex.schema.alterTable('sessions', (t) => {
    t.string('invalidated_reason', 32).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sessions', (t) => {
    t.dropColumn('invalidated_reason');
  });
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('recovery_changed_at');
    t.dropColumn('password_changed_at');
  });
}
