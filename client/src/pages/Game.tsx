import { useParams } from 'react-router';

export function GamePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <main>
      <h1>Game {id}</h1>
      <p>Placeholder game page.</p>
    </main>
  );
}
