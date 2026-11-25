import { Router } from 'express';
import { requireAuth } from '../auth/middleware';
import { asyncHandler } from '../http/asyncHandler';
import { listLobbyRooms, type PresenceSource } from '../rooms/queries';

export function createLobbyRouter(presence: PresenceSource): Router {
  const router = Router();

  // GET /lobby/rooms: open and in_progress rooms.
  router.get(
    '/rooms',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.status(200).json(await listLobbyRooms());
    }),
  );

  // GET /lobby/presence: users connected and not in any room or game.
  router.get('/presence', requireAuth, (_req, res) => {
    res.status(200).json(presence.lobbyUsers());
  });

  return router;
}
