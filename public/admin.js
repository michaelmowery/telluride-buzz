// Buzz admin: health board, towns, sources. Plain DOM, no framework.
// Every value from the server is set as text (never innerHTML), so source names
// and error messages can't inject markup.

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

async function api(path, body) {
  const res = await fetch(`/api/admin${path}`, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Sign in first'); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  return hr < 48 ? `${hr} h ago` : `${Math.round(hr / 24)} days ago`;
};
const COLOR_WORD = { green: 'OK', amber: 'Needs a look', red: 'Failing', paused: 'Paused' };
const dot = (c) => h('span', { class: `dot ${c}`, title: COLOR_WORD[c] || c, role: 'img', 'aria-label': COLOR_WORD[c] || c });

let adapters = null;
async function getAdapters() {
  if (!adapters) adapters = (await api('/adapters')).adapters;
  return adapters;
}

// ---------- sign-in ----------
function showLogin() {
  $('#login').hidden = false;
  $('#nav').hidden = true;
  view.replaceChildren();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', { password: e.target.password.value });
    e.target.reset();
    $('#login').hidden = true;
    route();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/logout', {}).catch(() => {}); showLogin(); });

// ---------- town bar ----------
// Pick a town once at the top (like the public site's town picker); Feeds, Resources
// and Settings tabs underneath are all for that town. The town is remembered here.
const TOWN_KEY = 'buzz-admin-town';
let townsCache = null;
async function adminTowns(fresh = false) {
  if (!townsCache || fresh) townsCache = (await api('/towns')).towns;
  return townsCache;
}
const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming' };
const townLabel = (t) => `${t.name}${t.state ? `, ${t.state}` : ''}`;
async function currentTown(wanted) {
  const towns = await adminTowns();
  const ok = (id) => towns.some((t) => t.id === id);
  const id = ok(wanted) ? wanted : ok(store.get(TOWN_KEY)) ? store.get(TOWN_KEY) : towns[0]?.id || '';
  if (id) store.set(TOWN_KEY, id);
  return id;
}
const TOWN_TABS = [['feeds', 'Feeds', (id) => `#feeds?town=${encodeURIComponent(id)}`],
  ['resources', 'Resources', (id) => `#all-resources?town=${encodeURIComponent(id)}`],
  ['settings', 'Settings', (id) => `#town/${encodeURIComponent(id)}`]];

function townPicker(towns, current, onPick) {
  // Grouped by state (A-Z, towns A-Z in each), with a search box, like the site's picker.
  const opt = (t) => h('a', {
    href: '#', class: 'town-opt', role: 'menuitem', 'aria-current': t.id === current ? 'page' : null,
    dataset: { q: [t.name, t.state, STATE_NAMES[t.state], ...(t.hostnames || [])].filter(Boolean).join(' ').toLowerCase() },
    onclick: (e) => { e.preventDefault(); setMenu(false); if (t.id !== current) onPick(t.id); },
  }, h('span', { class: 'town-txt' }, h('strong', {}, townLabel(t)),
    h('small', {}, t.id === current ? 'Editing now' : (t.hostnames || [])[0] || '')),
  h('span', { class: `pill ${t.status}` }, t.status));
  const byState = new Map();
  for (const t of [...towns].sort((a, b) => a.name.localeCompare(b.name))) {
    const st = STATE_NAMES[t.state] || t.state || 'Other';
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push(t);
  }
  const groups = [...byState].sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b))
    .map(([st, list]) => h('div', { class: 'town-group', dataset: { group: '' } }, h('p', { class: 'town-state' }, st), ...list.map(opt)));
  const none = h('p', { class: 'muted small town-none', hidden: true }, 'No towns match.');
  const search = h('input', { type: 'search', class: 'town-search', placeholder: 'Search towns or states', 'aria-label': 'Search towns', autocomplete: 'off',
    oninput: () => {
      const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let any = false;
      for (const a of menu.querySelectorAll('[data-q]')) { const ok = words.every((w) => a.dataset.q.includes(w)); a.hidden = !ok; any ||= ok; }
      for (const g of groups) g.hidden = !g.querySelector('[data-q]:not([hidden])');
      none.hidden = any;
    },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); menu.querySelector('[data-q]:not([hidden])')?.click(); } } });
  const menu = h('div', { class: 'town-menu', id: 'town-menu', role: 'menu', hidden: true },
    h('p', { class: 'town-menu-title' }, 'Choose a town'), search,
    h('div', { class: 'town-groups' }, ...groups), none,
    h('a', { href: '#towns', class: 'town-all', onclick: () => setMenu(false) }, 'All towns · Add a town'));
  const picker = h('button', { type: 'button', class: 'town-picker', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'town-menu',
    onclick: () => setMenu(menu.hidden) },
  h('span', {}, townLabel(towns.find((t) => t.id === current) || { name: 'Pick a town' })),
  h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  function setMenu(open) {
    menu.hidden = !open;
    picker.setAttribute('aria-expanded', String(open));
    if (open) search.focus();
  }
  const close = (e) => {
    if (!document.body.contains(menu)) { document.removeEventListener('click', close); document.removeEventListener('keydown', close); return; }
    if (menu.hidden) return;
    if (e.type === 'keydown' ? e.key === 'Escape' : !menu.contains(e.target) && !picker.contains(e.target)) { setMenu(false); if (e.type === 'keydown') picker.focus(); }
  };
  document.addEventListener('click', close);
  document.addEventListener('keydown', close);
  return h('div', { class: 'town-pick' }, picker, menu);
}

/** The bar above every town page: picker, then the town's tabs. tab = feeds|resources|settings. */
async function townBar(id, tab) {
  const towns = await adminTowns();
  const t = towns.find((x) => x.id === id);
  if (!t) return null;
  return h('div', { class: 'town-bar' },
    h('div', { class: 'town-bar-top' }, townPicker(towns, id, (next) => {
      store.set(TOWN_KEY, next);
      location.hash = (TOWN_TABS.find(([k]) => k === tab) || TOWN_TABS[0])[2](next).slice(1);
    }), h('a', { class: 'small', href: townUrlOf(t), target: '_blank', rel: 'noopener' }, 'View site ↗')),
    h('nav', { class: 'town-tabs', 'aria-label': `${t.name} admin` },
      ...TOWN_TABS.map(([k, label, href]) => h('a', { href: href(id), class: 'town-tab', 'aria-current': k === tab ? 'page' : null }, label))));
}
const townUrlOf = (t) => (t.url || `https://${t.hostnames?.[0] || `${t.id}.thetown.buzz`}`).replace(/\/$/, '');

// ---------- router ----------
let timer = null;
async function route() {
  clearInterval(timer);
  townsCache = null; // names, status and new towns show up right away
  const [path, query = ''] = (location.hash.slice(1) || 'feeds').split('?');
  const [page, a, b] = path.split('/').map(decodeURIComponent);
  try {
    await api('/me');
  } catch { return; }
  $('#login').hidden = true;
  $('#nav').hidden = false;
  document.querySelectorAll('[data-nav]').forEach((n) => n.toggleAttribute('aria-current',
    (n.dataset.nav === 'towns' && /^(towns|new-town)$/.test(page)) || (n.dataset.nav === 'admin-settings' && page === 'admin-settings')));
  try {
    if (page === 'health') { location.replace(`#feeds${query ? `?${query}` : ''}`); return; } // old bookmarks
    // Town pages: work out the town, draw the page, then put the town bar on top.
    let town = '';
    let tab = '';
    if (page === 'feeds') {
      readFilters(query);
      town = filters.town = await currentTown(new URLSearchParams(query).get('town'));
      tab = 'feeds';
      await healthPage();
      timer = setInterval(() => healthPage(true).catch(() => {}), 30e3);
    } else if (page === 'towns') await townsPage();
    else if (page === 'admin-settings') await adminSettingsPage();
    else if (page === 'new-town') await townPage(null);
    else if (page === 'town') { town = a; tab = 'settings'; await townPage(a); }
    else if (page === 'source') { town = a; tab = 'feeds'; await sourcePage(a, b); }
    else if (page === 'new-source') { town = a; tab = 'feeds'; await sourcePage(a, null); }
    else if (page === 'all-resources') {
      readResFilters(query);
      town = resFilters.town = await currentTown(new URLSearchParams(query).get('town'));
      tab = 'resources';
      await allResourcesPage();
    } else if (page === 'resources') { location.replace(`#all-resources?town=${encodeURIComponent(a)}`); return; }
    else if (page === 'resource') { town = a; tab = 'resources'; await resourcePage(a, b); }
    else if (page === 'new-resource') { town = a; tab = 'resources'; await resourcePage(a, null, b); }
    else location.hash = 'feeds';
    if (town) {
      store.set(TOWN_KEY, town);
      const bar = await townBar(town, tab);
      if (bar) view.prepend(bar);
    }
  } catch (err) {
    if (err.message !== 'Sign in first') view.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'error' }, err.message)));
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- filters ----------
// Health board filters live in the address (#feeds?town=durango&feed=roads&status=problems)
// so a filtered view can be bookmarked, and the last one is remembered on this device.
const FILTER_KEYS = ['town', 'feed', 'status', 'q'];
const STATUS_FILTERS = [['', 'Any status'], ['problems', 'Failing or needs a look'], ['red', 'Failing'], ['amber', 'Needs a look'], ['green', 'OK'], ['paused', 'Paused']];
const blankFilters = () => ({ town: '', feed: '', status: '', q: '' });
let filters = blankFilters();
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function readFilters(query) {
  const p = new URLSearchParams(query);
  const fromUrl = FILTER_KEYS.some((k) => p.has(k));
  const saved = store.get('buzz-admin-filters') || {};
  filters = blankFilters();
  for (const k of FILTER_KEYS) filters[k] = String((fromUrl ? p.get(k) : saved[k]) || '');
}

function saveFilters() {
  store.set('buzz-admin-filters', filters);
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (filters[k]) p.set(k, filters[k]);
  const qs = p.toString();
  history.replaceState(null, '', `#feeds${qs ? `?${qs}` : ''}`); // no hashchange, so no re-route
}

