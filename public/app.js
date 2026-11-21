// Telluride.Buzz home screen. Polls /api/home every 60 s while visible.
const POLL_MS = 60e3;
const STALE_MS = { weather: 45 * 60e3, roads: 20 * 60e3, lifts: 90 * 60e3, events: 6 * 3600e3 };
const CATEGORY_LABEL = { weather: 'Weather', roads: 'Roads', lifts: 'Lifts & Snow', events: 'Events', town: 'Town', news: 'News', prefs: 'Preferences' };

const $ = (s, el = document) => el.querySelector(s);
const state = { data: null, filter: null, lastOk: 0, timer: null, feed: [], seen: new Set() };

// ---------- helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(u) {
  try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
function ago(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const TZ = 'America/Denver';
function eventTime(t) {
  const d = new Date(t);
  const dayKey = (x) => x.toLocaleDateString('en-CA', { timeZone: TZ });
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86400e3));
  const day = dayKey(d) === today ? 'Today' : dayKey(d) === tomorrow ? 'Tomorrow' : d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  return time === '12:00 AM' ? day : `${day} · ${time}`;
}

const ICON_ALERT = '<svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';

// ---------- render: alerts ----------
function renderAlerts(alerts) {
  const el = $('#alerts');
  el.innerHTML = alerts.map((a) => {
    const link = safeUrl(a.link);
    return `<details class="alert ${a.severity >= 2 ? '' : 'notice'}">
      <summary>${ICON_ALERT}<div><div class="alert-title">${esc(a.title)}</div>
        <div class="alert-meta">${esc(a.sourceLabel)} · ${ago(a.publishedAt)}${a.expiresAt ? ` · until ${esc(eventTime(a.expiresAt))}` : ''}</div></div></summary>
      <div class="alert-body">${esc(a.summary || '')}${link ? `\n\n<a href="${esc(link)}" target="_blank" rel="noopener">Read at ${esc(a.sourceLabel)} ↗</a>` : ''}</div>
    </details>`;
  }).join('');
}

