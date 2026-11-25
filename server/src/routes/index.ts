import { Router } from 'express';
import type { PresenceSource } from '../rooms/queries';
import type { RoomService } from '../rooms/service';
import { authRouter } from './auth';
import { healthRouter } from './health';
import { createLobbyRouter } from './lobby';
import { createRoomsRouter } from './rooms';
import { usersRouter } from './users';

export interface ApiDeps {
  rooms: RoomService;
  presence: PresenceSource;
}

export function createApiRouter(deps: ApiDeps): Router {
  const apiRouter = Router();
  apiRouter.use(healthRouter);
  apiRouter.use('/auth', authRouter);
  apiRouter.use('/users', usersRouter);
  apiRouter.use('/lobby', createLobbyRouter(deps.presence));
  apiRouter.use('/rooms', createRoomsRouter(deps.rooms));
  return apiRouter;
}
