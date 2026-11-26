import { useState } from 'react';
import { Link } from 'react-router';
import { Field } from '../components/Field';
import { useAuth } from '../context/AuthContext';
import { errorsOf, secretError, useSubmit } from '../hooks/useSubmit';

/**
 * /profile: display name, password and recovery passphrase (PATCH /users/me). Changing a secret
 * signs out every other device; this one keeps going on a new session.
 * The avatar picker arrives with the avatar system (remaining-work prompt 7).
 */
export function ProfilePage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <main className="page narrow">
      <header className="bar">
        <h1>Profile</h1>
        <Link to="/" className="button">
          Back to lobby
        </Link>
      </header>
      <dl className="facts">
        <dt>Username</dt>
        <dd>{user.username}</dd>
      </dl>
      <DisplayNameForm current={user.displayName} />
      <PasswordForm />
      <PassphraseForm />
    </main>
  );
}

function Saved({ text }: { text: string | null }) {
  return text ? (
    <p className="notice" role="status">
      {text}
    </p>
  ) : null;
}

function FormError({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

function DisplayNameForm({ current }: { current: string }) {
  const { updateProfile } = useAuth();
  const [displayName, setDisplayName] = useState(current);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, fields, onSubmit } = useSubmit(
    async () => {
      setSaved(null);
      const me = await updateProfile({ displayName: displayName.trim() });
      setDisplayName(me.displayName);
      setSaved('Display name saved.');
    },
    () => errorsOf({ displayName: (!displayName.trim() || displayName.trim().length > 64) && 'Must be 1–64 characters.' }),
  );

  return (
    <section>
      <h2>Display name</h2>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <Field
          label="Display name"
          value={displayName}
          onChange={(v) => {
            setDisplayName(v);
            setSaved(null);
          }}
          error={fields.displayName}
          hint="What other players see."
          autoComplete="nickname"
          maxLength={64}
          required
        />
        <FormError error={error} />
        <Saved text={saved} />
        <button type="submit" className="primary" disabled={busy || displayName.trim() === current}>
          {busy ? 'Saving…' : 'Save display name'}
        </button>
      </form>
    </section>
  );
}

const SIGNED_OUT_ELSEWHERE = 'Any other devices have been signed out.';

function PasswordForm() {
  const { updateProfile } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, fields, onSubmit } = useSubmit(
    async () => {
      setSaved(null);
      await updateProfile({ currentPassword, password });
      setCurrentPassword('');
      setPassword('');
      setConfirm('');
      setSaved(`Password changed. ${SIGNED_OUT_ELSEWHERE}`);
    },
    () =>
      errorsOf({
        currentPassword: !currentPassword && 'Required.',
        password: secretError(password) || (password === currentPassword && 'Must differ from your current password.'),
        confirm: confirm !== password && 'Passwords do not match.',
      }),
  );

  return (
    <section>
      <h2>Password</h2>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <Field
          label="Current password"
          type="password"
          value={currentPassword}
          onChange={setCurrentPassword}
          error={fields.currentPassword}
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
          value={confirm}
          onChange={setConfirm}
          error={fields.confirm}
          autoComplete="new-password"
          required
        />
        <FormError error={error} />
        <Saved text={saved} />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}

function PassphraseForm() {
  const { updateProfile } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, fields, onSubmit } = useSubmit(
    async () => {
      setSaved(null);
      await updateProfile({ currentPassword, recoveryPassphrase: passphrase });
      setCurrentPassword('');
      setPassphrase('');
      setConfirm('');
      setSaved(`Recovery passphrase changed. ${SIGNED_OUT_ELSEWHERE}`);
    },
    () =>
      errorsOf({
        currentPassword: !currentPassword && 'Required.',
        recoveryPassphrase:
          secretError(passphrase) || (passphrase === currentPassword && 'Must be different from your password.'),
        confirm: confirm !== passphrase && 'Passphrases do not match.',
      }),
  );

  return (
    <section>
      <h2>Recovery passphrase</h2>
      <p className="muted">Used to reset your password if you forget it. There is no email reset.</p>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <Field
          label="Current password"
          type="password"
          value={currentPassword}
          onChange={setCurrentPassword}
          error={fields.currentPassword}
          autoComplete="current-password"
          required
        />
        <Field
          label="New recovery passphrase"
          type="password"
          value={passphrase}
          onChange={setPassphrase}
          error={fields.recoveryPassphrase}
          hint="At least 8 characters."
          autoComplete="off"
          required
        />
        <Field
          label="Confirm new recovery passphrase"
          type="password"
          value={confirm}
          onChange={setConfirm}
          error={fields.confirm}
          autoComplete="off"
          required
        />
        <FormError error={error} />
        <Saved text={saved} />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Change recovery passphrase'}
        </button>
      </form>
    </section>
  );
}