function matches(s, f, townName = '') {
  if (f.feed && s.feed !== f.feed) return false;
  if (f.status === 'problems' ? !['red', 'amber'].includes(s.color) : (f.status && s.color !== f.status)) return false;
  if (f.q) {
    const hay = [s.label, s.key, s.adapterName, s.note, s.error, townName].join(' ').toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

const isFiltered = (f, withTown) => !!(f.feed || f.status || f.q || (withTown && f.town));

/** A row of selects. towns = [{id,name}] or null to hide the town picker. */
function filterBar(f, { towns, feeds, feedNames }, onChange) {
  const sel = (key, label, options) => h('label', { class: 'filter' }, label,
    h('select', { name: key, onchange: (e) => { f[key] = e.target.value; onChange(); } },
      ...options.map(([v, text]) => h('option', { value: v, selected: f[key] === v }, text))));
  const q = h('input', { type: 'search', name: 'q', value: f.q, placeholder: 'Name, key or error', autocomplete: 'off' });
  q.addEventListener('input', () => { f.q = q.value.trim(); onChange(); });
  const clear = h('button', { type: 'button', class: 'small secondary', onclick: () => {
    Object.assign(f, blankFilters(), towns ? {} : { town: f.town });
    bar.querySelectorAll('select').forEach((x) => { x.value = ''; });
    q.value = '';
    onChange();
  } }, 'Clear');
  const bar = h('div', { class: 'filters card', role: 'search' },
    towns ? sel('town', 'Town', [['', 'All towns'], ...towns.map((t) => [t.id, t.name])]) : null,
    sel('feed', 'Feed', [['', 'All feeds'], ...feeds.map((k) => [k, feedNames[k] || k])]),
    sel('status', 'Status', STATUS_FILTERS),
    h('label', { class: 'filter grow' }, 'Search', q),
    clear);
  return bar;
}

const feedList = (sources, feedNames) => {
  const have = new Set(sources.map((s) => s.feed));
  return [...Object.keys(feedNames).filter((k) => have.has(k)), ...[...have].filter((k) => !(k in feedNames))];
};

// A Colorado (CDOT) or New Mexico (NMRoads) town without roads: one click adds them,
// highways picked from its map point. Other states have no roads feed yet, so their
// Roads tile is simply left off the site.
const ROAD_DOTS = { CO: { adapter: 'cdot', name: 'CDOT' }, NM: { adapter: 'nmroads', name: 'NMRoads' } };
function roadsCard(t) {
  const dot = ROAD_DOTS[t.state];
  if (!dot) return null;
  if (t.sources.some((s) => s.adapter === dot.adapter)) return null;
  const msg = h('span', { class: 'small', role: 'status' });
  const btn = h('button', { type: 'button', class: 'small', onclick: async () => {
    btn.disabled = true; msg.className = 'small muted'; msg.textContent = `Asking ${dot.name} for the highways near the map point…`;
    try {
      const r = await api('/source/cdot-auto', { town: t.id });
      msg.className = 'small ok-msg'; msg.textContent = `Added: ${r.roads.routes.join(', ')}. Edit the ${dot.name} source to change them.`;
      setTimeout(() => healthPage(), 1500);
    } catch (err) { btn.disabled = false; msg.className = 'small error'; msg.textContent = err.message; }
  } }, `Add ${dot.name} roads`);
  return h('div', { class: 'card' }, h('div', { class: 'row spread' },
    h('span', {}, h('strong', {}, `${t.name} has no roads yet. `), h('span', { class: 'muted small' }, 'The Roads tile stays hidden until it does.')), btn), msg);
}

// Feeds tab, "Find feeds with Claude": copy a research prompt built from the town
// (name, state, map point, the sources it already has), paste Claude's JSON answer,
// preview with checkboxes, then add the ticked ones. Confirmed RSS and iCal feeds start
// running; anything else is added paused to check. No API call: copy and paste only.
function claudeFeedsCard(townId) {
  const box = h('div', { hidden: true });
  const err = h('p', { class: 'error', role: 'alert' });
  const out = h('div');
  const copied = h('span', { class: 'ok-msg small', role: 'status' });
  const paste = h('textarea', { rows: 6, spellcheck: 'false', placeholder: 'Paste Claude\'s answer here (the ```json block, or the whole reply).' });
  let t = null;

  function prompt() {
    const place = `${t.name}${t.state ? `, ${t.state}` : ''}`;
    const point = t.location ? ` (map point ${(+t.location.lat).toFixed(4)}, ${(+t.location.lon).toFixed(4)})` : '';
    const have = t.sources.map((x) => `- ${x.label} (${x.adapter})${[].concat(x.settings?.url || [])[0] ? `: ${[].concat(x.settings.url)[0]}` : ''}`).join('\n') || '- none yet';
    return `I run ${String(t.url || '').replace(/^https?:\/\//, '') || 'a local info site'}, a real-time local information site for ${place}${point}. It shows a live feed of posts from official and trusted local sources. Find more sources for it with web search.

It already has these sources, so don't suggest them again:
${have}

Look for sources that publish timely local information for ${place} and the area around it:
- news: the local newspaper, radio or TV station, and the town or city news page
- government: the town or city, the county, and tribal or regional government if there is one (news, meeting notices, public notices)
- events: community calendars, the library, the chamber or visitor center, arts and recreation (iCal feeds if they have them)
- schools: the school district and local colleges (news, closures, calendars)
- utilities: electric, gas, water and trash providers (outage and service notices)
- emergency: county emergency management, sheriff, police and fire, the hospital, and public health (alerts and notices)

Skip weather and roads (the site already gets them from the National Weather Service and the state DOT), and skip social media accounts.

Answer with ONLY one JSON code block (\`\`\`json ... \`\`\`) in exactly this shape:

{
  "suggestedSources": [
    { "label": "Who publishes it", "type": "rss | ical | other", "kind": "news | town | events | alerts", "hasEvents": false, "url": "https://...", "why": "what it would add (county alerts, school closures, events)" }
  ]
}

Rules:
- kind sets where its posts sort in the live feed: "news" for newspapers, radio and blogs (sorted by post date); "town" for town, county, school and utility news; "events" for calendars and event listings (sorted by when the event happens); "alerts" only for official emergency notices (sheriff, emergency management, public health, utility outages).
- hasEvents: true for a news feed that also posts event listings with dates in them.
- type "rss" is an RSS or Atom feed address and "ical" is an iCal (.ics or webcal) calendar address. Use them only for feed addresses you actually found and opened. Use "other" for a useful page that has no feed.
- Only include URLs you actually found. Never guess a feed address.
- Say in "why" if a feed needs checking (old posts, not sure it updates).
- Up to 25 sources, most useful first.`;
  }

  const SKIP_DONE = /^Already added/;
  async function preview() {
    err.textContent = '';
    const text = paste.value.trim();
    if (!text) { err.textContent = 'Paste Claude\'s answer first.'; return; }
    const block = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
    let j;
    try { j = JSON.parse(block ? block[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { err.textContent = 'That doesn\'t look like the JSON answer. Paste the whole ```json block.'; return; }
    const suggested = Array.isArray(j) ? j : j.suggestedSources;
    let plan;
    try { plan = await api('/source/from-claude', { town: t.id, suggestedSources: suggested }); } catch (e) { err.textContent = e.message; return; }
    const checks = plan.sources.map((x) => h('input', { type: 'checkbox', value: x.index, checked: true, 'aria-label': `Add ${x.label}` }));
    const addBtn = h('button', { type: 'button' }, 'Add ticked sources');
    const msg = h('span', { class: 'small', role: 'status' });
    const sync = () => { const n = checks.filter((c) => c.checked).length; addBtn.disabled = !n; addBtn.textContent = n ? `Add ${n} source${n === 1 ? '' : 's'}` : 'Add ticked sources'; };
    checks.forEach((c) => c.addEventListener('change', sync));
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true; msg.className = 'small muted'; msg.textContent = 'Adding…';
      try {
        const r = await api('/source/from-claude', { town: t.id, suggestedSources: suggested, pick: checks.filter((c) => c.checked).map((c) => +c.value) });
        const on = r.added.filter((x) => x.enabled).length;
        out.replaceChildren(h('p', { class: 'ok-msg' }, `Added ${r.added.length} source${r.added.length === 1 ? '' : 's'}: ${on} running, ${r.added.length - on} paused to check. They're in the table above.`));
        paste.value = '';
        healthPage();
      } catch (e) { addBtn.disabled = false; msg.className = 'small error'; msg.textContent = e.message; }
    });
    sync();
    const skipped = plan.skipped.filter((x) => x.url || !SKIP_DONE.test(x.reason));
    out.replaceChildren(...[
      plan.sources.length
        ? h('ul', { class: 'claude-feeds' }, ...plan.sources.map((x, i) => h('li', {},
          h('label', { class: 'check' }, checks[i],
            h('span', {}, h('strong', {}, x.label), ' ', h('span', { class: `pill ${x.enabled ? 'on' : 'off'}` }, x.enabled ? `${x.adapter.toUpperCase()}, runs now` : 'Paused to check'))),
          h('div', { class: 'muted small' }, x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.url) : null),
          x.about ? h('div', { class: 'muted small' }, x.about) : null)))
        : h('p', { class: 'muted' }, 'Nothing new to add from that answer.'),
      skipped.length ? h('details', {}, h('summary', {}, `Not added (${skipped.length})`),
        h('ul', {}, ...skipped.map((x) => h('li', { class: 'small' }, h('strong', {}, x.label), x.url ? ` (${x.url})` : '', `: ${x.reason}`)))) : null,
      plan.sources.length ? h('div', { class: 'row form-actions' }, addBtn, msg) : null,
    ].filter(Boolean));
  }

  const btn = h('button', { type: 'button', class: 'secondary', onclick: async () => {
    if (!box.hidden) { box.hidden = true; btn.textContent = 'Show prompt'; return; }
    err.textContent = '';
    try { t = (await api('/towns')).towns.find((x) => x.id === townId); } catch (e) { err.textContent = e.message; return; }
    if (!t) { err.textContent = 'Town not found.'; return; }
    const p = prompt();
    const ta = h('textarea', { rows: 12, readonly: true, class: 'mono' }, p);
    box.replaceChildren(
      h('p', { class: 'muted small' }, '1. Copy this prompt into Claude (claude.ai, with web search on). 2. Paste Claude\'s answer below and press Preview. 3. Untick anything you don\'t want, then Add.'),
      ta,
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(p); } catch { ta.select(); document.execCommand('copy'); }
        copied.textContent = 'Copied.'; setTimeout(() => { copied.textContent = ''; }, 2500);
      } }, 'Copy prompt'), copied),
      field('Claude\'s answer', paste),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: preview }, 'Preview')),
      out);
    box.hidden = false;
    btn.textContent = 'Hide prompt';
  } }, 'Show prompt');
  return h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', {}, 'Find feeds with Claude'), btn),
    h('p', { class: 'muted small' }, 'Get a research prompt for this town that lists the sources it already has. Claude looks for news, government, events, schools, utilities and emergency feeds. Confirmed RSS and iCal feeds start running; the rest are added paused so you can check them.'),
    err, box);
}

// ---------- health board ----------
let healthData = null;
async function healthPage(refresh = false) {
  healthData = await api('/health');
  if (!refresh || !$('#health-results')) {
    const all = healthData.towns.filter((t) => !filters.town || t.id === filters.town).flatMap((t) => t.sources);
    const towns = healthData.towns.map((t) => ({ id: t.id, name: `${t.name}${t.state ? `, ${t.state}` : ''}` }));
    if (filters.town && !towns.some((t) => t.id === filters.town)) filters.town = '';
    view.replaceChildren(
      h('div', { class: 'row spread' }, h('h2', {}, 'Feeds'), h('span', {}, filters.town ? h('a', { class: 'button small', href: `#new-source/${filters.town}` }, 'Add a source') : null, ' ', h('span', { class: 'muted small', id: 'health-updated' }))),
      filterBar(filters, { towns: null, feeds: feedList(all, healthData.feeds || {}), feedNames: healthData.feeds || {} }, () => { saveFilters(); renderHealth(); }),
      h('div', { id: 'health-results' }),
      filters.town ? claudeFeedsCard(filters.town) : '',
    );
  }
  $('#health-updated').textContent = `Updated ${new Date().toLocaleTimeString()}, refreshes every 30 s`;
  renderHealth();
}

function renderHealth() {
  const box = $('#health-results');
  if (!box || !healthData) return;
  const towns = healthData.towns
    .filter((t) => !filters.town || t.id === filters.town)
    .map((t) => ({ ...t, shown: t.sources.filter((s) => matches(s, filters, t.name)) }));
  const total = towns.reduce((n, t) => n + t.sources.length, 0);
  const shown = towns.flatMap((t) => t.shown);
  const count = (c) => shown.filter((s) => s.color === c).length;
  const filtered = isFiltered(filters, false);
  const visible = filtered ? towns.filter((t) => t.shown.length || (filters.town && !filters.feed && !filters.status && !filters.q)) : towns;
  box.replaceChildren(...[
    h('p', { class: 'summary' },
      ...['green', 'amber', 'red', 'paused'].map((c) => h('span', {}, dot(c), `${count(c)} ${COLOR_WORD[c].toLowerCase()}`)),
      filtered ? h('span', { class: 'muted' }, `Showing ${shown.length} of ${total} sources`) : null),
    h('p', { class: 'muted small' }, 'Red means a source has failed for over an hour. Amber means failing for under an hour, overdue, or waiting for its first run.'),
    ...visible.map((t) => roadsCard(t)),
    ...visible.map((t) => h('div', { class: 'card' },
      t.shown.length ? sourceTable(t, t.shown) : h('p', { class: 'muted' }, t.sources.length ? 'No sources match the filters.' : 'No sources yet. Add a source above.'))),
    visible.length ? null : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No sources match the filters.')),
  ].filter(Boolean));
}

// Short names for a source's kind (adapters.js kindOf) in the Feeds table.
const KIND_NAMES = { news: 'News', town: 'Town news', events: 'Events', alerts: 'Alerts', weather: 'Weather', roads: 'Roads', lifts: 'Snow' };

/** First guess at a new feed's kind from its name and address; the same rules as claude-town.js. */
function guessKind(label, url) {
  const text = `${label || ''} ${url || ''}`;
  if (/\b(alert|emergenc|sheriff|911|evacuat|warning|oem)/i.test(text) || /nixle|everbridge|codered/i.test(url || '')) return 'alerts';
  if (/(event|calendar|festival|concert|\.ics\b|tribe_events|\/events?\b)/i.test(text)) return 'events';
  if (/\b(city|town|county|village|government|council|utilit|transit|bus)\b/i.test(label || '')) return 'town';
  return 'news';
}