// ---------- render: tiles ----------
const SRC_SHORT = { weather: 'NWS', roads: 'CDOT', lifts: 'Resort' };
const SRC_LONG = { weather: 'the National Weather Service', roads: 'CDOT', lifts: 'the resort' };
/** Clock time in Telluride: "5:42 AM", "Yesterday 5:42 PM" or "Nov 19, 5:42 PM". */
function clock(t) {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const key = (x) => x.toLocaleDateString('en-CA', { timeZone: TZ });
  if (key(d) === key(new Date())) return time;
  if (key(d) === key(new Date(Date.now() - 86400e3))) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })}, ${time}`;
}
const tileMeta = {}; // name -> { checked, source, stale }

/**
 * Top right of a tile: how long since we last got data (red when it's old).
 * Bottom: when the source itself last updated it, e.g. "NWS updated 5:42 AM".
 */
function tileAge(name, tile) {
  const el = $(`.tile[data-tile="${name}"] [data-age]`);
  const srcEl = $(`.tile[data-tile="${name}"] [data-src]`);
  const at = tile ? (tile.dataAt !== undefined ? tile.dataAt : tile.updatedAt) : null;
  const source = tile?.sourceAt || null;
  tileMeta[name] = { checked: at, source, stale: false };
  if (srcEl) {
    srcEl.innerHTML = source && SRC_SHORT[name] ? `${esc(SRC_SHORT[name])} updated<b>${esc(clock(source))}</b>` : '';
    srcEl.title = source ? `Last updated by ${SRC_LONG[name]}: ${new Date(source).toLocaleString('en-US', { timeZone: TZ })}` : '';
  }
  if (!at) { el.textContent = ''; el.classList.remove('stale'); return; }
  const stale = Date.now() - at > STALE_MS[name];
  tileMeta[name].stale = stale;
  // Only speak up when our copy is old; the source's own time is at the bottom.
  el.textContent = stale ? `as of ${ago(at)}` : '';
  el.classList.toggle('stale', stale);
  el.title = `We last checked ${SRC_LONG[name] || 'the source'} ${new Date(at).toLocaleString('en-US', { timeZone: TZ })}`;
}

function setTile(name, html) {
  $(`.tile[data-tile="${name}"] [data-body]`).innerHTML = html;
}

const unavailable = (msg) => `<div class="tile-error">${esc(msg || 'Not available right now.')}</div>`;

function renderWeather(w) {
  if (!w || !w.ok) return setTile('weather', unavailable(w?.error));
  setTile('weather', `
    <div class="big">${w.temp ?? '–'}°<small>${esc(w.unit || 'F')}</small></div>
    <div>${esc(w.short)}</div>
    <div class="muted">${w.hi != null ? `High ${w.hi}°` : ''}${w.hi != null && w.lo != null ? ' · ' : ''}${w.lo != null ? `Low ${w.lo}°` : ''}</div>
    ${w.snow ? `<div><span class="snowline">❄ ${esc(w.snow)} new snow</span></div>` : ''}`);
}

function renderRoads(r) {
  if (!r) return setTile('roads', unavailable());
  const rows = (r.routes || []).map((x) => `
    <div class="route"><span class="dot ${esc(x.level)}"></span><div><b>${esc(x.label)}</b> <span class="st">${esc(x.status)}</span></div></div>`).join('');
  setTile('roads', `${rows}${r.error ? `<div class="tile-error">${esc(r.error)}</div>` : ''}`);
}

function renderLifts(l) {
  if (!l || !l.ok) return setTile('lifts', unavailable(l?.error));
  const stat = (v, label, suffix = '') => (v == null ? '' : `<div class="stat"><b>${v}${suffix}</b><span>${label}</span></div>`);
  const ratio = (a, b, label) => (a == null ? '' : `<div class="stat"><b>${a}${b != null ? `<small class="muted">/${b}</small>` : ''}</b><span>${label}</span></div>`);
  setTile('lifts', `<div class="stats">
    ${(l.overnight || 0) > (l.new24 || 0) ? stat(l.overnight, 'Overnight', '"') : stat(l.new24, 'New (24h)', '"')}
    ${stat(l.base, 'Base', '"')}
    ${ratio(l.liftsOpen, l.liftsTotal, 'Lifts open')}
    ${ratio(l.trailsOpen, l.trailsTotal, 'Runs open')}
  </div>`);
}

function renderEvents(events) {
  if (!events?.length) return setTile('events', '<div class="tile-error">Nothing listed for the next few days.</div>');
  setTile('events', events.slice(0, 3).map((e) => `
    <div class="event"><time>${esc(eventTime(e.startsAt))}</time>${esc(e.title)}</div>`).join(''));
}

// ---------- render: feed ----------
function postHtml(p) {
  const link = safeUrl(p.link);
  const when = p.category === 'events' && p.startsAt ? eventTime(p.startsAt) : ago(p.publishedAt);
  return `<li class="post sev-${p.severity}" data-id="${p.id}">
    <div class="post-meta"><span class="src ${esc(p.category)}">${esc(p.sourceLabel)}</span><span>${esc(CATEGORY_LABEL[p.category] || '')}</span><span>·</span><time>${esc(when)}</time></div>
    <h3 class="post-title">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</h3>
    ${p.summary ? `<p class="post-sum">${esc(p.summary)}</p>` : ''}
    <div class="post-actions">
      ${p.summary && p.summary.length > 160 ? '<button data-expand>More</button>' : ''}
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Source ↗</a>` : ''}
    </div>
  </li>`;
}

function renderFeed(items) {
  state.feed = items;
  const el = $('#feed');
  el.innerHTML = items.length ? items.map(postHtml).join('') : '<li class="empty">No posts yet. New items appear here as sources update.</li>';
  $('#more').hidden = items.length < 40;
}

