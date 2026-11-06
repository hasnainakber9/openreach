// A small stand-in for linkedin.com that lets the browser driver's click-paths run end to end. It does
// not prove the selectors still match the live site.
//
// Profiles come in two layouts, as on LinkedIn, which moves members between them gradually:
// - '2026' (the default), modelled on the scrubbed snapshots in fixtures/linkedin-2026/: obfuscated
//   class names, no h1 (the name is the first h2 in main), details as plain <p> lines, the degree and the
//   action buttons rendered twice with one copy hidden, Connect and Message as links, a More menu of
//   role=menuitem items, the message composer inside an open shadow root, and a "People you may know"
//   sidebar whose controls belong to other people (clicking one logs a 'wrong' event). The top card
//   renders a moment after the document loads, like LinkedIn's.
// - 'classic': the older layout (main h1, classed details, buttons with aria-labels), kept so the
//   driver's fallbacks stay tested.

export interface MockPerson {
  name: string;
  degree: '1st' | '2nd';
  layout?: '2026' | 'classic';
  pending?: boolean;
  connectInMoreMenu?: boolean;
  // 2026: the Connect link goes to LinkedIn's /preload/custom-invite/ page instead of opening the
  // invitation dialog in place.
  invitePage?: boolean;
  email?: string;
  // What the profile's Message button does for someone you aren't connected to: open the InMail
  // composer, show the Premium upsell, or say the credits are used up. Unset: no Message button.
  inmail?: 'compose' | 'upsell' | 'no_credits';
  // Shows "View in Sales Navigator" (the account has Sales Navigator). Classic layout only.
  salesNav?: boolean;
  // 2026: a conversation bubble with someone else, with a draft in it, is already open on the page
  // (LinkedIn keeps bubbles open across pages). Its messages include this person's shared profile, so it
  // links to them too, but not from its profile card. Sending from it logs a 'wrong' event.
  staleBubble?: boolean;
  // 2026: the new message bubble shows its composer before its profile card (so nothing in it links to
  // the person yet).
  lateCard?: boolean;
}

