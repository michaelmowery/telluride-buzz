// SQLite storage using Node's built-in driver (no native dependencies).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { EVENT_DAYS, EVENT_WEIGHT, PIN_SEVERITY, RANK_SQL, EVENT_WINDOW_SQL } from './relevance.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

-- Towns are data: one row per town (config holds hostnames, map point, brand...).
CREATE TABLE IF NOT EXISTS towns (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL
);

-- Each feed or scrape a town reads. adapter names shared code (src/adapters.js);
-- key is the id items and health use for it (e.g. nws-alerts, feed-koto).
CREATE TABLE IF NOT EXISTS sources (
  town_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  adapter    TEXT NOT NULL,
  label      TEXT NOT NULL,
  about      TEXT,                     -- one line for the About page
  settings   TEXT NOT NULL DEFAULT '{}',
  every_min  REAL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (town_id, key)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Every feed lands here: tiles, the live feed and the alert banner all read it.
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  town_id      TEXT NOT NULL,
  source       TEXT NOT NULL,          -- source id, e.g. nws-alerts, cdot-incidents, koto
  source_label TEXT NOT NULL,          -- shown on the post, e.g. "National Weather Service"
  ext_id       TEXT NOT NULL,          -- id from the source, for de-duplication
  category     TEXT NOT NULL,          -- weather | roads | lifts | events | town | news | alerts
  title        TEXT NOT NULL,
  summary      TEXT,
  link         TEXT,
  severity     INTEGER NOT NULL DEFAULT 0,  -- 0 info, 1 notice, 2 warning (banner), 3 emergency (banner)
  published_at INTEGER NOT NULL,       -- epoch ms
  starts_at    INTEGER,                -- events: when it happens
  expires_at   INTEGER,                -- alerts: when it stops being active
  updated_at   INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (town_id, source, ext_id)
);
CREATE INDEX IF NOT EXISTS items_feed ON items (town_id, active, published_at DESC);
CREATE INDEX IF NOT EXISTS items_cat  ON items (town_id, category, published_at DESC);

-- Latest computed state of each home-screen tile.
CREATE TABLE IF NOT EXISTS tiles (
  town_id    TEXT NOT NULL,
  tile       TEXT NOT NULL,            -- weather | roads | lifts | events
  data       TEXT NOT NULL,            -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (town_id, tile)
);

-- Health of each ingestion job, so stale data is visible instead of silent.
CREATE TABLE IF NOT EXISTS source_status (
  town_id      TEXT NOT NULL,
  source       TEXT NOT NULL,
  last_run     INTEGER,
  last_ok      INTEGER,
  last_error   TEXT,
  error_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (town_id, source)
);

