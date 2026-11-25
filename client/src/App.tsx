import { Route, Routes } from 'react-router';
import { useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { useLocationSync } from './hooks/useLocationSync';
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
  const { status } = useAuth();
  if (status === 'loading') return <p className="page muted">Loading…</p>;
  if (status === 'anonymous') return <LoginPage />;
  return (
    <SocketProvider>
      <AuthenticatedRoutes />
    </SocketProvider>
  );
}
