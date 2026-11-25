// Compare towns: the numbers behind the compare icon on the Weather and
// Lifts & Snow tiles (GET /api/compare).
//
// Every live town is listed with its distance from the town asking, so the page
// can pick which towns to show (the visitor's "Compare with" choice in
// Preferences, saved on their device). Only what the two compare tables need is
// sent: current weather, the next few days, the first snow in the forecast, and
// each ski area's snow and terrain numbers.
import { townUrl } from './brand.js';
import { stateName } from './geocode.js';

/** Straight-line distance in miles between two { lat, lon } points, or null. */
export function distanceMi(a, b) {
  if (!a || !b || !Number.isFinite(+a.lat) || !Number.isFinite(+a.lon) || !Number.isFinite(+b.lat) || !Number.isFinite(+b.lon)) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Towns within this many miles start switched on for a new visitor. */
export const NEARBY_MI = 150;

const num = (v) => (Number.isFinite(v) ? v : null);

function weatherOf(w) {
  if (!w?.ok) return null;
  const periods = Array.isArray(w.periods) ? w.periods : [];
  // Daytime highs for the next three days after today.
  const days = periods.filter((p) => p.isDaytime && p !== periods[0]).slice(0, 3).map((p) => ({ start: p.start ?? null, name: p.name, temp: num(p.temp) }));
  const snowAt = periods.slice(0, 8).find((p) => /snow|flurr|blizzard/i.test(p.short || ''));
  return {
    temp: num(w.temp), short: w.short || '', hi: num(w.hi), lo: num(w.lo),
    days, snow: snowAt ? { name: snowAt.name, start: snowAt.start ?? null } : null,
    sourceAt: w.sourceAt || null,
  };
}

function resortsOf(l) {
  if (!l) return [];
  const list = l.resorts?.length ? l.resorts : [l];
  return list.filter((r) => r?.ok).map((r) => ({
    name: r.name || r.sourceLabel || 'Ski area',
    new24: num(r.new24), new48: num(r.new48), new7d: num(r.new7d), base: num(r.base), season: num(r.season),
    liftsOpen: num(r.liftsOpen), liftsTotal: num(r.liftsTotal), trailsOpen: num(r.trailsOpen), trailsTotal: num(r.trailsTotal),
    condition: r.condition || null, sourceAt: r.sourceAt || null,
  }));
}

/**
 * Compare data as seen from `here`. `tilesFor(town)` returns that town's tiles.
 * Towns come back nearest first, `here` first of all.
 */
export function compareData(here, towns, tilesFor) {
  const list = towns.map((t) => {
    const tiles = tilesFor(t) || {};
    const d = t.id === here.id ? 0 : distanceMi(here.location, t.location);
    return {
      id: t.id, name: t.name, state: t.state || '', stateName: stateName(t.state) || t.state || '', url: townUrl(t),
      distanceMi: d == null ? null : Math.round(d),
      nearby: t.id === here.id || (d != null && d <= NEARBY_MI),
      weather: weatherOf(tiles.weather),
      resorts: resortsOf(tiles.lifts),
    };
  });
  list.sort((a, b) => (a.id === here.id ? -1 : b.id === here.id ? 1 : (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9) || a.name.localeCompare(b.name)));
  return { here: here.id, nearbyMi: NEARBY_MI, towns: list };
}
