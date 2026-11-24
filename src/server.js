// Telluride.Buzz: one small process that ingests feeds on a schedule and serves the
// PWA plus a JSON API. Designed to sit behind the existing Caddy on the Hetzner box.
import { buildInfo } from './version.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { ALL_TOWNS_KEY, noticesFor, renderNotices } from './notice.js';
import { startScheduler } from './scheduler.js';
import { seedDemo } from './demo.js';
import { loadVapid, validSubscription, pushNewAlerts } from './push.js';
import { aliasRedirect, renderTemplate, TEMPLATED, townUrl } from './brand.js';
import { HUB_HOSTS, renderHub, snapshot, townForPath } from './hub.js';
import { importConfigs, loadTowns } from './towns.js';
import { createAdmin } from './admin.js';
import { sourceHealth } from './health.js';
import { importResources, renderResources } from './resources.js';
import { baseUrl, feedSnapshot, guideDescription, guideEntries, guideFor, guideJsonLd, guideNav, homeJsonLd, robotsTxt, seoHead, sitemapXml, townSitemap } from './seo.js';
import crypto from 'node:crypto';
import { createAnalytics } from './analytics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(ROOT, 'config');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
process.env.DATA_DIR = DATA_DIR;
const PORT = Number(process.env.PORT || 3000);
const DEMO = process.env.DEMO === '1';

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
};

// ---------- data ----------
const analytics = createAnalytics(process.env, { log });
const db = openDb(DEMO ? ':memory:' : path.join(DATA_DIR, 'buzz.db'));

// ---------- towns ----------
// Towns and their sources live in the database. config/*.json is imported once per
// town (first start after this change); after that the admin is where towns change.
const configs = fs.existsSync(CONFIG_DIR)
  ? fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8')))
  : [];
importConfigs(db, configs, { log });
// Resource seeds (config/resources/<town>.json), also imported once per town.
const RES_DIR = path.join(CONFIG_DIR, 'resources');
importResources(db, fs.existsSync(RES_DIR)
  ? fs.readdirSync(RES_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(RES_DIR, f), 'utf8')))
  : [], { log });

let towns = [];        // every town, drafts included
let publicTowns = [];  // live towns: the town picker and thetown.buzz list these
let byHost = new Map();
let defaultTown = null;
const homeCache = new Map(); // townId -> { at, body }
const templateCache = new Map(); // `${town.id}:${file}` -> { mtime, body, etag }
let hubCache = null; // { at, mtime, body, etag }

function refreshTowns() {
  towns = loadTowns(db);
  if (!towns.length) throw new Error(`No towns in the database and no town config in ${CONFIG_DIR}`);
  publicTowns = towns.filter((t) => t.status !== 'draft');
  byHost = new Map();
  for (const t of towns) for (const h of t.hostnames || []) byHost.set(h.toLowerCase(), t);
  // Unknown hostnames (the sslip.io test address, a bare IP) get the default town.
  defaultTown = towns.find((t) => t.default) || publicTowns[0] || towns[0];
  for (const t of towns) db.pruneStatus(t.id, t.sources.map((s) => s.key));
  homeCache.clear();
  templateCache.clear();
  hubCache = null;
}
refreshTowns();
/** Towns shown in a town's picker: the live ones, plus itself while it is a draft. */
const pickerTowns = (town) => (town.status === 'draft' ? [...publicTowns, town] : publicTowns);
const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();
const townFor = (req) => byHost.get(hostOf(req)) || defaultTown;
// Web push (VAPID keys live in DATA_DIR/vapid.json, created on first run).
const vapid = DEMO ? null : loadVapid(DATA_DIR);
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://telluride.buzz';
const MAX_SUBSCRIPTIONS = 5000;

