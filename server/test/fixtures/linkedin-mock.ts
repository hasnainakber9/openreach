// A tiny stand-in for linkedin.com, shaped like its real markup (accessible names, roles, the
// class hooks the driver relies on). It lets the browser driver's click-paths run end to end.
// It does not prove the selectors still match the live site.

export interface MockPerson {
  name: string;
  degree: '1st' | '2nd';
  pending?: boolean;
  connectInMoreMenu?: boolean;
  email?: string;
}

export interface MockState {
  people: Record<string, MockPerson>;
  events: { type: string; slug?: string; text?: string; count?: number }[];
  searchPages: number;
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
  return shell(
    `<section>
      <h1>${esc(p.name)}</h1>
      <div class="text-body-medium">Head of Growth at Northwind</div>
      <span class="text-body-small inline">London, England, United Kingdom</span>
      <span class="dist-value">${p.degree}</span>
      <button aria-label="Current company: Northwind. Click to skip to experience card">Northwind</button>
      <a href="/in/${slug}/overlay/contact-info/" id="contact">Contact info</a>
      ${primary}
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
