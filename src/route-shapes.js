// Route shapes for the Roads map: the line of each highway a town follows, so the
// map draws every route (green when clear), not only the stretches a DOT reports on.
//
// CDOT and NMRoads only send geometry for segments with conditions or events, so the
// shapes come from OpenStreetMap through the public Overpass API. Highways barely
// move, so each shape is fetched once and kept in the database for 30 days; a
// failed fetch waits an hour before trying again and never fails the road source.
import { fetchJson } from './http.js';
import { routeLabel } from './cdot-routes.js';

export const OVERPASS_URLS = (process.env.OVERPASS_URLS || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter')
  .split(',').map((s) => s.trim()).filter(Boolean);
const KEEP_MS = 30 * 86400e3;
const RETRY_MS = 3600e3;

/** Overpass "ref" regex for a route label: CO-62 -> CO 62 / SH 62 / CO-62; I-70 -> I 70. */
export function refPattern(label) {
  const r = routeLabel(label);
  if (!r) return null;
  const prefix = r.label.split('-')[0];
  const alts = { I: 'I', US: 'US', CO: '(CO|SH|SR)', NM: 'NM' }[prefix] || prefix;
  return `(^|;) *${alts}[ -]?${r.num} *($|;)`;
}

/** Overpass query for one route's ways inside the town's box. */
export function shapeQuery(label, b) {
  const re = refPattern(label);
  if (!re) return null;
  return `[out:json][timeout:25];way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]["ref"~"${re}"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});out geom;`;
}

const key = ([lat, lon]) => `${lat},${lon}`;
const r5 = (n) => Math.round(n * 1e5) / 1e5;

/** Drop points closer than tolKm to the line between their neighbours (Douglas-Peucker). */
export function simplify(path, tolKm = 0.04) {
  if (path.length < 3) return path;
  const kx = 111.32 * Math.cos((path[0][0] * Math.PI) / 180); const ky = 110.57;
  const keep = new Uint8Array(path.length); keep[0] = 1; keep[path.length - 1] = 1;
  const stack = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ay, ax] = [path[a][0] * ky, path[a][1] * kx]; const [by, bx] = [path[b][0] * ky, path[b][1] * kx];
    const dx = bx - ax; const dy = by - ay; const len = Math.hypot(dx, dy);
    let far = -1; let farD = tolKm;
    for (let i = a + 1; i < b; i++) {
      const px = path[i][1] * kx; const py = path[i][0] * ky;
      const d = len ? Math.abs(dy * (px - ax) - dx * (py - ay)) / len : Math.hypot(px - ax, py - ay);
      if (d > farD) { farD = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return path.filter((_, i) => keep[i]);
}

/**
 * Overpass ways -> a few long paths of [lat, lon]: clipped to the town's box,
 * joined end to end, simplified.
 */
export function waysToPaths(data, b) {
  const inside = ([lat, lon]) => !b || (lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon);
  let lines = [];
  for (const el of data?.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const pts = el.geometry.filter((g) => Number.isFinite(g?.lat) && Number.isFinite(g?.lon)).map((g) => [r5(g.lat), r5(g.lon)]);
    // Split at the box edge so the map only shows the stretch near town.
    let cur = [];
    for (const p of pts) {
      if (inside(p)) cur.push(p);
      else { if (cur.length > 1) lines.push(cur); cur = []; }
    }
    if (cur.length > 1) lines.push(cur);
  }
  // Join lines that share an end point.
  let joined = true;
  while (joined && lines.length > 1) {
    joined = false;
    const ends = new Map();
    lines.forEach((l, i) => { for (const e of [l[0], l[l.length - 1]]) { const k = key(e); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
    for (let i = 0; i < lines.length && !joined; i++) {
      const l = lines[i];
      for (const [end, atStart] of [[l[l.length - 1], false], [l[0], true]]) {
        const j = (ends.get(key(end)) || []).find((x) => x !== i);
        if (j === undefined) continue;
        let m = lines[j];
        if (atStart) {
          if (key(m[m.length - 1]) !== key(end)) m = [...m].reverse();
          lines[i] = [...m, ...l.slice(1)];
        } else {
          if (key(m[0]) !== key(end)) m = [...m].reverse();
          lines[i] = [...l, ...m.slice(1)];
        }
        lines.splice(j, 1);
        joined = true;
        break;
      }
    }
  }
  lines = lines.map((l) => simplify(l)).sort((a, b2) => b2.length - a.length);
  return lines.slice(0, 30);
}

async function fetchShape(label, b, get) {
  const q = shapeQuery(label, b);
  if (!q) return null;
  let lastErr = null;
  for (const base of OVERPASS_URLS) {
    try {
      const data = await get(`${base}?data=${encodeURIComponent(q)}`, { timeoutMs: 25000 });
      if (!Array.isArray(data?.elements)) throw new Error('Overpass sent no elements');
      return waysToPaths(data, b);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No Overpass server');
}

const metaKey = (b, label) => `route-shape:${label}:${[b.minLat, b.minLon, b.maxLat, b.maxLon].join(',')}`;

/**
 * Shapes for the town's routes, { 'CO-62': [[ [lat, lon], ... ], ...] }, from the
 * database when fresh, else from Overpass (one route per call, at most `maxFetch`
 * fetches per run so a new town doesn't hammer the public server).
 * Never throws: a route without a shape is simply drawn from its reports only.
 */
export async function routeShapes(town, db, { get = fetchJson, now = Date.now(), maxFetch = 2 } = {}) {
  const out = {};
  const b = town.bbox;
  if (!b || !db?.getMeta || db.getMeta('skip-route-shapes')) return out;
  let fetched = 0;
  for (const r of town.cdot?.routes || []) {
    const k = metaKey(b, r.label);
    let saved = null;
    try { saved = JSON.parse(db.getMeta(k) || 'null'); } catch { /* bad cache: refetch */ }
    const fresh = saved && ((saved.paths && now - saved.at < KEEP_MS) || (!saved.paths && now - saved.at < RETRY_MS));
    if (!fresh && fetched < maxFetch && shapeQuery(r.label, b)) {
      fetched++;
      try {
        const paths = await fetchShape(r.label, b, get);
        saved = { at: now, paths: paths || [] };
      } catch (e) {
        // Keep an old shape if there is one; otherwise wait an hour before the next try.
        saved = saved?.paths ? { ...saved, at: now - KEEP_MS + RETRY_MS } : { at: now, paths: null, error: String(e.message).slice(0, 200) };
      }
      db.setMeta(k, JSON.stringify(saved));
    }
    if (saved?.paths?.length) out[r.label] = saved.paths;
  }
  return out;
}