let scheduler = { reload() {}, runNow: () => false, stop() {} };
if (DEMO) {
  towns.forEach((t) => seedDemo(db, t));
  log.info('DEMO mode: sample data loaded, no feeds polled');
} else {
  let pushing = false;
  const afterRun = async (town) => {
    if (pushing) return;
    pushing = true;
    try { await pushNewAlerts(db, town, vapid, VAPID_SUBJECT, { log }); } finally { pushing = false; }
  };
  scheduler = startScheduler(db, towns, { log, afterRun });
}

// ---------- admin ----------
const admin = createAdmin({
  db,
  log,
  serverInfo: () => {
    const size = (f) => { try { return fs.statSync(f).size; } catch { return null; } };
    let lastBackup = '';
    try {
      const last = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => /^buzz-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().pop();
      if (last) lastBackup = last.slice(5, 15);
    } catch { /* none yet */ }
    const dbFile = path.join(DATA_DIR, 'buzz.db');
    return {
      demo: DEMO, analytics: analytics.enabled, push: !!vapid, pushSubscribers: db.countSubscriptions(),
      dbBytes: DEMO ? null : (size(dbFile) ?? 0) + (size(`${dbFile}-wal`) ?? 0), lastBackup,
      uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version, build: buildInfo,
    };
  },
  runNow: (townId, key) => scheduler.runNow(townId, key),
  onResources() { templateCache.clear(); },
  onChange() {
    const before = new Set(towns.map((t) => t.id));
    refreshTowns();
    if (DEMO) towns.filter((t) => !before.has(t.id)).forEach((t) => seedDemo(db, t));
    const r = scheduler.reload(towns);
    if (r) log.info(`scheduler: ${r.started} started, ${r.stopped} stopped, ${r.running} running`);
  },
});

// Nightly backup: a consistent copy of the database, 7 days kept.
function backup() {
  if (DEMO) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(DATA_DIR, 'backups');
    db.backupTo(path.join(dir, `buzz-${day}.db`));
    const files = fs.readdirSync(dir).filter((f) => /^buzz-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    files.slice(0, -7).forEach((f) => fs.unlinkSync(path.join(dir, f)));
    log.info(`backup written: backups/buzz-${day}.db`);
  } catch (e) {
    log.warn(`backup failed: ${e.message}`);
  }
}
setTimeout(backup, 60e3);
const backupTimer = setInterval(backup, 24 * 3600e3);

// ---------- API ----------

function home(town) {
  const c = homeCache.get(town.id);
  if (c && Date.now() - c.at < 15e3) return c.body;
  const body = JSON.stringify({
    town: { id: town.id, name: town.name },
    serverTime: Date.now(),
    alerts: db.alerts(town.id),
    tiles: db.getTiles(town.id),
    events: db.upcomingEvents(town.id, 40, 30),
    feed: db.feed(town.id, { limit: 40 }),
  });
  homeCache.set(town.id, { at: Date.now(), body });
  return body;
}

const CATEGORIES = new Set(['weather', 'roads', 'lifts', 'events', 'town', 'news', 'alerts']);

function health(town) {
  const sources = sourceHealth(town, db.sourceStatus(town.id)).map((s) => ({
    source: s.key,
    ok: s.color === 'green',
    color: s.color,
    lastRun: s.lastRun,
    lastOk: s.lastOk,
    error: s.error,
    failures: s.failures,
  }));
  return { ok: true, build: buildInfo, demo: DEMO, pushSubscribers: db.countSubscriptions(), analytics: analytics.enabled, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), sources };
}

// ---------- static ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, urlPath, town) {
  let p = decodeURIComponent(urlPath);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Clean URLs (/about -> about.html), then SPA-style fallback.
      if (!path.extname(p) && fs.existsSync(path.join(PUBLIC, `${path.basename(p)}.html`)) && path.dirname(p) === '/') return serveStatic(req, res, `${p}.html`, town);
      if (!path.extname(p)) return serveStatic(req, res, '/', town);
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(file);
    if (TEMPLATED.has(p)) return serveTemplate(req, res, file, ext, st, town);
    // Code and pages revalidate every time (cheap 304s via ETag) so a deploy never
    // leaves a browser with new HTML and old CSS/JS. Images and vendor files cache.
    const noCache = ['.html', '.css', '.js', '.webmanifest'].includes(ext) && !p.startsWith('/vendor/');
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600', ...SECURITY_HEADERS });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      ETag: etag,
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const siteOf = (town) => town.brand?.siteName || `${town.name} Buzz`;

