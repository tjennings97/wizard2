# Wizard — UI Foundation Brief

## Design Philosophy

Wizard is a classic card game with real depth — the UI should feel like a premium digital card game, not a generic SaaS dashboard. Think **dark felt table, rich jewel-tone suits, crisp card faces** — but fully modern: clean hierarchy, smooth transitions, and legible at a glance.

**Three principles to hold throughout the build:**

1. **The game is the hero.** Every non-game screen (lobby, auth, admin) should feel like a quiet anteroom to the table. Reduce visual noise outside the game board so the board itself feels like an event.
2. **State is always visible.** Your flows are event-driven and real-time. The UI must never leave a player wondering whose turn it is, what the trump suit is, or how many tricks they need. Information hierarchy > decoration.
3. **Feedback is immediate.** Cards dim when unplayable. Bids lock in with a satisfying confirmation. Trick resolution has a brief animation beat. Small moments of polish make a card game feel alive.

## Color System

The palette draws from the physical game: deep greens of a card table, warm ivory of card stock, and the four suit colors. Keep it dark-first — this is played in the evening, in short bursts, often on a screen.

**Background layers (dark-first)**

- `--bg-base: #0f1a14` — near-black green, the felt table
- `--bg-surface: #1a2b1e` — slightly lighter, for panels and modals
- `--bg-elevated: #243324` — cards, inputs, active elements

**Primary accent**

- `--accent-gold: #c9a84c` — warm gold for CTAs, active state, bid confirmations. Classic card game energy.
- `--accent-gold-hover: #e0bf6a` — lighter on hover

**Suit colors** (use sparingly — on card faces and trump indicators only)

- `--suit-spades: #e8e8e8` — near-white
- `--suit-hearts: #e05252` — rich red
- `--suit-diamonds: #e05252` — same red (standard)
- `--suit-clubs: #e8e8e8` — near-white
- `--suit-trump-indicator: #c9a84c` — gold border/glow when suit is trump

**Text**

- `--text-primary: #f0ead6` — warm ivory, main text
- `--text-secondary: #8a9e8d` — muted green-gray, labels and metadata
- `--text-disabled: #4a5c4d` — dimmed cards, inactive controls

**Feedback**

- `--color-success: #4caf7d` — exact bid hit, round won
- `--color-danger: #e05252` — bid miss, invalid play
- `--color-warning: #d4a030` — disconnect timer, 30s countdown

**Border**

- `--border-subtle: #2e3f30` — dividers, card outlines at rest
- `--border-active: #c9a84c` — selected card, active input

## Typography & Spacing

**Fonts**

Two fonts only:

- **Display: Cinzel** (Google Fonts) — for the logo, game title, wizard/jester card labels, and win screen. It reads as classic and slightly arcane without being unreadable.
- **UI: Inter** (Google Fonts) — for everything else. Legible at small sizes, works great in dark UIs, widely supported.

```css
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600&display=swap');

--font-display: 'Cinzel', serif;
--font-ui: 'Inter', sans-serif;
```

**Type scale**

| Role | Size | Weight | Font |
| --- | --- | --- | --- |
| Logo / Win screen | 2.5rem | 700 | Cinzel |
| Section heading | 1.25rem | 600 | Inter |
| Body / chat | 1rem | 400 | Inter |
| Label / metadata | 0.875rem | 500 | Inter |
| Badge / tiny | 0.75rem | 600 | Inter |

**Spacing system**

Base unit: **8px**. Use only multiples: `4, 8, 12, 16, 24, 32, 48, 64px`. Assign to CSS variables:

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-6: 24px;
--space-8: 32px;
--space-12: 48px;
--space-16: 64px;
```

Rule of thumb: padding inside a card or panel = `--space-6`. Gap between sibling cards = `--space-4`. Page margins = `--space-8` on desktop, `--space-4` on mobile.

**Border radius**

- Cards: `8px` — a slight softening, not bubbly
- Buttons: `6px`
- Badges / chips: `999px` (pill)
- Modals / panels: `12px`

## Core Components

Define these once, reuse everywhere. Build them as your first components before any screen.

**1. Button**

- **Primary** — gold bg (`--accent-gold`), dark text, `6px` radius. Use for: Start Game, Submit Bid, Play Card confirm.
- **Secondary** — transparent bg, gold border, gold text. Use for: Leave Room, Cancel.
- **Ghost** — no border, muted text (`--text-secondary`). Use for: View Scoreboard, toggle spectator.
- **Danger** — red bg, white text. Use for: Quit Game, Admin revoke.
- All buttons: `padding: 10px 20px`, `font-weight: 600`, `font-size: 0.875rem`, `transition: background 150ms ease`.
- Disabled state: `opacity: 0.4`, `cursor: not-allowed`. Never remove the button from the DOM — just disable it.

**2. Card (playing card)**

The most important component in the app.

- Size: `80x112px` at rest. Scale to `60x84px` for tight hands.
- Front: cream bg `#f5f0e8`, suit symbol top-left and bottom-right, rank center-large.
- Back: dark green CSS repeating-gradient pattern (no image dependency).
- Playable: full opacity, lift on hover (`transform: translateY(-8px)`).
- Unplayable: `opacity: 0.35`, no hover, `cursor: not-allowed`.
- Selected: `border: 2px solid var(--accent-gold)`, lifted.
- Wizard card: gold border, label WIZARD in Cinzel.
- Jester card: violet accent `#9b59b6`, label JESTER in Cinzel.