// ---------- filter ----------
function setFilter(cat) {
  state.filter = state.filter === cat ? null : cat;
  document.querySelectorAll('.tile').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.tile === state.filter)));
  $('#feed-title').textContent = state.filter ? CATEGORY_LABEL[state.filter] : 'Live feed';
  $('#clear-filter').hidden = !state.filter;
  loadFeed();
  if (state.filter) $('.feed-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadFeed(before) {
  if (!state.filter && !before && state.data) return renderFeed(state.data.feed);
  const q = new URLSearchParams();
  if (state.filter) q.set('category', state.filter);
  if (before) q.set('before', before);
  try {
    const r = await fetch(`/api/feed?${q}`);
    const { items } = await r.json();
    if (before) {
      state.feed = state.feed.concat(items);
      $('#feed').insertAdjacentHTML('beforeend', items.map(postHtml).join(''));
      $('#more').hidden = items.length < 40;
    } else renderFeed(items);
  } catch { /* keep what is on screen */ }
}

// ---------- status ----------
function setStatus() {
  const el = $('#status');
  const offline = !navigator.onLine;
  const stale = Date.now() - state.lastOk > 3 * POLL_MS;
  el.classList.toggle('offline', offline);
  el.classList.toggle('stale', !offline && stale);
  $('#status-text').textContent = offline ? 'Offline' : state.lastOk ? (stale ? `Updated ${ago(state.lastOk)}` : 'Live') : 'Loading…';
}

// ---------- load ----------
async function refresh() {
  try {
    const r = await fetch('/api/home', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    state.data = data;
    state.lastOk = Date.now();
    renderAlerts(data.alerts || []);
    const t = data.tiles || {};
    renderWeather(t.weather); renderRoads(t.roads); renderLifts(t.lifts); renderEvents(data.events);
    for (const name of ['weather', 'roads', 'lifts']) tileAge(name, t[name]);
    tileAge('events', null);
    if (!state.filter) renderFeed(data.feed || []);
    renderPanel();
  } catch {
    // Network or server hiccup: leave the last good screen up, status shows staleness.
  }
  setStatus();
}

function schedule() {
  clearTimeout(state.timer);
  if (document.visibilityState === 'visible') state.timer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { refresh(); schedule(); } else clearTimeout(state.timer);
});
window.addEventListener('online', () => { refresh(); setStatus(); });
window.addEventListener('offline', setStatus);

// Tapping a tile opens its expanded panel; the panel has a button to filter the feed.
document.querySelectorAll('.tile').forEach((t) => t.addEventListener('click', () => openPanel(t.dataset.tile)));
$('#clear-filter').addEventListener('click', () => setFilter(state.filter));
$('#more').addEventListener('click', () => {
  const last = state.feed[state.feed.length - 1];
  if (last) loadFeed(last.publishedAt);
});
$('#feed').addEventListener('click', (e) => {
  const b = e.target.closest('[data-expand]');
  if (!b) return;
  const post = b.closest('.post');
  post.classList.toggle('open');
  b.textContent = post.classList.contains('open') ? 'Less' : 'More';
});
setInterval(setStatus, 15e3);

refresh().then(schedule);

