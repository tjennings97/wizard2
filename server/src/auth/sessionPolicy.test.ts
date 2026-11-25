import {
  EXTEND_MIN_STEP_MS,
  isInReauthWindow,
  SESSION_IDLE_TTL_MS,
  SESSION_MAX_LIFETIME_MS,
  slidExpiry,
} from './sessionPolicy';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const at = (offsetMs: number) => new Date(NOW + offsetMs);

describe('isInReauthWindow', () => {
  it('is false for a fresh session', () => {
    expect(isInReauthWindow(at(0), NOW)).toBe(false);
  });

  it('is false with just over 24h left before the 30-day cap', () => {
    expect(isInReauthWindow(at(-SESSION_MAX_LIFETIME_MS + 24 * HOUR + 1), NOW)).toBe(false);
  });

  it('is true with exactly 24h left', () => {
    expect(isInReauthWindow(at(-SESSION_MAX_LIFETIME_MS + 24 * HOUR), NOW)).toBe(true);
  });

  it('is true with 1h left', () => {
    expect(isInReauthWindow(at(-SESSION_MAX_LIFETIME_MS + HOUR), NOW)).toBe(true);
  });
});

describe('slidExpiry', () => {
  it('moves expiry to now + 24h on activity', () => {
    const created = at(-2 * HOUR);
    expect(slidExpiry(created, at(HOUR), NOW)).toEqual(at(SESSION_IDLE_TTL_MS));
  });

  it('does not write when the move would be under the minimum step', () => {
    const created = at(-2 * HOUR);
    const expires = at(SESSION_IDLE_TTL_MS - EXTEND_MIN_STEP_MS + 1);
    expect(slidExpiry(created, expires, NOW)).toBeNull();
  });

  it('never moves expiry past the 30-day cap', () => {
    const created = at(-SESSION_MAX_LIFETIME_MS + 2 * HOUR);
    expect(slidExpiry(created, at(60 * 1000), NOW)).toEqual(at(2 * HOUR));
  });

  it('returns null once expiry already sits at the cap', () => {
    const created = at(-SESSION_MAX_LIFETIME_MS + 2 * HOUR);
    expect(slidExpiry(created, at(2 * HOUR), NOW)).toBeNull();
  });
});
