import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { sign } from 'cookie-signature';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { config } from '../config';
import { db } from '../db/knex';
import { rotateSession, SESSION_COOKIE } from '../auth/sessions';
import { SESSION_MAX_LIFETIME_MS } from '../auth/sessionPolicy';
import { buildServer, type BuildServerOptions } from '../server';

/** Empties every table except Knex's migration bookkeeping. */
export async function resetDb(): Promise<void> {
  const { rows }: { rows: { tablename: string }[] } = await db.raw(
    `select tablename from pg_tables where schemaname = 'public' and tablename not like 'knex_%'`,
  );
  if (rows.length === 0) return;
  await db.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} restart identity cascade`);
}

export interface TestUser {
  id: string;
  displayName: string;
  /** A Cookie header carrying this user's signed session cookie. */
  cookie: string;
}

export function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(`s:${sign(token, config.sessionSecret)}`)}`;
}

/**
 * Inserts a user and a session directly (no bcrypt, no rate limits).
 * `inReauthWindow` backdates the session into the last 24h before its 30-day cap.
 */
export async function createUser(
  displayName: string,
  { inReauthWindow = false }: { inReauthWindow?: boolean } = {},
): Promise<TestUser> {
  const username = `${displayName.toLowerCase().replace(/[^a-z0-9]/g, '')}_${randomUUID().slice(0, 8)}`;
  const [{ id }] = await db('users')
    .insert({ username, display_name: displayName, password_hash: 'x', recovery_hash: 'x' })
    .returning('id');
  const session = await db.transaction((trx) => rotateSession(trx, id));
  if (inReauthWindow) {
    const createdAt = new Date(Date.now() - SESSION_MAX_LIFETIME_MS + 60 * 60 * 1000);
    await db('sessions').where({ trace_id: session.traceId }).update({ created_at: createdAt });
  }
  return { id, displayName, cookie: cookieFor(session.token) };
}

export async function startServer(options: BuildServerOptions = {}) {
  const built = buildServer(options);
  await new Promise<void>((resolve) => built.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = built.httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    built.rooms.stop();
    built.games.stop();
    built.detachSocket();
    await new Promise<void>((resolve) => built.io.close(() => resolve()));
  };
  return { ...built, url, close };
}

export interface ReceivedEvent {
  event: string;
  seq: number;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Position in this client's log, for asserting order. */
  index: number;
}

/** A Socket.io client that records every event it receives, in order. */
export class TestClient {
  readonly log: ReceivedEvent[] = [];
  private waiters: (() => void)[] = [];

  constructor(readonly socket: ClientSocket) {
    socket.onAny((event: string, envelope: { seq: number; payload: unknown }) => {
      this.log.push({ event, seq: envelope.seq, payload: envelope.payload, index: this.log.length });
      for (const w of this.waiters.splice(0)) w();
    });
    socket.on('disconnect', () => {
      for (const w of this.waiters.splice(0)) w();
    });
  }

  /** The first logged event (at or after `from`) that matches, waiting for it if needed. */
  async waitFor(
    event: string | string[],
    match: (payload: any) => boolean = () => true, // eslint-disable-line @typescript-eslint/no-explicit-any
    { from = 0, timeoutMs = 3000 }: { from?: number; timeoutMs?: number } = {},
  ): Promise<ReceivedEvent> {
    const names = Array.isArray(event) ? event : [event];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.log.find((e) => e.index >= from && names.includes(e.event) && match(e.payload));
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for "${names.join('" or "')}". Received: ${this.log.map((e) => e.event).join(', ') || 'nothing'}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Resolves once the server has disconnected this client. */
  async waitForDisconnect(timeoutMs = 3000): Promise<void> {
    if (!this.socket.connected && this.log.length > 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for disconnect')), timeoutMs);
      this.socket.once('disconnect', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  events(name: string): ReceivedEvent[] {
    return this.log.filter((e) => e.event === name);
  }

  get length(): number {
    return this.log.length;
  }

  close(): void {
    this.socket.disconnect();
  }
}

/**
 * Connects with the given Cookie header (or none). Does not wait. Defaults to WebSocket only;
 * pass `polling: true` to start on HTTP long-polling and upgrade, as browsers do.
 */
export function connect(url: string, cookie?: string, { polling = false }: { polling?: boolean } = {}): TestClient {
  const socket = ioClient(url, {
    transports: polling ? ['polling', 'websocket'] : ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: cookie ? { cookie } : {},
  });
  return new TestClient(socket);
}

/** Connects and waits for the first snapshot (lobby_snapshot or room_snapshot). */
export async function connectReady(url: string, cookie: string): Promise<TestClient> {
  const client = connect(url, cookie);
  await client.waitFor(['lobby_snapshot', 'room_snapshot']);
  return client;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
