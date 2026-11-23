// Pick a Colorado town's highways for its Roads tile from CDOT's own data: the
// road-condition segments and work zones near the town's map point. Used when a
// Colorado town is created, and by "Add CDOT roads" on the Feeds tab.
import { sharedJson } from './http.js';
import { featuresOf } from './sources/cdot.js';

const BASE = process.env.CDOT_BASE || 'https://data.cotrip.org/api/v1';

/** "I 25", "I-25", "Interstate 25" -> I-25; "US 287" -> US-287; "CO 14", "SH 14" -> CO-14; "NM-371" -> NM-371. */
export function routeLabel(name) {
  const s = String(name || '').toUpperCase().replace(/\s+/g, ' ').trim();
  let m = s.match(/^(?:I|INTERSTATE)[ -]?(\d{1,3})\b/);
  if (m) return { label: `I-${+m[1]}`, num: String(+m[1]), rank: 0 };
  m = s.match(/^(?:US|U\.S\.)[ -]?(\d{1,3})\b/);
  if (m) return { label: `US-${+m[1]}`, num: String(+m[1]), rank: 1 };
  m = s.match(/^(?:CO|SH|STATE HIGHWAY|CO-?SH)[ -]?(\d{1,3})\b/);
  if (m) return { label: `CO-${+m[1]}`, num: String(+m[1]), rank: 2 };
  m = s.match(/^NM[ -]?(\d{1,3})\b/); // New Mexico state roads (NMRoads)
  if (m) return { label: `NM-${+m[1]}`, num: String(+m[1]), rank: 2 };
  return null;
}

const nameOf = (f) => {
  const p = f?.properties || f || {};
  return [p.routeName, p.route, p.roadName, p.primaryRoute, p.highway, ...(p.core_details?.road_names || []), ...(p.road_names || [])]
    .find((x) => typeof x === 'string' && routeLabel(x));
};

/** Kilometres from a point to the nearest part of a GeoJSON geometry (lines measured between vertices). */
export function distanceKm(geometry, lat, lon) {
  if (!geometry?.coordinates) return Infinity;
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  const xy = ([x, y]) => [(x - lon) * kx, (y - lat) * ky];
  let best = Infinity;
  const seg = (a, b) => {
    const [ax, ay] = xy(a); const [bx, by] = xy(b);
    const dx = bx - ax; const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  };
  (function walk(c) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') { seg(c, c); return; }
    if (Array.isArray(c[0]) && typeof c[0][0] === 'number') { for (let i = 0; i < c.length; i++) seg(c[i], c[i + 1] || c[i]); return; }
    c.forEach(walk);
  })(geometry.coordinates);
  return best;
}

/**
 * The highways near a point, closest first (interstates before US before state
 * routes when equally close), as CDOT source routes: [{ match: ['25'], label: 'I-25' }].
 */
export function routesNear(features, { lat, lon }, { radiusKm = 15, max = 4, withKm = false } = {}) {
  const near = new Map(); // label -> { route, km }
  for (const f of features) {
    const r = routeLabel(nameOf(f));
    if (!r) continue;
    const km = distanceKm(f.geometry, lat, lon);
    if (km > radiusKm) continue;
    const had = near.get(r.label);
    if (!had || km < had.km) near.set(r.label, { r, km });
  }
  return [...near.values()]
    .sort((a, b) => Math.round(a.km) - Math.round(b.km) || a.r.rank - b.r.rank || a.km - b.km)
    .slice(0, max)
    .map(({ r, km }) => ({ match: [r.num], label: r.label, ...(withKm ? { km: Math.round(km * 10) / 10 } : {}) }));
}

// Everything CDOT lists statewide (conditions, work zones, incidents), or { error }.
async function cdotFeatures(town, deps) {
  if (String(town.state || '').toUpperCase() !== 'CO') return { error: 'CDOT roads are for Colorado towns.' };
  const apiKey = deps.cdotKey !== undefined ? deps.cdotKey : process.env.CDOT_API_KEY;
  if (!apiKey) return { error: 'The server has no CDOT API key.' };
  const get = deps.json || sharedJson;
  const lat = Number(town.location?.lat); const lon = Number(town.location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: 'The town needs its map point first.' };
  const feats = [];
  const errs = [];
  for (const ep of ['roadConditions', 'wzdx', 'incidents']) {
    try { feats.push(...featuresOf(await get(`${BASE}/${ep}?apiKey=${encodeURIComponent(apiKey)}`, { timeoutMs: 12000 }))); } catch (e) { errs.push(`${ep}: ${e.message}`); }
  }
  if (!feats.length && errs.length) return { error: `Couldn't reach CDOT (${errs[0]}).` };
  return { feats, point: { lat, lon } };
}

/**
 * Highways CDOT lists within radiusKm of the town, closest first, with distance:
 * { routes: [{ label: 'US-550', match: ['550'], km: 0.4 }] } or { error }.
 * The admin's route editor offers these to add.
 */
export async function nearbyCdotRoutes(town, deps = {}, { radiusKm = 50, max = 12 } = {}) {
  const { feats, point, error } = await cdotFeatures(town, deps);
  if (error) return { error };
  return { routes: routesNear(feats, point, { radiusKm, max, withKm: true }) };
}

/**
 * A ready-to-save CDOT source for a Colorado town, or { error } saying why not.
 * deps.json fetches (tests pass a fake); deps.cdotKey overrides CDOT_API_KEY.
 */
export async function suggestCdotSource(town, deps = {}) {
  const { feats, point, error } = await cdotFeatures(town, deps);
  if (error) return { error };
  const { lat, lon } = point;
  let routes = routesNear(feats, { lat, lon });
  if (!routes.length) routes = routesNear(feats, { lat, lon }, { radiusKm: 35, max: 3 });
  if (!routes.length) return { error: 'CDOT lists no state highways near this map point.' };
  return {
    source: { adapter: 'cdot', label: 'Colorado Dept. of Transportation (COtrip)', about: `Roads: ${routes.map((r) => r.label).join(', ')}`,
      settings: { routes: JSON.stringify(routes), keyPlaces: town.name } },
  };
}
