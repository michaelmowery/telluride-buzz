// Towns as data. The database holds every town and its sources; the JSON files in
// config/ are only an import/export format (first start imports them once, and the
// admin can export a town back to JSON for safekeeping).
import { ADAPTERS, newKey, validateSource } from './adapters.js';
import { LOGO_STYLES, TOWN_THEMES } from './brand.js';
import { normalizeNotice } from './notice.js';

const SOURCE_BLOCKS = ['nws', 'cdot', 'lifts', 'resortAlerts', 'meander', 'feeds'];

/** Split a config/<town>.json object into a town row and its source rows. */
export function importConfig(cfg) {
  const town = Object.fromEntries(Object.entries(cfg).filter(([k]) => !SOURCE_BLOCKS.includes(k) && k !== 'sources'));
  const sources = [];
  const add = (s) => sources.push({ enabled: true, ...s, sort: sources.length * 10 });
  const defPoint = cfg.location ? `${(+cfg.location.lat).toFixed(4)},${(+cfg.location.lon).toFixed(4)}` : '';
  const pt = (p) => (p && p !== defPoint ? { point: p } : {});

  if (Array.isArray(cfg.sources)) {
    // Already in the new format (an exported town).
    cfg.sources.forEach((s) => add({ ...s, settings: s.settings || {} }));
    return { town, sources };
  }
  if (cfg.nws) {
    add({ key: 'nws-alerts', adapter: 'nws-alerts', label: 'National Weather Service', settings: pt(cfg.nws.alertPoint || cfg.nws.point) });
    add({ key: 'nws-forecast', adapter: 'nws-forecast', label: 'National Weather Service', settings: pt(cfg.nws.point) });
  }
  if (cfg.cdot) {
    const { routes, keyPlaces, disclaimer } = cfg.cdot;
    add({ key: 'cdot', adapter: 'cdot', label: 'Colorado Dept. of Transportation (COtrip)', settings: { routes, keyPlaces: keyPlaces || [], ...(disclaimer ? { disclaimer } : {}) } });
  }
  [].concat(cfg.lifts || []).filter((r) => r?.url).forEach((r, i) => {
    const { label, id, ...rest } = r;
    add({ key: i === 0 ? 'lifts-snow' : `lifts-snow-${id || `resort-${i + 1}`}`, adapter: 'snow-report', label: label || r.name, settings: { ...rest, name: r.name || label } });
  });
  if (cfg.resortAlerts?.url) {
    const { label, everyMin, ...rest } = cfg.resortAlerts;
    add({ key: 'resort-alerts', adapter: 'resort-alerts', label, everyMin, settings: rest });
  }
  if (cfg.meander?.tags?.length) {
    const { label, everyMin, enabled, ...rest } = cfg.meander;
    add({ key: 'meander', adapter: 'meander', label: label || 'Meander.me', everyMin, enabled: enabled !== false, settings: rest });
  }
  for (const f of cfg.feeds || []) {
    const { id, label, everyMin, enabled, ...rest } = f;
    add({ key: `feed-${id}`, adapter: 'rss', label, everyMin, enabled: enabled !== false, settings: rest });
  }
  return { town, sources };
}

/** A town and its sources as one JSON object (the format importConfig reads back). */
export function exportTown(town, sources) {
  const { sources: _s, createdAt, updatedAt, ...t } = town;
  return {
    ...t,
    sources: sources.map(({ key, adapter, label, about, settings, everyMin, enabled }) =>
      ({ key, adapter, label, ...(about ? { about } : {}), ...(everyMin ? { everyMin } : {}), ...(enabled === false ? { enabled: false } : {}), settings })),
  };
}

/** Load every town with its sources attached (sources sorted). */
export function loadTowns(db) {
  const sources = db.listSources();
  return db.listTowns().map((t) => ({ ...t, sources: sources.filter((s) => s.townId === t.id) }));
}

/**
 * Import config files whose town hasn't been imported before. After the first
 * import the database wins: editing the JSON later does nothing unless `force`.
 */
export function importConfigs(db, configs, { force = false, log = null } = {}) {
  const done = [];
  for (const cfg of configs) {
    if (!cfg?.id) continue;
    if (!force && db.getMeta(`imported:${cfg.id}`)) continue;
    const { town, sources } = importConfig(cfg);
    const existing = db.listTowns().find((t) => t.id === town.id);
    db.saveTown(town, existing?.status || town.status || 'live');
    for (const s of db.listSources(town.id)) if (!sources.some((x) => x.key === s.key)) db.deleteSource(town.id, s.key, []);
    for (const s of sources) db.saveSource(town.id, s);
    db.setMeta(`imported:${cfg.id}`, Date.now());
    done.push(town.id);
    log?.info?.(`imported town ${town.id} (${sources.length} sources) from config`);
  }
  return done;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const RESERVED_IDS = new Set(['www', 'admin', 'api', 'app', 'mail', 'hub', 'thetown', 'static', 'assets']);

function validZone(z) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}

/**
 * Fill defaults for a new or edited town and check it. Returns { town, error }.
 * `others` is every other town (hostnames must be unique).
 */
