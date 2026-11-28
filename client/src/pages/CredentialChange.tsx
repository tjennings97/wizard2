import { useState } from 'react';
import { Field } from '../components/Field';
import { useAuth } from '../context/AuthContext';
import { errorsOf, secretError, useSubmit } from '../hooks/useSubmit';
import { AuthScreen } from '../components/AuthScreen';

/**
 * Shown instead of the app while user.requiresCredentialChange is true (an admin reset the
 * account). The server allows only GET/PATCH /users/me and logout until the flag clears, which
 * happens once both the password and the recovery passphrase have been changed. Both are sent in
 * one PATCH /users/me; when the response clears the flag, App shows the lobby.
 */
export function CredentialChangePage() {
  const { user, updateProfile, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);

  const { busy, error, fields, onSubmit } = useSubmit(
    () => updateProfile({ currentPassword, password, recoveryPassphrase: passphrase }),
    () =>
      errorsOf({
        currentPassword: !currentPassword && 'Required.',
        password: secretError(password) || (password === currentPassword && 'Must differ from the temporary password.'),
        confirmPassword: confirmPassword !== password && 'Passwords do not match.',
        recoveryPassphrase:
          secretError(passphrase) || (passphrase === password && 'Must be different from your password.'),
        confirmPassphrase: confirmPassphrase !== passphrase && 'Passphrases do not match.',
      }),
  );

  async function onLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <AuthScreen>
      {/* An amber warning across the top, the form below (docs/design/ui-foundation.md, "Auth"). */}
      <p className="notice warning-banner" role="note">
        An admin reset your account{user ? ` (${user.username})` : ''}. Choose a new password and recovery passphrase
        to continue.
      </p>
      <h1>Choose new credentials</h1>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <Field
          label="Temporary password"
          type="password"
          value={currentPassword}
          onChange={setCurrentPassword}
          error={fields.currentPassword}
          hint="The password the admin gave you."
          autoComplete="current-password"
          required
        />
        <Field
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          error={fields.password}
          hint="At least 8 characters."
          autoComplete="new-password"
          required
        />
        <Field
          label="Confirm new password"
          type="password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          error={fields.confirmPassword}
          autoComplete="new-password"
          required
        />
        <Field
          label="New recovery passphrase"
          type="password"
          value={passphrase}
          onChange={setPassphrase}
          error={fields.recoveryPassphrase}
          hint="You'll need this to reset your password yourself. Keep it somewhere safe."
          autoComplete="off"
          required
        />
        <Field
          label="Confirm new recovery passphrase"
          type="password"
          value={confirmPassphrase}
          onChange={setConfirmPassphrase}
          error={fields.confirmPassphrase}
          autoComplete="off"
          required
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>
      </form>
      <button type="button" className="ghost block spaced" onClick={onLogout} disabled={loggingOut || busy}>
        {loggingOut ? 'Logging out…' : 'Log out'}
      </button>
    </AuthScreen>
  );
}
