import { Router } from 'express';
import { requireAuth, requireSessionRunway } from '../auth/middleware';
import { asyncHandler } from '../http/asyncHandler';
import { ApiError } from '../http/errors';
import { requestTraceId } from '../http/trace';
import { getRoomView, isRoomId, toRoomDto } from '../rooms/queries';
import { BID_RULES, DECK_TYPES, MEMBER_ROLES, type MemberRole, type RoomConfig } from '../rooms/rules';
import type { ConfigPatch, RoomService } from '../rooms/service';

type Fields = Record<string, string>;

function validationError(fields: Fields): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', `Invalid request body: ${Object.keys(fields).join(', ')}.`, { fields });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Reads the optional roundCount / bidRule / deckType keys of a config object. */
function readConfigFields(obj: Record<string, unknown>, fields: Fields, allowDeckType: boolean): Partial<RoomConfig> {
  const out: Partial<RoomConfig> = {};
  if (obj.roundCount !== undefined) {
    if (typeof obj.roundCount !== 'number' || !Number.isInteger(obj.roundCount) || obj.roundCount < 1) {
      fields.roundCount = 'Must be an integer of at least 1.';
    } else {
      out.roundCount = obj.roundCount;
    }
  }
  if (obj.bidRule !== undefined) {
    if (!(BID_RULES as unknown[]).includes(obj.bidRule)) fields.bidRule = `Must be one of: ${BID_RULES.join(', ')}.`;
    else out.bidRule = obj.bidRule as RoomConfig['bidRule'];
  }
  if (allowDeckType && obj.deckType !== undefined) {
    if (!(DECK_TYPES as unknown[]).includes(obj.deckType)) fields.deckType = `Must be one of: ${DECK_TYPES.join(', ')}.`;
    else out.deckType = obj.deckType as RoomConfig['deckType'];
  }
  return out;
}

const roomNotFound = () => new ApiError(404, 'NOT_FOUND', 'Room not found.');

/** The roomId path parameter, or 404 if it cannot name a room. */
function roomIdParam(raw: string): string {
  if (!isRoomId(raw)) throw roomNotFound();
  return raw.toLowerCase();
}

export function createRoomsRouter(rooms: RoomService): Router {
  const router = Router();
  const isConnected = (userId: string) => rooms.isConnected(userId);
  // The request log line carries the room (a well-formed id only; anything else is a 404).
  router.param('roomId', (req, _res, next, raw: string) => {
    if (isRoomId(raw)) req.logRoomId = raw.toLowerCase();
    next();
  });

  // POST /rooms
  router.post(
    '/',
    requireAuth,
    requireSessionRunway,
    asyncHandler(async (req, res) => {
      const body = req.body === undefined ? {} : asObject(req.body);
      const fields: Fields = {};
      let config: Partial<RoomConfig> = {};
      if (!body) {
        fields.body = 'Must be a JSON object.';
      } else if (body.config !== undefined) {
        const obj = asObject(body.config);
        if (!obj) fields.config = 'Must be an object.';
        else config = readConfigFields(obj, fields, true);
      }
      if (Object.keys(fields).length > 0) throw validationError(fields);

      const room = await rooms.createRoom(req.user!.id, config);
      res.status(201).json(toRoomDto(room, isConnected));
    }),
  );

  // GET /rooms/{roomId}
  router.get(
    '/:roomId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const room = await getRoomView(roomIdParam(req.params.roomId));
      if (!room) throw roomNotFound();
      res.status(200).json(toRoomDto(room, isConnected));
    }),
  );

  // DELETE /rooms/{roomId}
  router.delete(
    '/:roomId',
    requireAuth,
    asyncHandler(async (req, res) => {
      await rooms.closeByHost(req.user!.id, roomIdParam(req.params.roomId));
      res.status(204).end();
    }),
  );

  // PATCH /rooms/{roomId}/config
  router.patch(
    '/:roomId/config',
    requireAuth,
    asyncHandler(async (req, res) => {
      const roomId = roomIdParam(req.params.roomId);
      const body = asObject(req.body);
      const fields: Fields = {};
      let patch: ConfigPatch = {};
      if (!body) {
        fields.body = 'Must be a JSON object.';
      } else {
        patch = readConfigFields(body, fields, false);
        if (Object.keys(fields).length === 0 && patch.roundCount === undefined && patch.bidRule === undefined) {
          fields.body = 'Provide roundCount, bidRule, or both.';
        }
      }
      if (Object.keys(fields).length > 0) throw validationError(fields);

      const config = await rooms.updateConfig(req.user!.id, roomId, patch);
      res.status(200).json(config);
    }),
  );

  // POST /rooms/{roomId}/join
  router.post(
    '/:roomId/join',
    requireAuth,
    requireSessionRunway,
    asyncHandler(async (req, res) => {
      const roomId = roomIdParam(req.params.roomId);
      const role = asObject(req.body)?.role;
      if (!(MEMBER_ROLES as unknown[]).includes(role)) {
        throw validationError({ role: `Must be one of: ${MEMBER_ROLES.join(', ')}.` });
      }
      const room = await rooms.joinRoom(req.user!.id, roomId, role as MemberRole);
      res.status(200).json(toRoomDto(room, isConnected));
    }),
  );

  // POST /rooms/{roomId}/leave
  router.post(
    '/:roomId/leave',
    requireAuth,
    asyncHandler(async (req, res) => {
      await rooms.leaveRoom(req.user!.id, roomIdParam(req.params.roomId));
      res.status(204).end();
    }),
  );

  // POST /rooms/{roomId}/start
  router.post(
    '/:roomId/start',
    requireAuth,
    requireSessionRunway,
    asyncHandler(async (req, res) => {
      const room = await rooms.startGame(req.user!.id, roomIdParam(req.params.roomId), requestTraceId(req));
      res.status(200).json(toRoomDto(room, isConnected));
    }),
  );

  return router;
}
