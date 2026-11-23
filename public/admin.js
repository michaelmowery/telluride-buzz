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
  const menu = h('div', { class: 'town-menu', id: 'town-menu', role: 'menu', hidden: true },
    h('p', { class: 'town-menu-title' }, 'Choose a town'),
    ...[...towns].sort((a, b) => a.name.localeCompare(b.name)).map((t) => h('a', {
      href: '#', class: 'town-opt', role: 'menuitem', 'aria-current': t.id === current ? 'page' : null,
      onclick: (e) => { e.preventDefault(); setMenu(false); if (t.id !== current) onPick(t.id); },
    }, h('span', { class: 'town-txt' }, h('strong', {}, townLabel(t)),
      h('small', {}, t.id === current ? 'Editing now' : (t.hostnames || [])[0] || '')),
    h('span', { class: `pill ${t.status}` }, t.status))),
    h('a', { href: '#towns', class: 'town-all', onclick: () => setMenu(false) }, 'All towns · Add a town'));
  const picker = h('button', { type: 'button', class: 'town-picker', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'town-menu',
    onclick: () => setMenu(menu.hidden) },
  h('span', {}, townLabel(towns.find((t) => t.id === current) || { name: 'Pick a town' })),
  h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  function setMenu(open) {
    menu.hidden = !open;
    picker.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('.town-opt:not([aria-current])')?.focus();
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
  document.querySelectorAll('[data-nav]').forEach((n) => n.toggleAttribute('aria-current', n.dataset.nav === 'towns' && /^(towns|new-town)$/.test(page)));
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
    ...visible.map((t) => h('div', { class: 'card' },
      t.shown.length ? sourceTable(t, t.shown) : h('p', { class: 'muted' }, t.sources.length ? 'No sources match the filters.' : 'No sources yet. Add a source above.'))),
    visible.length ? null : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No sources match the filters.')),
  ].filter(Boolean));
}

