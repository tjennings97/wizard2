import { ApiError } from '../http/errors';
import type { AvatarConfig } from './users';

// Limits from the auth request schemas in docs/api/openapi-spec.md.
export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
export const DISPLAY_NAME_MAX = 64;
export const SECRET_MIN = 8;
// bcrypt only uses the first 72 bytes of its input. Rejecting longer secrets avoids silently
// ignoring the tail (and stops very large bodies from reaching bcrypt).
export const SECRET_MAX_BYTES = 72;
const AVATAR_KEYS = ['head', 'skin', 'face', 'hair'] as const;
const AVATAR_SLUG_MAX = 64;

type FieldErrors = Record<string, string>;

/** Collects field errors for one request body; throws a 400 VALIDATION_ERROR if any were found. */
export class BodyValidator {
  private readonly errors: FieldErrors = {};
  private readonly body: Record<string, unknown>;

  constructor(body: unknown) {
    this.body = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }

  /** Non-empty string. Used for credentials submitted to login/reset, which are not format-checked. */
  presentString(field: string): string {
    const value = this.body[field];
    if (typeof value !== 'string' || value.length === 0) {
      this.errors[field] = 'Required.';
      return '';
    }
    return value;
  }

  username(field = 'username'): string {
    const value = this.body[field];
    if (typeof value !== 'string' || !USERNAME_PATTERN.test(value)) {
      this.errors[field] = 'Username must be 3–32 lowercase alphanumeric characters or underscores.';
      return '';
    }
    return value;
  }

  displayName(field = 'displayName'): string {
    const value = this.body[field];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX) {
      this.errors[field] = `Display name must be 1–${DISPLAY_NAME_MAX} characters.`;
      return '';
    }
    return trimmed;
  }

  /** A new password or recovery passphrase. */
  newSecret(field: string): string {
    const value = this.body[field];
    if (typeof value !== 'string' || value.length < SECRET_MIN) {
      this.errors[field] = `Must be at least ${SECRET_MIN} characters.`;
      return '';
    }
    if (Buffer.byteLength(value, 'utf8') > SECRET_MAX_BYTES) {
      this.errors[field] = `Must be at most ${SECRET_MAX_BYTES} bytes.`;
      return '';
    }
    return value;
  }

  avatarConfig(field = 'avatarConfig'): AvatarConfig {
    const value = this.body[field];
    const fallback: AvatarConfig = { head: '', skin: '', face: '', hair: '' };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.errors[field] = 'Must be an object with head, skin, face and hair.';
      return fallback;
    }
    const obj = value as Record<string, unknown>;
    const extra = Object.keys(obj).filter((k) => !(AVATAR_KEYS as readonly string[]).includes(k));
    const bad = AVATAR_KEYS.filter((k) => {
      const v = obj[k];
      return typeof v !== 'string' || v.length === 0 || v.length > AVATAR_SLUG_MAX;
    });
    if (extra.length > 0 || bad.length > 0) {
      this.errors[field] = 'Must be an object with exactly head, skin, face and hair (non-empty strings).';
      return fallback;
    }
    return { head: obj.head as string, skin: obj.skin as string, face: obj.face as string, hair: obj.hair as string };
  }

  /** Required key whose value is a string or null. */
  nullableString(field: string): string | null {
    if (!(field in this.body)) {
      this.errors[field] = 'Required (may be null).';
      return null;
    }
    const value = this.body[field];
    if (value !== null && typeof value !== 'string') {
      this.errors[field] = 'Must be a string or null.';
      return null;
    }
    return value;
  }

  done(): void {
    const fields = Object.keys(this.errors);
    if (fields.length > 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Invalid request body: ${fields.join(', ')}.`, {
        fields: this.errors,
      });
    }
  }
}
