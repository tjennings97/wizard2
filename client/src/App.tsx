import { Navigate, Route, Routes } from 'react-router';
import { BugReport } from './components/BugReport';
import { useAuth } from './context/AuthContext';
import { GameProvider } from './context/GameContext';
import { SocketProvider } from './context/SocketContext';
import { useLocationSync } from './hooks/useLocationSync';
import { AdminPage } from './pages/Admin';
import { CredentialChangePage } from './pages/CredentialChange';
import { GamePage } from './pages/Game';
import { LobbyPage } from './pages/Lobby';
import { LoginPage } from './pages/Login';
import { ProfilePage } from './pages/Profile';
import { RegisterPage } from './pages/Register';
import { ResetPasswordPage } from './pages/ResetPassword';
import { RoomPage } from './pages/Room';

function AuthenticatedRoutes() {
  useLocationSync();
  return (
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/room/:id" element={<RoomPage />} />
      <Route path="/game/:id" element={<GamePage />} />
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/admin" element={<AdminPage />} />
      {/* Just signed up or in: the signed-out pages have nothing to show. */}
      <Route path="/register" element={<Navigate to="/" replace />} />
      <Route path="/reset-password" element={<Navigate to="/" replace />} />
      <Route path="*" element={<p className="page">Not found</p>} />
    </Routes>
  );
}

/** Signed out: any other URL shows the login screen and stays put, so logging in returns there. */
function AnonymousRoutes() {
  return (
    <Routes>
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="*" element={<LoginPage />} />
    </Routes>
  );
}

export function App() {
  const { status, user } = useAuth();
  if (status === 'loading') return <p className="page muted">Loading…</p>;
  if (status === 'anonymous') return <AnonymousRoutes />;
  // An admin reset this account. Nothing else is reachable (no socket, no routes) until the
  // password and recovery passphrase are changed; the server refuses everything else anyway.
  if (user?.requiresCredentialChange) return <CredentialChangePage />;
  return (
    <SocketProvider>
      <GameProvider>
        <AuthenticatedRoutes />
        {/* Every signed-in screen, including the game (the endpoint needs a session). */}
        <BugReport />
      </GameProvider>
    </SocketProvider>
  );
}
