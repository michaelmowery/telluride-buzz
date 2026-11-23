// Telluride.Buzz home screen. Polls /api/home every 60 s while visible.
const POLL_MS = 60e3;
const STALE_MS = { weather: 45 * 60e3, roads: 20 * 60e3, lifts: 90 * 60e3, events: 6 * 3600e3 };
const CATEGORY_LABEL = { weather: 'Weather', roads: 'Roads', lifts: 'Lifts & Snow', events: 'Events', town: 'Town', news: 'News', alerts: 'Alerts', prefs: 'Preferences' };

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

/** Each resort in the Lifts & Snow tile (older servers sent one resort at the top level). */
const resortsIn = (l) => (l?.resorts?.length ? l.resorts : l ? [l] : []);

function renderLifts(l) {
  const list = resortsIn(l);
  if (!list.some((r) => r.ok)) return setTile('lifts', unavailable(l?.error));
  const stat = (v, label, suffix = '') => (v == null ? '' : `<div class="stat"><b>${v}${suffix}</b><span>${label}</span></div>`);
  const ratio = (a, b, label) => (a == null ? '' : `<div class="stat"><b>${a}${b != null ? `<small class="muted">/${b}</small>` : ''}</b><span>${label}</span></div>`);
  const fresh = (r) => ((r.overnight || 0) > (r.new24 || 0) ? [r.overnight, 'overnight'] : [r.new24, 'new']);
  if (list.length === 1) {
    const r = list[0];
    const [snow, word] = fresh(r);
    return setTile('lifts', `<div class="mountain">${esc(r.name || r.sourceLabel || '')}</div><div class="stats">
    ${stat(snow, word === 'overnight' ? 'Overnight' : 'New (24h)', '"')}
    ${stat(r.base, 'Base', '"')}
    ${ratio(r.liftsOpen, r.liftsTotal, 'Lifts open')}
    ${ratio(r.trailsOpen, r.trailsTotal, 'Runs open')}
  </div>`);
  }
  // Several mountains: one compact row each.
  setTile('lifts', list.map((r) => {
    if (!r.ok) return `<div class="mtn-row"><b>${esc(r.name)}</b><span>No report</span></div>`;
    const [snow, word] = fresh(r);
    const bits = [snow != null ? `${snow}" ${word}` : null, r.liftsOpen != null ? `${r.liftsOpen}${r.liftsTotal != null ? `/${r.liftsTotal}` : ''} lifts` : null].filter(Boolean);
    return `<div class="mtn-row"><b>${esc(r.name)}</b><span>${esc(bits.join(' · ') || 'Report posted')}</span></div>`;
  }).join(''));
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

// ---------- show / hide (Preferences) ----------
const HIDE_KEY = 'buzz-hide';
function hidden() { return new Set((document.documentElement.dataset.hide || '').split(' ').filter(Boolean)); }
function setHidden(key, hide) {
  const h = hidden();
  if (hide) h.add(key); else h.delete(key);
  document.documentElement.dataset.hide = [...h].join(' ');
  try { localStorage.setItem(HIDE_KEY, JSON.stringify([...h])); } catch { /* storage blocked: this visit only */ }
}
// Feed topics the person hid ("feed-roads" etc.). The filtered views from a panel still show everything.
const shownInFeed = (p) => state.filter || !hidden().has(`feed-${p.category}`);

function renderFeed(items) {
  state.feed = items;
  const el = $('#feed');
  const visible = items.filter(shownInFeed);
  el.innerHTML = visible.length ? visible.map(postHtml).join('')
    : `<li class="empty">${items.length ? 'Nothing here from the topics you chose. Change them in Preferences.' : 'No posts yet. New items appear here as sources update.'}</li>`;
  $('#more').hidden = items.length < 40;
}

// ---------- filter ----------
// cat === null shows everything. From a pill the page stays put; from a panel it scrolls to the feed.
function setFilter(cat, scroll = true) {
  state.filter = cat && state.filter !== cat ? cat : null;
  document.querySelectorAll('.feed-pill').forEach((b) => b.setAttribute('aria-current', String((b.dataset.cat || null) === state.filter)));
  document.querySelectorAll('.tile').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.tile === state.filter)));
  loadFeed();
  if (state.filter && scroll) { showTab('feed'); $('.feed-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
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
      $('#feed').insertAdjacentHTML('beforeend', items.filter(shownInFeed).map(postHtml).join(''));
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
document.querySelectorAll('.feed-pill').forEach((b) => b.addEventListener('click', () => {
  const cat = b.dataset.cat || null;
  if (cat !== state.filter) setFilter(cat, false);
}));
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
  const list = resortsIn(l);
  if (!list.length) return unavailable(l?.error);
  const stat = (v, label, suffix = '"') => (v == null ? '' : `<div class="p-card"><b>${v}${suffix}</b><span>${label}</span></div>`);
  const ratio = (a, b, label) => (a == null ? '' : `<div class="p-card"><b>${a}${b != null ? `<small class="muted">/${b}</small>` : ''}</b><span>${label}</span>
    ${b ? `<div class="meter"><i data-pct="${Math.round((100 * a) / b)}"></i></div>` : ''}</div>`);
  const one = (r) => {
    const name = esc(r.name || r.sourceLabel || 'The resort');
    if (!r.ok) return `<h3 class="p-mountain">${name}</h3>${unavailable(r.error)}<div class="p-actions">${srcLink(r.link, 'Snow report')}</div>`;
    const updated = r.sourceAt ? `<span class="muted"> · updated ${esc(clock(r.sourceAt))}</span>` : '';
    return `<h3 class="p-mountain">${name}${updated}</h3>
    <h4>Snow</h4><div class="p-stats">${stat(r.overnight, 'Overnight')}${stat(r.new24, 'Last 24 hours')}${stat(r.new48, 'Last 48 hours')}${stat(r.base, 'Base depth')}</div>
    <h4>On the mountain</h4><div class="p-stats">${ratio(r.liftsOpen, r.liftsTotal, 'Lifts open')}${ratio(r.trailsOpen, r.trailsTotal, 'Runs open')}</div>
    <div class="p-actions">${srcLink(r.link, `Full report at ${r.sourceLabel || 'the resort'}`)}</div>`;
  };
  return `${list.map(one).join('')}<div class="p-actions"><button data-filter="lifts">Snow posts</button></div>`;
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
  ['lake', 'Blue Lake', 'Alpine blue with gold (default)'],
  ['trailhead', 'Trailhead', 'Forest green and amber'],
  ['aspen', 'Aspen', 'Burnt orange and gold'],
  ['columbine', 'Columbine', 'Purple with gold'],
];
const currentTheme = () => document.documentElement.dataset.palette || 'lake';
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
    <p class="prefs-note">Road and alert colors stay the same in every theme. Dark mode follows your phone's setting.</p>
    <h3>Show on the home screen</h3>
    <div class="toggles">${SHOW_OPTS.map(toggleHtml).join('')}</div>
    <h3>Topics in the live feed</h3>
    <div class="toggles">${FEED_OPTS.map(toggleHtml).join('')}</div>
    <p class="prefs-note">Emergency and weather warnings in the red banner always show. Everything here is saved on this device only.</p>`;
}
const SHOW_OPTS = [
  ['weather', 'Weather tile'], ['roads', 'Roads tile'], ['lifts', 'Lifts & Snow tile'], ['events', 'Events tile'],
  ['push', 'Phone alerts box'], ['feed', 'Live feed'],
];
const FEED_OPTS = [
  ['feed-weather', 'Weather'], ['feed-roads', 'Roads'], ['feed-lifts', 'Snow report'], ['feed-events', 'Events'],
  ['feed-town', 'Town and County news'], ['feed-news', 'Local news (KOTO, Meander.me)'],
];
function toggleHtml([key, label]) {
  const on = !hidden().has(key);
  return `<button class="toggle" role="switch" aria-checked="${on}" data-toggle="${esc(key)}"><span>${esc(label)}</span><i class="switch" aria-hidden="true"></i></button>`;
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
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    const key = tg.dataset.toggle;
    setHidden(key, !hidden().has(key));
    if (key.startsWith('feed-') && !state.filter) renderFeed(state.data?.feed || []);
    return renderPanel();
  }
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

const PUSH_TEXT = {
  off: 'Get a notification for winter storm warnings, road closures and county emergencies.',
  on: 'Alerts are on for this device.',
  ios: 'To get alerts on iPhone: tap Share, then "Add to Home Screen", and open Buzz from your home screen.',
  blocked: 'Notifications are blocked for this site. To turn them on, click the icon at the left of the address bar, set Notifications to Allow, then press Check again.',
  dismissed: 'Your browser did not turn notifications on. If you see a bell or "Notifications blocked" in the address bar, click it and choose Allow, then press the button again.',
  unsupported: 'This browser cannot show alerts. Try Chrome, Edge, Firefox or Safari.',
  error: 'Could not turn on alerts. Please try again.',
};

function showPush(mode, detail) {
  const box = $('#push'), text = $('#push-text'), btn = $('#push-btn');
  box.hidden = false;
  box.classList.toggle('on', mode === 'on');
  btn.hidden = mode === 'ios' || mode === 'unsupported';
  btn.disabled = false;
  text.textContent = PUSH_TEXT[mode] + (detail ? ` (${detail})` : '');
  btn.textContent = mode === 'on' ? 'Turn off' : mode === 'blocked' ? 'Check again' : mode === 'error' || mode === 'dismissed' ? 'Try again' : 'Turn on alerts';
}

// Chrome can hold the permission prompt behind a small address-bar chip, leaving
// requestPermission() pending; tell the person where to look instead of going quiet.
function askPermission() {
  const hint = setTimeout(() => {
    $('#push-text').textContent = 'Waiting for your browser. Look for a notification prompt or a bell icon in the address bar and choose Allow.';
  }, 1500);
  return Promise.resolve(Notification.requestPermission()).finally(() => clearTimeout(hint));
}

let pushReg = null;

async function onPushClick() {
  const btn = $('#push-btn'), text = $('#push-text');
  btn.disabled = true;
  text.textContent = 'Turning on alerts…';
  try {
    if (Notification.permission === 'denied') return showPush('blocked');
    const reg = pushReg || await navigator.serviceWorker.ready;
    const existing = await pushState(reg);
    if (existing) {
      text.textContent = 'Turning off alerts…';
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: existing }) });
      await existing.unsubscribe();
      return showPush('off');
    }
    const perm = await askPermission();
    if (perm === 'denied') return showPush('blocked');
    if (perm !== 'granted') return showPush('dismissed');
    text.textContent = 'Turning on alerts…';
    const kr = await fetch('/api/push/key');
    if (!kr.ok) throw new Error(`server ${kr.status}`);
    const { publicKey } = await kr.json();
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe().catch(() => {}); // stale sub from another key
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
    if (!r.ok) throw new Error(`server ${r.status}`);
    showPush('on');
  } catch (e) {
    console.warn('[push]', e);
    showPush('error', e?.message ? String(e.message).slice(0, 80) : '');
  }
}

async function setupPush(reg) {
  pushReg = reg;
  if (Notification.permission === 'denied') return showPush('blocked');
  showPush((await pushState(reg)) ? 'on' : 'off');
}

(function initPush() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) {
    if (isIOS && !standalone) showPush('ios');
    return;
  }
  $('#push-btn').addEventListener('click', onPushClick);
  navigator.serviceWorker.register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(setupPush)
    .catch((e) => { console.warn('[push] service worker', e); showPush('error', 'service worker did not start'); });
})();

// ---------- tabs: Live feed | Resources ----------
// #resources (or a section inside it, like #medical) opens the Resources tab, so the
// header phone icon, footer link and shared links all land on it.
function showTab(which, scroll = false) {
  const res = which === 'resources';
  $('#tab-feed').setAttribute('aria-selected', String(!res));
  $('#tab-resources').setAttribute('aria-selected', String(res));
  $('#feed-panel').hidden = res;
  $('#res-panel').hidden = !res;
  if (scroll) $('.feed-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function tabFromHash(scroll) {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const el = document.getElementById(id);
  if (id === 'resources' || (el && $('#res-panel').contains(el))) {
    showTab('resources', id === 'resources' && scroll);
    if (el && el.tagName === 'DETAILS') { el.open = true; if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } else if (id === 'feed') showTab('feed', scroll);
}
document.querySelectorAll('.tabs [role=tab]').forEach((t) => t.addEventListener('click', (e) => {
  e.preventDefault();
  history.replaceState(null, '', t.getAttribute('href'));
  showTab(t.id === 'tab-resources' ? 'resources' : 'feed');
}));
document.querySelectorAll('.tabs [role=tab]').forEach((t) => t.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const other = t.id === 'tab-feed' ? $('#tab-resources') : $('#tab-feed');
  other.focus(); other.click();
}));
window.addEventListener('hashchange', () => tabFromHash(true));
tabFromHash(false);