function sourceTable(town, rows, compact = false) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Source'), h('th', { class: 'hide-sm' }, 'Type'), h('th', {}, 'Last success'), h('th', { class: 'hide-sm' }, 'Posts'), h('th', {}, 'Status'), h('th', {}, ''))),
    h('tbody', {}, ...rows.map((s) => h('tr', {},
      h('td', {}, dot(s.color)),
      h('td', {}, h('a', { href: `#source/${town.id}/${s.key}` }, s.label), ' ', h('span', { class: `pill kind kind-${s.kind}`, title: 'Kind: sets where its posts sort in the feed' }, KIND_NAMES[s.kind] || s.kind), h('div', { class: 'muted small' }, s.key)),
      h('td', { class: 'hide-sm small' }, s.adapterName, h('div', { class: 'muted' }, `every ${s.everyMin} min`)),
      h('td', { class: 'small' }, ago(s.lastOk)),
      h('td', { class: 'hide-sm small' }, s.items ?? ''),
      s.error ? h('td', { class: 'err' }, `${s.note}: ${s.error}`) : h('td', { class: 'small' }, s.note),
      h('td', { class: 'actions' },
        s.enabled ? h('button', { class: 'small secondary', onclick: (e) => act(e, '/source/run', { town: town.id, key: s.key }, 'Running') }, 'Retry') : null,
        h('button', { class: 'small secondary', onclick: (e) => act(e, '/source/toggle', { town: town.id, key: s.key, enabled: !s.enabled }) }, s.enabled ? 'Pause' : 'Resume'),
        compact ? null : h('a', { class: 'button small secondary', href: `#source/${town.id}/${s.key}` }, 'Edit')),
    )))));
}

async function act(e, path, body, busyText) {
  const btn = e.currentTarget;
  btn.disabled = true;
  if (busyText) btn.textContent = busyText;
  try {
    await api(path, body);
    setTimeout(route, busyText ? 4000 : 0); // a retry needs a moment to finish
  } catch (err) { alertBox(err.message); btn.disabled = false; }
}

function alertBox(msg) {
  const el = h('div', { class: 'card error', role: 'alert' }, msg);
  view.prepend(el);
  setTimeout(() => el.remove(), 8000);
}

// ---------- towns ----------
// Header message fields (text, style, last day), used by a town's Settings and the All towns page.
const NOTICE_LEVELS = [['info', 'Note (blue dot)'], ['warn', 'Heads up (amber dot)'], ['urgent', 'Alert (red)']];
function noticeFields(n, help) {
  return h('div', {},
    h('p', { class: 'muted small' }, help),
    field('Message', h('input', { name: 'noticeText', maxlength: 280, value: n?.text || '', placeholder: 'Blank for none. Like: Town Hall is closed Friday for the holiday.' })),
    h('div', { class: 'grid2' },
      field('Style', h('select', { name: 'noticeLevel' }, ...NOTICE_LEVELS.map(([v, l]) => h('option', { value: v, selected: (n?.level || 'info') === v }, l)))),
      field('Last day shown', h('input', { name: 'noticeUntil', type: 'date', value: n?.until || '' }), 'Optional. Blank keeps it up until you clear it.')));
}

function allTownsNotice(n) {
  const msg = h('span', { class: 'ok-msg small', role: 'status' });
  const f = h('form', {}, noticeFields(n, 'Shown on every town\'s pages, at the top beside the town picker, ahead of each town\'s own message.'),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Save message'), msg));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    msg.textContent = '';
    try {
      const r = await api('/notice', { text: v.noticeText, level: v.noticeLevel, until: v.noticeUntil });
      msg.textContent = r.notice ? 'Saved. It shows on every town now.' : 'Cleared.';
    } catch (err) { msg.textContent = err.message; }
  });
  return h('div', { class: 'card' }, h('h2', {}, 'Message for every town'), f);
}

async function townsPage() {
  const [{ towns }, { towns: health }, { notice }] = await Promise.all([api('/towns'), api('/health'), api('/notice')]);
  const color = Object.fromEntries(health.map((t) => [t.id, t.color]));
  view.replaceChildren(
    h('div', { class: 'row spread' }, h('h1', {}, 'Towns'), h('a', { class: 'button', href: '#new-town' }, 'Add a town')),
    h('div', { class: 'card' }, h('ul', { class: 'towns-list' }, ...towns.map((t) => h('li', {},
      dot(color[t.id] || 'amber'),
      h('span', { class: 'grow' }, h('a', { href: `#town/${t.id}` }, h('strong', {}, `${t.name}${t.state ? `, ${t.state}` : ''}`)),
        h('div', { class: 'muted small' }, `${t.sources.length} sources · ${(t.hostnames || [])[0] || ''}`)),
      h('span', { class: `pill ${t.status}` }, t.status))))),
    allTownsNotice(notice),
  );
}

// ---------- admin settings ----------
// Settings for the whole admin and server, not one town: the admin password, signing
// out other devices, and a read-only look at the server's .env settings.
async function adminSettingsPage() {
  const { password: pw, groups } = await api('/server-settings');
  const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const status = () => (pw.source === 'admin'
    ? `Set here on ${day(pw.changedAt)}. It replaces ADMIN_PASSWORD in the server's .env.`
    : "Comes from ADMIN_PASSWORD in the server's .env.");
  const statusLine = h('p', { class: 'muted small' }, status());

  const msg = h('p', { class: 'ok-msg small', role: 'status' });
  const err = h('p', { class: 'error', role: 'alert' });
  const pwInput = (name, auto) => h('input', { type: 'password', name, autocomplete: auto, required: true });
  const f = h('form', { id: 'password-form' },
    field('Current password', pwInput('current', 'current-password')),
    h('div', { class: 'grid2' },
      field('New password', pwInput('next', 'new-password'), `At least ${pw.minLength} characters.`),
      field('New password again', pwInput('again', 'new-password'))),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Change password')),
    err, msg);
  f.next.minLength = pw.minLength;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = ''; msg.textContent = '';
    if (f.next.value !== f.again.value) { err.textContent = "The two new passwords don't match."; return; }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      Object.assign(pw, await api('/password', { current: f.current.value, next: f.next.value }));
      f.reset();
      statusLine.textContent = status();
      useEnv.hidden = pw.source !== 'admin';
      msg.textContent = 'Password changed. Every other device is signed out; this one stays signed in.';
    } catch (x) { err.textContent = x.message; }
    btn.disabled = false;
  });

  // Back to the .env password (needs the current password, typed in the field above).
  const useEnv = h('div', { hidden: pw.source !== 'admin' },
    h('p', { class: 'muted small' }, "Or go back to the password in the server's .env file. Type your current password above first."),
    h('button', { type: 'button', class: 'secondary small', onclick: async () => {
      err.textContent = ''; msg.textContent = '';
      if (!f.current.value) { err.textContent = 'Type your current password first.'; f.current.focus(); return; }
      try {
        Object.assign(pw, await api('/password/use-env', { current: f.current.value }));
        f.reset();
        statusLine.textContent = status();
        useEnv.hidden = true;
        msg.textContent = "The admin uses the .env password again. Every other device is signed out.";
      } catch (x) { err.textContent = x.message; }
    } }, 'Use the .env password'));

  const othersMsg = h('span', { class: 'ok-msg small', role: 'status' });
  const others = h('div', { class: 'card' }, h('h2', {}, 'Signed-in devices'),
    h('p', { class: 'muted small' }, 'A sign-in lasts 14 days on each device. If you signed in on a computer or phone that is not yours, sign it out here.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: async (e) => {
      e.target.disabled = true;
      try { await api('/sign-out-others', {}); othersMsg.textContent = 'Done. Only this device is signed in now.'; } catch (x) { othersMsg.textContent = x.message; }
      e.target.disabled = false;
    } }, 'Sign out every other device'), othersMsg));

  const value = (it) => {
    if (it.secret) return it.set ? h('span', {}, 'Set ', h('span', { class: 'muted' }, '(hidden)')) : h('span', { class: 'warn-text' }, 'Not set');
    if (!it.set) return h('span', { class: 'muted' }, 'Not set');
    return h('span', {}, it.name ? h('code', { class: 'setting-value' }, it.value) : it.value, it.isDefault ? h('span', { class: 'muted small' }, ' (default)') : null);
  };
  const groupCard = (g) => h('div', { class: 'card' }, h('h2', {}, g.title),
    h('dl', { class: 'settings-list' }, ...g.items.flatMap((it) => [
      h('dt', {}, it.label, it.name ? h('span', { class: 'muted small setting-name' }, it.name) : null),
      h('dd', {}, value(it), it.note ? h('span', { class: 'help' }, it.note) : null)])));

  view.replaceChildren(
    h('h1', {}, 'Admin settings'),
    h('p', { class: 'muted' }, 'For the whole admin and server. Each town has its own Settings tab for its name, logo and header message.'),
    h('div', { class: 'card' }, h('h2', {}, 'Admin password'), statusLine, f, useEnv),
    others,
    h('h2', { class: 'section-title' }, 'Server settings'),
    h('p', { class: 'muted small' }, "These come from the .env file on the server, so they only change there. Secret values are never shown. After you edit .env, run: ",
      h('code', {}, 'cd /opt/telluride-buzz && docker compose up -d --force-recreate')),
    ...groups.map(groupCard),
  );
}

const field = (label, input, help) => h('label', {}, label, help ? h('span', { class: 'help' }, help) : null, input);

