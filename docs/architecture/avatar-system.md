# Avatar System Specification

## Overview

The Avatar System gives each Wizard player a persistent visual identity displayed in lobbies, scoreboards, and game results. Each player builds a custom avatar by selecting individual parts (head shape, skin tone, face, hair). The browser composites these SVG layers live during the builder, and the final composed SVG is cached alongside the part selections on the `users` table.

This spec covers the avatar data model, API contract, frontend rendering, and edge-case handling. It is the authoritative reference for backend and frontend teams implementing the feature.

## Avatar Configuration

Each player has a single avatar built from four part selections: **head shape**, **skin tone**, **face**, and **hair**. These are stored in the `avatar_config` field on the `users` table as a structured object with four required keys: `head`, `skin`, `face`, and `hair`. The browser composites the selected SVG layers at build time; the resulting SVG string is cached in `avatar_svg` on the same table. There is no separate avatar catalog or player-avatar join table.

## Data Model

Avatar data lives directly on the `users` table as two fields.

**`users` table (relevant column)**

```
avatarConfig   object (jsonb) — structured avatar part selections.
               Required keys: head (string), skin (string), face (string), hair (string).
               Each value is a slug mapping to an SVG layer asset in the frontend.
               Nullable; null means no avatar set.

avatarSvg      text — cached SVG string of the fully composited avatar.
               Written at registration and on each avatar update alongside avatarConfig.
               Null until avatar is first set. Used for all rendering — avoids
               recompositing layers on every load.
```

## API Endpoints

Avatar data is read and written via the existing user endpoints. All endpoints require an authenticated session cookie (`wizard_session`). Responses follow the standard envelope: `{ data, meta, errors }`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/users/me` | Return the authenticated user's profile, including `avatarConfig` |
| PATCH | `/users/me` | Update the user's profile; pass `avatarConfig` to change avatar |

**Key request/response shapes**

`GET /users/me` — returns the full `User` object. The `avatarConfig` field contains `{ head, skin, face, hair }`, or `null` if not yet set. The `avatarSvg` field contains the cached SVG string, or `null` if not yet set.

`PATCH /users/me` — body: `{ avatarConfig: { head, skin, face, hair }, avatarSvg: "<svg>...</svg>" }`. Both fields must be sent together. Returns the updated `User` object on 200. Returns 400 if any required key is missing, a slug is invalid, or avatarSvg is missing when avatarConfig is provided.

The PATCH endpoint is idempotent for avatar updates. `avatarConfig` may be sent alone or alongside other mutable fields (`displayName`, `password`, etc.).

## Customization & Display

Avatars are images only in v1 — no color pickers, frames, or overlays yet. The display rules below ensure consistency across all surfaces.

**Asset format:** SVG for full-size display; a rasterized WebP thumbnail (48×48 px) for small surfaces where SVG rendering overhead is unnecessary.

**Surfaces and sizes**

| Surface | Asset | Size (CSS) |
| --- | --- | --- |
| Avatar gallery / picker | `asset_url` | 96×96 px |
| Profile drawer | `asset_url` | 128×128 px |
| Lobby player list | `asset_thumb` | 48×48 px |
| Scoreboard row | `asset_thumb` | 36×36 px |
| In-game player label | `asset_thumb` | 32×32 px |

**Rendering rules**

- Display avatars in a circle crop (`border-radius: 50%`). No square display anywhere in the UI.
- If an asset fails to load, fall back to the default avatar asset (`slug: "wizard-default"`). Never show a broken image.
- Avatar images are served from the CDN; do not proxy through the game API server.
- Use the `asset_thumb` URL for any surface under 64×64 px rendered CSS size to avoid unnecessary bandwidth.

## Frontend Integration

The frontend reads and writes `avatarConfig` via the standard user endpoints. The backend validates the structure; the frontend is responsible for rendering it.

**Data flow**

1. On player login, the `GET /users/me` response includes `avatarConfig` → store as `currentUser.avatarConfig`.
2. On lobby join, receive the lobby state message which includes each player's avatar data embedded (no second API call needed in-game).
3. Player builds or changes avatar in the builder UI → browser composites SVG layers live for preview → on confirm, serialize the composed SVG string → call `PATCH /users/me` with `{ avatarConfig: { head, skin, face, hair }, avatarSvg: "<svg>...</svg>" }`, roll back on error.

**Components**

- `<AvatarImage config size />` — renders the cached avatarSvg string with circle crop and fallback. The `config` prop is the raw `avatar_config` value. Used everywhere.
- `<AvatarPicker />` — layered SVG builder UI; composites parts live for preview; on confirm serializes the SVG and calls `PATCH /users/me` with the new `avatarConfig`.
- `<AvatarBadge playerId />` — fetches from `avatarStore` by `playerId`; renders `<AvatarImage size="thumb" />`.

**State management:** `avatarConfig` lives in the global session store (Zustand / Redux / equivalent). Invalidate and refetch after a successful PATCH.

## Edge Cases & Validation

**Missing asset** — If `avatar_config` is null or the referenced asset fails to load, fall back to the default avatar. Never show a broken image; pin the default avatar in the client build config and serve it from the CDN with a long TTL.

**Concurrent updates** — Two sessions writing different `avatar_config` values simultaneously: last writer wins (standard column update semantics). No conflict handling needed for v1.

**Account ban / config reset** — An admin can set `avatar_config = null` on the users table. The frontend treats a null `avatar_config` as "show default."

**Validation rules summary**

| Field | Rule |
| --- | --- |
| `avatarConfig` (PATCH body) | Object with required keys `head`, `skin`, `face`, and `hair` (all strings). Each value must be a valid part slug. Missing or extra keys → 400. |
| `avatarConfig` (stored) | Nullable; null = no avatar set, render default. |
