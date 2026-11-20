// SQLite storage using Node's built-in driver (no native dependencies).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS towns (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL
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
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return wrap(db);
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

    saveTown(town) {
      db.prepare(`INSERT INTO towns (id, name, config) VALUES (?, ?, ?)
                  ON CONFLICT (id) DO UPDATE SET name = excluded.name, config = excluded.config`)
        .run(town.id, town.name, JSON.stringify(town));
    },

    /**
     * Replace the active set for one source: upsert what the source returned now and
     * deactivate anything it no longer lists (e.g. an expired alert or a cleared incident).
     */
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

    feed(townId, { category = null, limit = 50, before = null } = {}) {
      const now = Date.now();
      const where = ['town_id = :town', 'active = 1', '(expires_at IS NULL OR expires_at > :now)'];
      const params = { town: townId, now, limit };
      if (category) {
        // "lifts" tile also shows snow; "weather" includes NWS alerts.
        where.push('category = :category');
        params.category = category;
      }
      if (before) { where.push('published_at < :before'); params.before = before; }
      return db.prepare(`SELECT id, source, source_label, category, title, summary, link, severity,
                                published_at, starts_at, expires_at
                         FROM items WHERE ${where.join(' AND ')}
                         ORDER BY published_at DESC LIMIT :limit`).all(params).map(rowToItem);
    },

    alerts(townId) {
      return db.prepare(`SELECT id, source, source_label, category, title, summary, link, severity,
                                published_at, starts_at, expires_at
                         FROM items WHERE town_id = ? AND active = 1 AND severity >= 2
                           AND (expires_at IS NULL OR expires_at > ?)
                         ORDER BY severity DESC, published_at DESC LIMIT 5`)
        .all(townId, Date.now()).map(rowToItem);
    },

    upcomingEvents(townId, limit = 4) {
      const now = Date.now();
      return db.prepare(`SELECT id, source, source_label, category, title, summary, link, severity,
                                published_at, starts_at, expires_at
                         FROM items WHERE town_id = ? AND active = 1 AND category = 'events'
                           AND starts_at IS NOT NULL AND starts_at >= ? AND starts_at < ?
                         ORDER BY starts_at ASC LIMIT ?`)
        .all(townId, now - 2 * 3600e3, now + 7 * 86400e3, limit).map(rowToItem);
    },

    recordRun(townId, source, error) {
      const now = Date.now();
      if (error) {
        db.prepare(`INSERT INTO source_status (town_id, source, last_run, last_error, error_count)
                    VALUES (?, ?, ?, ?, 1)
                    ON CONFLICT (town_id, source) DO UPDATE SET last_run = excluded.last_run,
                      last_error = excluded.last_error, error_count = error_count + 1`)
          .run(townId, source, now, clip(String(error), 500));
      } else {
        db.prepare(`INSERT INTO source_status (town_id, source, last_run, last_ok, last_error, error_count)
                    VALUES (?, ?, ?, ?, NULL, 0)
                    ON CONFLICT (town_id, source) DO UPDATE SET last_run = excluded.last_run,
                      last_ok = excluded.last_ok, last_error = NULL, error_count = 0`)
          .run(townId, source, now, now);
      }
    },

    sourceStatus(townId) {
      return db.prepare('SELECT source, last_run, last_ok, last_error, error_count FROM source_status WHERE town_id = ? ORDER BY source')
        .all(townId);
    },

    prune(days = 30) {
      db.prepare('DELETE FROM items WHERE updated_at < ? AND (active = 0 OR published_at < ?)')
        .run(Date.now() - days * 86400e3, Date.now() - days * 86400e3);
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
