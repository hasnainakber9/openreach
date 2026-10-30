// Creates a demo workspace with a simulated LinkedIn account, a lead list and a running campaign.
// Usage: npm run seed -w server   (then start the server, ideally with DEMO_SPEED=600)
import { realClock } from './clock.js';
import { loadConfig } from './config.js';
import { buildContext } from './context.js';
import { SimulatorDriver } from './drivers/simulator.js';
import { defaultSequence } from './engine/sequence.js';
import { hashPassword } from './services/crypto.js';
import { addLeadsToCampaign, importLeads, personToLead } from './services/leads.js';
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
db.insert('users', { workspace_id: ws, email, name: 'Demo User', password_hash: hashPassword(password), role: 'owner', created_at: now });
const accountId = db.insert('accounts', {
  workspace_id: ws,
  name: 'Demo seat (simulated)',
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
const listId = db.insert('lead_lists', { workspace_id: ws, name: 'Heads of Growth, Europe', created_at: now });
const people = await new SimulatorDriver(db, accountId, 'Demo', realClock).search('https://www.linkedin.com/search/results/people/?keywords=head%20of%20growth', 60);
importLeads(ctx, ws, listId, people.map((p) => ({ ...personToLead(p), email: null })));

const campaignId = db.insert('campaigns', {
  workspace_id: ws,
  account_id: accountId,
  name: 'Growth leaders – intro',
  status: 'active',
  sequence: JSON.stringify(defaultSequence()),
  settings: '{}',
  created_at: now,
  started_at: now,
});
const campaign = db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [campaignId])!;
const leadIds = db.all<{ id: number }>('SELECT id FROM leads WHERE list_id = ?', [listId]).map((r) => r.id);
const r = addLeadsToCampaign(ctx, campaign, leadIds);
console.log(`Seeded ${email} / ${password}: 1 simulated account, ${leadIds.length} leads, campaign with ${r.added} leads.`);
