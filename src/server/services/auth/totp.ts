import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// RFC 6238 TOTP with SHA-1, 6 digits, 30-second window. Compatible with
// every authenticator app (Google Authenticator, 1Password, Authy, Microsoft
// Authenticator, etc.). Hand-rolled from node:crypto — no npm dep.

const DIGITS = 6
const STEP_SECONDS = 30

// Base32 alphabet per RFC 4648 §6. Case-insensitive on input.
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 0x1f]
  return output
}

export function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

// New 160-bit (20-byte) secret. Length matches the RFC 6238 test-vector width
// and is what most authenticator apps expect.
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

function hotp(secret: Buffer, counter: bigint): string {
  const counterBuf = Buffer.alloc(8)
  counterBuf.writeBigUInt64BE(counter)
  const digest = createHmac('sha1', secret).update(counterBuf).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!
  const code = (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0')
  return code
}

// Verify a 6-digit code against the secret. Accepts the current 30s window
// plus ±1 window to tolerate mild clock drift between the user's device and
// the server. Timing-safe compare on the digits so millisecond timing can't
// leak the correct value.
export function verifyTotp(secretBase32: string, code: string): boolean {
  const trimmed = code.trim().replace(/\s+/g, '')
  if (!/^\d{6}$/.test(trimmed)) return false
  const secret = base32Decode(secretBase32)
  const now = Math.floor(Date.now() / 1000)
  const counter = BigInt(Math.floor(now / STEP_SECONDS))
  const candidateBuf = Buffer.from(trimmed)
  for (const shift of [-1n, 0n, 1n]) {
    const expected = Buffer.from(hotp(secret, counter + shift))
    if (expected.length === candidateBuf.length && timingSafeEqual(expected, candidateBuf)) return true
  }
  return false
}

// otpauth:// URL for the QR code. Any authenticator app parses this format.
export function otpauthUrl(secretBase32: string, accountLabel: string, issuer = 'ImpactIQ'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`)
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
