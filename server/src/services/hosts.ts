import { BlockList, isIP } from 'node:net';
import { billingEnabled } from '../billing/limits.js';
import type { Ctx } from '../context.js';
import { MailError } from './email.js';

// Hosts that tenants type in (the OpenAI-compatible base URL, mailbox SMTP/IMAP servers). On a hosted
// installation (billing on) they must not reach the server's own network, so loopback, private, CGNAT,
// link-local (cloud metadata) and other non-public addresses are refused, when saved and again before each
// connection. Self-hosted installs allow them: Ollama on localhost or an in-house mail relay are normal there.

const blocked = new BlockList();
const V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT; also some clouds' metadata address
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];
const V6: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local (AWS's IPv6 metadata address fd00:ec2::254 too)
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
const hextets = (ip: string) => {
  const [a, b, c, d] = ip.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
};
for (const [net, bits] of V4) {
  blocked.addSubnet(net, bits, 'ipv4');
  // The same ranges written as IPv6: IPv4-mapped, NAT64 and 6to4 addresses reach IPv4 hosts too.
  const [hi, lo] = hextets(net);
  blocked.addSubnet(`::ffff:${hi}:${lo}`, 96 + bits, 'ipv6');
  blocked.addSubnet(`64:ff9b::${hi}:${lo}`, 96 + bits, 'ipv6');
  blocked.addSubnet(`2002:${hi}:${lo}::`, 16 + bits, 'ipv6');
}
for (const [net, bits] of V6) blocked.addSubnet(net, bits, 'ipv6');

export function isBlockedAddress(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').split('%')[0];
  const v = isIP(ip);
  return v ? blocked.check(ip, v === 6 ? 'ipv6' : 'ipv4') : false;
}

// BLOCKED: the host is on a private network (a settings problem). UNRESOLVED: DNS had no answer (may pass).
export class HostCheckError extends Error {
  constructor(
    readonly code: 'BLOCKED' | 'UNRESOLVED',
    message: string,
  ) {
    super(message);
  }
}

// Resolves a tenant-supplied host and refuses it when any of its addresses is non-public. Returns the address
// to connect to, so a second, different DNS answer (rebinding) can't redirect the connection; null when
// billing is off (nothing checked, the host is used as it is).
export async function checkHost(ctx: Ctx, rawHost: string): Promise<string | null> {
  if (!billingEnabled(ctx)) return null;
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await ctx.dns.lookup(host)).map((a) => a.address);
    } catch {
      addresses = [];
    }
    if (!addresses.length) throw new HostCheckError('UNRESOLVED', `Could not find the server ${host}`);
  }
  if (addresses.some(isBlockedAddress)) throw new HostCheckError('BLOCKED', `${host} is on a private or local network, which this hosted server doesn't connect to`);
  return addresses[0];
}

// For routes saving a host: a 400-ready message, or null when the host may be used.
export async function hostProblem(ctx: Ctx, host: string): Promise<string | null> {
  try {
    await checkHost(ctx, host);
    return null;
  } catch (e) {
    if (e instanceof HostCheckError) return e.message;
    throw e;
  }
}

// A URL's host, for the same checks (an invalid URL is left to the URL validation).
export function urlHost(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url.trim()).hostname || null;
  } catch {
    return null;
  }
}

// Mail servers right before connecting: the settings with `address` set to the checked IP (TLS still checks
// the certificate against `host`). A private host is the mailbox's settings problem (AUTH: it needs attention).
export async function pinMailServer<T extends { host: string; address?: string }>(ctx: Ctx, server: T): Promise<T> {
  try {
    const address = await checkHost(ctx, server.host);
    return address ? { ...server, address } : server;
  } catch (e) {
    if (e instanceof HostCheckError) throw new MailError(e.code === 'BLOCKED' ? 'AUTH' : 'TRANSIENT', e.message);
    throw e;
  }
}
