// Telluride.Buzz home screen. Polls /api/home every 60 s while visible.
const POLL_MS = 60e3;
const STALE_MS = { weather: 45 * 60e3, roads: 20 * 60e3, lifts: 90 * 60e3, events: 6 * 3600e3 };
const CATEGORY_LABEL = { weather: 'Weather', roads: 'Roads', lifts: 'Lifts & Snow', events: 'Events', town: 'Town', news: 'News' };

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
function tileAge(name, tile) {
  const el = $(`.tile[data-tile="${name}"] [data-age]`);
  const at = tile ? (tile.dataAt !== undefined ? tile.dataAt : tile.updatedAt) : null;
  if (!at) { el.textContent = ''; el.classList.remove('stale'); return; }
  const stale = Date.now() - at > STALE_MS[name];
  el.textContent = stale ? `as of ${ago(at)}` : ago(at);
  el.classList.toggle('stale', stale);
  el.title = `Updated ${new Date(at).toLocaleString()}`;
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

document.querySelectorAll('.tile').forEach((t) => t.addEventListener('click', () => setFilter(t.dataset.tile)));
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