export interface MockState {
  people: Record<string, MockPerson>;
  events: { type: string; slug?: string; text?: string; subject?: string; count?: number; what?: string }[];
  searchPages: number;
  // People behind the mock post (/feed/update/...), and the size of every mock group's member list.
  post?: { reactors: number; commenters: number };
  groupMembers?: number;
  // The own profile (/in/me/): 'slow' never draws its card but has the title; 'blank' has neither.
  self?: 'slow' | 'blank';
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const HEADLINE = 'Head of Growth at Northwind';
const LOCATION = 'London, England, United Kingdom';
const SCHOOL = 'London School of Economics';

const shell = (body: string, script = '', title = 'LinkedIn') => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>/* The hidden copies LinkedIn renders (second degree line, second action row). */ .gvyaz2, .gvya3t { display: none; }</style></head><body>
<main>${body}</main>
<script>
const log = (e) => fetch('/__event', { method: 'POST', body: JSON.stringify(e) });
const dialog = (html) => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.innerHTML = html; document.body.appendChild(d); return d; };
${script}
</script></body></html>`;

// The invitation dialog, as LinkedIn has shown it so far (not seen in the 2026 snapshots).
const inviteDialogScript = `
const inviteDialog = (slug, first) => {
  const d = dialog('<p>You can add a note to personalize your invitation to ' + first + '.</p><button aria-label="Add a note" id="addnote">Add a note</button><button aria-label="Send without a note" id="nonote">Send without a note</button>');
  d.querySelector('#nonote').onclick = () => { log({ type: 'connect', slug, text: '' }); d.remove(); };
  d.querySelector('#addnote').onclick = () => {
    d.innerHTML = '<textarea name="message"></textarea><button aria-label="Send invitation" id="send">Send</button>';
    d.querySelector('#send').onclick = () => { log({ type: 'connect', slug, text: d.querySelector('textarea').value }); d.remove(); };
  };
};`;

// ---- 2026 layout ----

function degreeLines(p: MockPerson | null) {
  if (!p) return '';
  const line = (d: string) => `<p class="gvylje gvylo0 gvylis gvyj1a gvygoj">· ${d}</p>`;
  const hidden = (d: string) => `<div class="gvyaz2 gvyl4o" data-display-contents="true">${line(d)}</div>`;
  return p.degree === '1st' ? line('1st') + hidden('2nd') : hidden('1st') + line('2nd');
}

function actionRow(slug: string, p: MockPerson | null, copy: boolean) {
  if (!p) return `<button type="button" class="gvylw7 gvylw6" data-act="more" ${copy ? 'aria-label="More"' : ''}><span class="gvylje gvylo1">More</span></button>`;
  const message = `<a class="gvylw7 gvylw6 gvyt0" aria-disabled="false" data-act="message" href="/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AID-${slug}&amp;recipient=ID-${slug}&amp;screenContext=NON_SELF_PROFILE_VIEW"><svg id="paper-plane-diagonal-outline-small" aria-hidden="true"></svg><span class="gvylje gvylo1">Message</span></a>`;
  const connect = `<a class="gvylw7 gvylw6 gvyt0" aria-disabled="false" data-act="${p.invitePage ? 'invite-page' : 'connect'}" href="/preload/custom-invite/?vanityName=${slug}" aria-label="Invite ${esc(p.name)} to connect"><svg id="person-plus-outline-small" aria-hidden="true"></svg><div class="gvyhn4"><span class="gvylje gvylo1"><span>Connect</span></span></div></a>`;
  const pending = `<button type="button" class="gvylw7 gvylw6" data-act="pending" aria-label="Pending, click to withdraw invitation sent to ${esc(p.name)}"><span class="gvylje gvylo1">Pending</span></button>`;
  const more = `<button type="button" class="gvylw7 gvylw6" data-act="more" aria-expanded="false" ${copy ? 'aria-label="More"' : ''}><span class="gvylje gvylo1">More</span></button>`;
  const primary = p.degree === '1st' ? '' : p.pending ? pending : p.connectInMoreMenu ? '' : connect;
  const msg = p.degree === '1st' || p.inmail ? message : '';
  return `<div class="gvyayy gvyiu3">${[primary, msg, more].map((c) => (c ? `<div class="gvyayq gvyl4o" data-display-contents="true">${c}</div>` : '')).join('')}</div>`;
}

function menuItems(p: MockPerson | null) {
  if (!p) return '';
  const item = (act: string, text: string, inner = '') =>
    `<div role="menuitem" tabindex="0" class="gvyia7 gvyh13" data-act="${act}"><div class="gvyivr gvylcd"${inner ? ` aria-label="${esc(inner)}"` : ''}><svg aria-hidden="true"></svg><div class="gvyl4n"><p class="gvylje gvylo1">${text}</p></div></div></div>`;
  const link = (text: string) => `<a role="menuitem" tabindex="0" class="gvyia7 gvyh13" data-act="wrong" href="#"><div class="gvyivr"><p class="gvylje gvylo1">${esc(text)}</p></div></a>`;
  const items = [link('Send profile in a message'), item('wrong', 'Save to PDF')];
  if (p.degree === '1st') items.push(link('Request a recommendation'), link('Recommend'), item('wrong', 'Following'), item('wrong', 'Remove connection'));
  else {
    if (p.connectInMoreMenu && !p.pending) items.push(item('connect', 'Connect', `Invite ${p.name} to connect`));
    items.push(item('follow', 'Follow', `Follow ${p.name}`));
  }
  items.push(link(`Report ${p.name}`), link(`Block ${p.name}`), link('About this member'));
  return items.join('');
}

// Other people, shown beside the profile. Their controls must never be used for the profile's person.
const sidebar = `<section class="gvyl5m gvyilv"><h2 class="gvylje gvylo5">People you may know</h2>${['Alex Other', 'Bea Other']
  .map((n) => {
    const slug = n.toLowerCase().replace(' ', '-');
    return `<div class="gvylcd gvyayy"><a href="https://www.linkedin.com/in/${slug}/"><p class="gvylje gvylo1">${n}</p><p class="gvylje gvylo0">CEO at Elsewhere</p></a>
      <a data-act="wrong" aria-label="Invite ${n} to connect" href="/preload/custom-invite/?vanityName=${slug}"><span>Connect</span></a>
      <button data-act="wrong" aria-label="Follow ${n}"><span>Follow</span></button>
      <a data-act="wrong" href="/messaging/compose/?recipient=${slug}"><span>Message</span></a>
      <button data-act="wrong"><span>More</span></button></div>`;
  })
  .join('')}</section>`;

function topCard2026(slug: string, name: string, p: MockPerson | null) {
  const pronouns = p ? '' : '<p class="gvylje gvylo0 gvylis">He/Him</p>';
  const chip = (icon: string, text: string) =>
    `<div role="button" tabindex="0" class="gvymfy gvymfx"><div class="gvyivr gvyayy"><figure class="gvyl4v" aria-hidden="true"><svg id="${icon}" aria-hidden="true"></svg></figure><div class="gvyl4n"><div class="gvylis"><p class="gvylje gvylo1"><span>${text}</span></p></div></div></div></div>`;
  return `<section class="gvyl5m gvyilv gvybtc" componentkey="KEY">
  <div class="gvyl4n gvyayy">
    <div class="gvylcw gvya2a"><div role="button" tabindex="0" class="gvyhub gvyia7"><figure class="gvyl4v"><svg id="person-medium" role="img" aria-label="Cover photo"></svg></figure></div></div>
    <a class="gvylap gvyhrv" href="https://www.linkedin.com/in/${slug}/"><div class="gvyivr" aria-label="Profile photo"><figure aria-hidden="true"><svg id="person-accent-4" aria-hidden="true"></svg></figure></div></a>
    <a class="gvylw7 gvylw6" href="https://www.linkedin.com/in/${slug}/" aria-label="Manage notifications about ${esc(name)}"><svg id="bell-outline-medium" aria-hidden="true"></svg></a>
  </div>
  <div class="gvyl4n gvylcf gvylcw">
    <div class="gvyayy gvyiu3">
      <div class="gvyivz gvya2a"><div class="gvyl4n gvyayy">
        <div class="gvyayy gvyiu3"><div class="gvyayq gvyl4o" data-display-contents="true"><div class="gvyayy" componentkey="KEY"><h2 class="gvylje gvylo8 gvyivr">${esc(name)}</h2></div></div>${degreeLines(p)}</div>
        ${pronouns}
        <p class="gvylje gvylo2 gvylis">${HEADLINE}</p>
        <p class="gvylje gvylo0 gvylis gvya3u">Northwind · ${SCHOOL}</p>
        <div class="gvyayy gvyiu3"><p class="gvylje gvylo0 gvygpp">${LOCATION}</p><p class="gvylje gvylo1 gvylio" aria-hidden="true">·</p><p class="gvylje gvylo1 gvygm6"><a class="gvygm6 gvygnf" data-act="contact" href="https://www.linkedin.com/in/${slug}/overlay/contact-info/">Contact info</a></p></div>
      </div></div>
      <div class="gvyivr gvya2a gvya3s"><div class="gvyl4n gvyayy">${chip('company-accent-4', 'Northwind')}${chip('school-accent-4', SCHOOL)}</div></div>
    </div>
    <div class="gvyayy gvyiu3"><p class="gvylje gvylo1 gvylis gvygpp">1,204 followers</p><p class="gvylje gvylo1" aria-hidden="true">·</p><a tabindex="0" class="gvymfy" href="https://www.linkedin.com/search/results/people/?connectionOf=%5B%22ID%22%5D"><p class="gvylje gvylo1">500+ connections</p></a></div>
    <div class="gvyayq gvyl4o" data-display-contents="true">
      <div class="gvya2a gvyht3 gvya3s">${actionRow(slug, p, false)}</div>
      <div class="gvya2a gvyht3 gvya3t">${actionRow(slug, p, true)}</div>
    </div>
  </div>
