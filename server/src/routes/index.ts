import { Router } from 'express';
import type { GameService } from '../games/service';
import type { PresenceSource } from '../rooms/queries';
import type { RoomService } from '../rooms/service';
import { createAdminRouter } from './admin';
import { authRouter } from './auth';
import { createBugReportsRouter } from './bugReports';
import { healthRouter } from './health';
import { createLobbyRouter } from './lobby';
import { createRoomsRouter } from './rooms';
import { usersRouter } from './users';

export interface ApiDeps {
  rooms: RoomService;
  presence: PresenceSource;
  /** Live games, for the reporter's own player view in a bug report. */
  games: GameService;
}

export function createApiRouter(deps: ApiDeps): Router {
  const apiRouter = Router();
  apiRouter.use(healthRouter);
  apiRouter.use('/auth', authRouter);
  apiRouter.use('/users', usersRouter);
  apiRouter.use('/lobby', createLobbyRouter(deps.presence));
  apiRouter.use('/rooms', createRoomsRouter(deps.rooms));
  apiRouter.use('/admin', createAdminRouter());
  apiRouter.use('/bug-reports', createBugReportsRouter(deps.games));
  return apiRouter;
}
