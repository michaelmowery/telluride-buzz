// Shared source adapters. A town's sources are database rows (adapter + settings);
// the code for each kind of source lives here once and serves every town.
//
// Each adapter describes its settings (the admin builds its form from `fields`)
// and turns (town, source row) into one job: { key, everyMin, run(db) }.
// Adding a town never needs a new adapter; a new adapter is only needed for a
// new kind of source (e.g. another state's DOT).
import { openDb } from './db.js';
import { sharedJson, sharedText } from './http.js';
import { feedJobs } from './sources/feeds.js';
import { nwsJobs } from './sources/nws.js';
import { cdotJobs } from './sources/cdot.js';
import { nearbyCdotRoutes } from './cdot-routes.js';
import { liftsJobs } from './sources/lifts.js';
import { resortAlertsJobs } from './sources/resort-alerts.js';
import { meanderJobs } from './sources/meander.js';
import { parseIcs } from './ical.js';

export const CATEGORIES = ['alerts', 'town', 'news', 'events'];

const pointOf = (town) => (town.location ? `${(+town.location.lat).toFixed(4)},${(+town.location.lon).toFixed(4)}` : '');
const list = (v) => [].concat(v ?? []).flatMap((x) => String(x).split(/\n|,(?=\s*https?:)/)).map((x) => x.trim()).filter(Boolean);

