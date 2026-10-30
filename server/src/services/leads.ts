import type { Ctx } from '../context.js';
import { json } from '../db/db.js';
import type { Person } from '../drivers/types.js';
import { profileUrl, publicIdFromUrl } from '../drivers/types.js';
import { CampaignSettingsSchema, SequenceSchema, type Sequence } from '../engine/sequence.js';
import type { CampaignRow, LeadRow } from '../types.js';

export interface LeadInput {
  profileUrl: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  title?: string;
  company?: string;
  location?: string;
  email?: string | null;
  phone?: string | null;
  tags?: string[];
  custom?: Record<string, string>;
}

export function personToLead(p: Person): LeadInput {
  return {
    profileUrl: p.profileUrl,
    firstName: p.firstName,
    lastName: p.lastName,
    headline: p.headline,
    title: p.title,
    company: p.company,
    location: p.location,
    email: p.email,
    phone: p.phone,
  };
}

// Adds leads to a list, skipping any already in the workspace (matched on the profile slug).
export function importLeads(ctx: Ctx, workspaceId: number, listId: number, inputs: LeadInput[]) {
  let added = 0;
  let duplicates = 0;
  let invalid = 0;
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    for (const l of inputs) {
      const id = publicIdFromUrl(l.profileUrl ?? '');
      if (!id) {
        invalid++;
        continue;
      }
      const r = ctx.db.run(
        `INSERT OR IGNORE INTO leads (workspace_id, list_id, public_id, profile_url, first_name, last_name, headline, title, company, location, email, phone, tags, custom, created_at)
         VALUES ($ws, $list, $pid, $url, $fn, $ln, $hl, $title, $co, $loc, $email, $phone, $tags, $custom, $now)`,
        {
          ws: workspaceId,
          list: listId,
          pid: id,
          url: profileUrl(id),
          fn: (l.firstName ?? '').trim(),
          ln: (l.lastName ?? '').trim(),
          hl: (l.headline ?? '').trim(),
          title: (l.title ?? '').trim(),
          co: (l.company ?? '').trim(),
          loc: (l.location ?? '').trim(),
          email: l.email?.trim() || null,
          phone: l.phone?.trim() || null,
          tags: JSON.stringify(l.tags ?? []),
          custom: JSON.stringify(l.custom ?? {}),
          now,
        },
      );
      if (r.changes) added++;
      else duplicates++;
    }
  });
  return { added, duplicates, invalid };
}

// Fills in blanks on a lead from freshly scraped profile data; never overwrites what the user entered.
export function enrichLead(ctx: Ctx, lead: LeadRow, p: Person) {
  const patch: Record<string, string | number | null> = {};
  const fill = (col: keyof LeadRow, v: string | null | undefined) => {
    if (v && !lead[col]) patch[col] = v;
  };
  fill('first_name', p.firstName);
  fill('last_name', p.lastName);
  fill('headline', p.headline);
  fill('title', p.title);
  fill('company', p.company);
  fill('location', p.location);
  fill('email', p.email);
  fill('phone', p.phone);
  if (p.degree === 1 && lead.connection_status !== 'connected') {
    patch.connection_status = 'connected';
    patch.connected_at = ctx.clock.now();
  }
  ctx.db.update('leads', lead.id, patch);
  return { ...lead, ...patch } as LeadRow;
}

export function blacklistReason(ctx: Ctx, lead: LeadRow): string | null {
  const rows = ctx.db.all<{ kind: string; value: string }>('SELECT kind, value FROM blacklist WHERE workspace_id = ?', [lead.workspace_id]);
  const lc = (s: string | null) => (s ?? '').toLowerCase();
  for (const r of rows) {
    const v = r.value.toLowerCase();
    if (r.kind === 'profile' && (publicIdFromUrl(r.value) ?? v) === lead.public_id) return 'profile is blacklisted';
    if (r.kind === 'company' && lc(lead.company) === v) return `company "${r.value}" is blacklisted`;
    if (r.kind === 'keyword' && [lead.headline, lead.title, lead.company].some((f) => lc(f).includes(v))) return `keyword "${r.value}" is blacklisted`;
    if (r.kind === 'email_domain' && lc(lead.email).endsWith('@' + v.replace(/^@/, ''))) return `email domain "${r.value}" is blacklisted`;
  }
  return null;
}

export function campaignSequence(c: CampaignRow): Sequence {
  return SequenceSchema.parse(json(c.sequence, { start: null, nodes: {} }));
}

export function campaignSettings(c: CampaignRow) {
  return CampaignSettingsSchema.parse(json(c.settings, {}));
}

export function addLeadsToCampaign(ctx: Ctx, campaign: CampaignRow, leadIds: number[]) {
  const seq = campaignSequence(campaign);
  const settings = campaignSettings(campaign);
  const start = seq.start ? seq.nodes[seq.start] : null;
  const now = ctx.clock.now();
  const result = { added: 0, alreadyInCampaign: 0, inOtherCampaign: 0, blacklisted: 0, alreadyConnected: 0 };
  ctx.db.tx(() => {
    for (const id of leadIds) {
      const lead = ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [id, campaign.workspace_id]);
      if (!lead) continue;
      if (ctx.db.get('SELECT 1 FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?', [campaign.id, id])) {
        result.alreadyInCampaign++;
        continue;
      }
      if (settings.skipIfInOtherCampaign && ctx.db.get("SELECT 1 FROM campaign_leads WHERE lead_id = ? AND state = 'active'", [id])) {
        result.inOtherCampaign++;
        continue;
      }
      if (blacklistReason(ctx, lead)) {
        result.blacklisted++;
        continue;
      }
      if (settings.skipAlreadyConnected && lead.connection_status === 'connected') {
        result.alreadyConnected++;
        continue;
      }
      ctx.db.insert('campaign_leads', {
        campaign_id: campaign.id,
        lead_id: id,
        state: start ? 'active' : 'done',
        node_id: start?.id ?? null,
        node_type: start?.type ?? null,
        node_entered_at: now,
        next_run_at: now,
        added_at: now,
        finished_at: start ? null : now,
      });
      result.added++;
    }
  });
  return result;
}

export function publicLead(l: LeadRow) {
  return {
    id: l.id,
    profileUrl: l.profile_url,
    firstName: l.first_name,
    lastName: l.last_name,
    headline: l.headline,
    company: l.company,
    title: l.title,
    location: l.location,
    email: l.email,
    connectionStatus: l.connection_status,
  };
}
