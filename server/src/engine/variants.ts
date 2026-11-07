import { createHash } from 'node:crypto';
import type { Ctx } from '../context.js';
import { logActivity } from '../services/activity.js';
import type { CampaignLeadRow, CampaignRow } from '../types.js';
import { abMetric, isAbTest, nodeVariants, type AbMetric, type Sequence, type VariantContent, type VariantId, type VariantNode } from './sequence.js';

// A/B testing of message variants. Each lead gets one variant per step, picked by a hash so the
// split is even and repeatable; once a winner is set (by hand or automatically) later leads get it.
// A winner row with a NULL variant means a user chose to split again: leads split and auto-pick stays off.

// Two-sided 95% confidence.
const Z_SIGNIFICANT = 1.96;
// Below this many sends per variant, rates are too noisy to call.
const MIN_SENDS = 20;

// Stable index in [0, n) for a lead at a step: first 4 bytes of sha256("campaign:node:lead").
export function variantIndex(campaignId: number, nodeId: string, leadId: number, n: number): number {
  return createHash('sha256').update(`${campaignId}:${nodeId}:${leadId}`).digest().readUInt32BE(0) % n;
}

export function winnerOf(ctx: Ctx, campaignId: number, nodeId: string) {
  return ctx.db.get<{ variant: VariantId | null; decided_by: 'auto' | 'user'; decided_at: number }>(
    'SELECT variant, decided_by, decided_at FROM campaign_node_winners WHERE campaign_id = ? AND node_id = ?',
    [campaignId, nodeId],
  );
}

// The variant this lead gets at this step, or null for a step without variants (its own text is sent).
// A stored choice sticks, unless an edit removed that variant; then the lead is assigned again.
export function assignVariant(ctx: Ctx, campaign: CampaignRow, cl: Pick<CampaignLeadRow, 'id' | 'lead_id'>, node: VariantNode): VariantId | null {
  if (!isAbTest(node)) return null;
  const ids = nodeVariants(node).map((v) => v.id);
  const stored = ctx.db.get<{ variant: VariantId }>('SELECT variant FROM campaign_lead_variants WHERE campaign_lead_id = ? AND node_id = ?', [cl.id, node.id]);
  if (stored && ids.includes(stored.variant)) return stored.variant;

  // A winner whose variant was deleted no longer applies.
  const old = winnerOf(ctx, campaign.id, node.id);
  if (old?.variant && !ids.includes(old.variant)) ctx.db.run('DELETE FROM campaign_node_winners WHERE campaign_id = ? AND node_id = ?', [campaign.id, node.id]);
  maybePickWinner(ctx, campaign, node);
  const winner = winnerOf(ctx, campaign.id, node.id)?.variant;
  const variant = winner ?? ids[variantIndex(campaign.id, node.id, cl.lead_id, ids.length)];
  ctx.db.run(
    `INSERT INTO campaign_lead_variants (campaign_lead_id, node_id, variant, assigned_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (campaign_lead_id, node_id) DO UPDATE SET variant = excluded.variant, assigned_at = excluded.assigned_at`,
    [cl.id, node.id, variant, ctx.clock.now()],
  );
  return variant;
}

// One row per lead the step sent to: which variant it got and what happened after.
export interface VariantRow {
  variant: string;
  accepted: number;
  replied: number;
}

export interface VariantStat {
  id: string;
  sent: number;
  accepted: number;
  replied: number;
  // Percent of sends that reached the metric, one decimal.
  rate: number;
  leader: boolean;
  significant: boolean;
}

// Two-proportion z-test of x1/n1 against x2/n2 (pooled). 0 when either side has no data or nothing varies.
export function zScore(x1: number, n1: number, x2: number, n2: number): number {
  if (!n1 || !n2) return 0;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se ? (x1 / n1 - x2 / n2) / se : 0;
}

