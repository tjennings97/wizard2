import { useState } from 'react';
import { Link } from 'react-router';
import { resetPassword } from '../api/auth';
import { Field } from '../components/Field';
import { errorsOf, secretError, useSubmit } from '../hooks/useSubmit';
import { AuthScreen } from '../components/AuthScreen';

/**
 * POST /auth/reset-password: username + recovery passphrase, no email step. A reset signs out
 * every device, so the user then logs in with the new password.
 */
export function ResetPasswordPage() {
  const [username, setUsername] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [done, setDone] = useState(false);

  const { busy, error, fields, onSubmit } = useSubmit(
    async () => {
      await resetPassword(username.trim().toLowerCase(), passphrase, newPassword);
      setDone(true);
    },
    () =>
      errorsOf({
        username: !username.trim() && 'Required.',
        recoveryPassphrase: !passphrase && 'Required.',
        newPassword: secretError(newPassword),
        confirmPassword: confirmPassword !== newPassword && 'Passwords do not match.',
      }),
  );

  if (done) {
    return (
      <AuthScreen>
        <h1>Password reset</h1>
        <p className="notice" role="status">
          Your password has been changed and any other devices have been signed out.
        </p>
        <Link to="/" className="button primary">
          Log in
        </Link>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <h1>Reset your password</h1>
      <p className="muted">Enter your username and the recovery passphrase you chose when you signed up.</p>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <Field
          label="Username"
          value={username}
          onChange={setUsername}
          error={fields.username}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <Field
          label="Recovery passphrase"
          type="password"
          value={passphrase}
          onChange={setPassphrase}
          error={fields.recoveryPassphrase}
          autoComplete="off"
          required
        />
        <Field
          label="New password"
          type="password"
          value={newPassword}
          onChange={setNewPassword}
          error={fields.newPassword}
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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Resetting…' : 'Reset password'}
        </button>
      </form>
      <nav className="stack links">
        <Link to="/">Back to log in</Link>
      </nav>
    </AuthScreen>
  );
}
