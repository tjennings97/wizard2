export interface AvatarConfig {
  head: string;
  skin: string;
  face: string;
  hair: string;
}

/** A row of the users table. password_hash and recovery_hash must never leave the server. */
export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  recovery_hash: string;
  role: 'player' | 'admin';
  avatar_config: AvatarConfig | null;
  avatar_svg: string | null;
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
  avatarConfig: AvatarConfig | null;
  avatarSvg: string | null;
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
    avatarSvg: row.avatar_svg,
    createdAt: new Date(row.created_at).toISOString(),
    requiresCredentialChange: row.requires_credential_change,
  };
}
