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
import { routeShapes } from '../route-shapes.js';

const LABEL = 'CDOT COtrip';
const BASE = process.env.CDOT_BASE || 'https://data.cotrip.org/api/v1';
const MAP_LINK = 'https://maps.cotrip.org/';

// CDOT's required Source Data disclaimer, verbatim from the COtrip API terms of service.
export const DEFAULT_DISCLAIMER =
  "The data made available here has been modified for use from its original source, which is the State of Colorado, Department of Transportation (CDOT). THE STATE OF COLORADO AND CDOT MAKES NO REPRESENTATIONS OR WARRANTY AS TO THE COMPLETENESS, ACCURACY, TIMELINESS, OR CONTENT OF ANY DATA MADE AVAILABLE THROUGH THIS SITE. THE STATE OF COLORADO AND CDOT EXPRESSLY DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE. The data is subject to change as modifications and updates are complete. It is understood that the information contained in the Web feed is being used at one's own risk.";

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

/**
 * Compact map geometry: a list of paths, each a list of [lat, lon] (a point is a
 * path of one). Only coordinates inside the town's box, rounded, at most ~60 per path.
 */
export function geoOf(f, b) {
  const g = f?.geometry;
  if (!g || !g.coordinates) return null;
  const pt = (c) => (typeof c?.[0] === 'number' && typeof c?.[1] === 'number' ? c : null);
  const inside = ([lon, lat]) => !b || (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon);
  const r = (n) => Math.round(n * 1e5) / 1e5;
  const paths = [];
  (function walk(c) {
    if (!Array.isArray(c)) return;
    if (pt(c)) { paths.push([c]); return; }
    if (c.length && pt(c[0])) { paths.push(c); return; }
    for (const x of c) walk(x);
  })(g.coordinates);
  const out = [];
  for (const path of paths.slice(0, 20)) {
    const keep = path.filter((c) => pt(c) && inside(c));
    if (!keep.length) continue;
    const step = Math.ceil(keep.length / 60);
    const thin = keep.filter((_, i) => i % step === 0 || i === keep.length - 1);
    out.push(thin.map(([lon, lat]) => [r(lat), r(lon)]));
  }
  return out.length ? out : null;
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
      _geo: geoOf(f, town.bbox),
      _at: time(p, ['lastUpdated', 'updateTime', 'updated', 'update_date', 'reportedTime', 'timestamp']),
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
    const text = [...new Set(conds.filter(Boolean).map(cleanCondition).filter(Boolean))].join(', ');
    if (!text) continue;
    const segment = firstString(p, ['segmentName', 'description', 'name', 'locationDescription']) || '';
    (out[route.label] ||= []).push({ segment, text, level: classify(text), geo: geoOf(f, town.bbox), at: time(p, ['lastUpdated', 'updateTime', 'updated', 'update_date', 'reportedTime', 'timestamp']) });
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
      _geo: geoOf(f, town.bbox),
      _at: time(p, ['lastUpdated', 'updateTime', 'updated', 'update_date', 'reportedTime', 'timestamp']),
    });
  }
  // WZDx often lists one work zone as several features (one per direction or road
  // segment) with the same description. Show it once, keeping the most severe.
  const byText = new Map();
  for (const it of items) {
    const k = `${it.title}\n${it.summary || ''}\n${it.expiresAt || ''}`;
    const prev = byText.get(k);
    if (!prev || it.severity > prev.severity) byText.set(k, it);
  }
  return [...byText.values()];
}

// ---------- tile ----------

export const CDOT_ROADS_META = { sourceLabel: LABEL, shortName: 'CDOT', link: MAP_LINK, linkText: 'Live map at COtrip' };

/** The Roads tile. town.roadsMeta names another state's DOT (default CDOT). */
export function buildRoadsTile(town, { incidents = [], workZones = [], conditions = {}, shapes = {}, error = null, okAt = Date.now() }) {
  const meta = { ...CDOT_ROADS_META, ...(town.roadsMeta || {}) };
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
    if (!okAt) return { label: r.label, note: r.note, level: 'unknown', status: 'No current data', events: [], conditions: [] };
    return {
      label: r.label, note: r.note, level, status,
      // The whole highway near town (OpenStreetMap), drawn under the reported stretches.
      shape: shapes[r.label] || null,
      events: evts.slice(0, 12).map((e) => ({ title: e.title.replace(`${r.label}: `, ''), summary: e.summary || null, level: e._level, geo: e._geo || null })),
      segments: conds.filter((c) => c.geo).slice(0, 20).map((c) => ({ text: c.segment ? `${c.segment}: ${c.text}` : c.text, level: c.level, geo: c.geo })),
      conditions: [...new Set(conds.map((c) => (c.segment ? `${c.segment}: ${c.text}` : c.text)).filter(Boolean))].slice(0, 8),
    };
  });
  // Newest time CDOT itself stamped on anything we show (never in the future).
  const stamps = [...incidents, ...workZones].map((i) => i._at)
    .concat(Object.values(conditions).flat().map((c) => c.at))
    .filter((t) => Number.isFinite(t) && t <= Date.now() + 600e3);
  return {
    ok: !!okAt,
    dataAt: okAt || null,
    sourceAt: stamps.length ? Math.max(...stamps) : null,
    error: error ? (okAt ? 'Latest update failed; showing the last good data.' : `Road data is unavailable right now. Check ${meta.linkText.replace(/^Live map at /, '')}.`) : null,
    routes,
    link: meta.link,
    linkText: meta.linkText,
    shortName: meta.shortName,
    center: town.location ? [town.location.lat, town.location.lon] : null,
    sourceLabel: meta.sourceLabel,
    disclaimer: town.cdot.disclaimer || DEFAULT_DISCLAIMER,
  };
}

/** "4s - wet in areas, forecast text included" -> "Wet in areas" */
export function cleanCondition(c) {
  const t = String(c)
    .replace(/^\s*\d+[a-z]?\s*-\s*/i, '')
    .replace(/,?\s*forecast text included\.?/ig, '')
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
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
  const state = { incidents: [], workZones: [], conditions: {}, shapes: {}, error: null, okAt: null };
  const url = (ep) => `${BASE}/${ep}?apiKey=${encodeURIComponent(apiKey || '')}`;

  async function fetchFeed(ep) {
    if (!apiKey) throw new Error('CDOT_API_KEY is not set');
    const data = await get(url(ep));
    saveSample(`cdot-${ep}`, data);
    return data;
  }

  const refreshTile = async (db) => {
    if (state.okAt) state.shapes = await routeShapes(town, db, { get, maxFetch: 1 });
    db.setTile(town.id, 'roads', buildRoadsTile(town, state));
  };

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
        await refreshTile(db);
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
