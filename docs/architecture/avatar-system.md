# Avatar System Specification

## Overview

The Avatar System gives each Wizard player a persistent visual identity displayed in lobbies, rooms, game seats and scoreboards. Each player builds an avatar by choosing four parts: head shape, skin tone, face and hair. The choice is stored as four slugs in `users.avatar_config`. The browser draws the avatar from app-provided SVG layer files bundled with the client. No SVG or image is ever uploaded, stored or served by the server.

This spec covers the avatar data model, API contract, frontend rendering, and edge-case handling. It is the authoritative reference for the avatar feature.

> **Status:** built (`docs/development/remaining-work.md` prompt 7). Catalog: `server/src/shared/avatar.ts`; components: `client/src/components/Avatar.tsx` and `AvatarPicker.tsx`; layer files: `client/src/assets/avatar/`; migration `010_avatar_config_required.ts`. `docs/development/auth-follow-ups.md` §8 records why client SVG was removed.

## Avatar Configuration

Each player has exactly one avatar, defined by four required keys: `head`, `skin`, `face` and `hair`. Every value is a slug from the option catalog below. There is no separate avatar catalog table or player-avatar join table.

### Option catalog

| Key | Options | Slugs | What the slug chooses |
| --- | --- | --- | --- |
| `head` | 4 | `head-01` … `head-04` | Head shape (an SVG layer file) |
| `skin` | 6 | `skin-01` … `skin-06` | Fill colour applied to the head layer (not a file) |
| `face` | 6 | `face-01` … `face-06` | Facial features (an SVG layer file) |
| `hair` | 8 | `hair-01` … `hair-08` | Hairstyle (an SVG layer file) |

- Slugs are two-digit, zero-padded, and match `^(head|skin|face|hair)-\d{2}$`.
- The catalog lives in one shared module that both the client and the server import, so they always agree on valid slugs. Skin colour values (hex) are defined in that module next to the skin slugs.
- **Hair colour** is fixed in v1: every hairstyle uses the same colour, set with a single fill value. Hair layers are drawn with a fill (not baked-in colours) so a hair-colour choice can be added later without redrawing them. Adding one would add a fifth key and change this spec.
- Adding options later is safe. Removing or renaming a slug needs a migration that rewrites stored configs, because the server rejects unknown slugs.

## Data Model

```
avatar_config  jsonb, NOT NULL — { head, skin, face, hair }, each a slug from the
               option catalog. Example:
               {"head": "head-02", "skin": "skin-04", "face": "face-01", "hair": "hair-07"}
```

- Every user has an avatar. `avatar_config` is required at registration and is never null.
- The `avatar_svg` column is dropped. No composited SVG is cached; the client draws the avatar from the slugs.
- **Migration (prompt 7):** drop `avatar_svg`; give every existing user whose config is null or contains any slug outside the catalog a random valid config; then make `avatar_config` `NOT NULL`.

## API Endpoints

Avatar data is read and written via the existing user endpoints. All endpoints require an authenticated session cookie (`wizard_session`). Responses follow the standard envelope: `{ data, meta, errors }`.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/auth/register` | `avatarConfig` is required |
| GET | `/users/me` | Returns the authenticated user's profile, including `avatarConfig` |
| PATCH | `/users/me` | Pass `avatarConfig` to change the avatar |

- **Register:** `avatarConfig: { head, skin, face, hair }` is required. `avatarSvg` is not part of the API; if a client sends it, it is never stored or returned.
- **PATCH `/users/me`:** `avatarConfig` may be sent alone or with other mutable fields (`displayName`, password changes). The whole object is replaced; partial configs are rejected. Returns the updated `User` on 200. Idempotent.
- **Validation (both routes):** `avatarConfig` must be an object with exactly the keys `head`, `skin`, `face` and `hair`, each a string from that key's catalog. A missing key, an extra key, a wrong type or any unknown slug (for example `../x`, `<svg>`, `Round`, or a valid slug under the wrong key such as `head: "hair-01"`) returns `400 VALIDATION_ERROR`.
- `User` objects (REST and socket payloads) carry `avatarConfig` and no `avatarSvg`.

## Rendering

Avatars are images only in v1: no frames, badges or overlays.

**Assets:** SVG layer files bundled by Vite under `client/src/assets/avatar/` (`head/`, `face/`, `hair/`). They ship with the client build. There is no CDN, no thumbnail rasterisation and no server-side image processing. The same SVGs are used at every size.

**Layer stacking:** a fixed-size, square container with `position: relative`. The layers are drawn on top of each other with `position: absolute; inset: 0`, bottom to top:

1. `head` — filled with the `skin` colour (via a CSS custom property, for example `--avatar-skin`)
2. `face`
3. `hair` — filled with the fixed hair colour (`--avatar-hair`)

All layer files share one `viewBox` (`0 0 100 100`) so they line up at any size. Real art can replace the placeholder files later without code changes, as long as it keeps the `viewBox` and fills.

**Surfaces and sizes**

| Surface | Size (CSS) |
| --- | --- |
| Avatar picker preview | 128×128 px |
| Avatar picker option tiles | 64×64 px (touch target ≥ 44 px) |
| Profile page | 128×128 px |
| Room player list | 64×64 px |
| Lobby presence list | 40×40 px (player chip, `docs/design/ui-foundation.md`) |
| Game seat | 40×40 px (player chip) |
| Scoreboard row | 32×32 px |
| Lobby header profile link | 28×28 px |

**Rendering rules**

- Display avatars in a circle crop (`border-radius: 50%`). No square display anywhere in the UI.
- **Fallback:** if a config contains a slug the client doesn't know (for example an older client after an option was added), draw the default avatar for that layer: `head-01`, `skin-01`, `face-01`, `hair-01`. Never show a broken image.

## Frontend Integration

**Data flow**

1. On login, `GET /users/me` returns `avatarConfig`; it is kept in `AuthContext` with the rest of the current user.
2. Other players' `avatarConfig` arrives embedded in the existing payloads (`UserSummary` in `lobby_snapshot` / `presence_updated`, `MemberSummary` in `room_snapshot`, `avatar_config` in `user_joined` and in `game_started`'s `PlayerSummary`, the player list in game state). No separate avatar fetch.
3. The player changes their avatar in the picker → the preview updates live → on confirm, `PATCH /users/me` with `{ avatarConfig }` → on success, update `AuthContext`; on error, keep the previous avatar and show the error.

**Components**

- `<Avatar config size />` — stacks the layers for `config` at `size`, with the circle crop and per-layer fallback. Used on every surface.
- `<AvatarPicker value onChange />` — one row of option tiles per key, plus a live preview. Used at registration and on `/profile`. At registration it starts from a random valid config.

State lives in React context (`AuthContext`) only, per `CLAUDE.md`. No separate avatar store.

## Changing an Avatar

Players set their avatar at registration and may change it at any time on `/profile`.

- **No live broadcast.** Changing an avatar sends no socket event. Other players see the new avatar the next time they load it: the next `lobby_snapshot` or `room_snapshot` they receive, or after reloading the page. The player's own UI updates straight away from the PATCH response.
- **Games in progress** keep the avatar each player had when the game started, the same as display names.
- **Concurrent updates:** two sessions writing different configs at the same time → last writer wins. No conflict handling in v1.

## Edge Cases

- **Null config:** not possible after the prompt 7 migration (`NOT NULL`). There is no admin "reset avatar" action. If one is added, it sets a random valid config, not null.
- **Bot players** (out of scope) get a valid config when they are built, like any other user.
- **Unknown slug in a stored row:** prevented by server validation. The client per-layer fallback covers a client build older than the server's catalog.
