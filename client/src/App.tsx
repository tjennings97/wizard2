import { Route, Routes } from 'react-router';
import { useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { useLocationSync } from './hooks/useLocationSync';
import { CredentialChangePage } from './pages/CredentialChange';
import { GamePage } from './pages/Game';
import { LobbyPage } from './pages/Lobby';
import { LoginPage } from './pages/Login';
import { RoomPage } from './pages/Room';

function AuthenticatedRoutes() {
  useLocationSync();
  return (
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/room/:id" element={<RoomPage />} />
      <Route path="/game/:id" element={<GamePage />} />
      <Route path="*" element={<p className="page">Not found</p>} />
    </Routes>
  );
}

export function App() {
  const { status, user } = useAuth();
  if (status === 'loading') return <p className="page muted">Loading…</p>;
  if (status === 'anonymous') return <LoginPage />;
  // An admin reset this account. Nothing else is reachable (no socket, no routes) until the
  // password and recovery passphrase are changed; the server refuses everything else anyway.
  if (user?.requiresCredentialChange) return <CredentialChangePage />;
  return (
    <SocketProvider>
      <AuthenticatedRoutes />
    </SocketProvider>
  );
}
