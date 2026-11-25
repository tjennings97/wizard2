import { useParams } from 'react-router';

export function RoomPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <main>
      <h1>Room {id}</h1>
      <p>Placeholder room page.</p>
    </main>
  );
}
