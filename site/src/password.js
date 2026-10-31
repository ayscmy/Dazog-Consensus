import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const N = 16384;
const KEYLEN = 32;

export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(plain), salt, KEYLEN, { N }).toString('hex');
  return `scrypt$${N}$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, n, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const calc = scryptSync(String(plain), salt, KEYLEN, { N: Number(n) || N });
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && timingSafeEqual(calc, expect);
  } catch {
    return false;
  }
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (n = 32) => randomBytes(n).toString('hex');
