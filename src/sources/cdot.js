// CDOT COtrip API: incidents, winter road conditions and WZDx work zones for the
// Roads tile, the feed and the banner (closures).
//
// The API key lives only in the CDOT_API_KEY environment variable (env file on the
// server). CDOT may change or drop feeds at any time, so every parser here is
// defensive: unknown shapes produce no items rather than a crash, and the tile always
// says when it was last updated.
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson, redact } from '../http.js';

const LABEL = 'CDOT COtrip';
const BASE = process.env.CDOT_BASE || 'https://data.cotrip.org/api/v1';
const MAP_LINK = 'https://maps.cotrip.org/';

export const DEFAULT_DISCLAIMER =
  'Source Data: Colorado Department of Transportation (CDOT). Conditions change quickly; check COtrip before you travel.';

// ---------- generic helpers ----------

export function featuresOf(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.features)) return data.features;
  for (const k of ['data', 'items', 'results', 'incidents', 'roadConditions']) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

function propsOf(f) {
  return f && typeof f === 'object' ? (f.properties || f) : {};
}

/** Any coordinate of the geometry inside the box? Features without geometry pass. */
export function inBbox(f, b) {
  const g = f?.geometry;
  if (!g || !g.coordinates) return null; // unknown
  let hit = false;
  (function walk(c) {
    if (hit || !Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const [lon, lat] = c;
      if (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon) hit = true;
      return;
    }
    for (const x of c) walk(x);
  })(g.coordinates);
  return hit;
}

/** Collect every string in an object (shallow-ish), for matching and summaries. */
function strings(o, depth = 0, out = []) {
  if (o == null || depth > 4) return out;
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => strings(x, depth + 1, out));
  else if (typeof o === 'object') Object.entries(o).forEach(([k, v]) => { if (k !== 'geometry' && k !== 'coordinates') strings(v, depth + 1, out); });
  return out;
}

function routeNames(p) {
  const names = [p.routeName, p.route, p.roadName, p.name, p.primaryRoute, p.highway,
    ...(p.core_details?.road_names || []), ...(p.road_names || [])];
  return names.filter((x) => typeof x === 'string' && x.trim());
}

export function matchRoute(routes, p, f, town) {
  const names = routeNames(p).join(' ');
  for (const r of routes) {
    for (const m of r.match) {
      const re = new RegExp(`(^|[^0-9])${m}([^0-9]|$)`);
      if (re.test(names)) return r;
    }
  }
  // Fall back to geography + place names for records without a clean route field.
  const text = strings(p).join(' ');
  if (inBbox(f, town.bbox) && town.cdot.keyPlaces.some((k) => text.includes(k))) return routes[0];
  return null;
}

