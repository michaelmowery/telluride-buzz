// NMDOT NMRoads: New Mexico's road events (closures, difficult driving conditions,
// alerts, lane closures and roadwork) for the Roads tile, the feed and the banner.
//
// NMRoads has no API key. Its public GeoJSON feed (the "GeoJSON Feed" link on
// nmroads.com) is a WZDx v4.2 feature collection that NMDOT publishes under CC0
// (public domain), refreshed every few minutes. One statewide file serves every
// New Mexico town; each town keeps only its own highways inside its map box.
import { fetchJson, sharedJson } from '../http.js';
import { featuresOf, inBbox, geoOf, buildRoadsTile } from './cdot.js';
import { routeLabel, routesNear } from '../cdot-routes.js';
import { routeShapes } from '../route-shapes.js';

export const NM_FEED = process.env.NMROADS_URL || 'https://nmroads.com/nmroads.json';
const LABEL = 'NMDOT NMRoads';
export const NM_ROADS_META = {
  sourceLabel: LABEL,
  shortName: 'NMDOT',
  link: 'https://nmroads.com/',
  linkText: 'Live map at NMRoads',
};

// Not a legal requirement (the feed is public domain), but NMDOT's own disclaimer
// asks people not to rely on NMRoads alone, so the site says so where it shows it.
export const NM_DISCLAIMER =
  'Road information comes from the New Mexico Department of Transportation (NMDOT) NMRoads feed. Incidents and road conditions can change quickly, NMRoads may not list every incident or condition, and it covers only NMDOT-maintained routes, so it should not be your only source.';

const shorten = (s, n) => {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const when = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : null;
};

/** closed / caution / ok for one NMRoads event. */
export function nmLevel(c) {
  const type = String(c.event_type || '');
  const name = String(c.name || '');
  const impact = String(c.vehicle_impact || '');
  if (/^(seasonal )?closure$/i.test(type) || /^(construction )?closure$/i.test(name) || /all-lanes-closed|road closed/i.test(impact)) return 'closed';
  if (/difficult|alert/i.test(type) || /lane closure|flagg|one lane/i.test(`${name} ${c.description || ''}`) || /lane.*closed/i.test(impact)) return 'caution';
  return 'ok';
}

/** The town's route a feature belongs to (by highway name, then by key place in its box), or null. */
function routeFor(routes, c, f, town) {
  const labels = (c.road_names || []).map((n) => routeLabel(n)?.label).filter(Boolean);
  for (const r of routes) if (labels.includes(r.label)) return r;
  if (!labels.length && routes.length && inBbox(f, town.bbox)) {
    const text = String(c.description || '');
    if ((town.cdot.keyPlaces || []).some((k) => k && text.includes(k))) return routes[0];
  }
  return null;
}

/** Feed items for the town's highways, from the statewide NMRoads GeoJSON. */
export function nmroadsToItems(data, town, now = Date.now()) {
  const items = [];
  for (const f of featuresOf(data)) {
    const p = f?.properties || {};
    const c = p.core_details || {};
    const route = routeFor(town.cdot.routes, c, f, town);
    if (!route) continue;
    if (inBbox(f, town.bbox) !== true) continue; // the far end of a long highway
    const start = when(p.start_date);
    if (start && start > now + 3 * 86400e3) continue; // only current or imminent
    const level = nmLevel(c);
    const desc = String(c.description || c.name || c.event_type || 'Road event');
    const end = when(p.end_date);
    items.push({
      extId: f.id || c.data_source_id || `${route.label}-${desc}`.slice(0, 120),
      sourceLabel: LABEL,
      category: 'roads',
      title: `${route.label}: ${shorten(desc, 140)}`,
      summary: desc.length > 140 ? desc : null,
      link: NM_ROADS_META.link,
      severity: level === 'closed' ? 2 : level === 'caution' ? 1 : 0,
      publishedAt: when(c.update_date) || start || now,
      // NMRoads uses 2099 for "until further notice"; leave those open-ended.
      expiresAt: end && end < now + 5 * 365 * 86400e3 ? end : null,
      _route: route.label,
      _level: level,
      _geo: geoOf(f, town.bbox),
      _at: when(c.update_date),
    });
  }
  return items;
}

export function nmroadsJobs(town, { get = fetchJson } = {}) {
  const state = { incidents: [], shapes: {}, error: null, okAt: null };
  const tileView = { ...town, cdot: { ...town.cdot, disclaimer: town.cdot.disclaimer || NM_DISCLAIMER }, roadsMeta: NM_ROADS_META };
  return [{
    id: 'nmroads-events',
    everyMin: 5,
    async run(db) {
      try {
        const data = await get(NM_FEED, { timeoutMs: 15000 });
        if (!Array.isArray(data?.features)) throw new Error('NMRoads sent no road events (feed format changed?)');
        state.incidents = nmroadsToItems(data, town);
        db.syncItems(town.id, 'nmroads-events', state.incidents);
        state.error = null;
        state.okAt = Date.now();
      } catch (e) {
        state.error = e;
        throw e;
      } finally {
        if (state.okAt) state.shapes = await routeShapes(town, db, { get });
        db.setTile(town.id, 'roads', buildRoadsTile(tileView, state));
      }
    },
  }];
}

// ---------- picking a town's highways ----------

async function nmFeatures(town, deps) {
  if (String(town.state || '').toUpperCase() !== 'NM') return { error: 'NMRoads is for New Mexico towns.' };
  const lat = Number(town.location?.lat); const lon = Number(town.location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: 'The town needs its map point first.' };
  const get = deps.json || sharedJson;
  try {
    return { feats: featuresOf(await get(NM_FEED, { timeoutMs: 15000 })), point: { lat, lon } };
  } catch (e) {
    return { error: `Couldn't reach NMRoads (${e.message}).` };
  }
}

// NMRoads labels a route by its full name ("US-64"), so match on that, not the bare number.
const asNm = (r) => ({ ...r, match: [r.label] });

/** Highways NMRoads currently has events on within radiusKm, closest first: { routes } or { error }. */
export async function nearbyNmRoutes(town, deps = {}, { radiusKm = 50, max = 12 } = {}) {
  const { feats, point, error } = await nmFeatures(town, deps);
  if (error) return { error };
  return { routes: routesNear(feats, point, { radiusKm, max, withKm: true }).map(asNm) };
}

/**
 * A ready-to-save NMRoads source for a New Mexico town, or { error }.
 * NMRoads lists only highways with something going on, so a quiet day can find
 * fewer routes than CDOT would; the admin can add more by hand (US 491, US 64…).
 */
export async function suggestNmroadsSource(town, deps = {}) {
  const { feats, point, error } = await nmFeatures(town, deps);
  if (error) return { error };
  let routes = routesNear(feats, point, { radiusKm: 25, max: 4 });
  if (!routes.length) routes = routesNear(feats, point, { radiusKm: 60, max: 3 });
  if (!routes.length) return { error: 'NMRoads lists no highway events near this map point right now. Add the NMRoads source on Feeds and type the highways in.' };
  routes = routes.map(asNm);
  return {
    source: { adapter: 'nmroads', label: 'New Mexico Dept. of Transportation (NMRoads)', about: `Roads: ${routes.map((r) => r.label).join(', ')}`,
      settings: { routes: JSON.stringify(routes), keyPlaces: town.name } },
  };
}
