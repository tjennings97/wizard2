import { Router } from 'express';
import type { GameService } from '../games/service';
import type { PresenceSource } from '../rooms/queries';
import type { RoomService } from '../rooms/service';
import { createAdminRouter } from './admin';
import { authRouter } from './auth';
import { createBugReportsRouter } from './bugReports';
import { healthRouter } from './health';
import { createLobbyRouter } from './lobby';
import { metricsRouter } from './metrics';
import { markRouteBase } from '../metrics/http';
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
  // markRouteBase records each router's mount path for the route label of the HTTP metrics.
  apiRouter.use(markRouteBase);
  apiRouter.use(healthRouter);
  apiRouter.use(metricsRouter);
  apiRouter.use('/auth', markRouteBase, authRouter);
  apiRouter.use('/users', markRouteBase, usersRouter);
  apiRouter.use('/lobby', markRouteBase, createLobbyRouter(deps.presence));
  apiRouter.use('/rooms', markRouteBase, createRoomsRouter(deps.rooms));
  apiRouter.use('/admin', markRouteBase, createAdminRouter());
  apiRouter.use('/bug-reports', markRouteBase, createBugReportsRouter(deps.games));
  return apiRouter;
}