function firstString(p, keys) {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function time(p, keys) {
  for (const k of keys) {
    const v = p[k] ?? p.core_details?.[k];
    if (v == null) continue;
    const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function classify(text) {
  if (/\b(closed|closure|closes)\b/i.test(text) && !/\b(re-?opened|lane closed|shoulder closed|right lane|left lane)\b/i.test(text)) return 'closed';
  if (/chain law|traction law|code 15|code 16|icy|snow packed|snowpacked|slick|avalanche|rock ?fall|one lane|flagger|delays?/i.test(text)) return 'caution';
  return 'ok';
}

// ---------- incidents ----------

export function incidentsToItems(data, town) {
  const items = [];
  for (const f of featuresOf(data)) {
    const p = propsOf(f);
    const route = matchRoute(town.cdot.routes, p, f, town);
    if (!route) continue;
    if (inBbox(f, town.bbox) === false) continue; // far-away stretch of a matching route
    const msg = firstString(p, ['travelerInformationMessage', 'headline', 'description', 'message', 'details', 'title'])
      || strings(p).filter((s) => s.length > 20).sort((a, b) => b.length - a.length)[0] || '';
    const type = firstString(p, ['type', 'incidentType', 'eventType', 'category']) || 'Road incident';
    const level = classify(`${type} ${msg}`);
    items.push({
      extId: p.id || f.id || `${route.label}-${type}-${msg}`.slice(0, 120),
      sourceLabel: LABEL,
      category: 'roads',
      title: `${route.label}: ${shorten(msg || type, 140)}`,
      summary: msg && msg.length > 140 ? msg : null,
      link: MAP_LINK,
      severity: level === 'closed' ? 2 : level === 'caution' ? 1 : 0,
      publishedAt: time(p, ['lastUpdated', 'updateTime', 'updated', 'startTime', 'start_date', 'reportedTime']) || Date.now(),
      expiresAt: time(p, ['clearTime', 'endTime', 'end_date', 'estimatedClearTime']),
      _route: route.label,
      _level: level,
    });
  }
  return items;
}

// ---------- road conditions ----------

export function conditionsByRoute(data, town) {
  const out = {};
  for (const f of featuresOf(data)) {
    const p = propsOf(f);
    const route = matchRoute(town.cdot.routes, p, f, town);
    if (!route) continue;
    if (inBbox(f, town.bbox) === false) continue;
    const conds = [];
    for (const k of ['currentConditions', 'conditions', 'roadConditions']) {
      const v = p[k];
      if (Array.isArray(v)) v.forEach((c) => conds.push(typeof c === 'string' ? c : c?.conditionDescription || c?.description || c?.name));
      else if (typeof v === 'string') conds.push(v);
    }
    for (const k of ['roadCondition', 'surfaceCondition', 'primaryCondition', 'conditionDescription']) {
      if (typeof p[k] === 'string') conds.push(p[k]);
    }
    const text = conds.filter(Boolean).join(', ');
    if (!text) continue;
    const segment = firstString(p, ['segmentName', 'description', 'name', 'locationDescription']) || '';
    (out[route.label] ||= []).push({ segment, text, level: classify(text) });
  }
  return out;
}

// ---------- WZDx work zones ----------

export function workZonesToItems(data, town) {
  const items = [];
  for (const f of featuresOf(data)) {
    const p = propsOf(f);
    const route = matchRoute(town.cdot.routes, p, f, town);
    if (!route) continue;
    if (inBbox(f, town.bbox) !== true) continue; // WZDx always has geometry; require it to be local
    const core = p.core_details || p;
    const desc = core.description || p.description || 'Work zone';
    const start = time(p, ['start_date']);
    const end = time(p, ['end_date']);
    if (start && start > Date.now() + 3 * 86400e3) continue; // only current or imminent
    const impact = p.vehicle_impact || '';
    const closed = /all-lanes-closed/.test(impact);
    items.push({
      extId: core.id || f.id || p.id || desc.slice(0, 80),
      sourceLabel: LABEL,
      category: 'roads',
      title: `${route.label} work zone: ${shorten(desc, 120)}`,
      summary: desc.length > 120 ? desc : null,
      link: MAP_LINK,
      severity: closed ? 2 : 0,
      publishedAt: time(p, ['update_date']) || start || Date.now(),
      expiresAt: end,
      _route: route.label,
      _level: closed ? 'closed' : impact && impact !== 'all-lanes-open' ? 'caution' : 'ok',
    });
  }
  return items;
}

// ---------- tile ----------

export function buildRoadsTile(town, { incidents = [], workZones = [], conditions = {}, error = null, okAt = Date.now() }) {
  const rank = { ok: 0, caution: 1, closed: 2 };
  const routes = town.cdot.routes.map((r) => {
    const evts = [...incidents, ...workZones].filter((i) => i._route === r.label);
    const conds = conditions[r.label] || [];
    let level = 'ok';
    for (const x of [...evts.map((e) => e._level), ...conds.map((c) => c.level)]) {
      if (rank[x] > rank[level]) level = x;
    }
    const worstEvt = evts.sort((a, b) => rank[b._level] - rank[a._level])[0];
    const status = level === 'closed' ? 'Closed'
      : worstEvt && worstEvt._level === 'caution' ? shorten(worstEvt.title.replace(`${r.label}: `, ''), 60)
      : conds[0]?.text ? shorten(conds[0].text, 60)
      : 'No reported issues';
    // Never show a green "no issues" when we have no data at all.
    if (!okAt) return { label: r.label, note: r.note, level: 'unknown', status: 'No current data' };
    return { label: r.label, note: r.note, level, status };
  });
  return {
    ok: !!okAt,
    dataAt: okAt || null,
    error: error ? (okAt ? 'Latest update failed; showing the last good data.' : 'Road data is unavailable right now. Check COtrip.') : null,
    routes,
    link: MAP_LINK,
    sourceLabel: LABEL,
    disclaimer: town.cdot.disclaimer || DEFAULT_DISCLAIMER,
  };
}

function shorten(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function saveSample(name, data) {
  const dir = process.env.DATA_DIR;
  if (!dir) return;
  try {
    const file = path.join(dir, 'samples', `${name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const feats = featuresOf(data);
    const sample = feats.length ? { count: feats.length, first: feats.slice(0, 3) } : data;
    fs.writeFileSync(file, JSON.stringify(sample, null, 2).slice(0, 200000));
  } catch { /* samples are a debugging aid only */ }
}

export function cdotJobs(town, { get = fetchJson, apiKey = process.env.CDOT_API_KEY } = {}) {
  const state = { incidents: [], workZones: [], conditions: {}, error: null, okAt: null };
  const url = (ep) => `${BASE}/${ep}?apiKey=${encodeURIComponent(apiKey || '')}`;

  async function fetchFeed(ep) {
    if (!apiKey) throw new Error('CDOT_API_KEY is not set');
    const data = await get(url(ep));
    saveSample(`cdot-${ep}`, data);
    return data;
  }

  const refreshTile = (db) => db.setTile(town.id, 'roads', buildRoadsTile(town, state));

  const job = (id, ep, apply) => ({
    id,
    everyMin: 5,
    async run(db) {
      try {
        const data = await fetchFeed(ep);
        apply(db, data);
        state.error = null;
        state.okAt = Date.now();
      } catch (e) {
        state.error = e;
        throw new Error(redact(e.message));
      } finally {
        refreshTile(db);
      }
    },
  });

  return [
    job('cdot-incidents', 'incidents', (db, data) => {
      state.incidents = incidentsToItems(data, town);
      db.syncItems(town.id, 'cdot-incidents', state.incidents);
    }),
    job('cdot-conditions', 'roadConditions', (db, data) => {
      state.conditions = conditionsByRoute(data, town);
    }),
    job('cdot-wzdx', 'wzdx', (db, data) => {
      state.workZones = workZonesToItems(data, town);
      db.syncItems(town.id, 'cdot-wzdx', state.workZones);
    }),
  ];
}