async function townPage(id) {
  const { towns } = await api('/towns');
  const t = id ? towns.find((x) => x.id === id) : null;
  if (id && !t) throw new Error(`No town "${id}"`);
  const hd = id ? await api('/health') : null;
  if (hd) feedNamesCache = hd.feeds || {};
  const health = hd ? hd.towns.find((x) => x.id === id) : null;
  const b = t?.brand || {};
  const f = h('form', { id: 'town-form' },
    h('div', { class: 'grid2' },
      field('Town name', h('input', { name: 'name', required: true, value: t?.name || '', placeholder: 'Town name' })),
      field('State', h('input', { name: 'state', required: true, value: t?.state || '', placeholder: 'CO', maxlength: 2, pattern: '[A-Za-z]{2}' })),
      field('Address name', h('input', { name: 'id', required: true, value: t?.id || '', placeholder: 'townname', pattern: '[a-z][a-z0-9\\-]{1,39}', readonly: !!t }),
        t ? 'Fixed once the town exists.' : 'Becomes [address name].thetown.buzz. Lowercase letters, numbers, dashes.'),
      field('Site name', h('input', { name: 'siteName', value: b.siteName || '', placeholder: '[Town] Buzz' }), 'Used in sentences and the browser tab.'),
      field('Latitude', h('input', { name: 'lat', required: true, inputmode: 'decimal', value: t?.location?.lat ?? '', placeholder: 'Filled by Look up' })),
      field('Longitude', h('input', { name: 'lon', required: true, inputmode: 'decimal', value: t?.location?.lon ?? '', placeholder: 'Filled by Look up' })),
      field('Time zone', h('input', { name: 'timezone', value: t?.timezone || 'America/Denver', list: 'zones' })),
      field('Logo', h('select', { name: 'logo' },
        ...[['thetown', 'thetown.buzz style (town name + "thetown" circle)'],
          ['rock', 'thetown.buzz style, red rock circle'],
          ['ridge', 'thetown.buzz style, mountain ridge in the circle'],
          ['rail', 'thetown.buzz style, railroad under the town name'],
          ['own', 'Own domain style (we own [town].buzz)']]
          .map(([v, label]) => h('option', { value: v, selected: (b.logo || 'thetown') === v }, label)))),
    ),
    h('datalist', { id: 'zones' }, ...['America/Denver', 'America/Phoenix', 'America/Boise', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu'].map((z) => h('option', { value: z }))),
    field('Web addresses', h('textarea', { name: 'hostnames', rows: 2, placeholder: '[address name].thetown.buzz' }, (t?.hostnames || []).join('\n')),
      'One per line. Leave blank for [address name].thetown.buzz, which works right away (the *.thetown.buzz wildcard covers it). Only your own domains, like fortcollins.buzz, need DNS pointed at the server and a Caddy entry.'),
    h('div', { class: 'grid2' },
      field('Feedback email', h('input', { name: 'feedbackEmail', type: 'email', value: b.feedbackEmail || '', placeholder: 'telluridebuzz@gmail.com' })),
      field('Status', h('select', { name: 'status' },
        h('option', { value: 'draft', selected: t?.status !== 'live' }, 'Draft: works at its address, hidden from the town picker and thetown.buzz'),
        h('option', { value: 'live', selected: t?.status === 'live' }, 'Live: listed everywhere'))),
    ),
    field('"Not affiliated with" line', h('input', { name: 'notAffiliated', value: b.notAffiliated || '', placeholder: 'the town, the county, CDOT or the National Weather Service' }), 'About page. Leave blank for a general line.'),
    !t ? null : h('fieldset', { class: 'sponsor-box' }, h('legend', {}, 'Header message'),
      noticeFields(b.notice, 'This town only, shown at the top of every page beside the town picker. A message for every town is on the All towns page.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'preview', checked: b.preview !== false }), ' Show the "Preview: early testing" note')),
    h('button', { type: 'submit' }, t ? 'Save town' : 'Create town'),
    h('p', { class: 'error', id: 'town-error', role: 'alert' }),
  );
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const town = {
      id: v.id, name: v.name, state: v.state, timezone: v.timezone, status: v.status,
      location: { lat: v.lat, lon: v.lon },
      hostnames: v.hostnames.split(/\s+/).filter(Boolean),
      brand: { siteName: v.siteName, logo: v.logo, feedbackEmail: v.feedbackEmail, notAffiliated: v.notAffiliated,
        ...(t ? { notice: { text: v.noticeText, level: v.noticeLevel, until: v.noticeUntil }, preview: v.preview === 'on' } : {}) },
    };
    if (t && t.hostnames?.join('\n') !== v.hostnames.trim()) town.url = '';
    try {
      const r = await api('/town', { create: !t, town, ...(!t && f._claude ? { fromClaude: f._claude } : {}) });
      if (r.fromClaude) { showCreated(r.town, r.fromClaude, r.roads); return; }
      location.hash = `town/${r.town.id}`;
      if (t) route();
    } catch (err) { $('#town-error').textContent = err.message; }
  });

  // Settings is only the town's own fields: its sources live on the Feeds tab and its
  // listings on the Resources tab. A draft town also gets the going-live checklist.
  const kids = t ? [] : [h('p', {}, h('a', { href: '#towns' }, '← All towns')), h('h1', {}, 'Add a town')];
  if (!t) {
    // Only Town name and State are typed by hand. The rest is filled by Look up on the
    // map or Fill with Claude, and stays greyed out until Edit the other fields.
    const others = [...f.elements].filter((el) => el.name && !['name', 'state'].includes(el.name) && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
    const lock = (on) => {
      for (const el of others) {
        if (el.tagName === 'SELECT') el.disabled = on; else el.readOnly = on;
        el.classList.toggle('locked', on);
        if (on) el.dataset.autofill = ''; else delete el.dataset.autofill;
      }
      editBtn.textContent = on ? 'Edit the other fields' : 'Lock them again';
    };
    const editBtn = h('button', { type: 'button', class: 'small secondary', onclick: () => lock(others[0].classList.contains('locked') ? false : true) });
    f.querySelector('.grid2').before(h('div', { class: 'row lock-note' },
      h('span', { class: 'muted small' }, 'Type the town name and state. Everything else is filled in for you by Look up on the map or Fill with Claude.'), editBtn));
    lock(true);
    // Placeholders follow the typed town name, so nothing looks like another town's data.
    const hint = () => {
      const n = f.elements.name.value.trim();
      const slug = n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 40);
      f.elements.id.placeholder = slug || 'townname';
      f.elements.siteName.placeholder = n ? `${n} Buzz` : '[Town] Buzz';
      // Web addresses shows exactly what a blank box becomes: the address name, as filled or as hinted.
      f.elements.hostnames.placeholder = `${f.elements.id.value.trim() || slug || '[address name]'}.thetown.buzz`;
    };
    f.addEventListener('input', hint);
    f.addEventListener('lookup-filled', hint);
    // Disabled selects aren't sent with the form, so turn them back on just before saving.
    f.addEventListener('submit', () => { for (const el of others) if (el.tagName === 'SELECT') el.disabled = false; }, true);
    // The Look up button sits right under the Town name box; its result shows under the fields.
    const { button, out } = townLookup(f);
    f.elements.name.after(button);
    f.querySelector('.grid2').after(out);
  }

  if (!t) kids.push(h('p', { class: 'muted' }, 'A new town starts as a draft with National Weather Service alerts and forecast already added (they only need the map point). Then add its roads, resort, town and news sources.'));
  if (t && t.status === 'draft') kids.push(h('div', { class: 'card' }, h('h2', {}, 'Going live'), goLiveSteps(t, health)));
  kids.push(h('div', { class: 'card' }, h('h2', {}, t ? 'Settings' : 'Town details'), f));
  // Add a town: Fill with Claude sits under the form and builds its prompt from the
  // town name (and state) typed above.
  if (!t) kids.push(fillTownWithClaude(f));
  if (t) {
    kids.push(h('div', { class: 'card' }, h('h2', {}, 'Backup and removal'),
      h('p', {}, h('a', { class: 'button secondary', href: `/api/admin/export?town=${encodeURIComponent(t.id)}` }, 'Download town as JSON'),
        ' ', h('span', { class: 'muted small' }, 'Same format as config/*.json, so it can be re-imported.')),
      t.status === 'draft'
        ? h('p', {}, h('button', { class: 'danger', onclick: async () => {
          const typed = prompt(`This deletes ${t.name}, its sources and its posts. Type "${t.id}" to confirm.`);
          if (typed == null) return;
          try { await api('/town/delete', { town: t.id, confirm: typed }); location.hash = 'towns'; } catch (err) { alertBox(err.message); }
        } }, 'Delete town'))
        : h('p', { class: 'muted small' }, 'Switch the town to draft before deleting it.')));
  }
  view.replaceChildren(...kids);
}

let feedNamesCache = null;

function goLiveSteps(t, health) {
  const host = (t.hostnames || [])[0] || '';
  const has = (a) => t.sources.some((s) => s.adapter === a && s.enabled);
  const green = health ? health.sources.filter((s) => s.color === 'green').length : 0;
  const item = (done, ...text) => h('li', {}, done ? '✓ ' : '○ ', ...text);
  return h('ol', { class: 'steps' },
    item(true, 'Town created (draft).'),
    item(has('nws-forecast') && has('nws-alerts'), 'Weather: NWS alerts and forecast.'),
    ROAD_DOTS[t.state] ? item(has(ROAD_DOTS[t.state].adapter), `Roads: ${ROAD_DOTS[t.state].name} with the town's highways (Add ${ROAD_DOTS[t.state].name} roads on the Feeds tab picks them from the map point).`)
      : item(true, `Roads: no roads feed for ${t.state || 'this state'} yet, so the Roads tile is left off.`),
    item(has('snow-report'), 'Lifts & Snow: one snow report per nearby resort (skip if none).'),
    item(has('rss') || has('ical'), 'Town and news: town/county RSS, local paper, an events calendar.'),
    item(green > 0 && health.color !== 'red', `Health: ${green} of ${health?.sources.length || 0} sources green.`),
    host.endsWith('.thetown.buzz')
      ? item(true, 'Address: ', h('code', {}, host), ' works on its own (the *.thetown.buzz wildcard covers it).')
      : item(false, 'Address: ', h('code', {}, host), ' is your own domain: point its DNS at the server and add a Caddy entry.'),
    item(false, 'Check it at ', h('a', { href: t.url, target: '_blank', rel: 'noopener' }, t.url), ', then set Status to Live.'),
  );
}

// ---------- sources ----------
async function sourcePage(townId, key) {
  const [{ towns }, cat] = await Promise.all([api('/towns'), getAdapters()]);
  const t = towns.find((x) => x.id === townId);
  if (!t) throw new Error(`No town "${townId}"`);
  const s = key ? t.sources.find((x) => x.key === key) : null;
  if (key && !s) throw new Error(`No source "${key}" in ${t.name}`);
  const health = key ? (await api('/health')).towns.find((x) => x.id === townId)?.sources.find((x) => x.key === key) : null;

  const typeSel = h('select', { name: 'adapter', disabled: !!s },
    ...cat.map((a) => h('option', { value: a.type, selected: (s?.adapter || 'rss') === a.type,
      disabled: !s && a.single && t.sources.some((x) => x.adapter === a.type) }, a.name)));
  const typeHelp = h('p', { class: 'muted small' });
  const fieldsBox = h('div');
  const result = h('div');
  const err = h('p', { class: 'error', role: 'alert' });
  const every = h('input', { name: 'everyMin', type: 'number', min: 1, max: 1440, step: 1, value: s?.everyMin ?? '' });

  const renderFields = () => {
    const a = cat.find((x) => x.type === typeSel.value);
    typeHelp.textContent = a.description;
    every.placeholder = `${a.defaultEvery} (default)`;
    fieldsBox.replaceChildren(...a.fields.map((fd) => {
      const val = s?.adapter === a.type ? s.settings?.[fd.key] : undefined;
      let input;
      if (fd.type === 'select') {
        // A new feed's Kind starts from a guess and follows the name and address until changed by hand.
        const auto = !s && fd.key === 'category';
        input = h('select', { name: `s.${fd.key}`, ...(auto ? { 'data-auto': '1', onchange: (e) => { delete e.target.dataset.auto; } } : {}) },
          auto ? null : h('option', { value: '' }, ''),
          ...fd.options.map((o) => h('option', { value: o, selected: (val ?? (auto ? 'news' : '')) === o }, fd.labels?.[o] || o)));
      }
      else if (fd.type === 'checkbox') return h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `s.${fd.key}`, checked: !!val }), fd.label, fd.help ? h('span', { class: 'help inline-help' }, fd.help) : null);
      else if (fd.editor === 'routes') return routeEditor(fd, Array.isArray(val) ? val : [], t, a);
      else if (fd.type === 'json') input = h('textarea', { name: `s.${fd.key}`, rows: 6, placeholder: fd.placeholder || '' }, val ? JSON.stringify(val, null, 2) : '');
      else if (fd.type === 'list' || fd.type === 'urls') input = h('textarea', { name: `s.${fd.key}`, rows: 3, placeholder: fd.placeholder || '' }, [].concat(val ?? []).join('\n'));
      else input = h('input', { name: `s.${fd.key}`, type: fd.type === 'number' ? 'number' : (fd.type === 'url' ? 'url' : 'text'), value: val ?? '', placeholder: fd.placeholder || '', required: !!fd.required });
      return field(`${fd.label}${fd.required ? '' : ' (optional)'}`, input, fd.help);
    }));
  };
  typeSel.addEventListener('change', renderFields);

  const f = h('form', {},
    field('Type', typeSel), typeHelp,
    h('div', { class: 'grid2' },
      field('Name shown on posts', h('input', { name: 'label', required: true, value: s?.label || '', placeholder: 'Town or agency name' })),
      field('Check every (minutes)', every)),
    fieldsBox,
    field('About page line (optional)', h('input', { name: 'about', value: s?.about || '', placeholder: 'City news and the community calendar' }), 'Leave blank for the type\'s description.'),
    h('div', { class: 'row form-actions' },
      h('button', { type: 'button', class: 'secondary', onclick: test }, 'Test'),
      h('button', { type: 'submit' }, s ? 'Save source' : 'Add source'),
      s ? h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete') : null),
    err, result,
  );
  renderFields();
  if (!s) f.addEventListener('input', (e) => {
    if (e.target.name !== 'label' && e.target.name !== 's.url') return;
    const kind = f.querySelector('select[name="s.category"][data-auto]');
    if (kind) kind.value = guessKind(f.querySelector('[name=label]').value, f.querySelector('[name="s.url"]')?.value);
  });

  function collect() {
    const fd = new FormData(f);
    const source = { key: s?.key, adapter: typeSel.value, label: fd.get('label'), about: fd.get('about'), everyMin: fd.get('everyMin'), enabled: s ? s.enabled : true, settings: {} };
    const a = cat.find((x) => x.type === typeSel.value);
    for (const x of a.fields) {
      const v = fd.get(`s.${x.key}`);
      source.settings[x.key] = x.type === 'checkbox' ? v === 'on' : v;
    }
    return source;
  }

  async function test(e) {
    const btn = e.currentTarget;
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Testing…';
    result.replaceChildren(h('p', { class: 'muted' }, 'Fetching and reading the source…'));
    try {
      const { result: r } = await api('/source/test', { town: t.id, source: collect() });
      const tiles = Object.entries(r.tiles || {});
      result.replaceChildren(h('div', { class: 'test-result' },
        h('p', {}, r.ok ? h('strong', { class: 'ok-msg' }, `Worked in ${(r.ms / 1000).toFixed(1)} s: ${r.count} post${r.count === 1 ? '' : 's'}${tiles.length ? `, ${tiles.map(([k]) => k).join(' and ')} tile` : ''}.`)
          : h('strong', { class: 'error' }, `Failed: ${r.error}`)),
        r.items.length ? h('ol', {}, ...r.items.map((i) => h('li', {},
          i.link ? h('a', { href: i.link, target: '_blank', rel: 'noopener noreferrer' }, i.title) : i.title,
          h('div', { class: 'muted small' }, [i.category, i.startsAt ? `starts ${new Date(i.startsAt).toLocaleString()}` : `posted ${new Date(i.publishedAt).toLocaleString()}`, i.severity >= 2 ? 'BANNER' : null].filter(Boolean).join(' · '))))) : null,
        r.tiles?.roads ? roadsPreview(r.tiles.roads) : null,
        ...tiles.map(([k, v]) => h('details', {}, h('summary', {}, k === 'roads' ? 'roads tile (raw data)' : `${k} tile`), h('pre', {}, JSON.stringify(v, null, 2)))),
      ));
    } catch (e2) { result.replaceChildren(); err.textContent = e2.message; }
    btn.disabled = false; btn.textContent = 'Test';
  }

  async function remove() {
    if (!confirm(`Delete "${s.label}" from ${t.name}? Its posts disappear from the feed.`)) return;
    try { await api('/source/delete', { town: t.id, key: s.key }); location.hash = `feeds?town=${encodeURIComponent(t.id)}`; } catch (e2) { err.textContent = e2.message; }
  }

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api('/source', { create: !s, town: t.id, source: collect() });
      location.hash = `feeds?town=${encodeURIComponent(t.id)}`;
    } catch (e2) { err.textContent = e2.message; }
  });

  view.replaceChildren(...[
    h('p', {}, h('a', { href: `#feeds?town=${encodeURIComponent(t.id)}` }, '← Feeds')),
    h('div', { class: 'town-head' }, health ? dot(health.color) : null, h('h1', {}, s ? s.label : `Add a source to ${t.name}`)),
    health?.error ? h('p', { class: 'error' }, `${health.note}: ${health.error}`) : (health ? h('p', { class: 'muted' }, `${health.note}. Last success ${ago(health.lastOk)}.`) : null),
    h('div', { class: 'card' }, f),
    s && towns.length > 1 ? otherTownCard(t, s, towns) : null,
  ].filter(Boolean));
}

