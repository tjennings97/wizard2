import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

/**
 * Shown instead of the app while user.requiresCredentialChange is true (an admin reset the
 * account). The server allows only GET/PATCH /users/me and logout until the flag clears.
 *
 * TODO(auth-follow-ups §4a/§5): the change form (new password + recovery passphrase via
 * PATCH /users/me). That endpoint is not built yet, so for now this screen only blocks
 * navigation and offers logout.
 */
export function CredentialChangePage() {
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);

  async function onLogout() {
    setBusy(true);
    try {
      await logout();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <h1>Change your credentials</h1>
      <p className="notice">
        An admin reset your account. You need to set a new password and recovery passphrase before you can play.
      </p>
      <p className="muted">Changing them in the app isn’t available yet. Please contact an admin.</p>
      <button type="button" onClick={onLogout} disabled={busy}>
        {busy ? 'Logging out…' : 'Log out'}
      </button>
    </main>
  );
}
