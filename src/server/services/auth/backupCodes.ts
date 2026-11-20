import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'

// Recovery codes for MFA. Single-use: consumed on redeem, regenerated
// wholesale (never patched). Stored scrypt-hashed alongside the user.
// Format: 5-4-4 alphanumeric (13 chars visible, 13 letters of entropy).

const CODE_COUNT = 10
const HASH_KEYLEN = 32

function randomCode(): string {
  // Crockford-ish base32 (no I / L / O / U to avoid confusion). 13 chars ≈ 65 bits.
  // Use crypto.randomInt (rejection sampling) rather than randomBytes % len,
  // which biases toward the first 256 % 30 = 16 symbols.
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 13; i++) {
    out += alphabet[randomInt(alphabet.length)]
    if (i === 4 || i === 8) out += '-'
  }
  return out
}

interface HashedCode { salt: string; hash: string }

function hashCode(code: string): HashedCode {
  const salt = randomBytes(16)
  const hash = scryptSync(code, salt, HASH_KEYLEN)
  return { salt: salt.toString('hex'), hash: hash.toString('hex') }
}

export function generateBackupCodes(): { plain: string[]; hashes: HashedCode[] } {
  const plain: string[] = []
  const hashes: HashedCode[] = []
  for (let i = 0; i < CODE_COUNT; i++) {
    const code = randomCode()
    plain.push(code)
    hashes.push(hashCode(code))
  }
  return { plain, hashes }
}

// Verifies the code against the stored hashes and returns the *remaining*
// hashes (with the matched one removed) so the caller can save the shortened
// list. Returns null when no code matches.
export function consumeBackupCode(entered: string, stored: HashedCode[]): HashedCode[] | null {
  const normalized = entered.trim().toUpperCase()
  const enteredBuf = Buffer.from(normalized)
  for (let i = 0; i < stored.length; i++) {
    const h = stored[i]!
    const expected = scryptSync(normalized, Buffer.from(h.salt, 'hex'), HASH_KEYLEN)
    const storedBuf = Buffer.from(h.hash, 'hex')
    if (expected.length !== storedBuf.length) continue
    if (timingSafeEqual(expected, storedBuf)) {
      // Match. Return the remaining codes minus this one.
      void enteredBuf // keep for symmetry
      return [...stored.slice(0, i), ...stored.slice(i + 1)]
    }
  }
  return null
}
