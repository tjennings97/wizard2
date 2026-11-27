import { useState } from 'react';
import { Link } from 'react-router';
import { randomAvatarConfig } from '../../../server/src/shared/avatar';
import { AvatarPicker } from '../components/AvatarPicker';
import { Field } from '../components/Field';
import { useAuth } from '../context/AuthContext';
import { errorsOf, secretError, useSubmit } from '../hooks/useSubmit';

const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

/**
 * Invite-only registration (POST /auth/register). Signs the user in on success.
 * The avatar picker starts from a random config (docs/architecture/avatar-system.md).
 */
export function RegisterPage() {
  const { register } = useAuth();
  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [avatar, setAvatar] = useState(() => randomAvatarConfig());

  const { busy, error, fields, onSubmit } = useSubmit(
    () =>
      register({
        inviteCode: inviteCode.trim(),
        username,
        displayName: displayName.trim(),
        password,
        recoveryPassphrase: passphrase,
        avatarConfig: avatar,
      }),
    () =>
      errorsOf({
        inviteCode: !inviteCode.trim() && 'Required.',
        username: !USERNAME_PATTERN.test(username) && '3–32 lowercase letters, digits or underscores.',
        displayName: (!displayName.trim() || displayName.trim().length > 64) && 'Must be 1–64 characters.',
        password: secretError(password),
        confirmPassword: confirmPassword !== password && 'Passwords do not match.',
        recoveryPassphrase:
          secretError(passphrase) || (passphrase === password && 'Must be different from your password.'),
        confirmPassphrase: confirmPassphrase !== passphrase && 'Passphrases do not match.',
      }),
  );

  return (
    <main className="page narrow">
      <h1>Create your account</h1>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <Field
          label="Invite code"
          value={inviteCode}
          onChange={setInviteCode}
          error={fields.inviteCode}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <Field
          label="Username"
          value={username}
          onChange={(v) => setUsername(v.toLowerCase())}
          error={fields.username}
          hint="Used to log in. Can't be changed later."
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={32}
          required
        />
        <Field
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          error={fields.displayName}
          hint="What other players see."
          autoComplete="nickname"
          maxLength={64}
          required
        />
        <fieldset className="plain">
          <legend>Avatar</legend>
          <p className="hint">What other players see next to your name. You can change it later on your profile.</p>
          <AvatarPicker value={avatar} onChange={setAvatar} disabled={busy} error={fields.avatarConfig} />
        </fieldset>
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          error={fields.password}
          hint="At least 8 characters."
          autoComplete="new-password"
          required
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          error={fields.confirmPassword}
          autoComplete="new-password"
          required
        />
        <Field
          label="Recovery passphrase"
          type="password"
          value={passphrase}
          onChange={setPassphrase}
          error={fields.recoveryPassphrase}
          hint="There is no email reset. You'll need this passphrase to reset your password, so keep it somewhere safe."
          autoComplete="off"
          required
        />
        <Field
          label="Confirm recovery passphrase"
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
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <nav className="stack links">
        <Link to="/">Already have an account? Log in</Link>
      </nav>
    </main>
  );
}
