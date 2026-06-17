import crypto from 'crypto'

export function buildHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex')
}