// The highways on a roads source (CDOT, NMRoads; any state DOT adapter with nearbyRoutes):
// the current list, each with a note and Remove, and the highways the DOT
// lists near the town to add. A hidden textarea carries the JSON the form saves.
const ROUTE_RE = [[/^(?:I|INTERSTATE)[ -]?(\d{1,3})\b/, 'I'], [/^(?:US|U\.S\.)[ -]?(\d{1,3})\b/, 'US'], [/^(?:CO|SH|STATE HIGHWAY|[A-Z]{2})[ -]?(\d{1,3})\b/, null]];
function parseRoute(text, state) {
  const s = String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();
  for (const [re, pre] of ROUTE_RE) {
    const m = s.match(re);
    if (m) return { label: `${pre || state || 'CO'}-${+m[1]}`, match: [String(+m[1])] };
  }
  return null;
}

function routeEditor(fd, initial, t, adapter) {
  let routes = initial.map((r) => ({ ...r }));
  const store = h('textarea', { name: `s.${fd.key}`, hidden: true });
  const list = h('ol', { class: 'route-list' });
  const nearBox = h('div', { class: 'route-near' });
  let near = null; // [{ label, match, km }] once loaded
  const sync = () => { store.value = routes.length ? JSON.stringify(routes) : ''; };
  const has = (label) => routes.some((r) => r.label === label);
  const render = () => {
    sync();
    list.replaceChildren(...(routes.length ? routes.map((r, i) => {
      const note = h('input', { type: 'text', value: r.note || '', placeholder: 'Note, e.g. Ridgway to Red Mountain Pass', 'aria-label': `Note for ${r.label}` });
      note.addEventListener('input', () => { if (note.value.trim()) r.note = note.value.trim(); else delete r.note; sync(); });
      const btn = (label, title, fn, disabled) => h('button', { type: 'button', class: 'secondary small', title, 'aria-label': `${title} ${r.label}`, disabled: !!disabled, onclick: fn }, label);
      return h('li', { class: 'route-row' },
        h('strong', { class: 'route-label' }, r.label),
        r.match.join() === r.label ? null : h('span', { class: 'muted small route-match', title: 'Route number as the DOT writes it' }, `#${r.match.join(', #')}`),
        note,
        btn('↑', 'Move up', () => { [routes[i - 1], routes[i]] = [routes[i], routes[i - 1]]; render(); }, i === 0),
        btn('Remove', 'Remove', () => { routes.splice(i, 1); render(); }));
    }) : [h('li', { class: 'muted' }, 'No highways yet. Add one from the list below.')]));
    renderNear();
  };
  const add = (r) => { if (!has(r.label)) routes.push({ label: r.label, match: adapter.type === 'nmroads' ? [r.label] : [...r.match] }); render(); };

  const hand = h('input', { type: 'text', placeholder: t.state === 'NM' ? 'US 491, US 64, NM 371…' : 'US 550, I-70, CO 145…', 'aria-label': 'Highway to add' });
  const handErr = h('span', { class: 'error small' });
  const addHand = () => {
    const r = parseRoute(hand.value, t.state);
    handErr.textContent = r ? '' : 'Type a highway like US 550 or CO 145.';
    if (r) { add(r); hand.value = ''; }
  };
  hand.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addHand(); } });

  function renderNear() {
    if (!adapter.nearbyRoutes) return;
    if (!near) return;
    if (!near.length) { nearBox.replaceChildren(h('p', { class: 'muted small' }, 'The roads feed lists no highways within 50 km of the map point.')); return; }
    nearBox.replaceChildren(h('ul', { class: 'route-near-list' }, ...near.map((r) => h('li', {},
      h('strong', {}, r.label), h('span', { class: 'muted small' }, r.km < 1 ? 'through town' : `${Math.round(r.km)} km away`),
      has(r.label) ? h('span', { class: 'muted small' }, 'Added')
        : h('button', { type: 'button', class: 'secondary small', onclick: () => add(r) }, 'Add')))));
  }
  async function loadNear() {
    nearBox.replaceChildren(h('p', { class: 'muted small' }, 'Asking the roads feed which highways are near the map point…'));
    try {
      near = (await api('/source/nearby-routes', { town: t.id, adapter: adapter.type })).routes;
      renderNear();
    } catch (e) {
      nearBox.replaceChildren(h('p', { class: 'muted small' }, `Couldn't list nearby highways: ${e.message}`),
        h('button', { type: 'button', class: 'secondary small', onclick: loadNear }, 'Try again'));
    }
  }
  render();
  if (adapter.nearbyRoutes) loadNear();

  return h('fieldset', { class: 'route-editor' },
    h('legend', {}, 'Highways on the Roads tile'),
    h('p', { class: 'help' }, `In the order the Roads tile shows them. Press Test below to see what ${adapter.type === 'nmroads' ? 'NMRoads' : 'CDOT'} reports on them now.`),
    list, store,
    adapter.nearbyRoutes ? h('h3', { class: 'route-sub' }, `Highways near ${t.name}`) : null,
    nearBox,
    h('div', { class: 'row route-hand' }, hand, h('button', { type: 'button', class: 'secondary small', onclick: addHand }, 'Add highway'), handErr));
}

// The Test result's Roads tile, as people will read it.
function roadsPreview(tile) {
  const color = { ok: 'green', caution: 'amber', closed: 'red' };
  return h('div', { class: 'roads-preview' },
    h('h3', {}, 'Roads tile now'),
    tile.error ? h('p', { class: 'error' }, tile.error) : null,
    h('ul', {}, ...(tile.routes || []).map((r) => h('li', {},
      h('div', { class: 'route-status' }, dot(color[r.level] || 'grey'), h('strong', {}, r.label), h('span', {}, r.status), r.note ? h('span', { class: 'muted small' }, r.note) : null),
      (r.events?.length || r.conditions?.length) ? h('ul', { class: 'muted small' },
        ...(r.events || []).map((e) => h('li', {}, e.title)),
        ...(r.conditions || []).map((c) => h('li', {}, c))) : null))));
}

// Copy a source to another town (one feed serving several towns), or move it there
// with its posts and health history.
function otherTownCard(t, s, towns) {
  const sel = h('select', {}, ...towns.filter((x) => x.id !== t.id).map((x) => h('option', { value: x.id }, x.name)));
  const err = h('p', { class: 'error', role: 'alert' });
  const go = (mode) => async (e) => {
    const to = towns.find((x) => x.id === sel.value);
    if (mode === 'move' && !confirm(`Move "${s.label}" from ${t.name} to ${to.name}? Its posts move too and leave the ${t.name} feed.`)) return;
    const btn = e.currentTarget;
    err.textContent = '';
    btn.disabled = true;
    try {
      const r = await api('/source/move', { town: t.id, key: s.key, to: to.id, mode });
      location.hash = `source/${r.town}/${r.key}`;
    } catch (e2) { err.textContent = e2.message; btn.disabled = false; }
  };
  return h('div', { class: 'card' }, h('h2', {}, 'Use in another town'),
    h('p', { class: 'muted small' }, 'Copy adds the same feed to another town too, so both show it. Move takes it out of this town, with its posts and history.'),
    h('div', { class: 'row form-actions' }, field('Town', sel),
      h('button', { type: 'button', class: 'secondary', onclick: go('copy') }, 'Copy to town'),
      h('button', { type: 'button', class: 'secondary', onclick: go('move') }, 'Move to town')),
    err);
}

// ---------- new town: fill with Claude ----------
// Copy a prompt (built from the name and state typed in the form) into Claude, paste
// its JSON answer back, and the form fills in for review. Nothing is saved until
// Create town. Suggested sources and starter resources are shown to add afterwards.
// Add a town: type the name, press Look up, and the map point, state, address name,
// site name and time zone fill in (OpenStreetMap search, via our server). Several
// matches show as choices. Fields already typed by hand are kept, except the map point.
function townLookup(form) {
  const out = h('div', { class: 'lookup-out', role: 'status' });
  const el = (n) => form.elements[n];
  const fill = (m) => {
    const keep = (n, v) => { if (v && !el(n).value.trim()) el(n).value = v; };
    el('name').value = m.name;
    keep('state', m.state);
    keep('id', m.id);
    keep('siteName', `${m.name} Buzz`);
    el('lat').value = m.lat;
    el('lon').value = m.lon;
    form.dispatchEvent(new Event('lookup-filled'));
    if (m.timezone && (!el('timezone').value.trim() || el('timezone').value === 'America/Denver')) el('timezone').value = m.timezone;
    out.replaceChildren(h('p', { class: 'ok-msg small' }, `Filled from ${m.label}. `,
      h('a', { href: m.maps, target: '_blank', rel: 'noopener' }, 'Check the point on Google Maps ↗')));
  };
  const btn = h('button', { type: 'button', class: 'secondary', onclick: async () => {
    const name = el('name').value.trim();
    if (!name) { out.replaceChildren(h('p', { class: 'error' }, 'Type the town name first.')); el('name').focus(); return; }
    btn.disabled = true; btn.textContent = 'Looking up…';
    try {
      const { matches } = await api(`/geocode?q=${encodeURIComponent(name)}&state=${encodeURIComponent(el('state').value.trim())}`);
      if (!matches.length) out.replaceChildren(h('p', { class: 'error' }, `No town called "${name}" found. Add the state, or fill the point in by hand from `,
        h('a', { href: `https://www.google.com/maps/search/${encodeURIComponent(name)}`, target: '_blank', rel: 'noopener' }, 'Google Maps ↗'), '.'));
      else if (matches.length === 1 || matches[0].place && !matches[1].place) fill(matches[0]);
      else out.replaceChildren(h('p', { class: 'small' }, 'Which one?'),
        h('div', { class: 'row' }, ...matches.map((m) => h('button', { type: 'button', class: 'small secondary', title: m.label, onclick: () => fill(m) },
          `${m.name}${m.state ? `, ${m.state}` : ''}${m.county ? ` (${m.county})` : ''}`))));
    } catch (e) { out.replaceChildren(h('p', { class: 'error' }, e.message)); }
    btn.disabled = false; btn.textContent = 'Look up on the map';
  } }, 'Look up on the map');
  const maps = h('a', { class: 'small', href: 'https://www.google.com/maps', target: '_blank', rel: 'noopener',
    onclick: (e) => { const n = el('name').value.trim(); if (n) e.currentTarget.href = `https://www.google.com/maps/search/${encodeURIComponent(n)}`; } }, 'Open Google Maps ↗');
  return { button: h('span', { class: 'lookup' }, btn, maps), out };
}

