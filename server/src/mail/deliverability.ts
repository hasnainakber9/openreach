import { lookup as osLookup, Resolver } from 'node:dns/promises';

// Checks a sending domain's DNS: MX (can receive replies and bounces), SPF (which servers may send for
// it), DKIM (signing key published) and DMARC (policy). Each check says pass/warn/fail with what to fix.
// The resolver is injected (ctx.dns), so tests never touch the network.

export interface DnsResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(domain: string): Promise<string[][]>;
  // Every address a host name resolves to, the way a connection would resolve it (hosts file included).
  lookup(host: string): Promise<{ address: string; family: number }[]>;
}

// Public resolvers used when the system's DNS server can't be reached for MX/TXT queries.
export const FALLBACK_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

// Parses DNS_SERVERS ("1.1.1.1, 8.8.8.8" or "none"): a list of servers, [] for "none", or null when unset.
export function dnsServersFrom(raw: string | undefined): string[] | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (v.toLowerCase() === 'none') return [];
  return v.split(/[\s,]+/).filter(Boolean);
}

type MxTxt = Pick<DnsResolver, 'resolveMx' | 'resolveTxt'>;

// MX and TXT queries go to the system's DNS servers. Node reads those itself, and on some Windows setups (VPNs,
// sandboxes, virtual adapters) it ends up with 127.0.0.1 where nothing listens, so every query is refused even
// though the computer resolves names fine. Then the query is repeated once through `fallback`; a server that
// answered (NXDOMAIN, no records...) is never second-guessed. DNS_SERVERS overrides the system servers and
// DNS_FALLBACK_SERVERS the fallback ("none" turns it off). Host lookups always use the OS (hosts file included).
export function withFallback(primary: MxTxt, fallback: MxTxt | null): MxTxt {
  const unreachable = (e: unknown) => ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes((e as { code?: string })?.code ?? '');
  const run = async <T>(q: (r: MxTxt) => Promise<T>): Promise<T> => {
    try {
      return await q(primary);
    } catch (e) {
      if (!fallback || !unreachable(e)) throw e;
      return q(fallback);
    }
  };
  return { resolveMx: (d) => run((r) => r.resolveMx(d)), resolveTxt: (d) => run((r) => r.resolveTxt(d)) };
}

export function systemResolver(env: NodeJS.ProcessEnv = process.env): DnsResolver {
  const make = (servers: string[] | null) => {
    const r = new Resolver({ timeout: 5000, tries: 2 });
    if (servers?.length) r.setServers(servers);
    return r;
  };
  const fallbackServers = dnsServersFrom(env.DNS_FALLBACK_SERVERS) ?? FALLBACK_DNS_SERVERS;
  const q = withFallback(make(dnsServersFrom(env.DNS_SERVERS)), fallbackServers.length ? make(fallbackServers) : null);
  return { ...q, lookup: (h) => osLookup(h, { all: true }) };
}

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface DnsCheck {
  id: 'mx' | 'spf' | 'dkim' | 'dmarc';
  status: CheckStatus;
  record?: string;
  message: string;
  fix?: string;
}
export interface DomainReport {
  domain: string;
  checks: DnsCheck[];
}

export const DKIM_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 's1', 'dkim', 'mail'];
const PRESET_SPF: Record<string, { include: string; label: string }> = {
  gmail: { include: '_spf.google.com', label: 'Google' },
  outlook: { include: 'spf.protection.outlook.com', label: 'Microsoft 365' },
};

export const isHostname = (d: string) => d.length <= 253 && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d);

// "No such record" is an answer, not an error; anything else (timeouts, SERVFAIL) is reported as unknown.
async function lookup<T>(fn: () => Promise<T[]>): Promise<{ records: T[]; error?: string }> {
  try {
    return { records: await fn() };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return { records: [] };
    return { records: [], error: code ?? (e as Error).message };
  }
}

const RESERVED_TLD = /(^|\.)(example|test|invalid|localhost)$/;

const txt = (records: string[][]) => records.map((parts) => parts.join(''));

export async function checkDomain(resolver: DnsResolver, rawDomain: string, opts: { dkimSelector?: string | null; preset?: string | null } = {}): Promise<DomainReport> {
  const domain = rawDomain.trim().toLowerCase().replace(/\.$/, '');
  // Reserved names (RFC 2606/6761, used by the demo and simulated mailboxes) have no DNS: answer without a lookup.
  if (RESERVED_TLD.test(domain)) {
    const message = `${domain} is a reserved example domain with no DNS records, so there is nothing to check.`;
    const fix = 'Run the check on the domain you really send from.';
    return { domain, checks: (['mx', 'spf', 'dkim', 'dmarc'] as const).map((id) => ({ id, status: 'warn' as const, message, fix })) };
  }
  const [mx, spf, dkim, dmarc] = await Promise.all([checkMx(resolver, domain), checkSpf(resolver, domain, opts.preset), checkDkim(resolver, domain, opts.dkimSelector), checkDmarc(resolver, domain)]);
  return { domain, checks: [mx, spf, dkim, dmarc] };
}

