/**
 * The reconnection window (docs/api/websocket-events.md, "Reconnection"): how long a disconnected
 * player's seat is held for them to come back before they are treated as having quit.
 *
 * Shared by the server (the seat-hold timer) and the client (copy and the countdown fallback), so
 * the two can't drift apart. Production always uses this value; only tests override it
 * (GameServiceOptions.reconnectWindowMs), so under such a test server the client's wording is off.
 *
 * The client imports this file directly: keep it pure TypeScript with no imports and no Node or
 * DOM APIs.
 */
export const RECONNECT_WINDOW_MS = 2 * 60 * 1000;
