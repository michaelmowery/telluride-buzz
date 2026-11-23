// Town lookup for the admin's Add a town form: name (and optional state) in,
// map point, state code, time zone and a Google Maps link out. Uses OpenStreetMap's
// free Nominatim search (no key; one request per click, well inside its usage policy).
import { fetchJson } from './http.js';

// Main time zone per US state. Where a state spans two zones, the larger part wins;
// the admin can change it on the form.
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver',
};

/** Time zone for a US state code and point; a few split states are settled by longitude. */
export function guessTimezone(state, lat, lon) {
  if (state === 'ID' && lat > 45.5) return 'America/Los_Angeles'; // north Idaho panhandle
  if (state === 'OR' && lon > -117.6 && lat < 44.5) return 'America/Boise'; // Malheur County
  if (state === 'TX' && lon < -104.9) return 'America/Denver'; // El Paso area
  if ((state === 'KS' || state === 'NE' || state === 'SD' || state === 'ND') && lon < -101.5) return 'America/Denver';
  if (state === 'TN' && lon > -85.4) return 'America/New_York'; // east Tennessee
  if (state === 'KY' && lon < -86.3) return 'America/Chicago'; // west Kentucky
  if (state === 'FL' && lon < -85.0) return 'America/Chicago'; // western panhandle
  return STATE_TZ[state] || '';
}

const PLACE_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'municipality', 'locality', 'suburb']);
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Turn Nominatim results into town suggestions, towns and cities first. */
export function townsFromNominatim(results) {
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    const a = r.address || {};
    const state = String(a['ISO3166-2-lvl4'] || '').replace(/^US-/, '');
    const name = a.city || a.town || a.village || a.hamlet || a.municipality || r.name || '';
    const lat = Math.round(Number(r.lat) * 1e4) / 1e4;
    const lon = Math.round(Number(r.lon) * 1e4) / 1e4;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (out.some((x) => x.name === name && x.state === state)) continue;
    out.push({
      name, state, lat, lon,
      id: slug(name),
      county: a.county || '',
      timezone: guessTimezone(state, lat, lon),
      place: PLACE_TYPES.has(r.addresstype || r.type),
      label: r.display_name || name,
      maps: `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
    });
  }
  return out.sort((x, y) => Number(y.place) - Number(x.place)).slice(0, 5);
}

export async function geocodeTown(name, state = '', { fetchJsonImpl = fetchJson } = {}) {
  const q = [String(name).trim(), String(state).trim()].filter(Boolean).join(', ');
  if (!q) return [];
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&countrycodes=us&q=${encodeURIComponent(q)}`;
  return townsFromNominatim(await fetchJsonImpl(url, { timeoutMs: 10000 }));
}
