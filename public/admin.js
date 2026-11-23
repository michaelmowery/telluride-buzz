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

// ---------- router ----------
let timer = null;
async function route() {
  clearInterval(timer);
  const [path, query = ''] = (location.hash.slice(1) || 'health').split('?');
  const [page, a, b] = path.split('/').map(decodeURIComponent);
  try {
    await api('/me');
  } catch { return; }
  $('#login').hidden = true;
  $('#nav').hidden = false;
  document.querySelectorAll('[data-nav]').forEach((n) => n.toggleAttribute('aria-current', n.dataset.nav === (page === 'health' ? 'health' : /resource/.test(page) ? 'resources' : 'towns')));
  try {
    if (page === 'health') { readFilters(query); await healthPage(); timer = setInterval(() => healthPage(true).catch(() => {}), 30e3); }
    else if (page === 'towns') await townsPage();
    else if (page === 'new-town') await townPage(null);
    else if (page === 'town') await townPage(a);
    else if (page === 'source') await sourcePage(a, b);
    else if (page === 'new-source') await sourcePage(a, null);
    else if (page === 'all-resources') { readResFilters(query); await allResourcesPage(); }
    else if (page === 'resources') await resourcesPage(a);
    else if (page === 'resource') await resourcePage(a, b);
    else if (page === 'new-resource') await resourcePage(a, null, b);
    else location.hash = 'health';
  } catch (err) {
    if (err.message !== 'Sign in first') view.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'error' }, err.message)));
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- filters ----------
// Health board filters live in the address (#health?town=durango&feed=roads&status=problems)
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
  history.replaceState(null, '', `#health${qs ? `?${qs}` : ''}`); // no hashchange, so no re-route
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
    const all = healthData.towns.flatMap((t) => t.sources);
    const towns = healthData.towns.map((t) => ({ id: t.id, name: `${t.name}${t.state ? `, ${t.state}` : ''}` }));
    if (filters.town && !towns.some((t) => t.id === filters.town)) filters.town = '';
    view.replaceChildren(
      h('div', { class: 'row spread' }, h('h1', {}, 'Source health'), h('span', { class: 'muted small', id: 'health-updated' })),
      filterBar(filters, { towns, feeds: feedList(all, healthData.feeds || {}), feedNames: healthData.feeds || {} }, () => { saveFilters(); renderHealth(); }),
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
  const total = healthData.towns.reduce((n, t) => n + t.sources.length, 0);
  const shown = towns.flatMap((t) => t.shown);
  const count = (c) => shown.filter((s) => s.color === c).length;
  const filtered = isFiltered(filters, true);
  const visible = filtered ? towns.filter((t) => t.shown.length || (filters.town && !filters.feed && !filters.status && !filters.q)) : towns;
  box.replaceChildren(...[
    h('p', { class: 'summary' },
      ...['green', 'amber', 'red', 'paused'].map((c) => h('span', {}, dot(c), `${count(c)} ${COLOR_WORD[c].toLowerCase()}`)),
      filtered ? h('span', { class: 'muted' }, `Showing ${shown.length} of ${total} sources`) : null),
    h('p', { class: 'muted small' }, 'Red means a source has failed for over an hour. Amber means failing for under an hour, overdue, or waiting for its first run.'),
    ...visible.map((t) => h('div', { class: 'card' },
      h('div', { class: 'town-head' }, dot(t.color), h('h3', {}, h('a', { href: `#town/${t.id}` }, `${t.name}${t.state ? `, ${t.state}` : ''}`)),
        h('span', { class: `pill ${t.status}` }, t.status), h('a', { class: 'small', href: t.url, target: '_blank', rel: 'noopener' }, t.url.replace(/^https?:\/\//, ''))),
      t.shown.length ? sourceTable(t, t.shown, true) : h('p', { class: 'muted' }, t.sources.length ? 'No sources match the filters.' : 'No sources yet.'))),
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

  const kids = [h('p', {}, h('a', { href: '#towns' }, '← Towns')),
    h('div', { class: 'town-head' }, health ? dot(health.color) : null, h('h1', {}, t ? `${t.name}${t.state ? `, ${t.state}` : ''}` : 'Add a town'), t ? h('span', { class: `pill ${t.status}` }, t.status) : null)];
  if (!t) kids.push(h('p', { class: 'muted' }, 'A new town starts as a draft with National Weather Service alerts and forecast already added (they only need the map point). Then add its roads, resort, town and news sources.'));
  if (t) {
    kids.push(
      h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('h2', {}, 'Sources'), h('a', { class: 'button', href: `#new-source/${t.id}` }, 'Add a source')),
        health?.sources.length ? townSources(t, health.sources) : h('p', { class: 'muted' }, 'No sources yet.')),
      h('div', { class: 'card' },
        h('div', { class: 'row spread' }, h('h2', {}, 'Resources'), h('a', { class: 'button', href: `#resources/${t.id}` }, 'Edit resources')),
        h('p', { class: 'muted' }, 'Emergency numbers, medical, town offices, transit, utilities and more, shown at ',
          h('a', { href: `${siteOf(t)}/resources`, target: '_blank', rel: 'noopener' }, `${siteOf(t).replace(/^https?:\/\//, '')}/resources`), '.')),
      h('div', { class: 'card' }, h('h2', {}, 'Going live'), goLiveSteps(t, health)),
    );
  }
  kids.push(h('div', { class: 'card' }, h('h2', {}, t ? 'Town settings' : 'Town details'), f));
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

// The town page's sources, with feed / status / search filters (kept per town for this visit).
const townFilters = {};
let feedNamesCache = null;
function townSources(t, sources) {
  const f = townFilters[t.id] ||= blankFilters();
  const box = h('div');
  const names = feedNamesCache || {};
  const render = () => {
    const rows = sources.filter((s) => matches(s, f));
    box.replaceChildren(...[
      isFiltered(f) ? h('p', { class: 'muted small' }, `Showing ${rows.length} of ${sources.length} sources`) : null,
      rows.length ? sourceTable(t, rows) : h('p', { class: 'muted' }, 'No sources match the filters.')].filter(Boolean));
  };
  render();
  return h('div', {}, sources.length > 3 ? filterBar(f, { towns: null, feeds: feedList(sources, names), feedNames: names }, render) : null, box);
}

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
    try { await api('/source/delete', { town: t.id, key: s.key }); location.hash = `town/${t.id}`; } catch (e2) { err.textContent = e2.message; }
  }

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await api('/source', { create: !s, town: t.id, source: collect() });
      location.hash = `town/${t.id}`;
    } catch (e2) { err.textContent = e2.message; }
  });

  view.replaceChildren(...[
    h('p', {}, h('a', { href: `#town/${t.id}` }, `← ${t.name}`)),
    h('div', { class: 'town-head' }, health ? dot(health.color) : null, h('h1', {}, s ? s.label : `Add a source to ${t.name}`)),
    health?.error ? h('p', { class: 'error' }, `${health.note}: ${health.error}`) : (health ? h('p', { class: 'muted' }, `${health.note}. Last success ${ago(health.lastOk)}.`) : null),
    h('div', { class: 'card' }, f),
  ].filter(Boolean));
}