</section>`;
}

// The message composer bubble, inside an open shadow root on div#interop-outlet like LinkedIn's.
// Event handlers live inside the shadow root: clicks there reach document listeners retargeted.
const composerScript = `
const outlet = () => {
  let host = document.getElementById('interop-outlet');
  if (!host) { host = document.createElement('div'); host.id = 'interop-outlet'; document.body.appendChild(host); host.attachShadow({ mode: 'open' }); }
  return host.shadowRoot;
};
const bubble = (slug, name, opts) => {
  const b = document.createElement('div');
  b.className = 'msg-convo-wrapper msg-overlay-conversation-bubble msg-overlay-conversation-bubble--is-active';
  b.setAttribute('role', 'dialog');
  b.setAttribute('aria-label', 'Messaging');
  b.innerHTML = '<header class="msg-overlay-conversation-bubble-header"><h2 class="msg-overlay-bubble-header__title">' + name + '</h2>' +
    '<div class="msg-overlay-bubble-header__controls">' +
    '<button class="msg-overlay-bubble-header__control msg-overlay-conversation-bubble__expand-btn"><svg data-test-icon="minimize-small"></svg><span class="artdeco-button__text">Open the full conversation</span></button>' +
    '<button class="msg-overlay-bubble-header__control"><svg data-test-icon="close-small"></svg><span class="artdeco-button__text">Close your conversation</span></button></div></header>' +
    (opts.card === false ? '' : '<div class="msg-s-profile-card msg-s-profile-card-one-to-one"><a href="/in/' + slug + '/"></a><div class="artdeco-entity-lockup__title"><a class="profile-card-one-to-one__profile-link" href="/in/' + slug + '/"><span class="truncate">' + name + '</span></a></div></div>') +
    (opts.shared ? '<ul class="msg-s-message-list-content"><li class="msg-s-message-list__event"><p class="msg-s-event-listitem__body">Have you met <a href="https://www.linkedin.com/in/' + opts.shared + '/">this person</a>?</p></li></ul>' : '') +
    '<form class="msg-form">' + (opts.subject ? '<input name="subject" placeholder="Subject (optional)">' : '') +
    '<div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Write a message…"><p>' + (opts.draft || '<br>') + '</p></div>' +
    '<button class="msg-form__send-button artdeco-button" type="submit"' + (opts.draft ? '' : ' disabled') + '>Send</button></form>';
  const editor = b.querySelector('[contenteditable]');
  const send = b.querySelector('.msg-form__send-button');
  editor.addEventListener('input', () => { send.disabled = !editor.innerText.trim(); });
  b.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const subject = b.querySelector('input[name=subject]');
    opts.onSend({ text: editor.innerText.trim(), subject: subject ? subject.value : undefined });
  });
  b.querySelectorAll('.msg-overlay-bubble-header__control')[1].onclick = () => { b.remove(); log({ type: 'close', slug }); };
  // New bubbles open to the left of ones already open.
  outlet().prepend(b);
  return b;
};`;

function profile2026(slug: string, p: MockPerson | null, self?: string, selfMode?: MockState['self']) {
  const name = p?.name ?? self ?? '';
  const first = name.split(' ')[0];
  const title = p ? `${name} | LinkedIn` : `(2) ${name} | LinkedIn`;
  const body = topCard2026(slug, name, p) + sidebar;
  if (selfMode) return shell('', '', selfMode === 'slow' ? title : 'LinkedIn');
  return shell(
    '',
    `${inviteDialogScript}
