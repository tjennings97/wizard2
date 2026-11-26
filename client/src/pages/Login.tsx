import { useState } from 'react';
import { Link } from 'react-router';
import { Field } from '../components/Field';
import { useAuth } from '../context/AuthContext';
import { useSubmit } from '../hooks/useSubmit';

/**
 * Shown for any URL while signed out. `notice` says why the user is here (signed in elsewhere,
 * REAUTH_REQUIRED, ...); after REAUTH_REQUIRED the username is pre-filled (auth-follow-ups §5).
 */
export function LoginPage() {
  const { login, notice, prefillUsername } = useAuth();
  const [username, setUsername] = useState(prefillUsername);
  const [password, setPassword] = useState('');
  const { busy, error, onSubmit } = useSubmit(() => login(username, password));

  return (
    <main className="page narrow">
      <h1>Wizard</h1>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <form onSubmit={onSubmit} className="stack">
        <Field
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus={prefillUsername !== ''}
          required
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <nav className="stack links">
        <Link to="/reset-password">Forgot your password?</Link>
        <Link to="/register">Have an invite code? Create an account</Link>
      </nav>
    </main>
  );
}
