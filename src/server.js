// Telluride.Buzz: one small process that ingests feeds on a schedule and serves the
// PWA plus a JSON API. Designed to sit behind the existing Caddy on the Hetzner box.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { startScheduler } from './scheduler.js';
import { seedDemo } from './demo.js';
import { loadVapid, validSubscription, pushNewAlerts } from './push.js';

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

// ---------- towns ----------
const towns = fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8')));
if (!towns.length) throw new Error(`No town config in ${CONFIG_DIR}`);
const byHost = new Map();
for (const t of towns) for (const h of t.hostnames || []) byHost.set(h.toLowerCase(), t);
const townFor = (req) => byHost.get(String(req.headers.host || '').split(':')[0].toLowerCase()) || towns[0];

// ---------- data ----------
const db = openDb(DEMO ? ':memory:' : path.join(DATA_DIR, 'buzz.db'));
towns.forEach((t) => db.saveTown(t));
// Web push (VAPID keys live in DATA_DIR/vapid.json, created on first run).
const vapid = DEMO ? null : loadVapid(DATA_DIR);
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://telluride.buzz';
const MAX_SUBSCRIPTIONS = 5000;

let stopScheduler = () => {};
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
  stopScheduler = startScheduler(db, towns, { log, afterRun });
}

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
const homeCache = new Map(); // townId -> { at, body }

function home(town) {
  const c = homeCache.get(town.id);
  if (c && Date.now() - c.at < 15e3) return c.body;
  const body = JSON.stringify({
    town: { id: town.id, name: town.name },
    serverTime: Date.now(),
    alerts: db.alerts(town.id),
    tiles: db.getTiles(town.id),
    events: db.upcomingEvents(town.id, 4),
    feed: db.feed(town.id, { limit: 40 }),
  });
  homeCache.set(town.id, { at: Date.now(), body });
  return body;
}

const CATEGORIES = new Set(['weather', 'roads', 'lifts', 'events', 'town', 'news']);

function health(town) {
  const sources = db.sourceStatus(town.id).map((s) => ({
    source: s.source,
    ok: !s.last_error,
    lastRun: s.last_run,
    lastOk: s.last_ok,
    error: s.last_error,
    failures: s.error_count,
  }));
  return { ok: true, demo: DEMO, pushSubscribers: db.countSubscriptions(), uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), sources };
}

// ---------- static ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Clean URLs (/about -> about.html), then SPA-style fallback.
      if (!path.extname(p) && fs.existsSync(path.join(PUBLIC, `${path.basename(p)}.html`)) && path.dirname(p) === '/') return serveStatic(req, res, `${p}.html`);
      if (!path.extname(p)) return serveStatic(req, res, '/');
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(file);
    const noCache = ext === '.html' || p === '/sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

const json = (res, body, maxAge = 15) =>
  send(res, 200, typeof body === 'string' ? body : JSON.stringify(body), 'application/json; charset=utf-8',
    { 'Cache-Control': `public, max-age=${maxAge}` });

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
    if (req.method === 'POST' && url.pathname.startsWith('/api/push/')) {
      return handlePost(req, res, url, town).catch((e) => { log.warn(`post failed: ${e.message}`); send(res, 500, 'Server error'); });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    switch (url.pathname) {
      case '/api/push/key':
        return vapid ? json(res, { publicKey: vapid.publicKey }, 3600) : send(res, 503, 'Push is off in demo mode');
      case '/api/push/latest':
        return json(res, db.latestPush(town.id) || db.alerts(town.id)[0] || null, 0);
      case '/api/home':
        return json(res, home(town));
      case '/api/feed': {
        const cat = url.searchParams.get('category');
        const before = Number(url.searchParams.get('before')) || null;
        return json(res, { items: db.feed(town.id, { category: CATEGORIES.has(cat) ? cat : null, before, limit: 40 }) });
      }
      case '/api/health':
        return json(res, health(town), 0);
      case '/healthz':
        return send(res, 200, 'ok');
      default:
        return serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    log.warn(`request failed: ${e.stack || e.message}`);
    send(res, 500, 'Server error');
  }
});

server.listen(PORT, () => log.info(`Telluride.Buzz listening on :${PORT} (${towns.map((t) => t.id).join(', ')})`));

function shutdown() {
  log.info('shutting down');
  stopScheduler();
  clearInterval(backupTimer);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
