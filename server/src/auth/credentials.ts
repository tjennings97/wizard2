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