**3. Input field**

- Bg: `--bg-elevated`, border: `--border-subtle`, radius `6px`, padding `10px 14px`.
- Focus: border → `--accent-gold`, glow `box-shadow: 0 0 0 3px rgba(201,168,76,0.2)`.
- Error: border `--color-danger`, message below in `0.75rem`.

**4. Player avatar chip**

Used in lobby, room player list, and game board seats.

- Circle `40px`, color/image from avatar spec.
- Username label below in `0.75rem --text-secondary`.
- Status ring: gold = current turn, green = connected, red = disconnected.
- Host crown icon overlaid top-right when player is host.

**5. Scoreboard row**

- Columns: Avatar+Name, Bid, Won, Delta, Cumulative.
- Active player row: `3px solid var(--accent-gold)` left border.
- Exact bid delta in `--color-success`; over/under in `--color-danger`.
- Sticky header, scrollable body when more than 5 players.

**6. Toast / notification**

- Top-center, slides in, auto-dismisses after 3s.
- Variants: info (blue), success (green), warning (gold), error (red).
- Use for: invalid card rejection, disconnect notice, host transfer alert.

## Screen-by-Screen Guidance

Key design decisions for each of your 10 flows, based on what matters most per screen.

**Auth (Flow 1)** Center-column layout, max-width `400px`. Dark bg with a subtle card-pattern texture (CSS, not an image). Logo in Cinzel top-center. Single visible form at a time — Login, Register, or Reset, toggled by text links not tabs. The forced credential change screen should look like a warning: amber banner at top, same form layout below.

**Lobby (Flow 2)** Two-panel layout: room list (left, \~65%) + presence sidebar (right, \~35%). Room cards show: room name, host avatar, player count (e.g. "3/6"), and a Join button. A user already in a game sees those controls disabled with a tooltip. Empty state: centered illustration + "No rooms open — create one?" CTA. Real-time updates animate in (fade/slide), don't flash the whole list.

**Room / Pre-Game (Flow 3)** Player list is the hero — show avatars large, in join order. Host sees controls in a panel on the right (round count selector + bid rule toggle + Start Game button). Non-host sees the same panel grayed with "Waiting for host…". Chat sits below the player list. The 10-minute room timeout should show a countdown badge once under 2 minutes remain.

**Trump Determination (Flow 4)** This is a quick transition moment, not a full screen. Show a modal or overlay: the flipped card large in the center, trump suit indicator updating. The dealer's suit-selection prompt is a simple 4-button grid (♠ ♥ ♦ ♣). Others see a spinner + "Waiting for dealer to choose trump." Resolve in under 2 seconds visually.

**Bidding Phase (Flow 5)** The game board stays visible behind a bidding panel. Show each player's seat and a "?" chip until their bid is locked. The active bidder sees a number picker (0 to N), large and touch-friendly. Uneven rule: grey out the forbidden number with a tooltip explaining why. Scoreboard strip visible at top showing round number and bids so far.

**Trick Phase (Flow 6)** This is the core loop — invest design time here. Layout: player hand at the bottom, trick play area (table center), other players' seats around the edges showing card-back stacks (count visible). The active player's turn is announced with a gold pulse on their seat + a "Your turn" banner. Played cards animate to the center table. Invalid play: card snaps back with a brief red flash + toast.

**Round End / Scoring (Flow 7)** Full-screen modal overlay (not navigation). Shows each player in a results table: bid, won, delta (colored), new cumulative. Animate the delta numbers counting up. "Next Round" happens automatically — show a 3-second countdown so players can read the scores before it clears.

**Game End (Flow 8)** Celebration moment — winner(s) get visual emphasis (gold crown, name in Cinzel, confetti burst). Full scoreboard below as a round-by-round table. 30-second countdown timer at the bottom: "Returning to lobby in 0:28…" with a Leave Now button for impatient players.

**Player Drop (Flow 9)** Disconnect state: that player's seat dims, a disconnect icon replaces their avatar, and a 30s timer badge counts down on their seat. If the game pauses for their turn, show a "Game paused — waiting for reconnect" banner. The continue-or-end prompt (2-player scenario) is a modal with a 60s countdown — both players must see it and respond.

**Admin Panel (Flow 10)** Simple and functional — this is not a showcase screen. White-ish surface on dark bg. Two tabs: Invites and Users. Invite table is clean data: code (monospace), label, status badge (pill: pending/accepted/expired/revoked), expiry, revoke button. New invite generation is a side panel or modal. Role upgrade requires a confirmation step — destructive actions always need two clicks.
