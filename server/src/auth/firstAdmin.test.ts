import bcrypt from 'bcrypt';
import { buildFirstAdmin, firstAdminInsertSql, validateFirstAdmin } from './firstAdmin';

describe('validateFirstAdmin', () => {
  it('accepts an app-valid username and trims the display name', () => {
    expect(validateFirstAdmin('owner_1', '  Owner  ')).toEqual({ username: 'owner_1', displayName: 'Owner' });
  });

  it.each([undefined, '', 'ab', 'Owner', 'own-er', 'x'.repeat(33)])('rejects username %p', (username) => {
    expect(() => validateFirstAdmin(username, 'Owner')).toThrow(/Username/);
  });

  it.each([undefined, '', '   ', 'x'.repeat(65)])('rejects display name %p', (displayName) => {
    expect(() => validateFirstAdmin('owner', displayName)).toThrow(/Display name/);
  });
});

describe('buildFirstAdmin', () => {
  it('flags an admin whose bcrypt hashes match the temporary secrets', async () => {
    const admin = await buildFirstAdmin('owner', 'Owner');
    expect(admin.row).toMatchObject({ username: 'owner', display_name: 'Owner', role: 'admin', requires_credential_change: true });
    expect(admin.temporaryPassword).not.toBe(admin.temporaryPassphrase);
    expect(admin.row.password_hash).toMatch(/^\$2b\$12\$/);
    expect(await bcrypt.compare(admin.temporaryPassword, admin.row.password_hash)).toBe(true);
    expect(await bcrypt.compare(admin.temporaryPassphrase, admin.row.recovery_hash)).toBe(true);
  });
});

describe('firstAdminInsertSql', () => {
  const row = {
    username: 'owner',
    display_name: "O'Brien",
    password_hash: '$2b$12$abc',
    recovery_hash: '$2b$12$def',
    role: 'admin' as const,
    requires_credential_change: true as const,
  };

  it('escapes quotes and contains hashes only', () => {
    expect(firstAdminInsertSql(row)).toBe(
      'INSERT INTO users (username, display_name, password_hash, recovery_hash, role, requires_credential_change) ' +
        "VALUES ('owner', 'O''Brien', '$2b$12$abc', '$2b$12$def', 'admin', true);",
    );
  });
});
