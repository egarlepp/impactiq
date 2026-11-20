import crypto from 'crypto'
import { TOKEN_ENCRYPTION_KEY } from './env.js'

const ALGORITHM = 'aes-256-gcm'

// Derive a stable 32-byte key from the configured secret. Accepts either a
// 64-char hex string (legacy shape) or any other string material; we hash
// down to 32 bytes so we don't have to enforce hex-only encoding.
function deriveKey(material: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(material)) {
    return Buffer.from(material, 'hex')
  }
  return crypto.createHash('sha256').update(material).digest()
}
const KEY = deriveKey(TOKEN_ENCRYPTION_KEY)

export function encryptToken(token: string): string {
  return encryptWith(KEY, token)
}

// The Setup wizard runs before TOKEN_ENCRYPTION_KEY is set, so it encrypts
// with the key the operator just generated on step 3 instead.
export function encryptTokenWithKey(token: string, keyMaterial: string): string {
  return encryptWith(deriveKey(keyMaterial), token)
}

function encryptWith(key: Buffer, token: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':')
}

export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(':')
  const ivHex = parts[0]
  const tagHex = parts[1]
  const dataHex = parts[2]
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid encrypted token format')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(tag)
  return decipher.update(dataHex, 'hex', 'utf8') + decipher.final('utf8')
}

// Short, non-reversible fingerprint of the encryption key, stored in database
// backups (services/backup) so a restore can warn when the target install's
// key differs — every encrypted value would then fail to decrypt. An HMAC of
// a fixed label, so it reveals nothing usable about the key itself.
export function encryptionKeyCheck(): string {
  return crypto.createHmac('sha256', KEY).update('impactiq-backup-key-check').digest('hex').slice(0, 16)
}
