import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt 参数：N=16384 在普通服务器上单次约 40~60ms，足以抵抗离线爆破
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