export const ADAPTERS = {
  rss: {
    name: 'RSS or Atom feed',
    description: 'News, alerts or a calendar published as RSS/Atom (CivicPlus, WordPress, most newspapers).',
    defaultEvery: 15,
    fields: [
      { key: 'url', label: 'Feed address', type: 'urls', required: true, help: 'One per line. Extra lines are fallbacks (e.g. with and without www).' },
      { key: 'category', label: 'Shows under', type: 'select', options: CATEGORIES, required: true, help: 'alerts = town/county emergency notices (urgent words go to the banner).' },
      { key: 'startFromPubDate', label: 'Event start is the post date', type: 'checkbox', help: 'For WordPress "The Events Calendar" feeds.' },
    ],
    keyFor: (s) => `feed-${slug(s.label)}`,
    itemSources: (s) => [s.key],
    job(town, s, deps) {
      const urls = list(s.settings.url);
      const feed = { ...s.settings, id: s.key.replace(/^feed-/, ''), label: s.label, url: urls.length > 1 ? urls : urls[0] };
      const [job] = feedJobs({ ...town, feeds: [feed] }, { get: deps.text });
      if (`feed-${feed.id}` === s.key) return job;
      // Keys that don't start with feed- (rare) keep their own item source.
      return { ...job, run: (db) => job.run(renameSource(db, `feed-${feed.id}`, s.key)) };
    },
  },

  ical: {
    name: 'iCal calendar (.ics)',
    description: 'An event calendar link ending in .ics or webcal:// (Google Calendar, Outlook, many town sites).',
    defaultEvery: 60,
    fields: [
      { key: 'url', label: 'Calendar address', type: 'url', required: true, help: 'webcal:// links work too.' },
      { key: 'days', label: 'Days ahead to show', type: 'number', placeholder: '60' },
    ],
    keyFor: (s) => `ical-${slug(s.label)}`,
    itemSources: (s) => [s.key],
    job(town, s, deps) {
      return {
        async run(db) {
          const url = String(s.settings.url || '').replace(/^webcal:/i, 'https:');
          const text = await deps.text(url, { headers: { Accept: 'text/calendar, */*;q=0.8' } });
          if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Not an iCal file (no BEGIN:VCALENDAR)');
          const now = Date.now();
          const horizon = now + (Number(s.settings.days) || 60) * 86400e3;
          const items = parseIcs(text, town.timezone, now)
            .filter((e) => e.title && e.start >= now - 86400e3 && e.start < horizon)
            .slice(0, 200)
            .map((e) => ({
              extId: e.uid || `${e.title}@${e.start}`,
              sourceLabel: s.label,
              category: 'events',
              title: e.title,
              summary: [e.location, e.description].filter(Boolean).join(' · ') || null,
              link: e.url || null,
              publishedAt: Math.min(now, e.start),
              startsAt: e.start,
            }));
          db.syncItems(town.id, s.key, items);
        },
      };
    },
  },

  'nws-alerts': {
    name: 'National Weather Service alerts',
    description: 'Watches, warnings and advisories for the town\'s map point. Warnings go to the banner.',
    defaultEvery: 3,
    single: true,
    fields: [{ key: 'point', label: 'Map point (lat,lon)', type: 'text', placeholder: 'Town map point', help: 'Leave blank to use the town\'s map point.' }],
    keyFor: () => 'nws-alerts',
    itemSources: () => ['nws-alerts'],
    job(town, s, deps) {
      const point = s.settings.point || pointOf(town);
      return nwsJobs({ ...town, nws: { point, alertPoint: point } }, { get: deps.json }).find((j) => j.id === 'nws-alerts');
    },
  },

  'nws-forecast': {
    name: 'National Weather Service forecast',
    description: 'Fills the Weather tile: now, high/low, expected snow, hourly and 7-day.',
    defaultEvery: 10,
    single: true,
    tile: 'weather',
    fields: [{ key: 'point', label: 'Map point (lat,lon)', type: 'text', placeholder: 'Town map point', help: 'Leave blank to use the town\'s map point.' }],
    keyFor: () => 'nws-forecast',
    itemSources: () => [],
    job(town, s, deps) {
      const point = s.settings.point || pointOf(town);
      return nwsJobs({ ...town, nws: { point, alertPoint: point } }, { get: deps.json }).find((j) => j.id === 'nws-forecast');
    },
  },

  cdot: {
    name: 'CDOT roads (Colorado)',
    description: 'Incidents, closures, winter road conditions and work zones from COtrip. Fills the Roads tile. Statewide feeds are fetched once for every Colorado town.',
    defaultEvery: 5,
    single: true,
    tile: 'roads',
    fields: [
      { key: 'routes', label: 'Routes', type: 'json', editor: 'routes', required: true,
        placeholder: '[{ "match": ["550"], "label": "US-550", "note": "Ouray to Red Mountain Pass" }]',
        help: 'The highways on the Roads tile, in order. "match" is the route number as CDOT writes it.' },
      { key: 'keyPlaces', label: 'Key places', type: 'list', help: 'Place names (passes, towns) that mark a nearby incident when the route number is missing. One per line.' },
    ],
    keyFor: () => 'cdot',
    itemSources: () => ['cdot-incidents', 'cdot-wzdx'],
    // Highways near the town that the route editor offers to add (any state DOT can do the same).
    nearbyRoutes: (town, deps) => nearbyCdotRoutes(town, deps),
    validate(settings) {
      if (!Array.isArray(settings.routes) || !settings.routes.length) return 'Add at least one route.';
      for (const r of settings.routes) if (!r?.label || !Array.isArray(r.match) || !r.match.length) return 'Each route needs a "label" and a "match" list.';
      return null;
    },
    job(town, s, deps) {
      const view = { ...town, cdot: { routes: s.settings.routes || [], keyPlaces: s.settings.keyPlaces || [], disclaimer: s.settings.disclaimer } };
      const jobs = cdotJobs(view, { get: deps.json, ...(deps.cdotKey !== undefined ? { apiKey: deps.cdotKey } : {}) });
      return {
        // One source, three feeds: all run every time; any failure fails the source.
        async run(db) {
          const results = [];
          for (const j of jobs) results.push(await j.run(db).then(() => null, (e) => `${j.id.replace('cdot-', '')}: ${e.message}`));
          const errs = results.filter(Boolean);
          if (errs.length) throw new Error(errs.join('; '));
        },
      };
    },
  },

  'snow-report': {
    name: 'Ski resort snow report (web page)',
    description: 'Reads new snow, base, lifts and trails from a resort\'s snow report page. Fills the Lifts & Snow tile. Add one per resort.',
    defaultEvery: 15,
    tile: 'lifts',
    fields: [
      { key: 'url', label: 'Snow report page', type: 'url', required: true },
      { key: 'name', label: 'Mountain name', type: 'text', required: true, placeholder: 'Purgatory', help: 'Shown on the tile and in posts ("Purgatory: 6" of new snow").' },
      { key: 'linkUrl', label: 'Link people to', type: 'url', help: 'Defaults to the snow report page.' },
      { key: 'valueFirst', label: 'Numbers come before labels', type: 'checkbox', help: 'Tick if the page reads "3\" 24 Hr" rather than "24 Hr 3\"". Use Test to check.' },
    ],
    keyFor: (s, town, taken) => (taken.includes('lifts-snow') ? `lifts-snow-${slug(s.settings.name || s.label)}` : 'lifts-snow'),
    itemSources: (s) => [s.key],
    job(town, s, deps) {
      // The tile holds every resort of the town, so the job sees its siblings.
      const resorts = (town.sources || []).filter((x) => x.adapter === 'snow-report' && x.enabled !== false);
      if (!resorts.some((x) => x.key === s.key)) resorts.push(s);
      const view = { ...town, lifts: resorts.map((x) => ({ ...x.settings, id: x.key, jobId: x.key, label: x.label, name: x.settings.name || x.label })) };
      return liftsJobs(view, { get: deps.text }).find((j) => j.id === s.key);
    },
  },

  'resort-alerts': {
    name: 'Resort alerts (JSON)',
    description: 'Mountain alerts JSON used by several resort sites (e.g. Purgatory\'s m-json/alerts.json).',
    defaultEvery: 10,
    single: true,
    fields: [
      { key: 'url', label: 'Alerts JSON address', type: 'url', required: true },
      { key: 'linkUrl', label: 'Link people to', type: 'url' },
    ],
    keyFor: () => 'resort-alerts',
    itemSources: () => ['resort-alerts'],
    job(town, s, deps) {
      return resortAlertsJobs({ ...town, resortAlerts: { ...s.settings, label: s.label } }, { get: deps.json })[0];
    },
  },

  meander: {
    name: 'Meander.me tagged stories',
    description: 'Stories from the meander.me CMS (Strapi) that carry one of the given tags.',
    defaultEvery: 15,
    single: true,
    fields: [
      { key: 'tags', label: 'Tags', type: 'list', required: true, help: 'Tag slugs, one per line.' },
      { key: 'tagName', label: 'Tag shown to readers', type: 'text' },
      { key: 'api', label: 'CMS addresses', type: 'urls', placeholder: 'https://cms.meander.me', help: 'One per line, tried in order.' },
      { key: 'site', label: 'Site address', type: 'url', placeholder: 'https://meander.me' },
      { key: 'category', label: 'Shows under', type: 'select', options: CATEGORIES },
    ],
    keyFor: () => 'meander',
    itemSources: () => ['meander'],
    job(town, s, deps) {
      const cfg = { api: ['https://cms.meander.me'], site: 'https://meander.me', category: 'news', ...s.settings, label: s.label };
      cfg.api = list(cfg.api);
      return meanderJobs({ ...town, meander: cfg }, { get: deps.json })[0];
    },
  },
};