async function checkMx(r: DnsResolver, domain: string): Promise<DnsCheck> {
  const { records, error } = await lookup(() => r.resolveMx(domain));
  if (error) return { id: 'mx', status: 'warn', message: `Couldn't look up MX records (${error}). Try again later.` };
  if (!records.length) {
    return { id: 'mx', status: 'fail', message: 'No MX records: this domain cannot receive mail, so replies and bounces get lost and many servers distrust its mail.', fix: "Add MX records from your email provider's setup guide." };
  }
  const list = [...records].sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`);
  return { id: 'mx', status: 'pass', record: list.join(', '), message: `Mail for ${domain} is received by ${records.length === 1 ? 'one server' : `${records.length} servers`}.` };
}

async function checkSpf(r: DnsResolver, domain: string, preset?: string | null): Promise<DnsCheck> {
  const { records, error } = await lookup(() => r.resolveTxt(domain));
  if (error) return { id: 'spf', status: 'warn', message: `Couldn't look up TXT records (${error}). Try again later.` };
  const spf = txt(records).filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (!spf.length) {
    return {
      id: 'spf',
      status: 'fail',
      message: 'No SPF record: receiving servers can’t tell which servers may send for this domain, so mail is more likely to land in spam.',
      fix: `Add a TXT record on ${domain} such as "v=spf1 ${PRESET_SPF[preset ?? '']?.include ? `include:${PRESET_SPF[preset!].include} ` : ''}~all" (include every service that sends for you).`,
    };
  }
  if (spf.length > 1) return { id: 'spf', status: 'warn', record: spf.join(' | '), message: 'More than one SPF record: servers treat this as an error and SPF fails.', fix: 'Merge them into a single v=spf1 record.' };
  const record = spf[0];
  if (/(^|\s)\+all(\s|$)/i.test(record)) return { id: 'spf', status: 'warn', record, message: 'The SPF record ends with +all, which lets any server send as this domain.', fix: 'Use ~all (soft fail) or -all instead.' };
  const want = PRESET_SPF[preset ?? ''];
  if (want && !record.toLowerCase().includes(`include:${want.include}`)) {
    return { id: 'spf', status: 'warn', record, message: `The SPF record doesn't include ${want.label}'s servers, which send this mailbox's mail.`, fix: `Add include:${want.include} to the record.` };
  }
  return { id: 'spf', status: 'pass', record, message: 'One SPF record found.' };
}

async function checkDkim(r: DnsResolver, domain: string, selector?: string | null): Promise<DnsCheck> {
  const selectors = selector ? [selector.trim().toLowerCase()] : DKIM_SELECTORS;
  for (const s of selectors) {
    const { records } = await lookup(() => r.resolveTxt(`${s}._domainkey.${domain}`));
    const key = txt(records).find((t) => /(^|;)\s*p=[A-Za-z0-9+/=]{16,}/.test(t) || /v=DKIM1/i.test(t));
    if (key && /(^|;)\s*p=\s*(;|$)/.test(key)) return { id: 'dkim', status: 'fail', record: `${s}._domainkey`, message: `The DKIM key at selector "${s}" is empty (revoked).`, fix: 'Publish the current key from your email provider.' };
    if (key) return { id: 'dkim', status: 'pass', record: `${s}._domainkey`, message: `DKIM key found at selector "${s}".` };
  }
  return {
    id: 'dkim',
    status: 'warn',
    message: selector
      ? `No DKIM key at selector "${selector}".`
      : `No DKIM key at the common selectors (${DKIM_SELECTORS.join(', ')}). Your provider may use another one.`,
    fix: 'Turn on DKIM signing with your email provider and publish its TXT record, then check again with your selector (it appears as s= in the DKIM-Signature header of a sent email).',
  };
}

async function checkDmarc(r: DnsResolver, domain: string): Promise<DnsCheck> {
  const { records, error } = await lookup(() => r.resolveTxt(`_dmarc.${domain}`));
  if (error) return { id: 'dmarc', status: 'warn', message: `Couldn't look up the DMARC record (${error}). Try again later.` };
  const record = txt(records).find((t) => /^v=DMARC1/i.test(t.trim()));
  if (!record) {
    return { id: 'dmarc', status: 'fail', message: 'No DMARC record. Large mailbox providers expect one from bulk senders.', fix: `Add a TXT record on _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:dmarc@${domain}", then move to p=quarantine once reports look clean.` };
  }
  const policy = /(?:^|;)\s*p\s*=\s*(\w+)/i.exec(record)?.[1]?.toLowerCase();
  if (policy === 'quarantine' || policy === 'reject') return { id: 'dmarc', status: 'pass', record, message: `DMARC policy is "${policy}".` };
  return { id: 'dmarc', status: 'warn', record, message: 'DMARC policy is "none": it only monitors, so spoofed mail is still delivered.', fix: 'Once SPF and DKIM pass for all your senders, change p=none to p=quarantine.' };
}
