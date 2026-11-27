import { ApiError } from '../http/errors';
import { avatarConfigError, type AvatarConfig } from '../shared/avatar';

// Limits from the auth request schemas in docs/api/openapi-spec.md.
export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
export const DISPLAY_NAME_MAX = 64;
export const SECRET_MIN = 8;
// bcrypt only uses the first 72 bytes of its input. Rejecting longer secrets avoids silently
// ignoring the tail (and stops very large bodies from reaching bcrypt).
export const SECRET_MAX_BYTES = 72;

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

  /** A whole avatarConfig: exactly the four keys, each a slug from the shared catalog. */
  avatarConfig(field = 'avatarConfig'): AvatarConfig {
    const value = this.body[field];
    const error = avatarConfigError(value);
    if (error !== null) {
      this.errors[field] = error;
      return { head: '', skin: '', face: '', hair: '' };
    }
    const obj = value as AvatarConfig;
    return { head: obj.head, skin: obj.skin, face: obj.face, hair: obj.hair };
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