// ---------- expanded tile panel ----------
const panel = $('#panel');
const srcLink = (url, label) => { const u = safeUrl(url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : ''; };
const hourLabel = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric' });
const dayLabel = (t) => eventTime(t).split(' · ')[0];

function panelWeather(w) {
  if (!w || !w.ok) return unavailable(w?.error);
  const hourly = (w.hourly || []).map((h) => `<div class="hour"><time>${esc(hourLabel(h.t))}</time><b>${h.temp ?? '–'}°</b>
    <span>${esc(h.short)}</span>${h.pop ? `<span class="pop">${h.pop}%</span>` : ''}</div>`).join('');
  const periods = (w.periods || []).map((p) => `<div class="p-card period"><b>${esc(p.name)}</b>
    <span class="t ${p.isDaytime ? '' : 'night'}">${p.temp ?? '–'}°</span>
    <p>${esc(p.detail || p.short)}</p></div>`).join('');
  return `<div class="p-card p-now"><div class="big">${w.temp ?? '–'}°<small>${esc(w.unit || 'F')}</small></div>
      <div class="p-now-text"><div><b>${esc(w.short)}</b></div>
      <div class="muted">${w.hi != null ? `High ${w.hi}°` : ''}${w.hi != null && w.lo != null ? ' · ' : ''}${w.lo != null ? `Low ${w.lo}°` : ''}${w.wind ? ` · Wind ${esc(w.wind)}` : ''}</div>
      ${w.snow ? `<div><span class="snowline">❄ ${esc(w.snow)} new snow</span></div>` : ''}</div></div>
    ${hourly ? `<h3>Next 24 hours</h3><div class="hourly">${hourly}</div>` : ''}
    ${periods ? `<h3>Forecast</h3>${periods}` : ''}
    <div class="p-actions">${srcLink(w.link, 'Full forecast at weather.gov')}<button data-filter="weather">Weather posts</button></div>`;
}

function panelRoads(r) {
  if (!r) return unavailable();
  const routes = (r.routes || []).map((x) => {
    const lines = [
      ...(x.events || []).map((e) => `<li>${esc(e.title)}${e.summary ? `<small>${esc(e.summary)}</small>` : ''}</li>`),
      ...(x.conditions || []).map((c) => `<li>${esc(c)}</li>`),
    ].join('');
    return `<div class="p-card p-route"><div class="p-route-head"><span class="dot ${esc(x.level)}"></span><b>${esc(x.label)}</b>${x.note ? `<span class="note">${esc(x.note)}</span>` : ''}</div>
      ${lines ? `<ul>${lines}</ul>` : `<div class="status">${esc(x.status)}</div>`}</div>`;
  }).join('');
  return `<div class="roads-map-wrap"><div class="roads-map" id="roads-map-slot"></div>
      <div class="map-legend"><span><i class="lg ok"></i>Open</span><span><i class="lg caution"></i>Caution</span><span><i class="lg closed"></i>Closed</span><span class="muted">Tap a line or dot for details</span></div></div>
    ${r.error ? `<div class="p-card tile-error">${esc(r.error)}</div>` : ''}${routes}
    <div class="p-actions">${srcLink(r.link, 'Live map at COtrip')}<button data-filter="roads">Road posts</button></div>
    ${r.disclaimer ? `<p class="p-fine"><strong>Road data source:</strong> ${esc(r.disclaimer)}</p>` : ''}`;
}

function panelLifts(l) {
  if (!l || !l.ok) return `${unavailable(l?.error)}<div class="p-actions">${srcLink(l?.link, 'Snow report')}</div>`;
  const stat = (v, label, suffix = '"') => (v == null ? '' : `<div class="p-card"><b>${v}${suffix}</b><span>${label}</span></div>`);
  const ratio = (a, b, label) => (a == null ? '' : `<div class="p-card"><b>${a}${b != null ? `<small class="muted">/${b}</small>` : ''}</b><span>${label}</span>
    ${b ? `<div class="meter"><i data-pct="${Math.round((100 * a) / b)}"></i></div>` : ''}</div>`);
  return `<h3>Snow</h3><div class="p-stats">${stat(l.overnight, 'Overnight')}${stat(l.new24, 'Last 24 hours')}${stat(l.new48, 'Last 48 hours')}${stat(l.base, 'Base depth')}</div>
    <h3>On the mountain</h3><div class="p-stats">${ratio(l.liftsOpen, l.liftsTotal, 'Lifts open')}${ratio(l.trailsOpen, l.trailsTotal, 'Runs open')}</div>
    <div class="p-actions">${srcLink(l.link, `Full report at ${l.sourceLabel || 'the resort'}`)}<button data-filter="lifts">Snow posts</button></div>`;
}

const dayKey = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
let calOffset = 0; // months from the current one

function calendarHtml(events) {
  const has = new Map();
  for (const e of events) { const k = dayKey(e.startsAt); has.set(k, (has.get(k) || 0) + 1); }
  const today = dayKey(Date.now());
  const [ty, tm] = today.split('-').map(Number);
  const first = new Date(Date.UTC(ty, tm - 1 + calOffset, 1));
  const y = first.getUTCFullYear(), m = first.getUTCMonth() + 1;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastKey = dayKey(Date.now() + 30 * 86400e3);
  const pad = (n) => String(n).padStart(2, '0');
  let cells = '<span></span>'.repeat(first.getUTCDay());
  for (let d = 1; d <= days; d++) {
    const k = `${y}-${pad(m)}-${pad(d)}`;
    const n = has.get(k) || 0;
    const cls = [k === today ? 'today' : '', n ? 'has' : '', k < today ? 'past' : ''].join(' ').trim();
    cells += n
      ? `<button class="${cls}" data-day="${k}" aria-label="${esc(dayLabel(Date.parse(`${k}T12:00:00-07:00`)))}: ${n} event${n > 1 ? 's' : ''}">${d}<i></i></button>`
      : `<span class="${cls}">${d}</span>`;
  }
  const title = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const canNext = `${y}-${pad(m)}-${pad(days)}` < lastKey;
  return `<div class="p-card cal">
    <div class="cal-head"><button data-cal="-1" aria-label="Previous month" ${calOffset <= 0 ? 'disabled' : ''}>‹</button><b>${esc(title)}</b><button data-cal="1" aria-label="Next month" ${canNext ? '' : 'disabled'}>›</button></div>
    <div class="cal-grid cal-dow"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
    <div class="cal-grid">${cells}</div></div>`;
}

function panelEvents(events) {
  if (!events?.length) return '<div class="p-card tile-error">Nothing listed for the next few weeks.</div>';
  let lastDay = '';
  return calendarHtml(events) + events.map((e) => {
    const day = dayLabel(e.startsAt);
    const head = day !== lastDay ? `<div class="p-day" id="day-${dayKey(e.startsAt)}">${esc(day)}</div>` : '';
    lastDay = day;
    const time = eventTime(e.startsAt).split(' · ')[1] || 'All day';
    const link = safeUrl(e.link);
    return `${head}<div class="p-card p-event"><time>${esc(time)}</time><div>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : `<b>${esc(e.title)}</b>`}
      ${e.summary ? `<small>${esc(e.summary)}</small>` : ''}<small>${esc(e.sourceLabel)}</small></div></div>`;
  }).join('') + '<div class="p-actions"><button data-filter="events">Event posts</button></div>';
}

// ---------- roads map (Leaflet + OpenStreetMap, loaded only when needed) ----------
let leafletReady = null;
let roadsMap = null, roadsLayer = null;
function loadLeaflet() {
  leafletReady ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = '/vendor/leaflet/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletReady = null; reject(new Error('map failed to load')); };
    document.head.append(js);
  });
  return leafletReady;
}
const LEVEL_COLOR = { ok: '#3d7a4f', caution: '#c27c12', closed: '#a5432a', unknown: '#8a8478' };

