// Creates a demo workspace with a simulated LinkedIn account, a lead list and a running campaign.
// Usage: npm run seed -w server   (then start the server, ideally with DEMO_SPEED=600)
import { realClock } from './clock.js';
import { loadConfig } from './config.js';
import { buildContext } from './context.js';
import { SimulatorDriver } from './drivers/simulator.js';
import { defaultSequence } from './engine/sequence.js';
import { hashPassword } from './services/crypto.js';
import { addMembership } from './services/memberships.js';
import { addLeadsToCampaign, importLeads, personToLead } from './services/leads.js';
import { setCampaignAccounts } from './services/rotation.js';
import { setCampaignMailboxes } from './mail/mailboxes.js';
import type { CampaignRow } from './types.js';

const email = process.env.SEED_EMAIL ?? 'demo@openreach.local';
const password = process.env.SEED_PASSWORD ?? 'demo-password';

const ctx = buildContext(loadConfig(), realClock);
const { db } = ctx;
if (db.get('SELECT 1 FROM users WHERE email = ?', [email])) {
  console.log(`${email} already exists; nothing to do.`);
  process.exit(0);
}

const now = Date.now();
const ws = db.insert('workspaces', { name: 'Demo workspace', created_at: now });
const userId = db.insert('users', { workspace_id: ws, email, name: 'Demo User', password_hash: hashPassword(password), role: 'owner', created_at: now });
addMembership(ctx, userId, ws, 'owner');
const seat = (name: string) =>
  db.insert('accounts', {
    workspace_id: ws,
    name,
    driver: 'simulator',
    timezone: 'UTC',
    work_days: '[0,1,2,3,4,5,6]',
    work_start: '07:00',
    work_end: '22:00',
    delay_min_sec: 45,
    delay_max_sec: 150,
    warmup: 0,
    created_at: now,
  });
// Two seats, so the demo campaign shows sender rotation.
const accountId = seat('Demo seat (simulated)');
const secondId = seat('Second seat (simulated)');
const listId = db.insert('lead_lists', { workspace_id: ws, name: 'Heads of Growth, Europe', created_at: now });
const people = await new SimulatorDriver(db, accountId, 'Demo', realClock).search('https://www.linkedin.com/search/results/people/?keywords=head%20of%20growth', 60);
importLeads(ctx, ws, listId, people.map((p) => ({ ...personToLead(p), email: null })));

// The demo invites with two notes, so the Results tab has an A/B test to show.
const sequence = defaultSequence();
const invite = sequence.nodes.n3;
if (invite.type === 'connect') {
  invite.variants = [
    { id: 'A', note: invite.note },
    { id: 'B', note: 'Hi {{firstName}}, I work with growth teams like yours at {{company|your company}}. Happy to connect?' },
  ];
}
// The thank-you message opens with an AI line per lead (the built-in simulator writes it in the demo).
const thanks = sequence.nodes.n5;
if (thanks.type === 'message') thanks.text = 'Thanks for connecting, {{firstName}}! {{ai:icebreaker}} How is your team handling outreach today?';
const settings = { aiVariables: [{ name: 'icebreaker', instruction: 'One friendly sentence about something specific in their role or company.', fallback: 'Great to be connected.', maxChars: 160 }] };

const campaignId = db.insert('campaigns', {
  workspace_id: ws,
  account_id: accountId,
  name: 'Growth leaders – intro',
  status: 'active',
  sequence: JSON.stringify(sequence),
  settings: JSON.stringify(settings),
  created_at: now,
  started_at: now,
});
setCampaignAccounts(ctx, campaignId, [accountId, secondId]);
const campaign = db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [campaignId])!;
const leadIds = db.all<{ id: number }>('SELECT id FROM leads WHERE list_id = ?', [listId]).map((r) => r.id);
// The last 15 leads get (made-up, never deliverable) addresses and an email-only campaign from a simulated mailbox.
const emailIds = leadIds.slice(-15);
const r = addLeadsToCampaign(ctx, campaign, leadIds.slice(0, -15));
for (const id of emailIds) db.run("UPDATE leads SET email = lower(first_name || '.' || last_name || '@' || replace(company, ' ', '') || '.example') WHERE id = ?", [id]);
const mailboxId = db.insert('mailboxes', {
  workspace_id: ws,
  name: 'Demo mailbox (simulated)',
  provider: 'simulated',
  from_name: 'Demo User',
  from_email: 'demo@openreach.example',
  signature: 'Demo User\nOpenReach demo',
  timezone: 'UTC',
  work_days: '[0,1,2,3,4,5,6]',
  work_start: '07:00',
  work_end: '22:00',
  daily_limit: 30,
  warmup_start: 5,
  warmup_days: 7,
  gap_min_sec: 120,
  gap_max_sec: 400,
  created_at: now,
});
const emailCampaignId = db.insert('campaigns', {
  workspace_id: ws,
  name: 'Email follow-up (simulated mailbox)',
  status: 'active',
  sequence: JSON.stringify({
    start: 'e1',
    nodes: {
      e1: { id: 'e1', type: 'email', subject: 'Quick idea for {{company|your team}}', body: 'Hi {{firstName}},\n\nWe help growth teams book more meetings from LinkedIn and email. Worth a short call?', next: 'w' },
      w: { id: 'w', type: 'wait', days: 2, hours: 0, next: 'e2' },
      e2: { id: 'e2', type: 'email', subject: 'Following up', body: 'Hi {{firstName}}, just bumping this in case it got buried.', replyInThread: true, next: null },
    },
  }),
  settings: '{}',
  created_at: now,
  started_at: now,
});
setCampaignMailboxes(ctx, emailCampaignId, [mailboxId]);
const e = addLeadsToCampaign(ctx, db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [emailCampaignId])!, emailIds);
console.log(`Seeded ${email} / ${password}: 2 simulated accounts, a simulated mailbox, ${leadIds.length} leads, a LinkedIn campaign with ${r.added} leads and an email campaign with ${e.added}.`);