function sourceTable(town, rows, compact = false) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Source'), h('th', { class: 'hide-sm' }, 'Type'), h('th', {}, 'Last success'), h('th', { class: 'hide-sm' }, 'Posts'), h('th', {}, 'Status'), h('th', {}, ''))),
    h('tbody', {}, ...rows.map((s) => h('tr', {},
      h('td', {}, dot(s.color)),
      h('td', {}, h('a', { href: `#source/${town.id}/${s.key}` }, s.label), h('div', { class: 'muted small' }, s.key)),
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
async function townsPage() {
  const [{ towns }, { towns: health }] = await Promise.all([api('/towns'), api('/health')]);
  const color = Object.fromEntries(health.map((t) => [t.id, t.color]));
  view.replaceChildren(
    h('div', { class: 'row spread' }, h('h1', {}, 'Towns'), h('a', { class: 'button', href: '#new-town' }, 'Add a town')),
    h('div', { class: 'card' }, h('ul', { class: 'towns-list' }, ...towns.map((t) => h('li', {},
      dot(color[t.id] || 'amber'),
      h('span', { class: 'grow' }, h('a', { href: `#town/${t.id}` }, h('strong', {}, `${t.name}${t.state ? `, ${t.state}` : ''}`)),
        h('div', { class: 'muted small' }, `${t.sources.length} sources · ${(t.hostnames || [])[0] || ''}`)),
      h('span', { class: `pill ${t.status}` }, t.status))))),
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
      field('Town name', h('input', { name: 'name', required: true, value: t?.name || '', placeholder: 'Ouray' })),
      field('State', h('input', { name: 'state', value: t?.state || '', placeholder: 'CO', maxlength: 2 })),
      field('Address name', h('input', { name: 'id', required: true, value: t?.id || '', placeholder: 'ouray', pattern: '[a-z][a-z0-9\\-]{1,39}', readonly: !!t }),
        t ? 'Fixed once the town exists.' : 'Becomes ouray.thetown.buzz. Lowercase letters, numbers, dashes.'),
      field('Site name', h('input', { name: 'siteName', value: b.siteName || '', placeholder: 'Ouray Buzz' }), 'Used in sentences and the browser tab.'),
      field('Latitude', h('input', { name: 'lat', required: true, inputmode: 'decimal', value: t?.location?.lat ?? '', placeholder: '38.0228' }), 'Right-click the town on Google Maps to copy its point.'),
      field('Longitude', h('input', { name: 'lon', required: true, inputmode: 'decimal', value: t?.location?.lon ?? '', placeholder: '-107.6714' })),
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
    field('Web addresses', h('textarea', { name: 'hostnames', rows: 2, placeholder: 'ouray.thetown.buzz' }, (t?.hostnames || []).join('\n')),
      'One per line. Leave blank for [address name].thetown.buzz. Each needs DNS pointing at the server.'),
    h('div', { class: 'grid2' },
      field('Feedback email', h('input', { name: 'feedbackEmail', type: 'email', value: b.feedbackEmail || '', placeholder: 'telluridebuzz@gmail.com' })),
      field('Status', h('select', { name: 'status' },
        h('option', { value: 'draft', selected: t?.status !== 'live' }, 'Draft: works at its address, hidden from the town picker and thetown.buzz'),
        h('option', { value: 'live', selected: t?.status === 'live' }, 'Live: listed everywhere'))),
    ),
    field('"Not affiliated with" line', h('input', { name: 'notAffiliated', value: b.notAffiliated || '', placeholder: 'the City of Ouray, CDOT or the National Weather Service' }), 'About page. Leave blank for a general line.'),
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
      brand: { siteName: v.siteName, logo: v.logo, feedbackEmail: v.feedbackEmail, notAffiliated: v.notAffiliated },
    };
    if (t && t.hostnames?.join('\n') !== v.hostnames.trim()) town.url = '';
    try {
      const r = await api('/town', { create: !t, town });
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
    item(has('cdot'), 'Roads: CDOT with the town\'s highways (Colorado towns).'),
    item(has('snow-report'), 'Lifts & Snow: one snow report per nearby resort (skip if none).'),
    item(has('rss') || has('ical'), 'Town and news: town/county RSS, local paper, an events calendar.'),
    item(green > 0 && health.color !== 'red', `Health: ${green} of ${health?.sources.length || 0} sources green.`),
    item(false, 'Address: ', h('code', {}, host), ' must point at the server. With the wildcard *.thetown.buzz set up, nothing to do; otherwise add a DNS A record and a Caddy entry.'),
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
      if (fd.type === 'select') input = h('select', { name: `s.${fd.key}` }, h('option', { value: '' }, ''), ...fd.options.map((o) => h('option', { value: o, selected: val === o }, o)));
      else if (fd.type === 'checkbox') return h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `s.${fd.key}`, checked: !!val }), fd.label, fd.help ? h('span', { class: 'help inline-help' }, fd.help) : null);
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
      field('Name shown on posts', h('input', { name: 'label', required: true, value: s?.label || '', placeholder: 'City of Ouray' })),
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
        ...tiles.map(([k, v]) => h('details', {}, h('summary', {}, `${k} tile`), h('pre', {}, JSON.stringify(v, null, 2)))),
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
  "id": "address name: lowercase letters, numbers and dashes, usually the town name (ouray, crested-butte)",
  "siteName": "[Town] Buzz",
  "lat": 38.0228,
  "lon": -107.6714,
  "timezone": "IANA time zone, like America/Denver",
  "notAffiliated": "short list of the main agencies whose info the site will show, like: the City of Ouray, CDOT or the National Weather Service",
  "suggestedSources": [
    { "label": "Who publishes it", "type": "rss | ical | snow-report | resort-alerts | cdot | other", "url": "https://...", "why": "what it would add (town news, county alerts, events, ski resort snow report, local paper)" }
  ],
  "resourcesCsv": "CSV text, see below"
}

Rules:
- lat and lon: the center of town (town hall or main street), as numbers with 4 decimals.
- suggestedSources: official RSS or iCal feeds for the town/city and county (news, alerts, calendar), the local newspaper or radio station feed, the nearest ski resort's snow report page, and anything else that publishes timely local information. Only include URLs you actually found. Say in "why" if a feed needs checking.
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
    const srcs = Array.isArray(j.suggestedSources) ? j.suggestedSources.filter((x) => x && x.url) : [];
    const csv = typeof j.resourcesCsv === 'string' ? j.resourcesCsv.trim() : '';
    const csvCopied = h('span', { class: 'ok-msg small', role: 'status' });
    out.replaceChildren(...[
      h('p', { class: 'ok-msg' }, 'Filled in the form below. Check each field (especially the map point), then Create town.'),
      srcs.length ? h('details', { open: true }, h('summary', {}, `Suggested sources (${srcs.length}): add these after creating the town, using Add a source and Test`),
        h('ul', {}, ...srcs.map((x) => h('li', {}, h('strong', {}, x.label || 'Source'), x.type ? ` (${x.type})` : '', ': ',
          /^https?:\/\//.test(x.url) ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.url) : x.url, x.why ? h('div', { class: 'muted small' }, x.why) : null)))) : null,
      csv ? h('details', {}, h('summary', {}, `Starter resources (${csv.split('\n').length - 1} rows): after creating the town, paste into Resources, Import`),
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