async function drawRoadsMap(r) {
  const el = $('#roads-map');
  if (!el || !r) return;
  let L;
  try { L = await loadLeaflet(); } catch { el.innerHTML = '<div class="tile-error map-err">The map could not load. Use the COtrip link below.</div>'; return; }
  if (!roadsMap || roadsMap.getContainer() !== el) {
    roadsMap?.remove();
    roadsMap = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.5 }).setView(r.center || [37.94, -107.81], 9);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(roadsMap);
    roadsLayer = L.layerGroup().addTo(roadsMap);
    roadsMap.fitAfterOpen = true;
  }
  roadsLayer.clearLayers();
  const bounds = [];
  const add = (geo, level, html, weight) => {
    for (const path of geo || []) {
      const color = LEVEL_COLOR[level] || LEVEL_COLOR.unknown;
      const layer = path.length === 1
        ? L.circleMarker(path[0], { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
        : L.polyline(path, { color, weight, opacity: 0.9, lineCap: 'round' });
      layer.bindPopup(html).addTo(roadsLayer);
      bounds.push(...path);
    }
  };
  for (const route of r.routes || []) {
    for (const s of route.segments || []) add(s.geo, s.level, `<b>${esc(route.label)}</b><br>${esc(s.text)}`, 5);
  }
  for (const route of r.routes || []) {
    for (const e of route.events || []) add(e.geo, e.level, `<b>${esc(route.label)}</b><br>${esc(e.title)}${e.summary ? `<br><small>${esc(e.summary)}</small>` : ''}`, 7);
  }
  setTimeout(() => {
    roadsMap.invalidateSize();
    if (roadsMap.fitAfterOpen && bounds.length) roadsMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
    roadsMap.fitAfterOpen = false;
  }, 250);
}

// ---------- preferences ----------
const THEME_INFO = [
  ['trailhead', 'Trailhead', 'Forest green and amber, the original'],
  ['lake', 'Blue Lake', 'Alpine blue with gold'],
  ['aspen', 'Aspen', 'Burnt orange and gold'],
  ['columbine', 'Columbine', 'Purple with gold'],
];
const currentTheme = () => document.documentElement.dataset.palette || 'trailhead';
function setTheme(t) {
  document.documentElement.dataset.palette = t;
  try { localStorage.setItem('buzz-theme', t); } catch { /* storage blocked: applies for this visit only */ }
  const m = document.querySelector('meta[name="theme-color"]');
  if (m && window.BUZZ_THEMES?.[t]) m.content = window.BUZZ_THEMES[t];
}
function panelPrefs() {
  const cur = currentTheme();
  return `<h3>Color theme</h3>
    <div class="themes" role="radiogroup" aria-label="Color theme">${THEME_INFO.map(([id, name, desc]) => `
      <button class="theme-opt" role="radio" aria-checked="${id === cur}" data-theme="${id}">
        <span class="swatch sw-${id}"><i></i><i></i><i></i></span><b>${esc(name)}</b><small>${esc(desc)}</small></button>`).join('')}</div>
    <p class="prefs-note">Saved on this device only. Road and alert colors stay the same in every theme. Dark mode follows your phone's setting.</p>`;
}

const PANELS = { weather: panelWeather, roads: panelRoads, lifts: panelLifts, events: panelEvents, prefs: panelPrefs };
let openTile = null;
let closing = false;

function renderPanel() {
  if (!openTile || !state.data) return;
  const t = state.data.tiles || {};
  const data = openTile === 'events' ? state.data.events : t[openTile];
  const body = $('#panel-body');
  const scroll = body.scrollTop;
  const liveMap = $('#roads-map', body);
  body.innerHTML = PANELS[openTile](data);
  const slot = $('#roads-map-slot', body);
  if (slot) {
    if (liveMap) slot.replaceWith(liveMap); else slot.id = 'roads-map';
    drawRoadsMap(data);
  }
  body.scrollTop = scroll;
  body.querySelectorAll('[data-pct]').forEach((i) => { i.style.width = `${i.dataset.pct}%`; }); // CSP: no inline style attributes
  const src = $(`.tile[data-tile="${openTile}"] [data-age]`);
  const meta = tileMeta[openTile];
  const checked = meta?.checked ? `checked ${ago(meta.checked)}` : '';
  $('#panel-age').textContent = meta?.source ? `${SRC_SHORT[openTile]} updated ${clock(meta.source)}` : (meta?.stale ? src.textContent : checked);
  $('#panel-age').className = meta?.stale ? 'tile-age stale' : 'tile-age';
  $('#panel-age').title = src ? src.title : '';
}

function openPanel(name) {
  if (name !== openTile) calOffset = 0;
  openTile = name;
  $('#panel-title').textContent = CATEGORY_LABEL[name];
  $('#panel-body').scrollTop = 0;
  renderPanel();
  panel.classList.remove('closing');
  panel.style.transform = '';
  if (!panel.open) panel.showModal();
  document.documentElement.classList.add('panel-open');
  history.pushState({ panel: name }, '');
}

function closePanel(fromHistory = false) {
  if (!panel.open || closing) return;
  closing = true;
  const done = () => {
    closing = false;
    panel.classList.remove('closing');
    panel.style.transform = '';
    panel.close();
    document.documentElement.classList.remove('panel-open');
    (openTile === 'prefs' ? $('#prefs-btn') : $(`.tile[data-tile="${openTile}"]`))?.focus();
    openTile = null;
  };
  if (!fromHistory && history.state?.panel) history.back();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
  panel.classList.add('closing');
  setTimeout(done, 170);
}

document.querySelectorAll('.tile-expand').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.open)));
$('#panel-close').addEventListener('click', () => closePanel());
$('#prefs-btn').addEventListener('click', () => openPanel('prefs'));
$('#prefs-link').addEventListener('click', (e) => { e.preventDefault(); openPanel('prefs'); });
panel.addEventListener('cancel', (e) => { e.preventDefault(); closePanel(); }); // Esc
panel.addEventListener('click', (e) => {
  if (e.target === panel) return closePanel(); // tap on the backdrop
  const f = e.target.closest('[data-filter]');
  if (f) { closePanel(); if (state.filter !== f.dataset.filter) setFilter(f.dataset.filter); return; }
  const th = e.target.closest('[data-theme]');
  if (th) { setTheme(th.dataset.theme); return renderPanel(); }
  const nav = e.target.closest('[data-cal]');
  if (nav) { calOffset = Math.max(0, calOffset + Number(nav.dataset.cal)); return renderPanel(); }
  const day = e.target.closest('[data-day]');
  if (day) {
    const head = document.getElementById(`day-${day.dataset.day}`);
    const body = $('#panel-body');
    if (head) body.scrollTo({ top: head.offsetTop - body.offsetTop - 8, behavior: 'smooth' });
  }
});
window.addEventListener('popstate', () => { if (panel.open) closePanel(true); });

