import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Secrets at rest (LinkedIn session cookies, SMTP passwords) are sealed with AES-256-GCM
// under a key derived from APP_SECRET.
export class Sealer {
  private key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
  }

  open(sealed: string | null | undefined): string | null {
    if (!sealed) return null;
    const [v, iv, tag, body] = sealed.split('.');
    if (v !== 'v1') return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}
