// A tiny stand-in for linkedin.com, shaped like its real markup (accessible names, roles, the
// class hooks the driver relies on). It lets the browser driver's click-paths run end to end.
// It does not prove the selectors still match the live site.

export interface MockPerson {
  name: string;
  degree: '1st' | '2nd';
  pending?: boolean;
  connectInMoreMenu?: boolean;
  email?: string;
  // What the profile's Message button does for someone you aren't connected to: open the InMail
  // composer, show the Premium upsell, or say the credits are used up. Unset: no Message button.
  inmail?: 'compose' | 'upsell' | 'no_credits';
  // Shows "View in Sales Navigator" (the account has Sales Navigator).
  salesNav?: boolean;
}

export interface MockState {
  people: Record<string, MockPerson>;
  events: { type: string; slug?: string; text?: string; subject?: string; count?: number }[];
  searchPages: number;
  // People behind the mock post (/feed/update/...), and the size of every mock group's member list.
  post?: { reactors: number; commenters: number };
  groupMembers?: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const shell = (body: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>LinkedIn</title></head><body>
<main>${body}</main>
<script>
const log = (e) => fetch('/__event', { method: 'POST', body: JSON.stringify(e) });
const dialog = (html) => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.innerHTML = html; document.body.appendChild(d); return d; };
${script}
</script></body></html>`;

function profile(slug: string, p: MockPerson) {
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
      <div class="text-body-medium">Head of Growth at Northwind</div>
      <span class="text-body-small inline">London, England, United Kingdom</span>
      <span class="dist-value">${p.degree}</span>
      <button aria-label="Current company: Northwind. Click to skip to experience card">Northwind</button>
      <a href="/in/${slug}/overlay/contact-info/" id="contact">Contact info</a>
      ${primary}
      ${inmail}
      ${salesNav}
      <button aria-label="More actions" id="more">More</button>
      <div class="artdeco-dropdown__content" id="menu" hidden>${menuItem}</div>
    </section>`,
    `
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
      if (t.id === 'connect') {
        const d = dialog('<p>You can add a note to personalize your invitation to ${esc(first)}.</p><button aria-label="Add a note" id="addnote">Add a note</button><button aria-label="Send without a note" id="nonote">Send without a note</button>');
        d.querySelector('#nonote').onclick = () => { log({ type: 'connect', slug, text: '' }); d.remove(); };
        d.querySelector('#addnote').onclick = () => {
          d.innerHTML = '<textarea name="message"></textarea><button aria-label="Send invitation" id="send">Send</button>';
          d.querySelector('#send').onclick = () => { log({ type: 'connect', slug, text: d.querySelector('textarea').value }); d.remove(); };
        };
      }
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

export function mockLinkedIn(state: MockState) {
  return async (url: URL, body: string | null): Promise<{ status?: number; html?: string; json?: unknown }> => {
    const path = url.pathname;
    if (path === '/__event') {
      state.events.push(JSON.parse(body ?? '{}'));
      return { json: { ok: true } };
    }
    if (path === '/in/me/') return { html: profile('sam-sender', { name: 'Sam Sender', degree: '1st' }) };
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
      return { html: shell(`<article><p>Big news!</p><button aria-label="React Like" aria-pressed="false" id="like">Like</button></article>`, `document.getElementById('like').onclick = () => log({ type: 'like', slug: ${JSON.stringify(slug)} });`) };
    }
    m = path.match(/^\/in\/([^/]+)\/$/);
    if (m) {
      const p = state.people[m[1]];
      return p ? { html: profile(m[1], p) } : { status: 404, html: shell('<h2>Page not found</h2>') };
    }
    if (path === '/mynetwork/invite-connect/connections/') {
      const items = Object.entries(state.people)
        .filter(([, p]) => p.degree === '1st')
        .map(([slug, p]) => `<li><a href="https://www.linkedin.com/in/${slug}/">${esc(p.name)}</a><span>Head of Growth at Northwind</span><button>Message</button></li>`);
      return { html: shell(`<ul>${items.join('')}</ul>`) };
    }
    if (path === '/search/results/people/') {
      const page = Number(url.searchParams.get('page') ?? 1);
      if (page > state.searchPages) return { html: shell('<p>No results found</p>') };
      const items = Array.from({ length: 10 }, (_, i) => {
        const n = (page - 1) * 10 + i;
        return `<li><a href="https://www.linkedin.com/in/person-${n}/?miniProfile=x">Person ${n}</a><div>• 2nd</div><div>Founder at Co ${n}</div><div>Berlin</div><button>Connect</button></li>`;
      });
      return { html: shell(`<ul>${items.join('')}</ul>`) };
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
    if (path.startsWith('/messaging/')) {
      return {
        html: shell(
          `<ul><li class="msg-conversation-listitem" id="t1"><span class="notification-badge--show"></span>Jane Doe</li></ul><div class="msg-thread" id="thread"></div>`,
          `document.getElementById('t1').onclick = () => {
            history.pushState({}, '', '/messaging/thread/2-abc/');
            document.getElementById('thread').innerHTML = '<a href="https://www.linkedin.com/in/jane-doe/">Jane Doe</a><ul>' +
              '<li class="msg-s-message-list__event"><div data-event-urn="urn:1"><span class="msg-s-message-group__name">Sam Sender</span><p class="msg-s-event-listitem__body">Hi Jane!</p></div></li>' +
              '<li class="msg-s-message-list__event"><div data-event-urn="urn:2"><span class="msg-s-message-group__name">Jane Doe</span><p class="msg-s-event-listitem__body">Hey Sam, sure.</p></div></li></ul>';
          };`,
        ),
      };
    }
    if (path.startsWith('/checkpoint/')) return { html: shell('<h1>Security check</h1>') };
    return { html: shell('<h1>Feed</h1>') };
  };
}