// After Create town with Claude's answer: what was saved, and what still needs a person.
function showCreated(town, fc, roads) {
  const feeds = `#feeds?town=${encodeURIComponent(town.id)}`;
  const running = fc.sources.filter((s) => s.enabled);
  const paused = fc.sources.filter((s) => !s.enabled);
  const res = fc.resources;
  const link = (u) => (/^https?:\/\//.test(u) ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u) : u);
  const list = (items, row) => h('ul', {}, ...items.map((x) => h('li', {}, ...row(x))));
  window.scrollTo(0, 0);
  view.replaceChildren(
    h('p', {}, h('a', { href: '#towns' }, '← All towns')),
    h('h1', {}, `${town.name} is created (draft)`),
    h('div', { class: 'card' },
      h('h2', {}, 'What was added'),
      h('ul', {},
        h('li', {}, 'National Weather Service alerts and forecast.'),
        roads ? h('li', {}, roads.routes ? `Roads from ${roads.dot || 'CDOT'}: ${roads.routes.join(', ')}.` : `No roads yet: ${roads.error} Use Add ${roads.dot || 'CDOT'} roads on Feeds to try again.`)
          : h('li', { class: 'muted' }, `No roads feed for ${town.state || 'this state'} yet, so the Roads tile is left off the site.`),
        h('li', {}, `${running.length} feed${running.length === 1 ? '' : 's'} running now.`),
        paused.length ? h('li', {}, `${paused.length} source${paused.length === 1 ? '' : 's'} saved paused, to check.`) : null,
        res ? h('li', {}, `${res.added} resource${res.added === 1 ? '' : 's'} added${res.errors.length ? `, ${res.errors.length} row${res.errors.length === 1 ? '' : 's'} skipped` : ''}.`) : null),
      h('p', { class: 'row' },
        h('a', { class: 'button', href: feeds }, 'Go to Feeds'), ' ',
        h('a', { class: 'button secondary', href: `#all-resources?town=${encodeURIComponent(town.id)}` }, 'Resources'), ' ',
        h('a', { class: 'button secondary', href: `#town/${encodeURIComponent(town.id)}` }, 'Settings and going live'))),
    running.length ? h('div', { class: 'card' }, h('h2', {}, 'Running now'),
      h('p', { class: 'muted small' }, 'Watch these turn green on the Feeds tab in a few minutes. A red one needs a better address.'),
      list(running, (s) => [h('strong', {}, s.label), ': ', link([].concat(s.url)[0])])) : null,
    paused.length || fc.skipped.length ? h('div', { class: 'card' }, h('h2', {}, 'Needs checking'),
      paused.length ? h('p', { class: 'muted small' }, 'Saved paused. On Feeds, open each one with Edit, find its RSS or iCal address, press Test, then resume it (or delete it).') : null,
      paused.length ? list(paused, (s) => [h('strong', {}, s.label), ': ', link([].concat(s.url)[0]), s.about ? h('div', { class: 'muted small' }, s.about) : null]) : null,
      fc.skipped.length ? h('p', { class: 'muted small' }, 'Not saved. Set these up by hand with Add a source:') : null,
      fc.skipped.length ? list(fc.skipped, (x) => [h('strong', {}, x.label), x.type ? ` (${x.type})` : '', ': ', x.url ? link(x.url) : '', h('div', { class: 'muted small' }, x.reason)]) : null) : null,
    res && res.errors.length ? h('div', { class: 'card' }, h('h2', {}, 'Resource rows skipped'),
      list(res.errors, (e) => [e.line ? `Line ${e.line}` : '', e.name ? ` (${e.name})` : '', `: ${e.error}`])) : null,
  );
}

function fillTownWithClaude(form) {
  const err = h('p', { class: 'error', role: 'alert' });
  const out = h('div');
  const paste = h('textarea', { rows: 6, spellcheck: 'false', placeholder: 'Paste Claude\'s answer here (the ```json block, or the whole reply).' });
  const copied = h('span', { class: 'ok-msg small', role: 'status' });

  function prompt() {
    const v = Object.fromEntries(new FormData(form));
    const place = [v.name, v.state].filter(Boolean).join(', ');
    return `I'm adding ${place} to thetown.buzz, a network of local real-time info sites (weather, roads, ski conditions, town news, events and a civic resources page). Each town has a page at [address-name].thetown.buzz. Research ${place} with web search and answer with ONLY one JSON code block (\`\`\`json ... \`\`\`) in exactly this shape:

{
  "name": "Town name as locals write it",
  "state": "Two-letter state",
  "id": "address name: lowercase letters, numbers and dashes, usually the town name with spaces and punctuation removed (like crestedbutte)",
  "siteName": "[Town] Buzz",
  "lat": 0.0000,
  "lon": 0.0000,
  "timezone": "IANA time zone, like America/Denver",
  "notAffiliated": "short list of the main agencies whose info the site will show, like: the City of [Town], CDOT or the National Weather Service",
  "suggestedSources": [
    { "label": "Who publishes it", "type": "rss | ical | snow-report | resort-alerts | other", "kind": "news | town | events | alerts", "hasEvents": false, "url": "https://...", "why": "what it would add (town news, county alerts, events, ski resort snow report, local paper)" }
  ],
  "resourcesCsv": "CSV text, see below"
}

Rules:
- lat and lon: the center of town (town hall or main street), as numbers with 4 decimals.
- suggestedSources: official RSS or iCal feeds for the town/city and county (news, alerts, calendar), the local newspaper or radio station feed, the nearest ski resort's snow report page, and anything else that publishes timely local information. Skip state road and highway sites: roads are added separately. Only include URLs you actually found. Say in "why" if a feed needs checking. kind is "news" (newspapers, radio), "town" (town, county, school, utility news), "events" (calendars) or "alerts" (official emergency notices only); hasEvents is true for a news feed that also lists events.
- resourcesCsv: starter entries for the Resources page as CSV text (use \\n for new lines inside the JSON string), header first:
id,town,category,name,phone,phone2,website,address,hours,note,emergency,hidden,checked,source
  Leave id blank. town is the id above. category is one of emergency, medical, government, transit, utilities, roads, outdoors, schools. Include 911, the non-emergency dispatch or police line, the nearest hospital or clinic, town hall, the county, transit, the electric/gas/water utilities, the state road conditions line, the local forest or park office, and the school district and library. emergency is "yes" only for emergency lines and the ER. checked is today's date (${new Date().toISOString().slice(0, 10)}) for rows you verified on an official site. source is the URL you used.
- Use official sources only. Never guess: leave a value blank (or empty string) if you can't confirm it.`;
  }

  function fill() {
    err.textContent = '';
    const text = paste.value.trim();
    if (!text) { err.textContent = 'Paste Claude\'s answer first.'; return; }
    const block = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
    let j;
    try { j = JSON.parse(block ? block[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { err.textContent = 'That doesn\'t look like the JSON answer. Paste the whole ```json block.'; return; }
    // Greyed-out (autofill) fields are filled too; a field fixed for good (an existing town's address name) isn't.
    const set = (name, val) => { const el = form.elements[name]; if (el && val != null && val !== '' && (!el.readOnly || 'autofill' in el.dataset)) el.value = String(val); };
    set('name', j.name); set('state', j.state); set('id', String(j.id || '').toLowerCase()); set('siteName', j.siteName);
    set('lat', j.lat ?? j.location?.lat); set('lon', j.lon ?? j.location?.lon); set('timezone', j.timezone); set('notAffiliated', j.notAffiliated);
    form.dispatchEvent(new Event('lookup-filled'));
    const srcs = Array.isArray(j.suggestedSources) ? j.suggestedSources.filter((x) => x && x.url) : [];
    const csv = typeof j.resourcesCsv === 'string' ? j.resourcesCsv.trim() : '';
    const csvCopied = h('span', { class: 'ok-msg small', role: 'status' });
    // Create town saves these too (see the town form's submit).
    form._claude = { suggestedSources: srcs, resourcesCsv: csv };
    out.replaceChildren(...[
      h('p', { class: 'ok-msg' }, `Filled in the form above. Check each field (especially the map point), then press Create town. It also saves ${[srcs.length ? `the ${srcs.length} suggested sources` : '', csv ? 'the starter resources' : ''].filter(Boolean).join(' and ') || 'the town'}.`),
      srcs.length ? h('details', { open: true }, h('summary', {}, `Suggested sources (${srcs.length}): saved with the town. Feeds run right away; anything that needs checking is saved paused`),
        h('ul', {}, ...srcs.map((x) => h('li', {}, h('strong', {}, x.label || 'Source'), x.type ? ` (${x.type})` : '', ': ',
          /^https?:\/\//.test(x.url) ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.url) : x.url, x.why ? h('div', { class: 'muted small' }, x.why) : null)))) : null,
      csv ? h('details', {}, h('summary', {}, `Starter resources (${csv.split('\n').length - 1} rows): saved with the town. Rows with a problem are skipped and listed`),
        h('textarea', { rows: 8, readonly: true }, csv),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: async () => {
          try { await navigator.clipboard.writeText(csv); csvCopied.textContent = 'Copied.'; } catch { csvCopied.textContent = 'Select the text and copy it.'; }
        } }, 'Copy resources CSV'), csvCopied)) : null,
    ].filter(Boolean));
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // The prompt shows here and follows the Town name and State boxes as they're typed.
  const promptBox = h('textarea', { rows: 8, readonly: true, class: 'mono' });
  const hint = h('p', { class: 'muted small' });
  const sync = () => {
    const has = !!form.elements.name.value.trim();
    promptBox.hidden = !has;
    hint.textContent = has ? '' : 'Type the town name above and the prompt for Claude appears here.';
    if (has) promptBox.value = prompt();
  };
  for (const n of ['name', 'state']) form.elements[n].addEventListener('input', sync);
  form.addEventListener('lookup-filled', sync);
  sync();
  return h('div', { class: 'card' },
    h('h2', {}, 'Fill the rest with Claude'),
    h('p', { class: 'muted small' }, 'For the sources, the starter resources and anything the map lookup missed. 1. Copy the prompt into Claude (claude.ai, with web search on). 2. Paste its answer below and press Fill form. Nothing is saved until you press Create town.'),
    hint, promptBox,
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: async () => {
        err.textContent = '';
        if (!form.elements.name.value.trim()) { err.textContent = 'Type the town name above first.'; form.elements.name.focus(); return; }
        sync();
        try { await navigator.clipboard.writeText(promptBox.value); copied.textContent = 'Prompt copied. Paste it into Claude.'; }
        catch { promptBox.select(); copied.textContent = 'Select the prompt and copy it.'; }
      } }, 'Copy prompt for Claude'), copied),
    paste,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: fill }, 'Fill form')),
    err, out);
}