// Per-variant results. The leader is the variant with the strictly best rate (none on a tie or with
// no sends); it is significant when every variant has enough sends and it beats the runner-up at 95%.
export function variantStats(rows: VariantRow[], metric: AbMetric, ids: string[] = [...new Set(rows.map((r) => r.variant))].sort()): VariantStat[] {
  const stats = ids.map((id) => {
    const mine = rows.filter((r) => r.variant === id);
    const sent = mine.length;
    const accepted = mine.filter((r) => r.accepted).length;
    const replied = mine.filter((r) => r.replied).length;
    const hits = metric === 'accepted' ? accepted : replied;
    return { id, sent, accepted, replied, hits, rate: sent ? Math.round((hits / sent) * 1000) / 10 : 0, leader: false, significant: false };
  });
  const ranked = stats.filter((s) => s.sent > 0).sort((a, b) => b.hits / b.sent - a.hits / a.sent || a.id.localeCompare(b.id));
  const [first, second] = ranked;
  if (first && (!second || first.hits / first.sent > second.hits / second.sent)) {
    first.leader = true;
    first.significant = !!second && stats.every((s) => s.sent >= MIN_SENDS) && zScore(first.hits, first.sent, second.hits, second.sent) >= Z_SIGNIFICANT;
  }
  return stats.map(({ hits: _hits, ...s }) => s);
}

// The variant auto-pick may keep: the strict leader, once every variant has been sent and the leader has at
// least one result. Otherwise null, so a tie or an all-0% start (invites are accepted days later) keeps splitting.
export function bestVariant(stats: VariantStat[], metric: AbMetric): string | null {
  const leader = stats.find((s) => s.leader);
  if (!leader || stats.some((s) => s.sent === 0)) return null;
  return (metric === 'accepted' ? leader.accepted : leader.replied) > 0 ? leader.id : null;
}

// Sent = distinct leads with an ok activity of the step's type for that variant (an InMail step's sends to
// connections are logged as messages). Accepted = connected to
// the sending account at or after the send (leads.connected_at when there is no per-account row).
// Replied = a reply logged at or after the send. Sends made before the variant's text last changed (or before
// its letter was reused) were of an older text and are left out.
export function variantRows(ctx: Ctx, campaignId: number, node: VariantNode): VariantRow[] {
  return ctx.db.all<VariantRow>(
    `SELECT s.variant,
       CASE WHEN EXISTS (SELECT 1 FROM lead_connections lc WHERE lc.lead_id = s.lead_id AND lc.account_id = s.account_id AND lc.status = 'connected' AND lc.connected_at >= s.sent_at)
              OR (NOT EXISTS (SELECT 1 FROM lead_connections lc WHERE lc.lead_id = s.lead_id AND lc.account_id = s.account_id)
                  AND EXISTS (SELECT 1 FROM leads l WHERE l.id = s.lead_id AND l.connection_status = 'connected' AND l.connected_at >= s.sent_at))
            THEN 1 ELSE 0 END AS accepted,
       CASE WHEN EXISTS (SELECT 1 FROM activity r WHERE r.lead_id = s.lead_id AND r.type = 'replied' AND r.created_at >= s.sent_at) THEN 1 ELSE 0 END AS replied
     FROM (SELECT a.lead_id, MIN(a.variant) AS variant, MIN(a.account_id) AS account_id, MIN(a.created_at) AS sent_at
           FROM activity a WHERE a.campaign_id = ? AND a.node_id = ? AND (a.type = ? OR (? = 'inmail' AND a.type = 'message')) AND a.status = 'ok' AND a.variant IS NOT NULL
             AND a.created_at >= COALESCE((SELECT st.started_at FROM campaign_variant_starts st
                                           WHERE st.campaign_id = a.campaign_id AND st.node_id = a.node_id AND st.variant = a.variant), 0)
           GROUP BY a.lead_id) s`,
    [campaignId, node.id, node.type, node.type],
  );
}

export function nodeStats(ctx: Ctx, campaignId: number, node: VariantNode) {
  return variantStats(variantRows(ctx, campaignId, node), abMetric(node), nodeVariants(node).map((v) => v.id));
}

// With auto-pick on, once the step has sent N times and a variant is clearly ahead, it becomes the winner.
// Any stored decision (a winner, or a user's "split again") stops it.
export function maybePickWinner(ctx: Ctx, campaign: CampaignRow, node: VariantNode): VariantId | null {
  const after = node.abtest?.autoPickAfter;
  if (!after || !isAbTest(node) || winnerOf(ctx, campaign.id, node.id)) return null;
  const stats = nodeStats(ctx, campaign.id, node);
  if (stats.reduce((n, s) => n + s.sent, 0) < after) return null;
  const best = bestVariant(stats, abMetric(node)) as VariantId | null;
  if (!best) return null;
  setWinner(ctx, campaign, node.id, best, 'auto');
  return best;
}