// ---------- resources ----------
const siteOf = (t) => (t.url || `https://${t.hostnames?.[0] || `${t.id}.thetown.buzz`}`).replace(/\/$/, '');
// Each town's /resources page: phone numbers, offices and links, kept by hand.
const DAY = 86400e3;
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
  const f = h('form', {},
    h('div', { class: 'grid2' },
      field('Name', input('name', { required: true, maxlength: 120, placeholder: 'Telluride Regional Medical Center' })),
      field('Category', h('select', { name: 'category' }, ...d.categories.map((c) => h('option', { value: c.id, selected: v.category === c.id }, c.label)))),
      field('Phone', input('phone', { type: 'tel', maxlength: 40, placeholder: '970-728-3848' }), 'Tap-to-call on phones.'),
      field('Second phone', input('phone2', { type: 'tel', maxlength: 40, placeholder: 'After-hours line' }), 'Optional. Explain it in the note.'),
      field('Website', input('website', { maxlength: 300, placeholder: 'https://www.tellmed.org' })),
      field('Address', input('address', { maxlength: 200, placeholder: '500 W Pacific Ave, Telluride, CO 81435' }), 'Shows a Map button.'),
      field('Hours', input('hours', { maxlength: 200, placeholder: 'Daily 8 a.m. to 6 p.m.' })),
    ),
    field('Note', h('textarea', { name: 'note', rows: 2, maxlength: 400, placeholder: 'For the ER, call the main line and press 0.' }, v.note || '')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'emergency', checked: !!v.emergency }), ' Also show in the Emergency box at the top'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'hidden', checked: !!v.hidden }), ' Hide from the public page'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'checked', checked: !r }), ' I checked this is right today'),
    h('div', { class: 'row form-actions' },
      h('button', { type: 'submit' }, r ? 'Save' : 'Add resource'),
      r ? h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete') : null),
    err,
  );
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(f);
    const resource = { id: r?.id, sort: r?.sort, emergency: fd.get('emergency') === 'on', hidden: fd.get('hidden') === 'on' };
    for (const k of ['name', 'category', 'phone', 'phone2', 'website', 'address', 'hours', 'note']) resource[k] = fd.get(k);
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
const RES_STATUS = [['', 'Any status'], ['stale', 'Needs checking'], ['never', 'Never checked'], ['hidden', 'Hidden'], ['emergency', 'In the emergency box']];
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
  if (resFilters.town && !townName.has(resFilters.town)) resFilters.town = '';
  const f = resFilters;
  const err = h('p', { class: 'error', role: 'alert' });
  const results = h('div');

  const sel = (key, label, options) => h('label', { class: 'filter' }, label,
    h('select', { name: key, onchange: (e) => { f[key] = e.target.value; saveResFilters(); render(); } },
      ...options.map(([v, text]) => h('option', { value: v, selected: f[key] === v }, text))));
  const q = h('input', { type: 'search', value: f.q, placeholder: 'Name, phone, address, note', autocomplete: 'off' });
  q.addEventListener('input', () => { f.q = q.value.trim(); saveResFilters(); render(); });
  const bar = h('div', { class: 'filters card', role: 'search' },
    sel('town', 'Town', [['', 'All towns'], ...d.towns.map((t) => [t.id, townName.get(t.id)])]),
    sel('cat', 'Category', [['', 'All categories'], ...d.categories.map((c) => [c.id, c.label])]),
    sel('status', 'Status', RES_STATUS),
    h('label', { class: 'filter grow' }, 'Search', q),
    h('button', { type: 'button', class: 'small secondary', onclick: () => {
      Object.assign(f, { town: '', cat: '', status: '', q: '' });
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
    if (f.q) {
      const hay = [r.name, r.phone, r.phone2, r.phone.replace(/\D/g, ''), r.website, r.address, r.hours, r.note, townName.get(r.townId), catName.get(r.category)].join(' ').toLowerCase();
      if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function render() {
    const rows = d.resources.filter(matches);
    const staleN = rows.filter(stale).length;
    results.replaceChildren(
      h('p', { class: 'summary' }, `${rows.length} of ${d.resources.length} resources`, staleN ? h('span', { class: 'err' }, ` · ${staleN} need checking`) : null,
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
            r.hours ? h('div', { class: 'muted small' }, `🕒 ${r.hours}`) : null),
          f.town ? null : h('td', { class: 'small' }, townName.get(r.townId) || r.townId),
          h('td', { class: 'small hide-sm' }, catName.get(r.category) || r.category),
          h('td', { class: 'small hide-sm' }, [r.phone, r.website && r.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')].filter(Boolean).join(' · ')),
          h('td', { class: 'small' }, stale(r) ? h('span', { class: 'err' }, r.checkedAt ? ago(r.checkedAt) : 'Never') : ago(r.checkedAt))))))) :
        h('div', { class: 'card' }, h('p', { class: 'muted' }, d.resources.length ? 'No resources match the filters.' : 'No resources yet.')),
    );
  }

  // "Update with Claude": a ready-to-copy research prompt for the town and category
  // picked in the filters, with the current entries as CSV. Paste the answer into the
  // import box below, preview, then import. No API call: copy and paste only.
  function claudeCard() {
    const box = h('div', { hidden: true });
    const btn = h('button', { type: 'button', onclick: () => {
      if (!box.hidden) { box.hidden = true; btn.textContent = 'Update with Claude'; return; }
      if (!f.town) { err.textContent = 'Pick a town first, so the prompt is about one town.'; return; }
      err.textContent = '';
      const prompt = claudePrompt(f.town, f.cat);
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
      h('div', { class: 'row spread' }, h('h2', {}, 'Update with Claude'), btn),
      h('p', { class: 'muted small' }, 'Builds a research prompt for the town (and category) picked above, with the current entries included. Claude checks them against official sources, fixes and adds entries, and answers in the import format.'),
      box);
  }

  function claudePrompt(townId, cat) {
    const t = d.towns.find((x) => x.id === townId);
    const rows = d.resources.filter((r) => r.townId === townId && (!cat || r.category === cat));
    const cell = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
    const cols = ['id', 'town', 'category', 'name', 'phone', 'phone2', 'website', 'address', 'hours', 'note', 'emergency', 'hidden', 'checked', 'source'];
    const csv = [cols.join(','), ...rows.map((r) => [r.id, r.townId, r.category, r.name, r.phone, r.phone2, r.website, r.address, r.hours, r.note,
      r.emergency ? 'yes' : '', r.hidden ? 'yes' : '', day(r.checkedAt), ''].map(cell).join(','))].join('\n');
    const place = `${t.name}${t.state ? `, ${t.state}` : ''}`;
    const scope = cat ? `the "${catName.get(cat)}" category` : 'all categories';
    const today = new Date().toISOString().slice(0, 10);
    return `You are helping maintain the Resources page of ${t.url.replace(/^https?:\/\//, '')}, a local information site for ${place}. It lists essential civic resources people look up: emergency numbers, medical care, town and county offices, transit and parking, utilities, roads and travel, trails and outdoors, schools and the library. It is not a business directory, so leave out shops, restaurants, lodging and other private businesses unless they are the only provider of an essential service (for example, the hospital or the electric co-op).

Task: review and improve the entries for ${scope} in ${place}.
1. Check every current entry below against official, primary sources (the agency's or organization's own website, or a government site). Fix wrong or outdated phone numbers, websites, addresses and hours.
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
      const r = await api('/resources/import', { csv: pending, town: f.town, apply });
      if (apply) { file.value = ''; paste.value = ''; importBox.replaceChildren(h('p', { class: 'ok-msg' }, `Imported: ${r.adds} added, ${r.updates} updated.`)); const fresh = await api('/all-resources'); d.resources = fresh.resources; render(); return; }
      importBox.replaceChildren(...[
        h('p', {}, h('strong', {}, `${r.rows} row${r.rows === 1 ? '' : 's'}: ${r.adds} to add, ${r.updates} to update`), r.errors.length ? h('span', { class: 'err' }, `, ${r.errors.length} with problems`) : null, '.'),
        r.errors.length ? h('ul', {}, ...r.errors.map((e) => h('li', { class: 'err' }, `Row ${e.line}${e.name ? ` (${e.name})` : ''}: ${e.error}`))) : null,
        r.preview.length ? h('details', {}, h('summary', {}, 'Show rows'), h('ul', { class: 'small' }, ...r.preview.map((x) => h('li', {}, `Row ${x.line}: ${x.action} "${x.name}" in ${townName.get(x.town) || x.town}, ${catName.get(x.category) || x.category}`)))) : null,
        !r.errors.length && (r.adds || r.updates) ? h('button', { onclick: () => runImport(true) }, `Import ${r.adds + r.updates} row${r.adds + r.updates === 1 ? '' : 's'}`) : null].filter(Boolean));
    } catch (e) { err.textContent = e.message; }
  }

  view.replaceChildren(
    h('div', { class: 'row spread' }, h('h1', {}, 'Resources'),
      h('span', {},
        f.town ? h('a', { class: 'button', href: `#new-resource/${f.town}/${f.cat || 'emergency'}` }, 'Add resource') : null, ' ',
        h('a', { class: 'button secondary', href: `/api/admin/resources/export${f.town ? `?town=${encodeURIComponent(f.town)}` : ''}` }, f.town ? 'Export CSV' : 'Export all as CSV'))),
    h('p', { class: 'muted' }, `Phone numbers, offices and links shown on each town's Resources tab. Entries not checked in ${d.staleDays} days show in red.`, f.town ? null : ' Pick a town to add a resource.'),
    bar, err, claudeCard(), results,
    h('div', { class: 'card' }, h('h2', {}, 'Import from a spreadsheet'),
      h('p', { class: 'muted small' }, 'Export a CSV, edit it in Excel, Numbers or Google Sheets, then import it here. Rows with an id update that resource; rows without one are added. The town column says which town each row goes to', f.town ? `; blank means ${townName.get(f.town)}.` : '.', ' Category can be the id (medical) or the name (Medical). Nothing changes until you press Import.'),
      h('div', { class: 'row' }, file, h('button', { type: 'button', class: 'secondary', onclick: () => runImport(false) }, 'Preview')),
      paste,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: () => runImport(false) }, 'Preview pasted CSV')),
      importBox),
  );
  render();
}

route();
