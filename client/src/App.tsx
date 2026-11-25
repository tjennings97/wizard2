import { Route, Routes } from 'react-router';
import { LobbyPage } from './pages/Lobby';
import { RoomPage } from './pages/Room';
import { GamePage } from './pages/Game';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/room/:id" element={<RoomPage />} />
      <Route path="/game/:id" element={<GamePage />} />
      <Route path="*" element={<p>Not found</p>} />
    </Routes>
  );
}