-- Web push: browser subscriptions, which alerts were already pushed, and the latest
-- pushed alert (what the service worker shows when a payload-less push arrives).
-- Town resources: phone numbers, offices and links kept by hand in /admin (see resources.js).
CREATE TABLE IF NOT EXISTS resources (
  id          INTEGER PRIMARY KEY,
  town_id     TEXT NOT NULL,
  category    TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT,
  phone2      TEXT,
  website     TEXT,
  address     TEXT,
  hours       TEXT,
  note        TEXT,
  emergency   INTEGER NOT NULL DEFAULT 0,  -- also shown in the Emergency box at the top
  hidden      INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  checked_at  INTEGER,                     -- last time someone confirmed it is right
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS resources_town ON resources (town_id, category, sort);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    TEXT PRIMARY KEY,
  town_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_ok     INTEGER,
  fail_count  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pushed_alerts (
  town_id  TEXT NOT NULL,
  item_id  INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (town_id, item_id)
);
CREATE TABLE IF NOT EXISTS latest_push (
  town_id  TEXT PRIMARY KEY,
  data     TEXT NOT NULL,
  at       INTEGER NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return wrap(db);
}

/** Columns added after the first deploy (CREATE TABLE IF NOT EXISTS won't add them). */
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const add = (table, col, def) => { if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  add('towns', 'status', "TEXT NOT NULL DEFAULT 'live'"); // draft | live
  add('towns', 'created_at', 'INTEGER');
  add('towns', 'updated_at', 'INTEGER');
  add('source_status', 'failing_since', 'INTEGER');
  add('source_status', 'last_items', 'INTEGER');
  add('resources', 'tags', 'TEXT');
  // Sponsored listings: dates are yyyy-mm-dd in the town's time zone, both inclusive.
  add('resources', 'sponsor_from', 'TEXT');
  add('resources', 'sponsor_until', 'TEXT');
  add('resources', 'sponsor_tagline', 'TEXT');
  add('resources', 'sponsor_logo', 'TEXT');
}

function wrap(db) {
  const upsertItem = db.prepare(`
    INSERT INTO items (town_id, source, source_label, ext_id, category, title, summary, link,
                       severity, published_at, starts_at, expires_at, updated_at, active)
    VALUES (:town_id, :source, :source_label, :ext_id, :category, :title, :summary, :link,
            :severity, :published_at, :starts_at, :expires_at, :updated_at, 1)
    ON CONFLICT (town_id, source, ext_id) DO UPDATE SET
      source_label = excluded.source_label, category = excluded.category,
      title = excluded.title, summary = excluded.summary, link = excluded.link,
      severity = excluded.severity, published_at = excluded.published_at,
      starts_at = excluded.starts_at, expires_at = excluded.expires_at,
      updated_at = excluded.updated_at, active = 1`);

  return {
    raw: db,

    // ---------- towns and sources ----------
    saveTown(town, status = null) {
      const now = Date.now();
      const { sources, status: st, ...config } = town;
      db.prepare(`INSERT INTO towns (id, name, config, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT (id) DO UPDATE SET name = excluded.name, config = excluded.config,
                    status = COALESCE(?, towns.status), updated_at = excluded.updated_at`)
        .run(town.id, town.name, JSON.stringify(config), status || st || 'live', now, now, status || st || null);
    },

    listTowns() {
      return db.prepare('SELECT id, name, config, status, created_at, updated_at FROM towns ORDER BY name').all()
        .map((r) => ({ ...JSON.parse(r.config), id: r.id, name: r.name, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at }));
    },

    deleteTown(id) {
      db.exec('BEGIN');
      try {
        for (const t of ['towns']) db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id);
        for (const t of ['sources', 'source_status', 'tiles', 'items', 'push_subs', 'pushed_alerts', 'latest_push', 'resources']) db.prepare(`DELETE FROM ${t} WHERE town_id = ?`).run(id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    listSources(townId = null) {
      const rows = townId
        ? db.prepare('SELECT * FROM sources WHERE town_id = ? ORDER BY sort, key').all(townId)
        : db.prepare('SELECT * FROM sources ORDER BY town_id, sort, key').all();
      return rows.map((r) => ({
        townId: r.town_id, key: r.key, adapter: r.adapter, label: r.label, about: r.about,
        settings: JSON.parse(r.settings || '{}'), everyMin: r.every_min, enabled: !!r.enabled, sort: r.sort, updatedAt: r.updated_at,
      }));
    },

    saveSource(townId, s) {
      db.prepare(`INSERT INTO sources (town_id, key, adapter, label, about, settings, every_min, enabled, sort, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (town_id, key) DO UPDATE SET adapter = excluded.adapter, label = excluded.label,
                    about = excluded.about, settings = excluded.settings, every_min = excluded.every_min,
                    enabled = excluded.enabled, sort = excluded.sort, updated_at = excluded.updated_at`)
        .run(townId, s.key, s.adapter, s.label, s.about || null, JSON.stringify(s.settings || {}),
          s.everyMin ?? null, s.enabled === false ? 0 : 1, s.sort ?? 0, Date.now());
    },

    setSourceEnabled(townId, key, enabled) {
      db.prepare('UPDATE sources SET enabled = ?, updated_at = ? WHERE town_id = ? AND key = ?').run(enabled ? 1 : 0, Date.now(), townId, key);
    },

    /** Remove a source, its health row and its posts. */
    deleteSource(townId, key, itemSources = [key]) {
      db.prepare('DELETE FROM sources WHERE town_id = ? AND key = ?').run(townId, key);
      db.prepare('DELETE FROM source_status WHERE town_id = ? AND source = ?').run(townId, key);
      for (const s of itemSources) db.prepare('UPDATE items SET active = 0 WHERE town_id = ? AND source = ?').run(townId, s);
    },

    /**
     * Move a source to another town with its posts and health. Posts the other town
     * already has (same id from the source) stay there; the leftovers are hidden.
     * Moved alerts count as already pushed, so the new town's phones aren't sent old news.
     */
    moveSource(fromTown, toTown, key, itemSources = [key], sort = 0) {
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE sources SET town_id = ?, sort = ?, updated_at = ? WHERE town_id = ? AND key = ?').run(toTown, sort, Date.now(), fromTown, key);
        db.prepare('DELETE FROM source_status WHERE town_id = ? AND source = ?').run(toTown, key);
        db.prepare('UPDATE source_status SET town_id = ? WHERE town_id = ? AND source = ?').run(toTown, fromTown, key);
        for (const src of itemSources) {
          db.prepare('UPDATE OR IGNORE items SET town_id = ? WHERE town_id = ? AND source = ?').run(toTown, fromTown, src);
          db.prepare('UPDATE items SET active = 0 WHERE town_id = ? AND source = ?').run(fromTown, src);
          db.prepare(`INSERT OR IGNORE INTO pushed_alerts (town_id, item_id, at)
                      SELECT town_id, id, ? FROM items WHERE town_id = ? AND source = ?`).run(Date.now(), toTown, src);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    /** Drop health rows for jobs that no longer exist (e.g. after a source was renamed). */
    pruneStatus(townId, keys) {
      const ph = keys.map(() => '?').join(',');
      db.prepare(`DELETE FROM source_status WHERE town_id = ?${keys.length ? ` AND source NOT IN (${ph})` : ''}`).run(townId, ...keys);
    },

    // ---------- resources ----------
    /** One town's resources, or every town's when townId is null. */
    listResources(townId) {
      const rows = townId
        ? db.prepare('SELECT * FROM resources WHERE town_id = ? ORDER BY sort, id').all(townId)
        : db.prepare('SELECT * FROM resources ORDER BY town_id, sort, id').all();
      return rows.map((r) => ({
        id: r.id, townId: r.town_id, category: r.category, name: r.name, phone: r.phone || '', phone2: r.phone2 || '',
        website: r.website || '', address: r.address || '', hours: r.hours || '', note: r.note || '', tags: r.tags || '',
        sponsored: !!r.sponsor_until, sponsorFrom: r.sponsor_from || '', sponsorUntil: r.sponsor_until || '',
        sponsorTagline: r.sponsor_tagline || '', sponsorLogo: r.sponsor_logo || '',
        emergency: !!r.emergency, hidden: !!r.hidden, sort: r.sort, checkedAt: r.checked_at, updatedAt: r.updated_at,
      }));
    },

    /** Insert (no id) or update one resource. Returns its id, or null when the id isn't in that town. */
    saveResource(townId, r) {
      const now = Date.now();
      const vals = [r.category, r.name, r.phone || null, r.phone2 || null, r.website || null, r.address || null,
        r.hours || null, r.note || null, r.tags || null, r.emergency ? 1 : 0, r.hidden ? 1 : 0, r.sort ?? 0,
        r.sponsored ? r.sponsorFrom : null, r.sponsored ? r.sponsorUntil : null,
        r.sponsored ? r.sponsorTagline || null : null, r.sponsored ? r.sponsorLogo || null : null];
      if (r.id) {
        const res = db.prepare(`UPDATE resources SET category = ?, name = ?, phone = ?, phone2 = ?, website = ?, address = ?,
                    hours = ?, note = ?, tags = ?, emergency = ?, hidden = ?, sort = ?,
                    sponsor_from = ?, sponsor_until = ?, sponsor_tagline = ?, sponsor_logo = ?, checked_at = COALESCE(?, checked_at), updated_at = ?
                    WHERE id = ? AND town_id = ?`).run(...vals, r.checkedAt ?? null, now, r.id, townId);
        return res.changes ? r.id : null;
      }
      const res = db.prepare(`INSERT INTO resources (town_id, category, name, phone, phone2, website, address, hours, note, tags,
                  emergency, hidden, sort, sponsor_from, sponsor_until, sponsor_tagline, sponsor_logo, checked_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(townId, ...vals, r.checkedAt ?? null, now);
      return Number(res.lastInsertRowid);
    },

    deleteResource(townId, id) {
      return db.prepare('DELETE FROM resources WHERE id = ? AND town_id = ?').run(id, townId).changes > 0;
    },

    /** Set many sort values at once (reorder). */
    sortResources(townId, ids) {
      db.exec('BEGIN');
      try {
        ids.forEach((id, i) => db.prepare('UPDATE resources SET sort = ? WHERE id = ? AND town_id = ?').run((i + 1) * 10, id, townId));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    markResourcesChecked(townId, ids) {
      const now = Date.now();
      for (const id of ids) db.prepare('UPDATE resources SET checked_at = ? WHERE id = ? AND town_id = ?').run(now, id, townId);
    },

    getMeta(key) { return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; },
    setMeta(key, value) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
    },
    deleteMeta(key) { db.prepare('DELETE FROM meta WHERE key = ?').run(key); },

    /**
     * Replace the active set for one source: upsert what the source returned now and
     * deactivate anything it no longer lists (e.g. an expired alert or a cleared incident).
     */
    /** When each post of a source was first published or seen: Map(ext_id -> ms). */
    firstSeen(townId, source) {
      return new Map(db.prepare('SELECT ext_id, published_at FROM items WHERE town_id = ? AND source = ?').all(townId, source)
        .map((r) => [r.ext_id, r.published_at]));
    },

    syncItems(townId, source, items, { deactivateMissing = true } = {}) {
      const now = Date.now();
      db.exec('BEGIN');
      try {
        const seen = [];
        for (const it of items) {
          upsertItem.run({
            town_id: townId,
            source,
            source_label: it.sourceLabel,
            ext_id: String(it.extId),
            category: it.category,
            title: clip(it.title, 300),
            summary: it.summary ? clip(it.summary, 1200) : null,
            link: it.link || null,
            severity: it.severity || 0,
            published_at: it.publishedAt || now,
            starts_at: it.startsAt || null,
            expires_at: it.expiresAt || null,
            updated_at: now,
          });
          seen.push(String(it.extId));
        }
        if (deactivateMissing) {
          const placeholders = seen.map(() => '?').join(',');
          const sql = seen.length
            ? `UPDATE items SET active = 0 WHERE town_id = ? AND source = ? AND active = 1 AND ext_id NOT IN (${placeholders})`
            : `UPDATE items SET active = 0 WHERE town_id = ? AND source = ? AND active = 1`;
          db.prepare(sql).run(townId, source, ...seen);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    setTile(townId, tile, data) {
      db.prepare(`INSERT INTO tiles (town_id, tile, data, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT (town_id, tile) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
        .run(townId, tile, JSON.stringify(data), Date.now());
    },

    getTiles(townId) {
      const out = {};
      for (const r of db.prepare('SELECT tile, data, updated_at FROM tiles WHERE town_id = ?').all(townId)) {
        out[r.tile] = { ...JSON.parse(r.data), updatedAt: r.updated_at };
      }
      return out;
    },

    /**
     * The live feed, most relevant first (see relevance.js): urgent alerts pinned, then
     * news by publish time mixed with events by how close they are. Ended events drop
     * off; the main feed only shows events in the next EVENT_DAYS days. The Events
     * filter lists upcoming events by start time instead.
     */
    feed(townId, { category = null, limit = 50, offset = 0, eventDays = EVENT_DAYS } = {}) {
      const now = Date.now();
      const where = ['town_id = :town', 'active = 1', '(expires_at IS NULL OR expires_at > :now)', EVENT_WINDOW_SQL];
      const all = category === 'events' || eventDays == null;
      const params = { town: townId, now, limit, offset: Math.max(0, Math.min(1000, Number(offset) || 0)),
        horizon: all ? 8.64e15 : now + eventDays * 86400e3 };
      if (category) { where.push('category = :category'); params.category = category; }
      let order = 'starts_at IS NULL, starts_at ASC, published_at DESC, id DESC';
      if (category !== 'events') {
        order = `(severity >= :pin) DESC, ${RANK_SQL} DESC, id DESC`;
        Object.assign(params, { w: EVENT_WEIGHT, pin: PIN_SEVERITY });
      }
      return db.prepare(`SELECT id, source, source_label, category, title, summary, link, severity,
                                published_at, starts_at, expires_at
                         FROM items WHERE ${where.join(' AND ')}
                         ORDER BY ${order} LIMIT :limit OFFSET :offset`).all(params).map(rowToItem);
    },

    alerts(townId) {
      return db.prepare(`SELECT id, source, source_label, category, title, summary, link, severity,
                                published_at, starts_at, expires_at
                         FROM items WHERE town_id = ? AND active = 1 AND severity >= 2
                           AND (expires_at IS NULL OR expires_at > ?)
                         ORDER BY severity DESC, published_at DESC LIMIT 5`)
        .all(townId, Date.now()).map(rowToItem);
    },

    upcomingEvents(townId, limit = 4, days = 7) {
      const now = Date.now();
      return db.prepare(`SELECT id, source, source_label, category, title, summary, link, severity,
                                published_at, starts_at, expires_at
                         FROM items WHERE town_id = ? AND active = 1 AND category = 'events'
                           AND starts_at IS NOT NULL AND starts_at >= ? AND starts_at < ?
                         ORDER BY starts_at ASC LIMIT ?`)
        .all(townId, now - 2 * 3600e3, now + days * 86400e3, limit).map(rowToItem);
    },

    recordRun(townId, source, error) {
      const now = Date.now();
      if (error) {
        db.prepare(`INSERT INTO source_status (town_id, source, last_run, last_error, error_count, failing_since)
                    VALUES (?, ?, ?, ?, 1, ?)
                    ON CONFLICT (town_id, source) DO UPDATE SET last_run = excluded.last_run,
                      last_error = excluded.last_error, error_count = error_count + 1,
                      failing_since = COALESCE(source_status.failing_since, excluded.failing_since)`)
          .run(townId, source, now, clip(String(error), 500), now);
      } else {
        const items = db.prepare('SELECT COUNT(*) AS n FROM items WHERE town_id = ? AND source LIKE ? AND active = 1').get(townId, `${source}%`).n;
        db.prepare(`INSERT INTO source_status (town_id, source, last_run, last_ok, last_error, error_count, failing_since, last_items)
                    VALUES (?, ?, ?, ?, NULL, 0, NULL, ?)
                    ON CONFLICT (town_id, source) DO UPDATE SET last_run = excluded.last_run,
                      last_ok = excluded.last_ok, last_error = NULL, error_count = 0, failing_since = NULL,
                      last_items = excluded.last_items`)
          .run(townId, source, now, now, items);
      }
    },

    sourceStatus(townId = null) {
      const cols = 'town_id, source, last_run, last_ok, last_error, error_count, failing_since, last_items';
      return townId
        ? db.prepare(`SELECT ${cols} FROM source_status WHERE town_id = ? ORDER BY source`).all(townId)
        : db.prepare(`SELECT ${cols} FROM source_status ORDER BY town_id, source`).all();
    },

    // ---------- push ----------
    addSubscription(townId, endpoint) {
      db.prepare(`INSERT INTO push_subs (endpoint, town_id, created_at) VALUES (?, ?, ?)
                  ON CONFLICT (endpoint) DO UPDATE SET town_id = excluded.town_id, fail_count = 0`)
        .run(endpoint, townId, Date.now());
    },
    removeSubscription(endpoint) {
      db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
    },
    countSubscriptions() {
      return db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n;
    },
    pushSubscriptions(townId) {
      return db.prepare('SELECT endpoint FROM push_subs WHERE town_id = ?').all(townId);
    },
    subscriptionOk(endpoint) {
      db.prepare('UPDATE push_subs SET last_ok = ?, fail_count = 0 WHERE endpoint = ?').run(Date.now(), endpoint);
    },
    subscriptionFailed(endpoint) {
      db.prepare('UPDATE push_subs SET fail_count = fail_count + 1 WHERE endpoint = ?').run(endpoint);
      db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND fail_count >= 10').run(endpoint);
    },
    unpushedAlerts(townId) {
      return db.prepare(`SELECT i.id, i.source_label, i.title, i.summary, i.link, i.severity, i.published_at
                         FROM items i LEFT JOIN pushed_alerts p ON p.town_id = i.town_id AND p.item_id = i.id
                         WHERE i.town_id = ? AND i.active = 1 AND i.severity >= 2 AND p.item_id IS NULL
                           AND (i.expires_at IS NULL OR i.expires_at > ?)
                         ORDER BY i.published_at ASC`).all(townId, Date.now())
        .map((r) => ({ id: r.id, sourceLabel: r.source_label, title: r.title, summary: r.summary, link: r.link, severity: r.severity, publishedAt: r.published_at }));
    },
    markPushed(townId, itemId) {
      db.prepare('INSERT OR IGNORE INTO pushed_alerts (town_id, item_id, at) VALUES (?, ?, ?)').run(townId, itemId, Date.now());
    },
    setLatestPush(townId, alert) {
      db.prepare(`INSERT INTO latest_push (town_id, data, at) VALUES (?, ?, ?)
                  ON CONFLICT (town_id) DO UPDATE SET data = excluded.data, at = excluded.at`)
        .run(townId, JSON.stringify(alert), Date.now());
    },
    latestPush(townId) {
      const r = db.prepare('SELECT data, at FROM latest_push WHERE town_id = ?').get(townId);
      return r ? { ...JSON.parse(r.data), pushedAt: r.at } : null;
    },

    prune(days = 30) {
      db.prepare('DELETE FROM items WHERE updated_at < ? AND (active = 0 OR published_at < ?)')
        .run(Date.now() - days * 86400e3, Date.now() - days * 86400e3);
    },

    /** How much is in the database, in total and per town (Admin settings > Site size). */
    sizeStats() {
      const perTown = new Map(db.prepare('SELECT id, name, status FROM towns ORDER BY name').all()
        .map((t) => [t.id, { id: t.id, name: t.name, status: t.status, sources: 0, sourcesOn: 0, resources: 0, items: 0, itemsActive: 0 }]));
      const add = (rows, fn) => { for (const r of rows) { const t = perTown.get(r.town_id); if (t) fn(t, r); } };
      add(db.prepare('SELECT town_id, COUNT(*) AS n, SUM(enabled) AS on_ FROM sources GROUP BY town_id').all(), (t, r) => { t.sources = r.n; t.sourcesOn = r.on_ || 0; });
      add(db.prepare('SELECT town_id, COUNT(*) AS n FROM resources GROUP BY town_id').all(), (t, r) => { t.resources = r.n; });
      add(db.prepare('SELECT town_id, COUNT(*) AS n, SUM(active) AS act FROM items GROUP BY town_id').all(), (t, r) => { t.items = r.n; t.itemsActive = r.act || 0; });
      const one = (sql) => db.prepare(sql).get().n;
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      const towns = [...perTown.values()];
      const sum = (k) => towns.reduce((s, t) => s + t[k], 0);
      return {
        towns,
        totals: {
          towns: towns.length, townsLive: towns.filter((t) => t.status === 'live').length,
          // Totals count every row, including any left behind by a town that no longer exists.
          sources: one('SELECT COUNT(*) AS n FROM sources'), sourcesOn: sum('sourcesOn'),
          resources: one('SELECT COUNT(*) AS n FROM resources'),
          items: one('SELECT COUNT(*) AS n FROM items'), itemsActive: sum('itemsActive'),
          pushSubscribers: one('SELECT COUNT(*) AS n FROM push_subs'),
        },
        // Space inside the file that is empty (deleted rows) and could be given back by VACUUM.
        freeBytes: db.prepare('PRAGMA freelist_count').get().freelist_count * pageSize,
      };
    },

    /** Consistent online copy of the database (safe while the app is running). */
    backupTo(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) fs.unlinkSync(file);
      db.prepare('VACUUM INTO ?').run(file);
    },

    close() { db.close(); },
  };
}

function rowToItem(r) {
  return {
    id: r.id,
    source: r.source,
    sourceLabel: r.source_label,
    category: r.category,
    title: r.title,
    summary: r.summary,
    link: r.link,
    severity: r.severity,
    publishedAt: r.published_at,
    startsAt: r.starts_at,
    expiresAt: r.expires_at,
  };
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