/** Per-request values for a page template: listings, search tags, first-paint posts. */
// The header's message area (see notice.js).
function siteNotices(town) {
  let all = null;
  try { all = JSON.parse(db.getMeta(ALL_TOWNS_KEY) || 'null'); } catch { /* ignore a bad value */ }
  return renderNotices(noticesFor(town, all));
}

function pageExtras(file, town, guide) {
  const name = path.basename(file);
  const site = siteOf(town);
  const now = Date.now();
  if (guide) {
    // /food-drink, /shops, /lodging, /essentials: one home page tab on its own address.
    const list = db.listResources(town.id);
    const title = guide.title(town);
    const description = guideDescription(list, town, guide);
    return {
      resources: renderResources(list, town, now, guide.tab), pageTitle: title, pageDescription: description,
      h1: guide.h1(town), lede: guide.lede, guideNav: guideNav(guide.path),
      // An empty list is a thin page: kept out of search until it has listings.
      seo: seoHead(town, { path: guide.path, title: `${title} · ${site}`, description, noindex: !guideEntries(list, guide.tab).length, jsonLd: guideJsonLd(list, town, guide, now) }),
    };
  }
  if (name === 'resources.html') {
    // The all-in-one page stays for old links; the guide pages are what search engines get.
    return { resources: renderResources(db.listResources(town.id), town),
      seo: seoHead(town, { path: '/resources', title: `Essentials · ${site}`, description: `Local guide for ${town.name}.`, noindex: true }) };
  }
  if (name === 'index.html') {
    // Home page: one panel per tab (Essentials, Food & drink, Shops, Lodging).
    const list = db.listResources(town.id);
    return { resources: renderResources(list, town, now, 'essentials'), eat: renderResources(list, town, now, 'eat'),
      shop: renderResources(list, town, now, 'shop'), stay: renderResources(list, town, now, 'stay'),
      feedSnapshot: feedSnapshot(db.feed(town.id, { limit: 20 }), town),
      seo: seoHead(town, { path: '/', title: `${site}: ${town.name} News, Weather, Roads & Snow Right Now`,
        description: `The real-time pulse of ${town.name}: what's happening in our town, right now, from sources you can trust.`, jsonLd: homeJsonLd(town) }) };
  }
  if (name === 'about.html') {
    return { seo: seoHead(town, { path: '/about', title: `About · ${site}`, description: `What ${site} is, where its information comes from, and how to report a problem.` }) };
  }
  return {};
}

