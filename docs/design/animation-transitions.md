# Wizard — Animation & Transition Spec

## Principles

Animations serve the game, not the interface. Every motion either communicates state change, confirms a player action, or buys time for the server to respond. Decoration for its own sake is cut.

**Three rules that govern every animation in this spec:**

1. **Motion follows the server.** Nothing animates until the corresponding WebSocket event arrives. Optimistic animation is never used — a card that animates out then snaps back on `invalid_play_error` is worse than a brief wait.
2. **Parallel where possible, sequential only where necessary.** Multiple non-dependent changes animate simultaneously. Sequential chains are reserved for cause-and-effect moments (card played → trick winner declared → cards swept).
3. **Interruptible beats, uninterruptible resolutions.** Idle animations (turn indicator pulse, disconnect countdown) can be interrupted by a game event. Resolution animations (trick sweep, score count-up) run to completion before the next phase begins.

## Timing & Easing Reference

All durations and curves are defined as CSS custom properties on `:root`. Use these tokens everywhere — never hardcode a duration.

```css
/* Durations */
--duration-instant:   80ms;   /* state flips: disabled, selected */
--duration-fast:     150ms;   /* hover, focus, button press */
--duration-normal:   250ms;   /* panel open/close, toast slide-in */
--duration-slow:     400ms;   /* card play, card lift, modal */
--duration-dramatic: 600ms;   /* trick sweep, score count-up start */

/* Easing curves */
--ease-standard:  cubic-bezier(0.4, 0, 0.2, 1);  /* most UI motion */
--ease-decelerate: cubic-bezier(0, 0, 0.2, 1);   /* elements entering the screen */
--ease-accelerate: cubic-bezier(0.4, 0, 1, 1);   /* elements leaving the screen */
--ease-spring:    cubic-bezier(0.34, 1.56, 0.64, 1); /* card lift, selection bounce */
```

**Which curve to use:**

| Motion type | Curve | Example |
| --- | --- | --- |
| Entering screen | `--ease-decelerate` | Toast slide-in, modal open |
| Leaving screen | `--ease-accelerate` | Toast dismiss, modal close |
| Position change on screen | `--ease-standard` | Card move to table center |
| Elastic / tactile feel | `--ease-spring` | Card lift on hover, bid confirm |
| Opacity-only fade | `--ease-standard` | Seat dim on disconnect |

## Game Event Animations

Each entry maps a WebSocket event to its visual behaviour. Triggered on event, not on user action.

### `card_played` (on `card_played` broadcast)

Sequence (total \~550ms, first three run in parallel):

1. **Card lifts** from player's hand: `transform: translateY(-8px)` over `--duration-fast` with `--ease-spring`.
2. **Other hand cards** close the gap: `margin` collapses over `--duration-normal` with `--ease-standard`.
3. **Card travels** to table center: `transform: translate(x, y)` + `scale(0.9)` over `--duration-slow` with `--ease-standard`. Start position = card's current DOM coordinates (use `getBoundingClientRect`).
4. **Card lands** on table: brief scale pulse `scale(0.9 → 1.0)` over `--duration-fast` with `--ease-spring`.

If card is yours: trigger immediately on your `play_card` send. If another player: trigger on receipt of `card_played`.

---

### `invalid_play_error` (unicast, your turn only)

1. Card snaps back to hand with `--ease-spring` over `--duration-normal`.
2. Card flashes red: `box-shadow: 0 0 0 3px var(--color-danger)` pulses once over `--duration-fast`, fades over `--duration-normal`.
3. Toast slides in top-center: `invalid_play_error.reason` as the message, `--color-danger` variant, 3s auto-dismiss.
4. `legal_cards` from the payload → re-apply unplayable state (`opacity: 0.35`) to any cards not in that set.

---

### `trick_complete` (on `trick_complete` broadcast)

Sequential — wait for each step:

1. **Pause 400ms** after last card lands (let players read the trick).
2. **Winner highlight**: gold ring pulses on `winner_id` seat avatar — `box-shadow: 0 0 0 4px var(--accent-gold)` over `--duration-fast`, holds 600ms.
3. **Cards sweep** to winner's seat: all `cards_played` translate simultaneously toward winner seat position over `--duration-dramatic` with `--ease-accelerate`, then `opacity → 0` over `--duration-fast`.
4. **Trick counter** on winner's seat increments with a brief scale pop (`scale(1 → 1.2 → 1)` over `--duration-normal`).
5. If tricks remain: `play_request` arrives and next player's turn indicator activates.

---

### `round_complete` / Scoring overlay

Overlay fades in (`opacity: 0 → 1`, `--duration-normal`). Then score rows animate in sequence, 80ms stagger between rows:

1. Each row slides in from left (`translateX(-16px) → 0`, `--duration-normal`, `--ease-decelerate`).
2. **Delta values** count up from 0 to their final value over `--duration-dramatic`. Color: `--color-success` for exact bid, `--color-danger` for miss.
3. **Cumulative scores** update after deltas finish, with a brief number flash.
4. Hold for 3 seconds (countdown badge visible), then overlay dismisses and next round begins.

---

### `trump_revealed`

1. Trump card flips face-up: `rotateY(0 → 180deg)` over `--duration-slow` with `--ease-standard` (use CSS 3D transform with backface-visibility).
2. Trump suit indicator in the game HUD pulses in: `opacity: 0 → 1` + `scale(0.8 → 1)` over `--duration-normal` with `--ease-spring`.
3. If suit is trump, cards in hand with that suit get a subtle gold shimmer border (`--suit-trump-indicator`) over `--duration-normal`.

