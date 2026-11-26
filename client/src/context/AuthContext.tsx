import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as authApi from '../api/auth';
import { ApiRequestError, setSessionEndedHandler } from '../api/http';
import type { User } from '../api/types';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthValue {
  status: Status;
  user: User | null;
  /** Why the user was sent back to the login screen, if they were. */
  notice: string | null;
  /** Username to pre-fill on the login screen (REAUTH_REQUIRED: the same user signs in again). */
  prefillUsername: string;
  /**
   * Bumped whenever this device gets a new session without signing out (a password or passphrase
   * change rotates it). The socket reconnects so it uses the new cookie.
   */
  sessionEpoch: number;
  login(username: string, password: string): Promise<void>;
  register(body: authApi.RegisterBody): Promise<void>;
  logout(): Promise<void>;
  /** PATCH /users/me. Resolves with the updated user, which also replaces `user`. */
  updateProfile(body: authApi.ProfileUpdate): Promise<User>;
  /**
   * The server ended the session (401 or a fatal session_error): show the login screen.
   * `reason` is the session_error reason for SESSION_INVALIDATED (displaced, logout,
   * password_reset, credential_change).
   * CREDENTIAL_CHANGE_REQUIRED keeps the user signed in and shows the forced change screen instead.
   */
  endSession(code: string, reason?: string): void;
}

const AuthContext = createContext<AuthValue | null>(null);

// The 401 / session_error mapping in docs/development/auth-follow-ups.md §5.
const NOTICES: Record<string, string | null> = {
  UNAUTHORIZED: null,
  // Only when the server could not say why (a session ended before reasons were recorded).
  SESSION_INVALIDATED: 'You were signed out. Please sign in again.',
  REAUTH_REQUIRED: 'Please sign in again to continue.',
};

/** SESSION_INVALIDATED notices by session_error reason. */
const INVALIDATED_NOTICES: Record<string, string> = {
  displaced: 'You signed in on another device.',
  logout: 'You logged out in another tab.',
  password_reset: 'You were signed out because your password was reset.',
  credential_change: 'You were signed out because your password or recovery passphrase was changed.',
};

function noticeFor(code: string, reason?: string): string | null {
  if (code === 'SESSION_INVALIDATED' && reason && INVALIDATED_NOTICES[reason]) return INVALIDATED_NOTICES[reason];
  return NOTICES[code] ?? null;
}

