import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useGame } from '../context/GameContext';
import { useRealtime } from '../context/SocketContext';

/**
 * The server decides whether the user is in the lobby, a room or a game (lobby_snapshot,
 * room_snapshot, game_started / state_snapshot), including after a reconnect or a room closing.
 * Keep the URL in step with it. A game takes precedence: its room is still the socket's room.
 */
export function useLocationSync(): void {
  const { location, room } = useRealtime();
  const { game } = useGame();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (game) {
      if (pathname !== `/game/${game.gameId}`) navigate(`/game/${game.gameId}`, { replace: true });
    } else if (location === 'room' && room && pathname !== `/room/${room.roomId}`) {
      navigate(`/room/${room.roomId}`, { replace: true });
    } else if (location === 'lobby' && (pathname.startsWith('/room/') || pathname.startsWith('/game/'))) {
      navigate('/', { replace: true });
    }
  }, [game, location, room, pathname, navigate]);
}