---

### `trump_selection_request` (dealer unicast)

1. Suit picker modal slides up from bottom: `translateY(100% → 0)` over `--duration-normal` with `--ease-decelerate`.
2. Other players see: trump card visible, spinner overlay on card with text "Dealer choosing…" — no animation needed, just opacity fade-in.
3. On `trump_revealed` broadcast: spinner fades out, suit picker dismisses with `translateY(0 → 100%)` over `--duration-fast`.

---

### `game_starting` (countdown)

1. Countdown badge renders in room center: number counts down from `countdown_seconds`.
2. Each tick: scale pulse `scale(1 → 1.15 → 1)` over 800ms, `--ease-spring`.
3. On 0: badge scales out `scale(1 → 0)` over `--duration-fast`, game board fades in `opacity: 0 → 1` over `--duration-normal`.

---

### `game_over` (win screen)

1. Overlay fades in over `--duration-slow`.
2. Winner name renders in Cinzel, scales in: `scale(0.8 → 1)` over `--duration-dramatic` with `--ease-spring`.
3. Confetti burst: CSS-only particle animation, 40 particles, random `translateY` + `rotate`, 1.2s duration, no loop.
4. Full scoreboard rows stagger in (same pattern as `round_complete`) 300ms after winner reveal.
5. Countdown badge for lobby return appears after 2s.

## UI State Animations

These are ambient or persistent animations tied to game state, not discrete events.

### Active turn indicator

Triggered when `play_request` or `bid_request` arrives for the current player. The seat avatar gets a gold ring that pulses continuously until the action is taken:

```css
@keyframes turn-pulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--accent-gold); }
  50%       { box-shadow: 0 0 0 5px var(--accent-gold), 0 0 12px rgba(201,168,76,0.4); }
}
.seat--active-turn {
  animation: turn-pulse 1.6s ease-in-out infinite;
}
```

Stop the animation immediately when `bid_placed` or `card_played` arrives for that player.

### Card hover (playable)

Applied only when it is the current player's turn and the card is in `legal_cards`:

```css
.card--playable:hover {
  transform: translateY(-8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  transition: transform var(--duration-fast) var(--ease-spring),
              box-shadow var(--duration-fast) var(--ease-standard);
}
```

### Card selected state

On click (first click = select, second click = play):

```css
.card--selected {
  transform: translateY(-8px);
  border: 2px solid var(--accent-gold);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4), 0 0 0 3px rgba(201,168,76,0.3);
  transition: all var(--duration-fast) var(--ease-spring);
}
```

### Disconnect countdown (on `user_left` with `reason: "timeout"` pending)

Triggered when another player's ping times out (30s window before `user_left` is broadcast). Show a countdown badge on their seat:

1. Seat dims to `opacity: 0.5` over `--duration-normal`.
2. Disconnect icon fades in over avatar.
3. Countdown badge (e.g. "28s") renders and decrements every second.
4. At 0: `user_left` arrives — seat either clears (lobby) or stays dimmed with "Disconnected" label (mid-game).

If the player reconnects (`player_reconnected`): reverse — seat brightens, badge clears, all over `--duration-normal`.

### Bid locked-in confirmation

On `bid_placed` for the current player (unicast confirmed):

1. Bid number chip on the player's seat bounces in: `scale(0 → 1.2 → 1)` over `--duration-normal` with `--ease-spring`.
2. Chip background: `--bg-elevated` with gold border.
3. If uneven rule active and player submitted the forbidden number: this never fires — `invalid_bid_error` fires instead (toast + re-enable picker).

## Implementation Notes

**Use CSS over JS for everything possible.** The timing token variables, keyframes, and class-toggled transitions above are all CSS. JS is only needed where DOM coordinates are required (card travel path in `card_played`, using `getBoundingClientRect`) or where an animation must be driven by a timer synced to the server (disconnect countdown, round end countdown).

**Reduce motion.** Respect the OS-level preference:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

State changes must still happen (cards must still move to the table) — only the motion is removed. Test all flows with reduced motion enabled.

**Card travel implementation.** The cleanest pattern for moving a card from hand to table is the FLIP technique (First, Last, Invert, Play):

1. Record the card's starting `getBoundingClientRect()`.
2. Move the card element to its final DOM position (table center).
3. Record the final `getBoundingClientRect()`.
4. Apply an inverted `transform` to snap it back to the start visually.
5. Animate `transform → none` — the browser does the rest.

This avoids absolute positioning or portal hacks and keeps the card in normal document flow at its destination.

**Stagger utility.** For lists that animate in (scoreboard rows, bidding order), use a CSS custom property for the delay:

```css
.score-row {
  animation: slide-in var(--duration-normal) var(--ease-decelerate) both;
  animation-delay: calc(var(--row-index) * 80ms);
}
```

Set `--row-index` via inline style in JSX: `style={{ '--row-index': index }}`.

**Animation sequencing.** For multi-step sequences like `trick_complete`, use a small promise chain or async/await rather than nested `setTimeout` calls. Tie each step to the `animationend` or `transitionend` event of the previous one where possible — this keeps timing correct even if the browser throttles the animation.

**Never animate during reconnection.** When a `state_snapshot` arrives (reconnect path), apply all state changes instantly with `transition: none` — do not replay animations. The player needs to see the current state immediately, not watch a sequence of events they missed.