${composerScript}
const slug = ${JSON.stringify(slug)}, name = ${JSON.stringify(name)}, first = ${JSON.stringify(first)};
const person = ${JSON.stringify(p ?? {})};
// LinkedIn renders the profile by script, a while after the document has loaded.
setTimeout(() => {
  document.querySelector('main').innerHTML = ${JSON.stringify(body)};
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.className = 'gvyl4n gvyayy';
  menu.hidden = true;
  menu.innerHTML = ${JSON.stringify(menuItems(p))};
  document.body.appendChild(menu);
  document.title = ${JSON.stringify(title)};
  if (person.staleBubble) bubble('ollie-other', 'Ollie Other', { draft: 'Half-written draft for Ollie', shared: slug, onSend: () => log({ type: 'wrong', what: 'stale bubble send' }) });
}, 400);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { const m = document.querySelector('[role=menu]'); if (m) m.hidden = true; } });
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act !== 'invite-page') ev.preventDefault();
  const menu = document.querySelector('[role=menu]');
  if (act !== 'more' && menu) menu.hidden = true;
  if (act === 'wrong') return void log({ type: 'wrong', what: t.getAttribute('aria-label') || t.innerText.trim() });
  if (act === 'more') menu.hidden = !menu.hidden;
  if (act === 'contact') {
    dialog('<section><h3>Email</h3><a href="mailto:${p?.email ?? ''}">${p?.email ?? ''}</a></section><button aria-label="Dismiss" onclick="this.parentElement.remove()">x</button>');
  }
  if (act === 'follow') { log({ type: 'follow', slug }); t.querySelector('p').textContent = 'Following'; }
  if (act === 'connect') inviteDialog(slug, first);
  if (act === 'pending') {
    const d = dialog('<p>Withdraw invitation?</p><button>Withdraw</button>');
    d.querySelector('button').onclick = () => { log({ type: 'withdraw', slug }); d.remove(); };
  }
  if (act === 'message') {
    const kind = person.degree === '1st' ? 'message' : 'inmail';
    bubble(slug, name, { subject: kind === 'inmail', card: !person.lateCard, onSend: (m) => log(kind === 'inmail' ? { type: kind, slug, subject: m.subject, text: m.text } : { type: kind, slug, text: m.text }) });
  }
});`,
    'LinkedIn',
  );
}

// ---- classic layout ----

function profileClassic(slug: string, p: MockPerson) {
  const first = p.name.split(' ')[0];
  const connect = `<button aria-label="Invite ${esc(p.name)} to connect" id="connect">Connect</button>`;
  const follow = `<button aria-label="Follow ${esc(p.name)}" id="follow">Follow</button>`;
  const primary =
    p.degree === '1st'
      ? `<button aria-label="Message ${esc(p.name)}" id="message">Message</button>`
      : p.pending
        ? `<button aria-label="Pending, click to withdraw invitation sent to ${esc(p.name)}" id="pending">Pending</button>`
        : p.connectInMoreMenu
          ? follow
          : connect;
  const menuItem = p.degree === '2nd' && !p.pending && p.connectInMoreMenu ? `<div role="button" aria-label="Invite ${esc(p.name)} to connect" id="connect">Connect</div>` : `<div role="button" aria-label="Follow ${esc(p.name)}" id="follow">Follow</div>`;
  const inmail = p.degree === '2nd' && p.inmail ? `<button aria-label="Message ${esc(p.name)}" id="inmail">Message</button>` : '';
  const salesNav = p.salesNav ? `<button aria-label="View in Sales Navigator" id="salesnav">Sales Navigator</button>` : '';
  return shell(
    `<section>
      <h1>${esc(p.name)}</h1>
      <div class="text-body-medium">${HEADLINE}</div>
      <span class="text-body-small inline">${LOCATION}</span>
      <span class="dist-value">${p.degree}</span>
      <button aria-label="Current company: Northwind. Click to skip to experience card">Northwind</button>
      <a href="/in/${slug}/overlay/contact-info/" id="contact">Contact info</a>
      ${primary}
      ${inmail}
      ${salesNav}
      <button aria-label="More actions" id="more">More</button>
      <div class="artdeco-dropdown__content" id="menu" hidden>${menuItem}</div>
    </section>`,
    `${inviteDialogScript}
    const slug = ${JSON.stringify(slug)};
    document.getElementById('more').onclick = () => { document.getElementById('menu').hidden = false; };
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest('button, [role=button], a');
      if (!t) return;
      if (t.id === 'contact') {
        ev.preventDefault();
        dialog('<section><h3>Email</h3><a href="mailto:${p.email ?? ''}">${p.email ?? ''}</a></section><button aria-label="Dismiss" onclick="this.parentElement.remove()">x</button>');
      }
      if (t.id === 'follow') { log({ type: 'follow', slug }); t.setAttribute('aria-label', 'Following ${esc(p.name)}'); }
      if (t.id === 'connect') inviteDialog(slug, ${JSON.stringify(first)});
      if (t.id === 'pending') {
        const d = dialog('<p>Withdraw invitation?</p><button>Withdraw</button>');
        d.querySelector('button').onclick = () => { log({ type: 'withdraw', slug }); d.remove(); };
      }
      if (t.id === 'message') {
        const box = document.createElement('div');
        box.innerHTML = '<div class="msg-form__contenteditable" contenteditable="true"></div><button class="msg-form__send-button">Send</button>';
        document.body.appendChild(box);
        box.querySelector('button').onclick = () => log({ type: 'message', slug, text: box.querySelector('[contenteditable]').innerText });
      }
      if (t.id === 'inmail') {
        const mode = ${JSON.stringify(p.inmail ?? '')};
        if (mode === 'upsell') return void dialog('<h2>Try Premium for free</h2><p>Message anyone with InMail.</p>');
        if (mode === 'no_credits') return void dialog("<p>You've used all your InMail credits for this month.</p>");
        const box = document.createElement('div');
        box.innerHTML = '<input name="subject" placeholder="Subject (optional)"><div class="msg-form__contenteditable" contenteditable="true"></div><button class="msg-form__send-button">Send</button>';
        document.body.appendChild(box);
        box.querySelector('button').onclick = () => log({ type: 'inmail', slug, subject: box.querySelector('input').value, text: box.querySelector('[contenteditable]').innerText });
      }
      if (t.id === 'salesnav') location.href = '/sales/lead/ACwAAA-' + slug + ',NAME_SEARCH,x1';
    });`,
  );
}

// ---- list pages ----

// A 2026 search result is one big profile link holding the whole card, with more links inside (the
// name, and mutual connections, who are other people). HTML parsing can't nest links, so the page
// builds them with DOM calls, as LinkedIn's script does.
function searchPage(page: number) {
  const card = (n: number) =>
    `<figure class="gvyl4v"></figure><div class="gvyl4n gvyivr"><p class="gvylje gvylo3"><a class="gvygoj" href="https://www.linkedin.com/in/person-${n}/">Person ${n}</a><span class="gvygpp"><span class="gvylo0"> • 2nd</span></span></p>` +
    `<div class="gvylis"><p class="gvylje gvylo0"><span>Founder at Co ${n}</span></p></div><div class="gvylis"><p class="gvylje gvylo0"><span>Berlin</span></p></div></div>` +
    `<div class="gvyayy"><a class="gvylw7" href="/preload/search-custom-invite/?vanityName=person-${n}" aria-label="Invite Person ${n} to connect"><span>Connect</span></a></div>` +
    `<div class="gvyk8t"><p class="gvylje gvyloy"><span>Current: Founder at Co ${n}</span></p></div>` +
    `<div class="gvyk8t"><p class="gvylje gvyloy"><span><a href="https://www.linkedin.com/in/mutual-a-${n}/">Mia Mutual</a> and <a href="https://www.linkedin.com/in/mutual-b-${n}/">Max Mutual</a> are mutual connections</span></p></div>`;
  const cards = Array.from({ length: 10 }, (_, i) => (page - 1) * 10 + i).map((n) => ({ n, html: card(n) }));
  return shell(
    '<div id="results"></div>',
    `for (const c of ${JSON.stringify(cards)}) {
      const holder = document.createElement('div');
      holder.innerHTML = c.html;
      const outer = document.createElement('a');
      outer.href = 'https://www.linkedin.com/in/person-' + c.n + '/?miniProfile=x';
      outer.className = 'gvymfy gvymfx';
      const inner = document.createElement('div');
      inner.className = 'gvyl4n gvyivr';
      inner.append(...holder.childNodes);
      outer.appendChild(inner);
      const wrap = document.createElement('div');
      wrap.appendChild(outer);
      document.getElementById('results').appendChild(wrap);
    }`,
  );
}

// The 2026 connections page: no <li> cards. Each person has a photo link and a name link (holding the
// name and occupation), then "Connected on ...", Message and More.
function connectionsPage(people: [string, MockPerson][]) {
  const cards = people.map(
    ([slug, p]) => `<div class="gvylcd gvylcu gvyayy" componentkey="KEY">
      <a tabindex="0" class="gvyj1i" href="https://www.linkedin.com/in/${slug}/"><figure class="gvyl4v"><svg role="img" aria-label="${esc(p.name)}’s profile picture"></svg></figure></a>
      <div class="gvyl4n gvyivr"><div class="gvyl4n"><a tabindex="0" class="gvymfy" href="https://www.linkedin.com/in/${slug}/"><div class="gvyl4n"><p class="gvylje gvylo5">${esc(p.name)}</p><div class="gvylis"><p class="gvylje gvylo0"><span>${HEADLINE}</span></p></div></div></a>
      <p class="gvylje gvylo0 gvylis">Connected on November 2, 2026</p></div></div>
      <div class="gvyayy"><a class="gvylw7" href="/messaging/compose/?recipient=ID-${slug}" aria-label="Send a message to ${esc(p.name)}"><span>Message</span></a><button class="gvylw7" type="button" aria-label="More actions for ${esc(p.name)}"></button></div>
    </div>`,
  );
  return shell(`<div class="gvyl4n">${cards.join('')}</div>`);
}

// The messaging page keeps LinkedIn's older msg-* classes. Thread 1 is shaped like the older thread
// view (the participant linked in the title bar). Thread 2 is shaped like the 2026 one in
// fixtures/linkedin-2026/messaging-thread.html: no profile link anywhere in the thread, the name in the
// title bar and the profile card as hovercard buttons (the hovercard, which holds the link, is drawn on
// hover; its markup was not captured live), and only our own message, which holds a link to someone else.
// A conversation bubble with someone else, with their messages, is open beside the threads.
function messagingPage() {
  const classic =
    '<div class="msg-title-bar"><a class="msg-thread__link-to-profile" href="https://www.linkedin.com/in/jane-doe/">Jane Doe</a></div><ul>' +
    '<li class="msg-s-message-list__event"><div data-event-urn="urn:1"><span class="msg-s-message-group__name">Sam Sender</span><p class="msg-s-event-listitem__body">Hi Jane! Bea is great too: <a href="https://www.linkedin.com/in/bea-other/">linkedin.com/in/bea-other</a></p></div></li>' +
    '<li class="msg-s-message-list__event"><div data-event-urn="urn:2"><span class="msg-s-message-group__name">Jane Doe</span><p class="msg-s-event-listitem__body">Hey Sam, sure.</p></div></li></ul>';
  const hover = (gen: number, inner: string, cls = 'msg-s-message-group__name t-14 t-black t-bold') =>
    `<span tabindex="-1" class="artdeco-hoverable-trigger artdeco-hoverable-trigger--content-placed-bottom ember-view inline-block"><button class="${cls}" aria-controls="artdeco-hoverable-artdeco-gen-${gen}" aria-expanded="false" type="button">${inner}</button><div id="artdeco-gen-${gen}" class="ember-view"><div class="ember-view"></div></div></span>`;
  const current =
    `<div class="msg-title-bar global-title-container shared-title-bar"><div class="shared-title-bar__title msg-title-bar__title-bar-title"><div class="msg-entity-lockup truncate"><dl class="truncate"><dt class="msg-entity-lockup__entity-title-wrapper">${hover(43, '<span class="msg-entity-lockup__entity-title truncate pr2"> Olga Open </span>')}</dt><dd class="msg-entity-lockup__entity-info">Head of Growth at Northwind</dd></dl></div><button class="msg-thread__star-icon" aria-label="Star conversation" type="button"></button></div></div>` +
    '<div class="msg-s-message-list-container"><div class="msg-s-message-list"><ul class="msg-s-message-list-content list-style-none"><li class="msg-s-message-list__top-of-list"></li>' +
    `<li><div class="msg-s-profile-card msg-s-profile-card-one-to-one ph3"><div class="artdeco-entity-lockup"><div class="artdeco-entity-lockup__image">${hover(44, '')}</div><div class="artdeco-entity-lockup__content"><div class="artdeco-entity-lockup__title">${hover(45, '<span class="inline-block v-align-middle truncate"> Olga Open </span>')}</div><div class="artdeco-entity-lockup__subtitle"><div> Head of Growth at Northwind </div></div></div></div></div></li>` +
    '<li class="msg-s-message-list__event clearfix"><time class="msg-s-message-list__time-heading">Today</time><div class="msg-s-event-listitem msg-s-event-listitem--other" data-event-urn="urn:li:msg:3" data-view-name="message-list-item"><div>' +
    hover(46, '', 't-14 t-black t-bold') +
    `</div><div class="msg-s-message-group__meta"><span><span class="msg-s-message-group__profile-link msg-s-message-group__name">${hover(47, ' Sam Sender ', 'msg-s-message-group__profile-link msg-s-message-group__name t-14 t-black t-bold')}</span></span><time class="msg-s-message-group__timestamp">10:02 AM</time></div>` +
    '<div class="msg-s-event-listitem__message-bubble"><div class="msg-s-event__content"><div><p class="msg-s-event-listitem__body">Hi Olga! You should meet <a href="https://www.linkedin.com/in/alex-other/">Alex</a>.</p></div></div></div></div></li></ul></div></div>';
  const bubble =
    '<div class="msg-convo-wrapper msg-overlay-conversation-bubble" role="dialog" aria-label="Messaging"><header class="msg-overlay-conversation-bubble-header"><h2 class="msg-overlay-bubble-header__title">Ollie Other</h2></header>' +
    '<ul><li class="msg-s-message-list__event"><div data-event-urn="urn:ollie"><span class="msg-s-message-group__name">Ollie Other</span><p class="msg-s-event-listitem__body">Ollie wrote this, not Olga</p></div></li></ul></div>';
  // The card is drawn into the trigger's wrapper on hover, under the id the trigger names.
  const hovercard = `document.addEventListener('mouseover', (ev) => {
      const b = ev.target.closest && ev.target.closest('.msg-title-bar button[aria-controls]');
      if (!b || document.getElementById(b.getAttribute('aria-controls'))) return;
      b.parentElement.querySelector('div[id^="artdeco-gen-"]').insertAdjacentHTML('beforeend', '<div id="' + b.getAttribute('aria-controls') + '" class="artdeco-hoverable-content"><a href="/in/olga-open/">Olga Open</a><p>Head of Growth at Northwind</p></div>');
    });`;
  return shell(
    `${bubble}<ul><li class="msg-conversation-listitem" id="t1"><span class="notification-badge--show"></span>Jane Doe</li><li class="msg-conversation-listitem" id="t2"><h3 class="msg-conversation-listitem__participant-names"><span class="truncate"> Olga Open </span></h3></li></ul><div class="msg-convo-wrapper msg-thread" id="thread"></div>`,
    `const open = (id, html) => { history.pushState({}, '', '/messaging/thread/' + id + '/'); document.getElementById('thread').innerHTML = html; };
    document.getElementById('t1').onclick = () => open('2-abc', ${JSON.stringify(classic)});
    document.getElementById('t2').onclick = () => open('2-def', ${JSON.stringify(current)});
    ${hovercard}`,
  );
}

export function mockLinkedIn(state: MockState) {
  return async (url: URL, body: string | null): Promise<{ status?: number; html?: string; json?: unknown }> => {
    const path = url.pathname;
    const layout = (slug: string) => state.people[slug]?.layout ?? '2026';
    if (path === '/__event') {
      state.events.push(JSON.parse(body ?? '{}'));
      return { json: { ok: true } };
    }
    if (path === '/in/me/') return { html: profile2026('sam-sender', null, 'Sam Sender', state.self) };
    let m = path.match(/^\/in\/([^/]+)\/details\/skills\/$/);
    if (m) {
      const slug = m[1];
      return {
        html: shell(
          ['Python', 'Growth', 'SQL', 'Leadership'].map((s) => `<button aria-label="Endorse ${s}" class="e">Endorse</button>`).join(''),
          `document.querySelectorAll('.e').forEach(b => b.onclick = () => { log({ type: 'endorse', slug: ${JSON.stringify(slug)} }); b.setAttribute('aria-label', 'Endorsed'); });`,
        ),
      };
    }
    m = path.match(/^\/in\/([^/]+)\/recent-activity\/all\/$/);
    if (m) {
      const slug = m[1];
      if (layout(slug) === 'classic') {
        return { html: shell(`<article><p>Big news!</p><button aria-label="React Like" aria-pressed="false" id="like">Like</button></article>`, `document.getElementById('like').onclick = () => log({ type: 'like', slug: ${JSON.stringify(slug)} });`) };
      }
      // 2026: the like toggle is labelled with its state; the first post is already liked.
      const post = (text: string, state: string) =>
        `<div class="gvylsf"><p>${text}</p><div class="gvylsh"><button class="gvylw7" type="button" aria-label="Reaction button state: ${state}"><svg id="thumbs-up-outline-feed-compact" aria-hidden="true"></svg><span>Like</span></button></div><button class="gvylw7" type="button" aria-label="Open reactions menu" aria-expanded="false"></button></div>`;
      return {
        html: shell(
          post('Old news', 'Like') + post('Big news!', 'no reaction'),
          `document.querySelectorAll('[aria-label^="Reaction button state"]').forEach((b) => b.onclick = () => {
            if (b.getAttribute('aria-label').endsWith('Like')) return void log({ type: 'wrong', what: 'unlike' });
            log({ type: 'like', slug: ${JSON.stringify(slug)} });
            b.setAttribute('aria-label', 'Reaction button state: Like');
          });`,
        ),
      };
    }
    m = path.match(/^\/in\/([^/]+)\/$/);
    if (m) {
      const p = state.people[m[1]];
      if (!p) return { status: 404, html: shell('<h2>Page not found</h2>') };
      return { html: layout(m[1]) === 'classic' ? profileClassic(m[1], p) : profile2026(m[1], p) };
    }
    if (path === '/preload/custom-invite/') {
      // Where a 2026 Connect link leads when LinkedIn doesn't open the dialog in place.
      const slug = url.searchParams.get('vanityName') ?? '';
      const p = state.people[slug];
      if (!p) return { status: 404, html: shell('<h2>Page not found</h2>') };
      return { html: shell('', `${inviteDialogScript}\ninviteDialog(${JSON.stringify(slug)}, ${JSON.stringify(p.name.split(' ')[0])});`) };
    }
    if (path === '/mynetwork/invite-connect/connections/') {
      return { html: connectionsPage(Object.entries(state.people).filter(([, p]) => p.degree === '1st')) };
    }
    if (path === '/search/results/people/') {
      const page = Number(url.searchParams.get('page') ?? 1);
      if (page > state.searchPages) return { html: shell('<p>No results found</p>') };
      return { html: searchPage(page) };
    }
    m = path.match(/^\/sales\/lead\/ACwAAA-([^,/]+),/);
    if (m) {
      const slug = m[1];
      const p = state.people[slug];
      if (!p) return { status: 404, html: shell('<h2>Lead not found</h2>') };
      return {
        html: shell(
          `<section><h1>${esc(p.name)}</h1><button aria-label="Message ${esc(p.name)}" id="snmsg">Message</button></section>`,
          `document.getElementById('snmsg').onclick = () => {
            const d = dialog('<input name="subject" placeholder="Subject"><textarea name="message"></textarea><button>Send</button>');
            d.querySelector('button').onclick = () => { log({ type: 'salesnav', slug: ${JSON.stringify(slug)}, subject: d.querySelector('input').value, text: d.querySelector('textarea').value }); d.remove(); };
          };`,
        ),
      };
    }
    if (/^\/(feed\/update|posts)\//.test(path)) {
      const { reactors, commenters } = state.post ?? { reactors: 0, commenters: 0 };
      const person = (kind: string, i: number | string) => `<a href="https://www.linkedin.com/in/${kind}-${i}/">${kind[0].toUpperCase() + kind.slice(1)} ${i}</a>`;
      const comment = (i: number | string) => `<article class="comments-comment-entity">${person('commenter', i)}<div>CTO at Co ${i}</div><p>Great post!</p></article>`;
      const reactor = (i: number | string) => `<li>${person('reactor', i)}<div>· 2nd</div><div>Founder at Co ${i}</div></li>`;
      return {
        html: shell(
          `<article><p>Big news!</p><button aria-label="${reactors} reactions" id="reactions">${reactors}</button>
            <section id="comments">${Array.from({ length: Math.min(5, commenters) }, (_, i) => comment(i)).join('')}</section>
            <button id="morecomments" ${commenters > 5 ? '' : 'hidden'}>Load more comments</button></article>`,
          `const reactors = ${reactors}, commenters = ${commenters};
          const reactor = (i) => ${JSON.stringify(reactor('@'))}.replaceAll('@', String(i));
          const comment = (i) => ${JSON.stringify(comment('@'))}.replaceAll('@', String(i));
          let shownComments = Math.min(5, commenters);
          document.getElementById('morecomments').onclick = (e) => {
            const next = Math.min(commenters, shownComments + 5);
            for (let i = shownComments; i < next; i++) document.getElementById('comments').insertAdjacentHTML('beforeend', comment(i));
            shownComments = next;
            if (shownComments >= commenters) e.target.hidden = true;
          };
          document.getElementById('reactions').onclick = () => {
            let shown = Math.min(10, reactors);
            const d = dialog('<ul id="reactors"></ul><button id="moreReactors">Show more results</button>');
            const list = d.querySelector('#reactors');
            for (let i = 0; i < shown; i++) list.insertAdjacentHTML('beforeend', reactor(i));
            const more = d.querySelector('#moreReactors');
            more.hidden = shown >= reactors;
            more.onclick = () => {
              const next = Math.min(reactors, shown + 10);
              for (let i = shown; i < next; i++) list.insertAdjacentHTML('beforeend', reactor(i));
              shown = next;
              more.hidden = shown >= reactors;
            };
            document.addEventListener('keydown', (ev) => ev.key === 'Escape' && d.remove(), { once: true });
          };`,
        ),
      };
    }
    m = path.match(/^\/events\/([^/]+)\/$/);
    if (m) {
      // Only attendees see the list; "hidden-..." events show none.
      const link = m[1].startsWith('hidden') ? '' : `<a href="/search/results/people/?eventAttending=${m[1]}">See all attendees</a>`;
      return { html: shell(`<h1>Growth Summit</h1>${link}`) };
    }
    m = path.match(/^\/groups\/([^/]+)\/members\/$/);
    if (m) {
      const total = state.groupMembers ?? 0;
      const member = (i: number | string) => `<li><a href="https://www.linkedin.com/in/member-${i}/">Member ${i}</a><div>Designer at Studio ${i}</div></li>`;
      return {
        html: shell(
          `<ul id="members">${Array.from({ length: Math.min(10, total) }, (_, i) => member(i)).join('')}</ul><button id="more" ${total > 10 ? '' : 'hidden'}>Show more results</button>`,
          `let shown = Math.min(10, ${total});
          document.getElementById('more').onclick = (e) => {
            const next = Math.min(${total}, shown + 10);
            for (let i = shown; i < next; i++) document.getElementById('members').insertAdjacentHTML('beforeend', ${JSON.stringify(member('@'))}.replaceAll('@', String(i)));
            shown = next;
            if (shown >= ${total}) e.target.hidden = true;
          };`,
        ),
      };
    }
    if (path.startsWith('/messaging/')) return { html: messagingPage() };
    if (path.startsWith('/checkpoint/')) return { html: shell('<h1>Security check</h1>') };
    return { html: shell('<h1>Feed</h1>') };
  };
}
