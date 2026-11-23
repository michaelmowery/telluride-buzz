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
  document.querySelectorAll('[data-nav]').forEach((n) => n.toggleAttribute('aria-current', n.dataset.nav === (page === 'health' ? 'health' : 'towns')));
  try {
    if (page === 'health') { readFilters(query); await healthPage(); timer = setInterval(() => healthPage(true).catch(() => {}), 30e3); }
    else if (page === 'towns') await townsPage();
    else if (page === 'new-town') await townPage(null);
    else if (page === 'town') await townPage(a);
    else if (page === 'source') await sourcePage(a, b);
    else if (page === 'new-source') await sourcePage(a, null);
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

route();