/** How long after this tab's own secret change a credential_change for it is still expected. */
const OWN_ROTATION_GRACE_MS = 10_000;
/** /users/me checks after another tab's change, while its new cookie may still be on the way. */
const ROTATION_RETRY_DELAYS_MS = [0, 1000, 3000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The last signed-in username, so a REAUTH_REQUIRED on app load (when /users/me says nothing
// about who the user is) can still pre-fill it. A per-device convenience only.
const LAST_USERNAME_KEY = 'wizard:lastUsername';
function readLastUsername(): string {
  try {
    return localStorage.getItem(LAST_USERNAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function rememberUsername(username: string): void {
  try {
    localStorage.setItem(LAST_USERNAME_KEY, username);
  } catch {
    // Storage blocked (private mode): nothing to remember.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prefillUsername, setPrefillUsername] = useState('');
  const [sessionEpoch, setSessionEpoch] = useState(0);

  // Logging out ends the session server-side, which also sends this tab's socket a fatal
  // SESSION_INVALIDATED. That is our own doing, so it must not show the "signed in elsewhere" notice.
  const loggingOut = useRef(false);
  // The last secret change this tab made: in flight (settledAt null) or recently finished. Its
  // session rotation sends our own socket a SESSION_INVALIDATED (credential_change) that may
  // arrive before or just after the response that sets the new cookie.
  const ownRotation = useRef<{ request: Promise<unknown>; settledAt: number | null } | null>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  const signedIn = useCallback((me: User) => {
    loggingOut.current = false;
    rememberUsername(me.username);
    setNotice(null);
    setUser(me);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback((code: string, reason?: string) => {
    if (code === 'REAUTH_REQUIRED') setPrefillUsername(userRef.current?.username ?? readLastUsername());
    else setPrefillUsername('');
    setUser(null);
    setStatus('anonymous');
    setNotice(noticeFor(code, reason));
  }, []);

  /**
   * A password / passphrase change ended this session. Three cases:
   * - this tab made the change: updateProfile already took the new session (nothing to do);
   * - another tab on this device made it: the shared cookie is (or soon will be) the new one, so
   *   check /users/me, retrying while the new cookie may not have landed yet, then reconnect;
   * - another device made it: /users/me keeps answering 401, so sign out.
   * Only a 401 means signed out. Any other failure (network, 5xx, 429) keeps the user signed in
   * and reconnects the socket, whose handshake then decides.
   */
  const recoverFromRotation = useCallback(
    async (code: string, reason: string) => {
      const own = ownRotation.current;
      if (own && (own.settledAt === null || Date.now() - own.settledAt < OWN_ROTATION_GRACE_MS)) {
        const ok = await own.request.then(
          () => true,
          () => false,
        );
        if (ok) return;
        // The response was lost (network) but the change may have committed: check below.
      }
      let lastError: unknown = null;
      for (const delay of ROTATION_RETRY_DELAYS_MS) {
        if (delay > 0) await sleep(delay);
        try {
          setUser(await authApi.fetchMe());
          setSessionEpoch((n) => n + 1);
          return;
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError instanceof ApiRequestError && lastError.status === 401) signOut(code, reason);
      else setSessionEpoch((n) => n + 1);
    },
    [signOut],
  );

  const endSession = useCallback(
    (code: string, reason?: string) => {
      if (loggingOut.current) return;
      if (code === 'CREDENTIAL_CHANGE_REQUIRED') {
        // The session is still valid; App shows the forced change screen instead of the game.
        setUser((u) => (u ? { ...u, requiresCredentialChange: true } : u));
        return;
      }
      if (code === 'SESSION_INVALIDATED' && reason === 'credential_change') {
        void recoverFromRotation(code, reason);
        return;
      }
      signOut(code, reason);
    },
    [signOut, recoverFromRotation],
  );

  useEffect(() => {
    setSessionEndedHandler(endSession);
    return () => setSessionEndedHandler(null);
  }, [endSession]);

  // Restore an existing session on load.
  useEffect(() => {
    authApi
      .fetchMe()
      .then(signedIn)
      .catch((err) => signOut(err?.code ?? 'UNAUTHORIZED', err?.reason));
  }, [signedIn, signOut]);

  const login = useCallback(
    async (username: string, password: string) => {
      signedIn(await authApi.login(username, password));
    },
    [signedIn],
  );

  const register = useCallback(
    async (body: authApi.RegisterBody) => {
      signedIn(await authApi.register(body));
    },
    [signedIn],
  );

  const logout = useCallback(async () => {
    loggingOut.current = true;
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
      setNotice(null);
      setPrefillUsername('');
    }
  }, []);

  const updateProfile = useCallback(async (body: authApi.ProfileUpdate) => {
    const secret = body.password !== undefined || body.recoveryPassphrase !== undefined;
    const request = authApi.updateMe(body);
    const rotation = secret ? { request, settledAt: null as number | null } : null;
    if (rotation) ownRotation.current = rotation;
    try {
      const me = await request;
      setUser(me);
      // The response set a new session cookie; reconnect the socket with it.
      if (secret) setSessionEpoch((n) => n + 1);
      return me;
    } finally {
      if (rotation) rotation.settledAt = Date.now();
    }
  }, []);

  const value = useMemo(
    () => ({ status, user, notice, prefillUsername, sessionEpoch, login, register, logout, updateProfile, endSession }),
    [status, user, notice, prefillUsername, sessionEpoch, login, register, logout, updateProfile, endSession],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
