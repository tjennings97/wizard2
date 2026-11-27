import { db } from '../db/knex';
import type { AvatarConfig } from '../shared/avatar';

export type { AvatarConfig };

/** A row of the users table. password_hash and recovery_hash must never leave the server. */
export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  recovery_hash: string;
  role: 'player' | 'admin';
  avatar_config: AvatarConfig;
  requires_credential_change: boolean;
  /** When the user last chose their password / passphrase; NULL after an admin reset. */
  password_changed_at: Date | null;
  recovery_changed_at: Date | null;
  created_at: Date;
}

/** The `User` schema from docs/api/openapi-spec.md. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: 'player' | 'admin';
  avatarConfig: AvatarConfig;
  createdAt: string;
  requiresCredentialChange: boolean;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarConfig: row.avatar_config,
    createdAt: new Date(row.created_at).toISOString(),
    requiresCredentialChange: row.requires_credential_change,
  };
}

/** The fields other users see. Null if the user no longer exists. */
export async function getUserProfile(userId: string): Promise<{ displayName: string; avatarConfig: AvatarConfig } | null> {
  const row: Pick<UserRow, 'display_name' | 'avatar_config'> | undefined = await db('users')
    .where({ id: userId })
    .first('display_name', 'avatar_config');
  return row ? { displayName: row.display_name, avatarConfig: row.avatar_config } : null;
}
