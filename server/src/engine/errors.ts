/**
 * Error types thrown by the game engine. The socket/API layer maps `code`
 * to client-facing responses; the engine never formats responses itself.
 */
export type EngineErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_PHASE'
  | 'UNKNOWN_PLAYER'
  | 'NOT_YOUR_TURN'
  | 'INVALID_BID'
  | 'ALREADY_BID'
  | 'CARD_NOT_IN_HAND'
  | 'ILLEGAL_CARD'
  | 'INVALID_SUIT'
  | 'ROUND_CLOSED'
  | 'DECK_EXHAUSTED';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export class NotImplementedError extends Error {
  constructor(message = 'Not implemented') {
    super(message);
    this.name = 'NotImplementedError';
  }
}
