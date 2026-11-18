import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ProviderError } from '../providers/http.js';
import type { LeadRow } from '../types.js';
import { isReplyCategory } from './categories.js';
import { threadUpTo } from './classify.js';
import { completeJson } from './complete.js';
import { replyRequest } from './prompts.js';

// What LinkedIn accepts in one message.
const MESSAGE_MAX = 8000;

const answerSchema = z.object({ replies: z.array(z.string()).min(1) });

// Drafts 1–3 next replies for a conversation from its thread, the lead's profile and the campaign name.
// Never sends or stores anything: the user picks one, edits it and presses Send.
export async function suggestReplies(ctx: Ctx, workspaceId: number, conversationId: number, o: { count: number; instruction?: string }): Promise<{ suggestions: string[]; simulated: boolean }> {
  const conv = ctx.db.get<{ id: number; lead_id: number | null; category: string | null }>('SELECT id, lead_id, category FROM conversations WHERE id = ? AND workspace_id = ?', [conversationId, workspaceId]);
  if (!conv) throw new ProviderError('NOT_FOUND', 'Conversation not found');
  const thread = threadUpTo(ctx, conv.id);
  const latest = [...thread].reverse().find((m) => m.direction === 'in');
  const lead = conv.lead_id ? ctx.db.get<LeadRow>('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', [conv.lead_id, workspaceId]) : undefined;
  const campaign = conv.lead_id
    ? ctx.db.get<{ name: string }>('SELECT c.name FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ? AND c.workspace_id = ? ORDER BY cl.added_at DESC LIMIT 1', [conv.lead_id, workspaceId])
    : undefined;
  const req = replyRequest({
    thread,
    latest: latest?.body ?? '',
    count: o.count,
    category: isReplyCategory(conv.category) ? conv.category : null,
    campaignName: campaign?.name ?? null,
    instruction: o.instruction,
    lead,
  });
  const { data, out } = await completeJson(ctx, workspaceId, req, answerSchema);
  const seen = new Set<string>();
  const suggestions = data.replies
    .map((r: string) => r.trim().slice(0, MESSAGE_MAX))
    .filter((r: string) => r && !seen.has(r) && seen.add(r))
    .slice(0, o.count);
  if (!suggestions.length) throw new ProviderError('BAD_REQUEST', 'The AI returned no usable drafts. Try again.');
  return { suggestions, simulated: out.simulated };
}
