import { createHash } from 'node:crypto';

// Simulated providers derive their "randomness" from a hash of their inputs, so the same lead
// always gets the same answer no matter in which order calls happen (and cached results match re-runs).
export function hashUnit(...parts: (string | number | null | undefined)[]): number {
  const h = createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

export function hashId(prefix: string, ...parts: (string | number | null | undefined)[]): string {
  return `${prefix}_${createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex').slice(0, 12)}`;
}

export function pick<T>(items: readonly T[], ...parts: (string | number | null | undefined)[]): T {
  return items[Math.floor(hashUnit(...parts) * items.length) % items.length];
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