export function slug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'source';
}

/** Wrap a db so items saved under one source name land under another. */
function renameSource(db, from, to) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'syncItems') return (town, src, ...rest) => target.syncItems(town, src === from ? to : src, ...rest);
      return target[prop];
    },
  });
}

const DEFAULT_DEPS = { text: sharedText, json: sharedJson };

/** The scheduler job for one source row, or null if its adapter is unknown. */
export function jobFor(town, source, deps = {}) {
  const a = ADAPTERS[source.adapter];
  if (!a) return null;
  const job = a.job(town, { ...source, settings: source.settings || {} }, { ...DEFAULT_DEPS, ...deps });
  if (!job) return null;
  return { key: source.key, everyMin: Number(source.everyMin) || a.defaultEvery, run: job.run };
}

/** Check a source row before saving. Returns an error message or null. */
export function validateSource(source, town, existing = []) {
  const a = ADAPTERS[source.adapter];
  if (!a) return `Unknown source type "${source.adapter}".`;
  if (!String(source.label || '').trim()) return 'Give the source a name (shown on every post).';
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(source.key || '')) return 'Source key must be lowercase letters, numbers and dashes.';
  if (a.single && existing.some((x) => x.adapter === source.adapter && x.key !== source.key)) return `${town.name} already has a ${a.name} source.`;
  for (const f of a.fields) {
    const v = source.settings?.[f.key];
    if (f.required && (v == null || v === '' || (Array.isArray(v) && !v.length))) return `${f.label} is required.`;
    if (v && (f.type === 'url' || f.type === 'urls')) {
      for (const u of list(v)) if (!/^(https?|webcal):\/\/[^\s]+$/i.test(u)) return `${f.label}: "${u}" is not a web address.`;
    }
    if (f.type === 'select' && v && !f.options.includes(v)) return `${f.label} must be one of ${f.options.join(', ')}.`;
  }
  if (source.everyMin != null && source.everyMin !== '' && !(Number(source.everyMin) >= 1 && Number(source.everyMin) <= 1440)) return 'Check every must be 1 to 1440 minutes.';
  return a.validate ? a.validate(source.settings || {}) : null;
}