// ---------- resources ----------
const siteOf = (t) => (t.url || `https://${t.hostnames?.[0] || `${t.id}.thetown.buzz`}`).replace(/\/$/, '');
// Each town's /resources page: phone numbers, offices and links, kept by hand.
const DAY = 86400e3;
const sponsorLabel = (state) => ({ active: 'sponsored', scheduled: 'sponsor starts later', ended: 'sponsor ended' }[state] || '');
const sponsorPill = (r) => (r.sponsorState ? h('span', { class: `pill ${r.sponsorState === 'active' ? 'sponsor' : 'draft'}` }, sponsorLabel(r.sponsorState)) : null);
async function resourcesPage(townId) {
  const d = await api(`/resources?town=${encodeURIComponent(townId)}`);
  const t = d.town;
  const stale = (r) => !r.checkedAt || Date.now() - r.checkedAt > d.staleDays * DAY;
  const byCat = (c) => d.resources.filter((r) => r.category === c);
  const err = h('p', { class: 'error', role: 'alert' });

  async function move(r, dir) {
    const list = byCat(r.category);
    const i = list.indexOf(r);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    // Keep every other category's order; only this category's ids swap places.
    const ids = d.categories.flatMap((c) => (c.id === r.category ? list : byCat(c.id)).map((x) => x.id));
    try { await api('/resource/order', { town: t.id, ids }); route(); } catch (e) { err.textContent = e.message; }
  }

  const row = (r, i, list) => h('tr', { class: r.hidden ? 'muted' : null },
    h('td', {}, h('a', { href: `#resource/${t.id}/${r.id}` }, r.name),
      r.emergency && r.category !== 'emergency' ? h('span', { class: 'pill live' }, 'emergency box') : null,
      r.hidden ? h('span', { class: 'pill draft' }, 'hidden') : null,
      sponsorPill(r),
      h('div', { class: 'muted small' }, [r.phone, r.website && r.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')].filter(Boolean).join(' · '))),
    h('td', { class: 'small hide-sm' }, stale(r) ? h('span', { class: 'err' }, r.checkedAt ? `Checked ${ago(r.checkedAt)}` : 'Never checked') : `Checked ${ago(r.checkedAt)}`),
    h('td', { class: 'actions' },
      h('button', { class: 'small secondary', title: 'Move up', 'aria-label': `Move ${r.name} up`, disabled: i === 0, onclick: () => move(r, -1) }, '↑'),
      h('button', { class: 'small secondary', title: 'Move down', 'aria-label': `Move ${r.name} down`, disabled: i === list.length - 1, onclick: () => move(r, 1) }, '↓'),
      h('button', { class: 'small secondary', onclick: async () => { try { await api('/resource/checked', { town: t.id, ids: [r.id] }); route(); } catch (e) { err.textContent = e.message; } } }, 'Still right')));

  const staleCount = d.resources.filter(stale).length;
  view.replaceChildren(
    h('p', {}, h('a', { href: `#town/${t.id}` }, `← ${t.name}`)),
    h('div', { class: 'row spread' }, h('h1', {}, `${t.name} resources`),
      h('a', { class: 'button secondary', href: `${siteOf(t)}/resources`, target: '_blank', rel: 'noopener' }, 'View page')),
    h('p', { class: 'muted' }, `${d.resources.length} entries. `,
      staleCount ? `${staleCount} not checked in the last ${d.staleDays} days. ` : 'All checked recently. ',
      'Entries in Emergency, or marked for the emergency box, show at the top of the page.'),
    err,
    ...d.categories.map((c) => {
      const list = byCat(c.id);
      return h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('h2', {}, c.label), h('a', { class: 'button small', href: `#new-resource/${t.id}/${c.id}` }, 'Add')),
        list.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, ...list.map(row)))) : h('p', { class: 'muted' }, 'Nothing here yet.'));
    }),
  );
}

async function resourcePage(townId, id, category = '') {
  const d = await api(`/resources?town=${encodeURIComponent(townId)}`);
  const t = d.town;
  const r = id ? d.resources.find((x) => String(x.id) === String(id)) : null;
  if (id && !r) throw new Error('That resource no longer exists.');
  const v = r || { category: category || 'emergency' };
  const err = h('p', { class: 'error', role: 'alert' });
  const input = (name, attrs = {}) => h('input', { name, value: v[name] || '', ...attrs });
  // Sponsorship: business categories only. Shows first in its category with a
  // "Sponsored" label between the two dates, then goes back to a normal listing.
  const isBiz = (cat) => d.categories.find((c) => c.id === cat)?.group === 'business';
  const plusDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const sponsorOn = h('input', { type: 'checkbox', name: 'sponsored', checked: !!v.sponsored });
  const sponsorFields = h('div', { class: 'grid2', hidden: !v.sponsored },
    field('Starts', input('sponsorFrom', { type: 'date', value: v.sponsorFrom || d.today })),
    field('Ends', input('sponsorUntil', { type: 'date', value: v.sponsorUntil || plusDays(d.today, 29) }), 'Last day shown as sponsored. After that it goes back to a normal listing.'),
    field('Tagline', input('sponsorTagline', { maxlength: 80, placeholder: 'Happy hour 3 to 5 daily' }), 'Optional. One short line under the name.'),
    field('Logo', input('sponsorLogo', { maxlength: 300, placeholder: 'https://example.com/logo.png' }), 'Optional. An https:// image address. Shown small.'));
  sponsorOn.addEventListener('change', () => { sponsorFields.hidden = !sponsorOn.checked; });
  const sponsorBox = h('fieldset', { class: 'sponsor-box' },
    h('legend', {}, 'Sponsored listing', v.sponsorState ? sponsorPill(v) : null),
    h('label', { class: 'check' }, sponsorOn, ' Sponsored: show first in its category with a "Sponsored" label'),
    sponsorFields);
  const f = h('form', {},
    h('div', { class: 'grid2' },
      field('Name', input('name', { required: true, maxlength: 120, placeholder: 'Telluride Regional Medical Center' })),
      field('Category', h('select', { name: 'category' }, ...d.categories.map((c) => h('option', { value: c.id, selected: v.category === c.id }, c.label)))),
      field('Phone', input('phone', { type: 'tel', maxlength: 40, placeholder: '970-728-3848' }), 'Tap-to-call on phones.'),
      field('Second phone', input('phone2', { type: 'tel', maxlength: 40, placeholder: 'After-hours line' }), 'Optional. Explain it in the note.'),
      field('Website', input('website', { maxlength: 300, placeholder: 'https://www.tellmed.org' })),
      field('Address', input('address', { maxlength: 200, placeholder: '500 W Pacific Ave, Telluride, CO 81435' }), 'Shows a Map button.'),
      field('Hours', input('hours', { maxlength: 200, placeholder: 'Daily 8 a.m. to 6 p.m.' })),
      field('Tags', input('tags', { maxlength: 80, placeholder: 'Mexican · $$' }), 'Short descriptor on the card. Mostly for businesses: cuisine, price, what they sell.'),
    ),
    field('Note', h('textarea', { name: 'note', rows: 2, maxlength: 400, placeholder: 'For the ER, call the main line and press 0.' }, v.note || '')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'emergency', checked: !!v.emergency }), ' Also show in the Emergency box at the top'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'hidden', checked: !!v.hidden }), ' Hide from the public page'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'checked', checked: !r }), ' I checked this is right today'),
    sponsorBox,
    h('div', { class: 'row form-actions' },
      h('button', { type: 'submit' }, r ? 'Save' : 'Add resource'),
      r ? h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete') : null),
    err,
  );
  const catSelect = f.querySelector('select[name=category]');
  const syncSponsor = () => { sponsorBox.hidden = !isBiz(catSelect.value); };
  catSelect.addEventListener('change', syncSponsor);
  syncSponsor();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(f);
    const resource = { id: r?.id, sort: r?.sort, emergency: fd.get('emergency') === 'on', hidden: fd.get('hidden') === 'on' };
    for (const k of ['name', 'category', 'phone', 'phone2', 'website', 'address', 'hours', 'note', 'tags', 'sponsorFrom', 'sponsorUntil', 'sponsorTagline', 'sponsorLogo']) resource[k] = fd.get(k);
    resource.sponsored = fd.get('sponsored') === 'on' && isBiz(resource.category);
    try {
      await api('/resource', { town: t.id, resource, checked: fd.get('checked') === 'on' });
      location.hash = `resources/${t.id}`;
    } catch (e2) { err.textContent = e2.message; }
  });
  async function remove() {
    if (!confirm(`Delete "${r.name}" from ${t.name}'s resources?`)) return;
    try { await api('/resource/delete', { town: t.id, id: r.id }); location.hash = `resources/${t.id}`; } catch (e2) { err.textContent = e2.message; }
  }
  view.replaceChildren(
    h('p', {}, h('a', { href: `#resources/${t.id}` }, `← ${t.name} resources`)),
    h('h1', {}, r ? r.name : `Add a resource to ${t.name}`),
    r ? h('p', { class: 'muted' }, r.checkedAt ? `Last checked ${ago(r.checkedAt)}.` : 'Never checked.') : null,
    h('div', { class: 'card' }, f),
  );
}

// ---------- all resources (every town) ----------
// One list across towns with filters and search, plus CSV export and import.
const RES_FILTER_KEYS = ['town', 'cat', 'status', 'q'];
const RES_STATUS = [['', 'Any status'], ['stale', 'Needs checking'], ['never', 'Never checked'], ['hidden', 'Hidden'], ['emergency', 'In the emergency box'], ['sponsored', 'Sponsored (any)'], ['sponsor-active', 'Sponsored now'], ['sponsor-ended', 'Sponsorship ended']];
let resFilters = { town: '', cat: '', status: '', q: '' };
function readResFilters(query) {
  const p = new URLSearchParams(query);
  const fromUrl = RES_FILTER_KEYS.some((k) => p.has(k));
  const saved = store.get('buzz-admin-res-filters') || {};
  for (const k of RES_FILTER_KEYS) resFilters[k] = String((fromUrl ? p.get(k) : saved[k]) || '');
}
function saveResFilters() {
  store.set('buzz-admin-res-filters', resFilters);
  const p = new URLSearchParams();
  for (const k of RES_FILTER_KEYS) if (resFilters[k]) p.set(k, resFilters[k]);
  const qs = p.toString();
  history.replaceState(null, '', `#all-resources${qs ? `?${qs}` : ''}`);
}