// Swipe down on the handle or header to close (phones).
(() => {
  let y0 = null, dy = 0;
  const start = (e) => { if (e.target.closest('button')) return; y0 = e.touches[0].clientY; dy = 0; panel.style.transition = 'none'; };
  const move = (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    panel.style.transition = 'transform .18s ease-out';
    if (dy > 90) closePanel(); else panel.style.transform = '';
  };
  for (const el of [$('.panel-grab'), $('.panel-head')]) {
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }
})();

// ---------- push alerts ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function b64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushState(reg) {
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? sub : null;
}

function showPush(mode) {
  const box = $('#push'), text = $('#push-text'), btn = $('#push-btn');
  box.hidden = false;
  box.classList.toggle('on', mode === 'on');
  btn.hidden = mode === 'ios' || mode === 'blocked';
  btn.disabled = false;
  if (mode === 'on') { text.textContent = 'Alerts are on for this device.'; btn.textContent = 'Turn off'; }
  else if (mode === 'ios') text.textContent = 'To get alerts on iPhone: tap Share, then "Add to Home Screen", and open Buzz from your home screen.';
  else if (mode === 'blocked') text.textContent = 'Notifications are blocked for this site. Allow them in your browser settings to get alerts.';
  else { text.textContent = 'Get a notification for winter storm warnings, road closures and county emergencies.'; btn.textContent = 'Turn on alerts'; }
}

async function setupPush(reg) {
  if (!('PushManager' in window) || !('Notification' in window)) {
    if (isIOS && !standalone) showPush('ios');
    return;
  }
  if (Notification.permission === 'denied') return showPush('blocked');
  showPush((await pushState(reg)) ? 'on' : 'off');

  $('#push-btn').addEventListener('click', async () => {
    const btn = $('#push-btn');
    btn.disabled = true;
    try {
      const existing = await pushState(reg);
      if (existing) {
        await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: existing }) });
        await existing.unsubscribe();
        return showPush('off');
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return showPush(perm === 'denied' ? 'blocked' : 'off');
      const { publicKey } = await (await fetch('/api/push/key')).json();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
      if (!r.ok) throw new Error(await r.text());
      showPush('on');
    } catch (e) {
      $('#push-text').textContent = 'Could not turn on alerts. Please try again.';
      btn.disabled = false;
    }
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(setupPush).catch(() => {});
}