/** Pick a key for a new source that doesn't collide with the town's others. */
export function newKey(source, town, existing = []) {
  const a = ADAPTERS[source.adapter];
  const taken = existing.map((x) => x.key);
  let key = a.keyFor(source, town, taken);
  for (let i = 2; taken.includes(key); i++) key = `${a.keyFor(source, town, taken)}-${i}`;
  return key;
}

/** Item source names a source writes under (to clear its posts when it is deleted). */
export const itemSourcesOf = (s) => ADAPTERS[s.adapter]?.itemSources(s) || [s.key];

/**
 * Dry run for the admin's Test button: run the source against a scratch database
 * and return what it would show. Nothing touches the live data.
 */
export async function testSource(town, source, deps = {}) {
  const job = jobFor(town, source, deps);
  if (!job) throw new Error(`Unknown source type "${source.adapter}"`);
  const scratch = openDb(':memory:');
  const started = Date.now();
  let error = null;
  try { await job.run(scratch); } catch (e) { error = e.message; }
  const items = scratch.feed(town.id, { limit: 200 });
  const events = items.filter((i) => i.startsAt).sort((a, b) => a.startsAt - b.startsAt);
  const out = {
    ok: !error,
    error,
    ms: Date.now() - started,
    count: items.length,
    items: (events.length > items.length / 2 ? events : items).slice(0, 15),
    tiles: scratch.getTiles(town.id),
  };
  scratch.close();
  return out;
}

/** Public list for the admin form. */
export function adapterCatalog() {
  return Object.entries(ADAPTERS).map(([type, a]) => ({
    type, name: a.name, description: a.description, defaultEvery: a.defaultEvery, single: !!a.single, tile: a.tile || null, fields: a.fields,
    nearbyRoutes: !!a.nearbyRoutes,
  }));
}

/** Routes this adapter's data lists near the town: { routes: [{ label, match, km }] } or { error }. */
export async function nearbyRoutes(type, town, deps = {}) {
  const a = ADAPTERS[type];
  if (!a?.nearbyRoutes) return { error: 'This source type has no route list.' };
  return a.nearbyRoutes(town, deps);
}