// A null variant (a user's "split again") is stored rather than deleted, so auto-pick doesn't undo it.
export function setWinner(ctx: Ctx, campaign: CampaignRow, nodeId: string, variant: VariantId | null, by: 'auto' | 'user', who?: string) {
  const now = ctx.clock.now();
  ctx.db.run(
    `INSERT INTO campaign_node_winners (campaign_id, node_id, variant, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (campaign_id, node_id) DO UPDATE SET variant = excluded.variant, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
    [campaign.id, nodeId, variant, by, now],
  );
  if (!variant) return;
  logActivity(ctx, {
    workspaceId: campaign.workspace_id,
    campaignId: campaign.id,
    type: 'ab_winner',
    nodeId,
    variant,
    detail: `Node ${nodeId}: variant ${variant}${by === 'auto' ? ' (picked automatically)' : who ? ` (chosen by ${who})` : ''}`,
  });
}

// Everything the campaign page shows about its A/B tests, in sequence order.
export function variantReport(ctx: Ctx, campaign: CampaignRow, seq: Sequence) {
  const order: string[] = [];
  const visit = (id: string | null) => {
    const n = id ? seq.nodes[id] : undefined;
    if (!n || order.includes(n.id)) return;
    order.push(n.id);
    for (const s of n.type === 'condition' ? [n.yes, n.no] : [n.next]) visit(s);
  };
  visit(seq.start);
  for (const id of Object.keys(seq.nodes)) if (!order.includes(id)) order.push(id);

  return order
    .map((id) => seq.nodes[id])
    .filter(isAbTest)
    .map((node) => {
      const winner = winnerOf(ctx, campaign.id, node.id);
      const ids = nodeVariants(node).map((v) => v.id);
      // A winner whose variant is gone no longer applies; a NULL variant is a user's "split again".
      const live = winner && (winner.variant === null || ids.includes(winner.variant)) ? winner : undefined;
      return {
        nodeId: node.id,
        nodeType: node.type,
        metric: abMetric(node),
        autoPickAfter: node.abtest?.autoPickAfter ?? null,
        winner: live?.variant ?? null,
        decidedBy: live?.decided_by ?? null,
        decidedAt: live?.decided_at ?? null,
        variants: nodeStats(ctx, campaign.id, node),
      };
    });
}

const contentKey = (v: VariantContent) => JSON.stringify([v.note ?? '', v.text ?? '', v.subject ?? '', v.body ?? '']);

// Called in the transaction that saves a campaign's sequence. A variant that is new to its step (including a
// letter that was removed and is now reused) or whose text changed starts its results over. A winner that was
// removed or edited is dropped, since the text under that letter hasn't been tested. Changing the auto-pick
// setting turns auto-pick back on after a user's "split again".
export function syncVariants(ctx: Ctx, campaignId: number, before: Sequence, after: Sequence) {
  const now = ctx.clock.now();
  const variantsAt = (seq: Sequence, id: string) => {
    const n = seq.nodes[id];
    return n && isAbTest(n) ? new Map(nodeVariants(n).map((v) => [v.id, contentKey(v)])) : new Map<VariantId, string>();
  };
  const autoPickAt = (seq: Sequence, id: string) => {
    const n = seq.nodes[id];
    return n && isAbTest(n) ? (n.abtest?.autoPickAfter ?? null) : null;
  };
  for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
    const old = variantsAt(before, id);
    const cur = variantsAt(after, id);
    const changed = [...cur].filter(([v, key]) => old.get(v) !== key).map(([v]) => v);
    for (const v of changed) {
      ctx.db.run(
        `INSERT INTO campaign_variant_starts (campaign_id, node_id, variant, started_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (campaign_id, node_id, variant) DO UPDATE SET started_at = excluded.started_at`,
        [campaignId, id, v, now],
      );
    }
    const winner = winnerOf(ctx, campaignId, id);
    if (!winner) continue;
    const stale = !cur.size || (winner.variant ? !cur.has(winner.variant) || changed.includes(winner.variant) : autoPickAt(before, id) !== autoPickAt(after, id));
    if (stale) ctx.db.run('DELETE FROM campaign_node_winners WHERE campaign_id = ? AND node_id = ?', [campaignId, id]);
  }
}
