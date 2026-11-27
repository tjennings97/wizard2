import { randomAvatarConfig, type AvatarConfig } from '../shared/avatar';
import { generateTemporarySecret, hashSecret } from './credentials';
import { DISPLAY_NAME_MAX, USERNAME_PATTERN } from './validation';

/**
 * The first admin of a fresh database (docs/operations/deployment-infrastructure.md, First Admin
 * Account). Registration needs an invite and only an admin can create one, so this account is
 * inserted directly, in the same state as an admin credential reset: temporary secrets and
 * requires_credential_change = true, so the app makes the owner choose their own at first sign-in.
 */
export interface FirstAdmin {
  temporaryPassword: string;
  temporaryPassphrase: string;
  row: {
    username: string;
    display_name: string;
    password_hash: string;
    recovery_hash: string;
    role: 'admin';
    requires_credential_change: true;
    /** Random, like a registration's starting avatar; the owner can change it on /profile. */
    avatar_config: AvatarConfig;
  };
}

/** Throws with a usage-friendly message if the username or display name would be rejected by the app. */
export function validateFirstAdmin(username: string | undefined, displayName: string | undefined): { username: string; displayName: string } {
  if (!username || !USERNAME_PATTERN.test(username)) {
    throw new Error('Username must be 3–32 lowercase letters, digits or underscores.');
  }
  const trimmed = (displayName ?? '').trim();
  if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX) {
    throw new Error(`Display name must be 1–${DISPLAY_NAME_MAX} characters.`);
  }
  return { username, displayName: trimmed };
}

export async function buildFirstAdmin(username: string, displayName: string): Promise<FirstAdmin> {
  const temporaryPassword = generateTemporarySecret();
  const temporaryPassphrase = generateTemporarySecret();
  const [passwordHash, recoveryHash] = await Promise.all([hashSecret(temporaryPassword), hashSecret(temporaryPassphrase)]);
  return {
    temporaryPassword,
    temporaryPassphrase,
    row: {
      username,
      display_name: displayName,
      password_hash: passwordHash,
      recovery_hash: recoveryHash,
      role: 'admin',
      requires_credential_change: true,
      avatar_config: randomAvatarConfig(),
    },
  };
}

const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** A standalone INSERT for the row, for databases the script cannot reach directly. Holds hashes only. */
export function firstAdminInsertSql(row: FirstAdmin['row']): string {
  const values = [row.username, row.display_name, row.password_hash, row.recovery_hash].map(sqlString);
  return (
    'INSERT INTO users (username, display_name, password_hash, recovery_hash, role, requires_credential_change, avatar_config) ' +
    `VALUES (${values.join(', ')}, 'admin', true, ${sqlString(JSON.stringify(row.avatar_config))}::jsonb);`
  );
}
