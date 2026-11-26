# Getting Started (Local Development)

This guide takes a new developer from a fresh clone to a running local copy of Wizard: the Express + Socket.io server and the React client.

**Current state:** the repository is a scaffold. Expect a health endpoint, a Socket.io connection, three placeholder pages, and a database schema created by Knex migrations. There is no game logic or auth yet, and no application code reads or writes the tables.

---

## 1. Prerequisites

| Tool | Version | Check with |
|---|---|---|
| Node.js | 20 or newer (React Router 7 requires it; `.nvmrc` pins 20) | `node -v` |
| npm | 9 or newer (comes with Node) | `npm -v` |
| PostgreSQL | 16 is the production target; 14 or newer works locally | `psql --version` |
| Git | any recent version | `git --version` |

You only need Postgres when you work on database code. The server starts without it and logs a warning (see [step 6](#6-check-that-it-works)).

### Installing Postgres on macOS

Use one of these options:

**Homebrew**
```bash
brew install postgresql@16
brew services start postgresql@16
createdb wizard
```

**Docker**
```bash
docker run -d --name wizard-db \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wizard \
  -p 5432:5432 postgres:16
```

**Note:** a Homebrew install creates a superuser named after your macOS account, with no password. It does not create a `postgres` user. If you use Homebrew, set `DATABASE_URL=postgres://<your-mac-username>@localhost:5432/wizard` in step 3.

---

## 2. Install dependencies

From the repository root:

```bash
npm install
```

The repository is an npm workspace with two packages, `server/` and `client/`. A single install at the root covers both. Don't run `npm install` inside the subfolders.

---

## 3. Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env` and set these values:

| Variable | Required | Purpose | Local value |
|---|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string | `postgres://postgres:postgres@localhost:5432/wizard` (Docker) or see the Homebrew note above |
| `SESSION_SECRET` | yes | Signs session cookies | any long random string, e.g. `openssl rand -hex 32` |
| `PROMETHEUS_TOKEN` | yes | Bearer token for `/api/v1/metrics` | any string locally |
| `NODE_ENV` | yes | `development`, `production`, or `test` | `development` |
| `PORT` | no | HTTP port for the server | `3000` (default) |
| `APP_ORIGIN` | production only | The one origin CORS allows in production, e.g. `https://wizard.example.com` (no path). Outside production, CORS allows only `http://localhost:5173`. | leave unset |
| `TRUST_PROXY_HOPS` | no | Reverse-proxy hops to trust for the client IP, which auth rate limiting keys on. Defaults to `1` in production (Railway's proxy) and `0` elsewhere. | leave unset; `1` when running the API tests |

`.env` is git-ignored, so never commit it. If you add a new required variable, add it to both `server/src/config.ts` and `.env.example`.

If a required variable is missing, the server refuses to start and tells you which one:

```
Error: Missing required environment variable(s): SESSION_SECRET. Copy .env.example to .env and fill in every key.
```

---

## 4. Create the database tables

With Postgres running and `DATABASE_URL` set, apply the migrations from the repository root:

```bash
npm run migrate:latest -w server
```

On success, the output lists every migration it applied:

```
INFO: migrations applied
    batch: 1
    files: [
      "001_create_users_sessions_invites.ts",
      ...
    ]
```

This creates all the tables in the [ERD & Data Dictionary](../architecture/data-model.md). Running it again is safe: Knex records applied migrations in the `knex_migrations` table and skips them. If `files` is empty, the database is already up to date. Re-run this step whenever you pull changes that add files to `server/migrations/`.

**If the `wizard` database already has tables from an older setup,** the first migration fails with `relation "users" already exists`. Keep the old data by renaming that database and creating a fresh one, then re-run the command:

```bash
# Connect to the built-in "postgres" database, not "wizard": your DATABASE_URL with /wizard changed to /postgres
psql "postgres://postgres:postgres@localhost:5432/postgres" \
  -c 'ALTER DATABASE wizard RENAME TO wizard_legacy' -c 'CREATE DATABASE wizard'
```

The rename fails if anything is connected to `wizard`, so stop the dev server and close any database clients first.

---

## 5. Start the app

```bash
npm run dev
```

This command starts two processes, prefixed `[server]` and `[client]` in the terminal:

| Process | URL | What it is |
|---|---|---|
| server | http://localhost:3000 | Express API and Socket.io; restarts on file changes (`tsx watch`) |
| client | http://localhost:5173 | Vite dev server with hot reload |

**Open http://localhost:5173 in your browser.** Vite forwards `/api`, `/health`, and `/socket.io` to the server on port 3000. The browser only ever talks to a single origin, as it will in production.

Press `Ctrl+C` to stop both processes.

### Run only one side

```bash
npm run dev -w server   # backend only
npm run dev -w client   # frontend only
```

---

## 6. Check that it works

1. **Health check:**
   ```bash
   curl http://localhost:3000/health
   # {"status":"ok"}
   ```
   The same response is also available at `/api/v1/health` and through the client proxy at `http://localhost:5173/health`.

2. **Server logs.** You should see:
   ```
   [server] INFO: server listening  port: 3000  nodeEnv: "development"
   [server] INFO: database connection ok
   ```
   If you see `WARN: database not reachable at startup` instead, the server is still running but can't reach Postgres. Check that Postgres is running and that `DATABASE_URL` is correct.

3. **Browser.** The lobby placeholder loads at `/`. The browser dev-tools console logs `connected <socket-id>`. Follow the links to `/room/demo` and `/game/demo`.

---

## 7. Common commands

Run these from the repository root:

| Command | What it does |
|---|---|
| `npm run dev` | Starts server and client in watch mode |
| `npm run typecheck` | Type-checks both packages |
| `npm run build` | Builds the client to `client/dist` and the server to `server/dist` |
| `npm start` | Runs the built server (production mode; also serves `client/dist`) |
| `npm run migrate:latest -w server` | Applies pending database migrations |
| `npm run migrate:rollback -w server` | Rolls back the last batch of migrations |
| `npm test -w server` | Runs the server unit tests (no database needed) |
| `npm run test:integration -w server` | Runs the server integration tests (Postgres required; see below) |

### Running the server integration tests (Jest)

The `*.int.test.ts` files start the real HTTP and Socket.io server on a random port and call it with Supertest and Socket.io clients. They need Postgres running, but no server and no setup:

```bash
npm run test:integration -w server
```

They use a database named `wizard_jest` on the same Postgres server as your `DATABASE_URL`. The first run creates it, and every run migrates it to the latest schema. To use a different database, set `TEST_DATABASE_URL`; its name must end in `_jest`. The tests empty every table between cases, so they refuse to run against any other database name. This database is kept separate from `wizard_test`, which the pytest suite below uses.

### Running the API tests (pytest)

The tests in `tests/api/` call a running server over HTTP and seed rows directly in its database, so point both at a separate test database:

```bash
createdb wizard_test   # once
python3 -m venv .venv && .venv/bin/pip install -r tests/api/requirements.txt   # once
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/wizard_test
npm run migrate:latest -w server

# Terminal 1: TRUST_PROXY_HOPS=1 gives each test its own rate-limit bucket
NODE_ENV=test TRUST_PROXY_HOPS=1 PORT=3100 npm run dev -w server

# Terminal 2
API_BASE_URL=http://127.0.0.1:3100/api/v1 .venv/bin/pytest tests/api
```

Each test sends a random client IP, so you can rerun the suite without restarting the server. Test users, invites and sessions are deleted when the run ends.

### Running a production build locally

```bash
npm run build
NODE_ENV=production npm start
# open http://localhost:3000
```

In production, one Express process serves the React build, the REST API, and WebSockets on a single port, which matches the Railway setup.

---

## 8. Project layout

```
package.json            Root workspace; dev/build/start scripts
tsconfig.base.json      Shared TypeScript settings
.env.example            Required env keys (copy to .env)

server/
  src/
    index.ts            Entry point: HTTP server, Socket.io, shutdown handling
    app.ts              Express app: middleware, routes, static client in prod
    config.ts           Loads and validates env vars at startup
    logger.ts           pino logger (pretty in dev, JSON in prod)
    routes/             Express routers, mounted under /api/v1
    socket/             Socket.io server setup and event handlers
    engine/             Game engine: pure TypeScript, no I/O (empty for now)
    db/
      knex.ts           Knex instance and connection check
      migrate.ts        Migration runner used by the migrate:* scripts
  migrations/           Knex migration files (001_…, 002_…, run in filename order)

client/
  index.html
  vite.config.ts        Dev server on 5173, proxies /api, /health, /socket.io
  src/
    main.tsx            Mounts React, opens the socket
    App.tsx             Route table
    pages/              Lobby, Room, Game placeholders
    socket/client.ts    Single shared Socket.io client
```

The architecture has four layers, and each layer may only call the layers below it: **routes/socket → engine → db**. The engine must never import from `db/`, `socket/`, or `routes/`. For the full design, see [System Architecture](../architecture/system-architecture.md).

---

## 9. Adding a migration

Create a file in `server/migrations/` named with the next three-digit number, e.g. `006_add_user_last_seen.ts`. Knex runs migrations in filename order, so don't use `knex migrate:make` — it generates timestamp prefixes that would sort after every numbered file. Never rename a migration once it has been applied; Knex tracks applied migrations by filename.

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // await knex.schema.createTable('users', (t) => { ... });
}

export async function down(knex: Knex): Promise<void> {
  // await knex.schema.dropTable('users');
}
```

Then run `npm run migrate:latest -w server`. Table definitions are in the [ERD & Data Dictionary](../architecture/data-model.md).

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing required environment variable(s): ...` | `.env` is missing or incomplete. Re-run step 3. |
| `Port 5173 is already in use` | Another Vite dev server is running. Stop it, or find it with `lsof -i tcp:5173`. |
| `EADDRINUSE :::3000` | Something else is using port 3000. Stop it, or set `PORT=3001` in `.env` and start the client with `VITE_API_TARGET=http://127.0.0.1:3001 npm run dev -w client`. |
| `database not reachable at startup` | Postgres isn't running, the `wizard` database doesn't exist (`createdb wizard`), or the user or password in `DATABASE_URL` is wrong. |
| `role "postgres" does not exist` | You're using Homebrew Postgres. Use your macOS username in `DATABASE_URL` (see step 1). |
| `relation "users" already exists` during `migrate:latest` | The `wizard` database has tables from an older setup. See step 4. |
| `relation "..." does not exist` at runtime | Migrations haven't been applied. Run step 4. |
| Browser console shows `socket connect_error` | The server isn't running, or it crashed. Check the `[server]` lines in the terminal. |

---

## Next reading

1. [Product Requirements Document](../product/prd.md): what we're building
2. [Game Rules Reference](../product/game-rules.md): how Wizard is played
3. [System Architecture](../architecture/system-architecture.md): how it fits together
4. [Test Plan](../testing/test-plan.md) and [Deployment & Infrastructure Plan](../operations/deployment-infrastructure.md): how changes get tested and shipped