async function allResourcesPage() {
  const d = await api('/all-resources');
  const townName = new Map(d.towns.map((t) => [t.id, `${t.name}${t.state ? `, ${t.state}` : ''}`]));
  const catName = new Map(d.categories.map((c) => [c.id, c.label]));
  const stale = (r) => !r.checkedAt || Date.now() - r.checkedAt > d.staleDays * DAY;
  // One town at a time: the last one used, else the town with the most entries.
  const count = (id) => d.resources.filter((r) => r.townId === id).length;
  if (!townName.has(resFilters.town)) resFilters.town = [...d.towns].sort((a, b) => count(b.id) - count(a.id))[0]?.id || '';
  const f = resFilters;
  saveResFilters();
  const err = h('p', { class: 'error', role: 'alert' });
  const results = h('div');

  const sel = (key, label, options) => h('label', { class: 'filter' }, label,
    h('select', { name: key, onchange: (e) => { f[key] = e.target.value; saveResFilters(); render(); } },
      ...options.map(([v, text]) => h('option', { value: v, selected: f[key] === v }, text))));
  const q = h('input', { type: 'search', value: f.q, placeholder: 'Name, phone, address, note', autocomplete: 'off' });
  q.addEventListener('input', () => { f.q = q.value.trim(); saveResFilters(); render(); });
  const bar = h('div', { class: 'filters card', role: 'search' },
    sel('cat', 'Category', [['', 'All categories'], ...d.categories.map((c) => [c.id, c.label])]),
    sel('status', 'Status', RES_STATUS),
    h('label', { class: 'filter grow' }, 'Search', q),
    h('button', { type: 'button', class: 'small secondary', onclick: () => {
      Object.assign(f, { cat: '', status: '', q: '' });
      bar.querySelectorAll('select').forEach((x) => { x.value = ''; });
      q.value = ''; saveResFilters(); render();
    } }, 'Clear'));


  function matches(r) {
    if (f.town && r.townId !== f.town) return false;
    if (f.cat && r.category !== f.cat) return false;
    if (f.status === 'stale' && !stale(r)) return false;
    if (f.status === 'never' && r.checkedAt) return false;
    if (f.status === 'hidden' && !r.hidden) return false;
    if (f.status === 'emergency' && !(r.emergency || r.category === 'emergency')) return false;
    if (f.status === 'sponsored' && !r.sponsored) return false;
    if (f.status === 'sponsor-active' && r.sponsorState !== 'active') return false;
    if (f.status === 'sponsor-ended' && r.sponsorState !== 'ended') return false;
    if (f.q) {
      const hay = [r.name, r.phone, r.phone2, r.phone.replace(/\D/g, ''), r.website, r.address, r.hours, r.note, r.tags, townName.get(r.townId), catName.get(r.category)].join(' ').toLowerCase();
      if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function render() {
    const rows = d.resources.filter(matches);
    const staleN = rows.filter(stale).length;
    results.replaceChildren(
      h('p', { class: 'summary' }, `${rows.length} of ${count(f.town)} resources`, staleN ? h('span', { class: 'err' }, ` · ${staleN} need checking`) : null,
        rows.length && staleN ? h('button', { class: 'small secondary', onclick: async () => {
          const ids = rows.filter(stale).map((r) => r.id);
          const byTown = new Map();
          for (const r of rows.filter(stale)) byTown.set(r.townId, [...(byTown.get(r.townId) || []), r.id]);
          if (!confirm(`Mark ${ids.length} shown resource${ids.length === 1 ? '' : 's'} as checked today?`)) return;
          try { for (const [town, list] of byTown) await api('/resource/checked', { town, ids: list }); route(); } catch (e) { err.textContent = e.message; }
        } }, 'Mark shown as checked') : null),
      rows.length ? h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Resource'), f.town ? null : h('th', {}, 'Town'), h('th', { class: 'hide-sm' }, 'Category'), h('th', { class: 'hide-sm' }, 'Contact'), h('th', {}, 'Checked'))),
        h('tbody', {}, ...rows.map((r) => h('tr', { class: r.hidden ? 'muted' : null },
          h('td', {}, h('a', { href: `#resource/${r.townId}/${r.id}` }, r.name),
            r.emergency && r.category !== 'emergency' ? h('span', { class: 'pill live' }, 'emergency box') : null,
            r.hidden ? h('span', { class: 'pill draft' }, 'hidden') : null,
            sponsorPill(r),
            r.sponsored ? h('div', { class: 'muted small' }, `Sponsored ${r.sponsorFrom} to ${r.sponsorUntil}`) : null,
            r.hours ? h('div', { class: 'muted small' }, `🕒 ${r.hours}`) : null),
          f.town ? null : h('td', { class: 'small' }, townName.get(r.townId) || r.townId),
          h('td', { class: 'small hide-sm' }, catName.get(r.category) || r.category),
          h('td', { class: 'small hide-sm' }, [r.phone, r.website && r.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')].filter(Boolean).join(' · ')),
          h('td', { class: 'small' }, stale(r) ? h('span', { class: 'err' }, r.checkedAt ? ago(r.checkedAt) : 'Never') : ago(r.checkedAt))))))) :
        h('div', { class: 'card' }, h('p', { class: 'muted' }, count(f.town) ? 'No resources match the filters.' : 'No resources yet. Add one, or use Update with Claude below the filters.')),
    );
  }

  // "Update with Claude": a ready-to-copy research prompt for the town and category
  // picked in the filters, with the current entries as CSV. Paste the answer into the
  // import box below, preview, then import. No API call: copy and paste only.
  function claudeCard() {
    const box = h('div', { hidden: true });
    // For the town picked at the top; its own category picker starts from the filter.
    const catSel = h('select', { name: 'claude-cat' }, h('option', { value: '' }, 'All categories'), ...d.categories.map((c) => h('option', { value: c.id, selected: c.id === f.cat }, c.label)));
    const refresh = () => { if (!box.hidden) { box.hidden = true; btn.click(); } };
    catSel.addEventListener('change', refresh);
    const btn = h('button', { type: 'button', onclick: () => {
      if (!box.hidden) { box.hidden = true; btn.textContent = 'Update with Claude'; return; }
      err.textContent = '';
      const prompt = claudePrompt(f.town, catSel.value);
      const ta = h('textarea', { rows: 14, readonly: true, class: 'mono' }, prompt);
      const copied = h('span', { class: 'ok-msg small', role: 'status' });
      box.replaceChildren(
        h('p', { class: 'muted small' }, '1. Copy this prompt into Claude (claude.ai, with web search on). 2. Paste Claude\'s CSV answer into "Import from a spreadsheet" below. 3. Preview, check the changes, then Import.'),
        ta,
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(prompt); } catch { ta.select(); document.execCommand('copy'); }
          copied.textContent = 'Copied.';
          setTimeout(() => { copied.textContent = ''; }, 2500);
        } }, 'Copy prompt'), copied,
        h('button', { type: 'button', class: 'secondary', onclick: () => { paste.focus(); paste.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Go to paste box')));
      box.hidden = false;
      btn.textContent = 'Hide prompt';
    } }, 'Update with Claude');
    return h('div', { class: 'card' },
      h('h2', {}, 'Update with Claude'),
      h('p', { class: 'muted small' }, `Pick a category, or all of ${townName.get(f.town)}. You get a research prompt with the current entries included. Claude checks them against official sources, fixes and adds entries, and answers in the import format.`),
      h('div', { class: 'row claude-pick' }, h('label', { class: 'filter' }, 'Category', catSel), btn),
      box);
  }

  const isBizCat = (id) => d.categories.find((c) => c.id === id)?.group === 'business';
  function claudePrompt(townId, cat) {
    const t = d.towns.find((x) => x.id === townId);
    const rows = d.resources.filter((r) => r.townId === townId && (!cat || r.category === cat));
    const cell = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
    const cols = ['id', 'town', 'category', 'name', 'phone', 'phone2', 'website', 'address', 'hours', 'note', 'tags', 'emergency', 'hidden', 'checked', 'source'];
    const csv = [cols.join(','), ...rows.map((r) => [r.id, r.townId, r.category, r.name, r.phone, r.phone2, r.website, r.address, r.hours, r.note, r.tags,
      r.emergency ? 'yes' : '', r.hidden ? 'yes' : '', day(r.checkedAt), ''].map(cell).join(','))].join('\n');
    const place = `${t.name}${t.state ? `, ${t.state}` : ''}`;
    const scope = cat ? `the "${catName.get(cat)}" category` : 'all categories';
    const today = new Date().toISOString().slice(0, 10);
    const biz = cat ? isBizCat(cat) : false;
    const civicCats = d.categories.filter((c) => c.group !== 'business').map((c) => c.id).join(', ');
    const bizCats = d.categories.filter((c) => c.group === 'business').map((c) => c.id).join(', ');
    const about = cat
      ? (biz
        ? `This category lists local businesses. Include established, currently open, locally relevant places in or right next to ${place}: the ones residents and visitors actually use. Keep it to the most useful 10 to 25. Skip chains unless they are the only option, and skip anything permanently closed.`
        : 'This category is essential civic information. Only include public agencies, utilities and essential services, not shops or restaurants.')
      : `Civic categories (${civicCats}) are essential public information: agencies, utilities and essential services only. Business categories (${bizCats}) list established, currently open local businesses residents and visitors actually use: the most useful 10 to 25 per category, no chains unless they are the only option, nothing permanently closed.`;
    return `You are helping maintain the local guide of ${t.url.replace(/^https?:\/\//, '')}, a local information site for ${place}. Its Essentials tab lists emergency numbers, medical care, town and county offices, transit and parking, utilities, roads and travel, trails and outdoors, schools and the library. Its Food & drink, Shops (shops and local services) and Lodging tabs list local businesses.
${about}

Task: review and improve the entries for ${scope} in ${place}.
1. Check every current entry below against official, primary sources (the agency's, organization's or business's own website, a government site, or its Google Maps listing for hours and address). Fix wrong or outdated phone numbers, websites, addresses and hours.
2. Add important missing resources for ${scope}.
3. Use web search. Do not guess or fill in from memory. If you cannot confirm a value from an official source, leave that cell blank and say so in the source column.

Answer with ONLY one CSV code block (\`\`\`csv ... \`\`\`) in exactly this format, with the header row first:
${cols.join(',')}

Rules for the CSV:
- id: keep the id for existing entries. Leave it blank for new ones. Never invent an id.
- town: always "${townId}".
- category: one of ${d.categories.map((c) => c.id).join(', ')}.
- name: the official name, plainly written.
- phone, phone2: like 970-728-3848. Use phone2 only for a second line (after hours, outage line) and explain it in note.
- website: full https:// address of the official page.
- address: street, town, state and ZIP.
- hours: short and readable, like "Mon to Fri 8 a.m. to 5 p.m." or "24/7". Blank if unknown.
- note: one short sentence a resident would find useful. No marketing language.
- tags: a short descriptor, mostly for businesses: cuisine and price for food ("Mexican · $$"), what a shop sells ("Ski & bike rentals"), the kind of lodging ("Hotel · $$$"). Blank for civic entries.
- emergency: "yes" only for things someone needs in an emergency (911, dispatch, ER, poison control). Otherwise blank.
- hidden: keep the current value. Leave blank for new entries.
- checked: ${today} for entries you verified against an official source today. Otherwise keep the current value.
- source: the URL(s) you used for that row, or why a value is blank. This column is for review only and is ignored on import.
- Include every current entry, changed or not, so nothing is lost. To suggest removing one, keep it and write "suggest removing: <reason>" in source.
- Quote any cell that contains a comma.

Current entries (${rows.length}):
\`\`\`csv
${csv}
\`\`\``;
  }

  // CSV import: pick a file, preview what would change, then import.
  const importBox = h('div');
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const paste = h('textarea', { rows: 6, placeholder: 'Or paste CSV here (for example, Claude\'s answer). A ```csv code block is fine.', spellcheck: 'false', class: 'mono' });
  let pending = '';
  async function runImport(apply) {
    err.textContent = '';
    if (!apply) {
      const pasted = paste.value.trim();
      const fl = file.files[0];
      if (!pasted && !fl) { err.textContent = 'Choose a CSV file or paste CSV first.'; return; }
      if (!pasted && fl.size > 400 * 1024) { err.textContent = 'That file is too big (400 KB at most).'; return; }
      // Claude often wraps CSV in a ```csv block with a sentence around it: keep just the block.
      const block = pasted.match(/```(?:csv)?\s*\n([\s\S]*?)```/i);
      pending = pasted ? (block ? block[1] : pasted) : await fl.text();
    }
    try {
      const r = await api('/resources/import', { csv: pending, town: f.town, only: true, apply });
      const problems = (list) => h('ul', {}, ...list.map((e) => h('li', { class: 'err' }, `Row ${e.line}${e.name ? ` (${e.name})` : ''}: ${e.error}`)));
      if (apply) {
        file.value = ''; paste.value = '';
        importBox.replaceChildren(...[
          h('p', { class: 'ok-msg' }, `Imported: ${r.adds} added, ${r.updates} updated.`, r.errors.length ? ` Skipped ${r.errors.length} row${r.errors.length === 1 ? '' : 's'} with problems (below): fix them in the CSV and import just those, or add them by hand.` : ''),
          r.errors.length ? problems(r.errors) : null].filter(Boolean));
        const fresh = await api('/all-resources'); d.resources = fresh.resources; render(); return;
      }
      const n = r.adds + r.updates;
      // The Import button sits right on the summary line, so it's the first thing you see.
      const go = n ? h('button', { onclick: () => runImport(true) },
        `Import ${n} row${n === 1 ? '' : 's'}${r.errors.length ? `, skip ${r.errors.length}` : ''}`) : null;
      importBox.replaceChildren(...[
        h('div', { class: 'row import-summary' },
          h('p', {}, h('strong', {}, `${r.rows} row${r.rows === 1 ? '' : 's'}: ${r.adds} to add, ${r.updates} to update`), r.errors.length ? h('span', { class: 'err' }, `, ${r.errors.length} with problems (skipped)`) : null, '.'),
          go),
        r.errors.length ? problems(r.errors) : null,
        r.preview.length ? h('details', {}, h('summary', {}, 'Show rows'), h('ul', { class: 'small' }, ...r.preview.map((x) => h('li', {}, `Row ${x.line}: ${x.action} "${x.name}" in ${townName.get(x.town) || x.town}, ${catName.get(x.category) || x.category}`)))) : null].filter(Boolean));
    } catch (e) { err.textContent = e.message; }
  }

  view.replaceChildren(
    h('div', { class: 'row spread' }, h('h2', {}, 'Resources'),
      h('span', {},
        h('a', { class: 'button', href: `#new-resource/${f.town}/${f.cat || 'emergency'}` }, 'Add resource'), ' ',
        h('a', { class: 'button secondary', href: `/api/admin/resources/export?town=${encodeURIComponent(f.town)}` }, 'Export CSV'))),
    h('p', { class: 'muted' }, `What shows on ${townName.get(f.town)}'s Essentials, Food & drink, Shops and Lodging tabs. Entries not checked in ${d.staleDays} days show in red. `,
      h('a', { href: '/api/admin/resources/export', class: 'small' }, 'Export every town as one CSV')),
    bar, err, claudeCard(), results,
    h('div', { class: 'card' }, h('h2', {}, 'Import from a spreadsheet'),
      h('p', { class: 'muted small' }, `Export a CSV, edit it in Excel, Numbers or Google Sheets, then import it here. Rows with an id update that resource; rows without one are added. Rows go to ${townName.get(f.town)} (rows for another town are skipped).`, ' Category can be the id (medical) or the name (Medical). Nothing changes until you press Import; rows with problems are skipped.'),
      h('div', { class: 'row' }, file, h('button', { type: 'button', class: 'secondary', onclick: () => runImport(false) }, 'Preview')),
      paste,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: () => runImport(false) }, 'Preview pasted CSV')),
      importBox),
  );
  render();
}

route();
