import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as authApi from '../api/auth';
import { setSessionEndedHandler } from '../api/http';
import type { User } from '../api/types';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthValue {
  status: Status;
  user: User | null;
  /** Why the user was sent back to the login screen, if they were. */
  notice: string | null;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /**
   * The server ended the session (401 or a fatal session_error): show the login screen.
   * `reason` is the session_error reason for SESSION_INVALIDATED (displaced, logout, password_reset).
   * CREDENTIAL_CHANGE_REQUIRED keeps the user signed in and shows the forced change screen instead.
   */
  endSession(code: string, reason?: string): void;
}

const AuthContext = createContext<AuthValue | null>(null);

const NOTICES: Record<string, string> = {
  SESSION_INVALIDATED: 'You were signed out because you logged in somewhere else.',
  REAUTH_REQUIRED: 'Your session is about to expire. Please log in again.',
  UNAUTHORIZED: 'Your session has ended. Please log in again.',
};

/** SESSION_INVALIDATED notices by session_error reason. */
const INVALIDATED_NOTICES: Record<string, string> = {
  displaced: 'You were signed out because you logged in somewhere else.',
  logout: 'You were signed out because you logged out in another tab.',
  password_reset: 'You were signed out because your password was reset.',
};

function noticeFor(code: string, reason?: string): string {
  if (code === 'SESSION_INVALIDATED' && reason && INVALIDATED_NOTICES[reason]) return INVALIDATED_NOTICES[reason];
  return NOTICES[code] ?? NOTICES.UNAUTHORIZED;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Logging out ends the session server-side, which also sends this tab's socket a fatal
  // SESSION_INVALIDATED. That is our own doing, so it must not show the "signed in elsewhere" notice.
  const loggingOut = useRef(false);

  const endSession = useCallback((code: string, reason?: string) => {
    if (loggingOut.current) return;
    if (code === 'CREDENTIAL_CHANGE_REQUIRED') {
      // The session is still valid; App shows the forced change screen instead of the game.
      setUser((u) => (u ? { ...u, requiresCredentialChange: true } : u));
      return;
    }
    setUser(null);
    setStatus('anonymous');
    setNotice(noticeFor(code, reason));
  }, []);

  useEffect(() => {
    setSessionEndedHandler(endSession);
    return () => setSessionEndedHandler(null);
  }, [endSession]);

  // Restore an existing session on load.
  useEffect(() => {
    authApi
      .fetchMe()
      .then((me) => {
        setUser(me);
        setStatus('authenticated');
      })
      .catch((err) => {
        setStatus('anonymous');
        if (err?.code === 'REAUTH_REQUIRED') setNotice(NOTICES.REAUTH_REQUIRED);
      });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const me = await authApi.login(username, password);
    loggingOut.current = false;
    setNotice(null);
    setUser(me);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    loggingOut.current = true;
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
      setNotice(null);
    }
  }, []);

  const value = useMemo(
    () => ({ status, user, notice, login, logout, endSession }),
    [status, user, notice, login, logout, endSession],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
