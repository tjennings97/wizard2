import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useRealtime } from '../context/SocketContext';

/**
 * The server decides whether the user is in the lobby or a room (room_snapshot / lobby_snapshot),
 * including after a reconnect or a room closing. Keep the URL in step with it.
 */
export function useLocationSync(): void {
  const { location, room } = useRealtime();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location === 'room' && room && pathname !== `/room/${room.roomId}`) {
      navigate(`/room/${room.roomId}`, { replace: true });
    } else if (location === 'lobby' && pathname.startsWith('/room/')) {
      navigate('/', { replace: true });
    }
  }, [location, room, pathname, navigate]);
}
