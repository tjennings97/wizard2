import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcrypt';

/** bcrypt work factor for passwords and recovery passphrases. See docs/architecture/security.md. */
export const BCRYPT_WORK_FACTOR = 12;

export function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_WORK_FACTOR);
}

export function verifySecret(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// A valid hash of a random value, used so that a login for an unknown username costs the same
// bcrypt time as a real one and response timing does not reveal which usernames exist.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), BCRYPT_WORK_FACTOR);

export async function burnVerifyTime(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}

/** 256-bit random session token. Lives only in the client's HTTP-only cookie. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest. Used for session tokens and invite codes, which are high-entropy random
 * values (a fast hash is appropriate; bcrypt is not needed). Only the digest is stored.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// Lowercase RFC 4648 base32: no case to get wrong when a code is read out or typed on a phone.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** "abcd-efgh-…": dashes every 4 characters, for reading a value out or copying it by hand. */
const grouped = (value: string): string => value.match(/.{1,4}/g)!.join('-');

/**
 * Admin invite code: 128 random bits (docs/architecture/security.md), as grouped base32.
 * Only sha256(normalizeInviteCode(code)) is stored; the raw code is returned once.
 */
export function generateInviteCode(): string {
  return grouped(base32(randomBytes(16)));
}

/**
 * The canonical form of a typed invite code: lowercase with spaces and dashes removed, so the
 * code matches however it was copied. The stored hash is of this form.
 */
export function normalizeInviteCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

/**
 * A temporary password or recovery passphrase set by an admin credential reset: 100 random bits
 * as grouped base32 (20 characters plus dashes). The user must replace it on next login.
 */
export function generateTemporarySecret(): string {
  return grouped(base32(randomBytes(13)).slice(0, 20));
}