// Pages, manifest and service worker are filled in per town (see brand.js).
function serveTemplate(req, res, file, ext, st, town, guide = null) {
  const key = `${town.id}:${file}:${guide?.path || ''}`;
  let c = templateCache.get(key);
  // Pages with resources are also re-rendered every 10 minutes, so a sponsorship
  // starts and ends on its dates without anyone touching the admin.
  if (!c || c.mtime !== st.mtimeMs || (c.expires && Date.now() > c.expires)) {
    const extra = ext === '.html' ? { ...pageExtras(file, town, guide), notices: siteNotices(town) } : {};
    const text = renderTemplate(fs.readFileSync(file, 'utf8'), ext, town, pickerTowns(town), extra);
    const body = Buffer.from(ext === '.html' ? analytics.inject(text, town.id) : text);
    // The home page carries a snapshot of the feed, so it is rebuilt every 2 minutes.
    // Messages with an end date, and sponsorships, need the page rebuilt now and then too.
    const ttl = extra.feedSnapshot !== undefined ? 2 * 60_000 : extra.resources || extra.notices ? 10 * 60_000 : 0;
    c = { mtime: st.mtimeMs, expires: ttl ? Date.now() + ttl : 0, body, etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"` };
    templateCache.set(key, c);
  }
  const headers = { 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Host', ...SECURITY_HEADERS };
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': c.body.length, ...headers });
  res.end(req.method === 'HEAD' ? undefined : c.body);
}

// thetown.buzz home page (see hub.js). Re-rendered at most once a minute.
function serveHub(req, res) {
  const file = path.join(PUBLIC, 'hub.html');
  const st = fs.statSync(file);
  if (!hubCache || hubCache.mtime !== st.mtimeMs || Date.now() - hubCache.at > 60e3) {
    const body = Buffer.from(analytics.inject(renderHub(fs.readFileSync(file, 'utf8'), publicTowns, (t) => snapshot(db.getTiles(t.id), db.alerts(t.id))), 'hub'));
    hubCache = { at: Date.now(), mtime: st.mtimeMs, body, etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"` };
  }
  const headers = { 'Cache-Control': 'no-cache', ETag: hubCache.etag, Vary: 'Host', ...SECURITY_HEADERS };
  if (req.headers['if-none-match'] === hubCache.etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Content-Length': hubCache.body.length, ...headers });
  res.end(req.method === 'HEAD' ? undefined : hubCache.body);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

const json = (res, body, maxAge = 15) =>
  send(res, 200, typeof body === 'string' ? body : JSON.stringify(body), 'application/json; charset=utf-8',
    { 'Cache-Control': `public, max-age=${maxAge}` });

function sendAdmin(res, r) {
  if (typeof r.body === 'string') return send(res, r.status, r.body, r.type || 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store', ...(r.headers || {}) });
  send(res, r.status, JSON.stringify(r.body), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...(r.headers || {}) });
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

async function handlePost(req, res, url, town) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, 'Use application/json');
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, 'Bad request'); }
  const sub = body.subscription;
  if (url.pathname === '/api/push/subscribe') {
    if (!vapid) return send(res, 503, 'Push is off in demo mode');
    if (!validSubscription(sub)) return send(res, 400, 'Invalid subscription');
    if (db.countSubscriptions() >= MAX_SUBSCRIPTIONS) return send(res, 503, 'Subscriptions full');
    db.addSubscription(town.id, sub.endpoint);
    return json(res, { ok: true }, 0);
  }
  if (url.pathname === '/api/push/unsubscribe') {
    if (sub && typeof sub.endpoint === 'string') db.removeSubscription(sub.endpoint);
    return json(res, { ok: true }, 0);
  }
  return send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const town = townFor(req);
    if (url.pathname.startsWith('/api/admin/')) {
      return admin.handle(req, url, () => readJson(req, 512 * 1024).catch(() => ({})))
        .then((r) => sendAdmin(res, r))
        .catch((e) => { log.warn(`admin failed: ${e.stack || e.message}`); sendAdmin(res, { status: 500, body: { ok: false, error: 'Server error' } }); });
    }
    // Other addresses of a town forward to its main one (pages only; /api/ stays put).
    const moved = (req.method === 'GET' || req.method === 'HEAD') && aliasRedirect(town, hostOf(req), url.pathname, url.search);
    if (moved) return send(res, 301, `Moved to ${moved}`, undefined, { Location: moved, 'Cache-Control': 'public, max-age=3600' });
    if (/^\/admin(\.html|\.js|\.css|\/.*)?$/.test(url.pathname)) {
      if (!admin.enabled) return send(res, 404, 'Not found');
      if (url.pathname === '/admin.js' || url.pathname === '/admin.css') return serveStatic(req, res, url.pathname, town);
      // The nav's Analytics link: opens the Umami dashboard.
      if (url.pathname === '/admin/analytics') return send(res, 302, 'Moved', undefined, { Location: analytics.dashboardUrl, 'Cache-Control': 'no-store' });
      return serveStatic(req, res, '/admin.html', town);
    }
    if (url.pathname.startsWith('/stats/')) {
      return analytics.handle(req, url.pathname)
        .then((r) => send(res, r.status, req.method === 'HEAD' ? undefined : r.body, r.headers['Content-Type'], r.headers))
        .catch((e) => { log.warn(`stats failed: ${e.message}`); send(res, 502, ''); });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/push/')) {
      return handlePost(req, res, url, town).catch((e) => { log.warn(`post failed: ${e.message}`); send(res, 500, 'Server error'); });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (HUB_HOSTS.has(hostOf(req))) {
      // thetown.buzz: home page, /<town> redirects to that town's site, assets as usual.
      if (url.pathname === '/' || url.pathname === '/index.html') return serveHub(req, res);
      const t = townForPath(url.pathname, publicTowns);
      if (t) return send(res, 302, `Moved to ${townUrl(t)}`, undefined, { Location: townUrl(t) });
      if (!path.extname(url.pathname) && !url.pathname.startsWith('/api/') && url.pathname !== '/healthz') {
        return send(res, 302, 'Moved', undefined, { Location: '/' });
      }
    } else if (/^\/(hub|guide)(\.html)?$/.test(url.pathname)) {
      return send(res, 404, 'Not found'); // hub renders only on thetown.buzz; guide only via its paths
    }
    const guide = !HUB_HOSTS.has(hostOf(req)) && guideFor(url.pathname);
    if (guide) {
      const file = path.join(PUBLIC, 'guide.html');
      return serveTemplate(req, res, file, '.html', fs.statSync(file), town, guide);
    }
    switch (url.pathname) {
      case '/robots.txt':
        return send(res, 200, robotsTxt(HUB_HOSTS.has(hostOf(req)) ? 'https://thetown.buzz' : baseUrl(town)), TYPES['.txt'], { 'Cache-Control': 'public, max-age=3600' });
      case '/sitemap.xml': {
        const entries = HUB_HOSTS.has(hostOf(req))
          ? [{ loc: 'https://thetown.buzz/', changefreq: 'hourly' }]
          : townSitemap(town, db.listResources(town.id), { latestPost: db.feed(town.id, { limit: 1 })[0]?.publishedAt || null });
        return send(res, 200, sitemapXml(entries), 'application/xml; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
      }
      case '/api/push/key':
        return vapid ? json(res, { publicKey: vapid.publicKey }, 3600) : send(res, 503, 'Push is off in demo mode');
      case '/api/push/latest':
        return json(res, db.latestPush(town.id) || db.alerts(town.id)[0] || null, 0);
      case '/api/home':
        return json(res, home(town));
      case '/api/feed': {
        const cat = url.searchParams.get('category');
        const offset = Number(url.searchParams.get('offset')) || 0;
        return json(res, { items: db.feed(town.id, { category: CATEGORIES.has(cat) ? cat : null, offset, limit: 40 }) });
      }
      case '/api/health':
        return json(res, health(town), 0);
      case '/api/tls-ask': {
        // Caddy's on_demand_tls asks here before issuing a certificate, so only
        // addresses that belong to a town (or thetown.buzz) ever get one.
        const d = String(url.searchParams.get('domain') || '').toLowerCase();
        return byHost.has(d) || HUB_HOSTS.has(d) ? send(res, 200, 'ok') : send(res, 404, 'unknown domain');
      }
      case '/api/version':
        return json(res, buildInfo, 0);
      case '/healthz':
        return send(res, 200, 'ok');
      default:
        return serveStatic(req, res, url.pathname, town);
    }
  } catch (e) {
    log.warn(`request failed: ${e.stack || e.message}`);
    send(res, 500, 'Server error');
  }
});

server.listen(PORT, () => log.info(`Buzz listening on :${PORT} (${towns.map((t) => `${t.id}${t.status === 'draft' ? ' [draft]' : ''}`).join(', ')})${admin.enabled ? ', admin on' : ''}`));

function shutdown() {
  log.info('shutting down');
  scheduler.stop();
  clearInterval(backupTimer);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
