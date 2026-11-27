import { base32, generateInviteCode, generateTemporarySecret, normalizeInviteCode } from './credentials';

describe('base32', () => {
  it('matches the RFC 4648 test vectors (lowercase, unpadded)', () => {
    const enc = (s: string) => base32(Buffer.from(s, 'utf8'));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('my');
    expect(enc('fo')).toBe('mzxq');
    expect(enc('foo')).toBe('mzxw6');
    expect(enc('foob')).toBe('mzxw6yq');
    expect(enc('fooba')).toBe('mzxw6ytb');
    expect(enc('foobar')).toBe('mzxw6ytboi');
  });
});

describe('generateInviteCode', () => {
  it('encodes 128 random bits as grouped base32', () => {
    const code = generateInviteCode();
    // 16 bytes -> 26 base32 characters, in groups of 4.
    expect(code).toMatch(/^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
    expect(normalizeInviteCode(code)).toHaveLength(26);
  });

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 200 }, generateInviteCode));
    expect(codes.size).toBe(200);
  });
});

describe('normalizeInviteCode', () => {
  it('ignores case, spaces and dashes', () => {
    expect(normalizeInviteCode(' ABCD-efgh ijkl\n')).toBe('abcdefghijkl');
  });
});

describe('generateTemporarySecret', () => {
  it('is 20 base32 characters in groups of 4, within the bcrypt byte limit', () => {
    const secret = generateTemporarySecret();
    expect(secret).toMatch(/^([a-z2-7]{4}-){4}[a-z2-7]{4}$/);
    expect(Buffer.byteLength(secret)).toBeLessThanOrEqual(72);
    expect(generateTemporarySecret()).not.toBe(secret);
  });
});
