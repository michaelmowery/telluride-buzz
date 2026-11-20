// Telluride.Buzz: one small process that ingests feeds on a schedule and serves the
// PWA plus a JSON API. Designed to sit behind the existing Caddy on the Hetzner box.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { startScheduler } from './scheduler.js';
import { seedDemo } from './demo.js';

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
let stopScheduler = () => {};
if (DEMO) {
  towns.forEach((t) => seedDemo(db, t));
  log.info('DEMO mode: sample data loaded, no feeds polled');
} else {
  stopScheduler = startScheduler(db, towns, { log });
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
  return { ok: true, demo: DEMO, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), sources };
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
      // SPA-style fallback for unknown paths without an extension.
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

const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    const url = new URL(req.url, 'http://x');
    const town = townFor(req);
    switch (url.pathname) {
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
