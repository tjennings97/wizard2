import { Link } from 'react-router-dom';

export function LobbyPage() {
  return (
    <main>
      <h1>Lobby</h1>
      <p>Placeholder lobby page.</p>
      <nav>
        <Link to="/room/demo">Room demo</Link> · <Link to="/game/demo">Game demo</Link>
      </nav>
    </main>
  );
}