export function normalizeTown(input, others = []) {
  const t = structuredClone(input || {});
  t.id = String(t.id || '').trim().toLowerCase();
  t.name = String(t.name || '').trim();
  t.state = String(t.state || '').trim().toUpperCase() || undefined;
  if (!ID_RE.test(t.id)) return { error: 'Address name: 2 to 40 lowercase letters, numbers or dashes, starting with a letter.' };
  if (RESERVED_IDS.has(t.id)) return { error: `"${t.id}" is reserved. Pick another address name.` };
  if (!t.name) return { error: 'Town name is required.' };
  t.timezone = String(t.timezone || 'America/Denver').trim();
  if (!validZone(t.timezone)) return { error: `"${t.timezone}" is not a time zone (e.g. America/Denver).` };
  const lat = Number(t.location?.lat), lon = Number(t.location?.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (lat === 0 && lon === 0)) return { error: 'Map point needs a latitude and longitude (e.g. 38.0228, -107.6714).' };
  t.location = { lat, lon };
  if (!t.bbox || ['minLat', 'maxLat', 'minLon', 'maxLon'].some((k) => !Number.isFinite(Number(t.bbox[k])))) {
    // About 25 miles each way: wide enough for nearby passes, narrow enough to skip the next valley.
    t.bbox = { minLat: +(lat - 0.35).toFixed(3), maxLat: +(lat + 0.35).toFixed(3), minLon: +(lon - 0.45).toFixed(3), maxLon: +(lon + 0.45).toFixed(3) };
  } else {
    t.bbox = Object.fromEntries(['minLat', 'maxLat', 'minLon', 'maxLon'].map((k) => [k, Number(t.bbox[k])]));
  }
  const hosts = [].concat(t.hostnames || []).flatMap((h) => String(h).split(/[\s,]+/)).map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  t.hostnames = [...new Set(hosts.length ? hosts : [`${t.id}.thetown.buzz`, `${t.id}.localhost`])];
  for (const h of t.hostnames) {
    if (!HOST_RE.test(h)) return { error: `"${h}" is not a valid web address.` };
    const clash = others.find((o) => o.id !== t.id && (o.hostnames || []).includes(h));
    if (clash) return { error: `${h} already belongs to ${clash.name}.` };
  }
  t.url = String(t.url || `https://${t.hostnames[0]}`).trim().replace(/\/$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(t.url)) return { error: 'Public address must look like https://ouray.thetown.buzz' };
  t.brand = { ...(t.brand || {}) };
  t.brand.siteName = String(t.brand.siteName || `${t.name} Buzz`).trim();
  t.brand.logo = LOGO_STYLES[t.brand.logo] ? t.brand.logo : 'thetown';
  if (!TOWN_THEMES[t.brand.theme] || t.brand.theme === 'lake') delete t.brand.theme; // lake is the default
  if (t.brand.feedbackEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.brand.feedbackEmail)) return { error: 'Feedback email is not an email address.' };
  if (!t.brand.feedbackEmail) delete t.brand.feedbackEmail;
  if (!t.brand.notAffiliated) delete t.brand.notAffiliated;
  if (t.brand.notice !== undefined) {
    const { notice, error } = normalizeNotice(t.brand.notice);
    if (error) return { error: `Site message: ${error}` };
    if (notice) t.brand.notice = notice; else delete t.brand.notice;
  }
  if (t.brand.preview === false || t.brand.preview === 'false') t.brand.preview = false; else delete t.brand.preview;
  if (!Array.isArray(t.brand.aboutSources) || !t.brand.aboutSources.length) delete t.brand.aboutSources;
  t.status = t.status === 'live' ? 'live' : 'draft';
  if (t.default !== true) delete t.default;
  if (!t.state) delete t.state;
  delete t.sources; delete t.createdAt; delete t.updatedAt;
  return { town: t };
}

/** Sources every new town starts with: they only need the map point. */
export function starterSources(town) {
  return [
    { key: 'nws-alerts', adapter: 'nws-alerts', label: 'National Weather Service', settings: {}, sort: 0 },
    { key: 'nws-forecast', adapter: 'nws-forecast', label: 'National Weather Service', settings: {}, sort: 10 },
  ].filter((s) => !validateSource(s, town, []));
}

/** Normalize a source from the admin form: key, settings types, interval. */
export function normalizeSource(input, town, existing) {
  const a = ADAPTERS[input?.adapter];
  if (!a) return { error: `Unknown source type "${input?.adapter}".` };
  const s = {
    key: String(input.key || '').trim(),
    adapter: input.adapter,
    label: String(input.label || '').trim(),
    about: String(input.about || '').trim() || null,
    everyMin: input.everyMin === '' || input.everyMin == null ? null : Number(input.everyMin),
    enabled: input.enabled !== false,
    sort: Number.isFinite(Number(input.sort)) ? Number(input.sort) : (Math.max(-10, ...existing.map((x) => x.sort || 0)) + 10),
    settings: {},
  };
  for (const f of a.fields) {
    let v = input.settings?.[f.key];
    if (v == null || v === '') continue;
    if (f.type === 'checkbox') v = v === true || v === 'true' || v === 'on';
    else if (f.type === 'number') v = Number(v);
    else if (f.type === 'list') v = [].concat(v).flatMap((x) => String(x).split('\n')).map((x) => x.trim()).filter(Boolean);
    else if (f.type === 'urls') { const l = [].concat(v).flatMap((x) => String(x).split('\n')).map((x) => x.trim()).filter(Boolean); v = l.length > 1 ? l : l[0]; }
    else if (f.type === 'json' && typeof v === 'string') {
      try { v = JSON.parse(v); } catch { return { error: `${f.label} is not valid JSON.` }; }
    } else if (typeof v === 'string') v = v.trim();
    if (v === false || v == null || (Array.isArray(v) && !v.length)) continue;
    s.settings[f.key] = v;
  }
  // Settings this form doesn't know (e.g. a CDOT disclaimer) are kept.
  const prev = existing.find((x) => x.key === s.key);
  if (prev && prev.adapter === s.adapter) {
    for (const [k, v] of Object.entries(prev.settings || {})) if (!a.fields.some((f) => f.key === k) && !(k in s.settings)) s.settings[k] = v;
  }
  if (!s.key) s.key = newKey(s, town, existing);
  const error = validateSource(s, town, existing);
  return error ? { error } : { source: s };
}
