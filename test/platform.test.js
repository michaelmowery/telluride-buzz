// Phase 1 platform: towns and sources in the database, shared adapters, admin, health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importConfig, importConfigs, exportTown, loadTowns, normalizeTown, normalizeSource } from '../src/towns.js';
import { ADAPTERS, jobFor, testSource, validateSource } from '../src/adapters.js';
import { startScheduler } from '../src/scheduler.js';
import { sourceHealth, townColor } from '../src/health.js';
import { createAdmin } from '../src/admin.js';
import { parseIcs, nextOccurrence } from '../src/ical.js';
import { aboutRows } from '../src/brand.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (f) => fs.readFileSync(path.join(root, 'test', 'fixtures', f), 'utf8');
const configs = fs.readdirSync(path.join(root, 'config')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'config', f), 'utf8')));
const quiet = { info() {}, warn() {} };

test('config import keeps every legacy job id, so live posts and health rows carry over', () => {
  const tel = importConfig(configs.find((c) => c.id === 'telluride'));
  assert.deepEqual(tel.sources.map((s) => s.key), ['nws-alerts', 'nws-forecast', 'cdot', 'lifts-snow', 'meander',
    'feed-town-news', 'feed-town-calendar', 'feed-county-news', 'feed-county-alerts', 'feed-koto']);
  assert.equal(tel.town.feeds, undefined);
  assert.equal(tel.town.brand.siteName, 'Telluride.Buzz');
  const dur = importConfig(configs.find((c) => c.id === 'durango'));
  assert.ok(dur.sources.find((s) => s.key === 'lifts-snow').settings.valueFirst);
  assert.equal(dur.sources.find((s) => s.key === 'feed-purgatory-events').settings.startFromPubDate, true);
  for (const s of [...tel.sources, ...dur.sources]) assert.equal(validateSource(s, tel.town, []), null, s.key);
});

test('import runs once per town; after that the database wins', () => {
  const db = openDb(':memory:');
  assert.deepEqual(importConfigs(db, configs).sort(), ['durango', 'telluride']);
  db.setSourceEnabled('telluride', 'feed-koto', false);
  assert.deepEqual(importConfigs(db, configs), []);
  assert.equal(db.listSources('telluride').find((s) => s.key === 'feed-koto').enabled, false);
  const towns = loadTowns(db);
  assert.equal(towns.length, 2);
  assert.ok(towns.every((t) => t.status === 'live' && t.sources.length >= 10));
});

test('export round-trips through import', () => {
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const tel = loadTowns(db).find((t) => t.id === 'telluride');
  const json = exportTown(tel, tel.sources);
  const back = importConfig(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back.sources.map((s) => [s.key, s.adapter, s.settings]), tel.sources.map((s) => [s.key, s.adapter, s.settings]));
  assert.equal(back.town.hostnames[0], 'telluride.thetown.buzz');
});

test('a new town needs only a name, address name and map point', () => {
  const { town, error } = normalizeTown({ id: 'ouray', name: 'Ouray', state: 'co', location: { lat: '38.0228', lon: '-107.6714' } }, configs);
  assert.equal(error, undefined);
  assert.deepEqual(town.hostnames, ['ouray.thetown.buzz', 'ouray.localhost']);
  assert.equal(town.url, 'https://ouray.thetown.buzz');
  assert.equal(town.brand.siteName, 'Ouray Buzz');
  assert.equal(town.brand.logo, 'thetown');
  assert.equal(town.status, 'draft');
  assert.equal(town.state, 'CO');
  assert.ok(town.bbox.minLat < 38.0228 && town.bbox.maxLon > -107.6714);
  assert.match(normalizeTown({ id: 'x', name: 'X', location: { lat: 1, lon: 1 } }).error, /Address name/);
  assert.match(normalizeTown({ id: 'admin', name: 'X', location: { lat: 1, lon: 1 } }).error, /reserved/);
  assert.match(normalizeTown({ id: 'tel2', name: 'T', location: { lat: 1, lon: 1 }, hostnames: ['telluride.buzz'] }, configs).error, /already belongs to Telluride/);
  assert.match(normalizeTown({ id: 'ouray', name: 'Ouray', location: { lat: 1, lon: 1 }, timezone: 'Mars/Base' }).error, /time zone/);
});

test('source form input is cleaned and checked per adapter', () => {
  const town = { id: 'ouray', name: 'Ouray', location: { lat: 38, lon: -107.7 } };
  const r = normalizeSource({ adapter: 'rss', label: 'City of Ouray', settings: { url: 'https://cityofouray.com/rss\nhttps://www.cityofouray.com/rss', category: 'town', startFromPubDate: false } }, town, []);
  assert.equal(r.error, undefined);
  assert.equal(r.source.key, 'feed-city-of-ouray');
  assert.deepEqual(r.source.settings, { url: ['https://cityofouray.com/rss', 'https://www.cityofouray.com/rss'], category: 'town' });
  assert.match(normalizeSource({ adapter: 'rss', label: 'X', settings: { url: 'not a url', category: 'town' } }, town, []).error, /not a web address/);
  assert.match(normalizeSource({ adapter: 'cdot', label: 'CDOT', settings: { routes: '[{"label":"US-550"}]' } }, town, []).error, /match/);
  assert.match(normalizeSource({ adapter: 'nws-alerts', label: 'NWS' }, town, [{ key: 'nws-alerts', adapter: 'nws-alerts' }]).error, /already has/);
  const two = normalizeSource({ adapter: 'snow-report', label: 'Purgatory Resort', settings: { url: 'https://p.example/', name: 'Purgatory' } }, town, [{ key: 'lifts-snow', adapter: 'snow-report' }]);
  assert.equal(two.source.key, 'lifts-snow-purgatory');
});

test('Test button: runs a source against a scratch database and shows what it would post', async () => {
  const town = { id: 'ouray', name: 'Ouray', timezone: 'America/Denver', location: { lat: 38, lon: -107.7 }, sources: [] };
  const r = await testSource(town, { key: 'feed-civic', adapter: 'rss', label: 'Town', settings: { url: 'https://x.example/rss', category: 'events' } },
    { text: async () => fx('civic-calendar.xml') });
  assert.equal(r.ok, true);
  assert.ok(r.count > 0);
  assert.ok(r.items[0].startsAt);
  const bad = await testSource(town, { key: 'feed-x', adapter: 'rss', label: 'X', settings: { url: 'https://x.example/', category: 'news' } },
    { text: async () => { throw new Error('HTTP 403'); } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /403/);
});

test('CDOT adapter: one source runs all three feeds and fills the Roads tile', async () => {
  const db = openDb(':memory:');
  const tel = importConfig(configs.find((c) => c.id === 'telluride'));
  const town = { ...tel.town, sources: tel.sources };
  const feeds = { incidents: fx('cdot-incidents.json'), wzdx: fx('cdot-wzdx.json'), roadConditions: '{"features":[]}' };
  const json = async (u) => JSON.parse(feeds[u.match(/v1\/(\w+)/)[1]]);
  await jobFor(town, tel.sources.find((s) => s.key === 'cdot'), { json, cdotKey: 'k' }).run(db);
  assert.ok(db.getTiles('telluride').roads.routes.length === 3);
  assert.ok(db.feed('telluride').some((i) => i.source === 'cdot-incidents'));
  const failing = jobFor(town, tel.sources.find((s) => s.key === 'cdot'), { json, cdotKey: '' });
  await assert.rejects(failing.run(db), /incidents: CDOT_API_KEY is not set/);
});

test('scheduler reload starts and stops only what changed', () => {
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const s = startScheduler(db, loadTowns(db), { log: quiet, deps: { text: () => new Promise(() => {}), json: () => new Promise(() => {}) } });
  try {
    const n = s.running().length;
    assert.equal(n, 21);
    assert.deepEqual(s.reload(loadTowns(db)), { started: 0, stopped: 0, running: n });
    db.setSourceEnabled('telluride', 'feed-koto', false);
    assert.deepEqual(s.reload(loadTowns(db)), { started: 0, stopped: 1, running: n - 1 });
    db.saveTown({ id: 'ouray', name: 'Ouray', timezone: 'America/Denver', location: { lat: 38, lon: -107.7 }, hostnames: ['ouray.thetown.buzz'] }, 'draft');
    db.saveSource('ouray', { key: 'nws-alerts', adapter: 'nws-alerts', label: 'NWS', settings: {} });
    assert.deepEqual(s.reload(loadTowns(db)), { started: 1, stopped: 0, running: n });
    assert.equal(s.runNow('ouray', 'nws-alerts'), true);
    assert.equal(s.runNow('telluride', 'feed-koto'), false);
  } finally { s.stop(); }
});

test('health board colours: green, amber under an hour, red after an hour, paused', () => {
  const now = Date.now();
  const town = { sources: [
    { key: 'a', adapter: 'rss', label: 'A', enabled: true },
    { key: 'b', adapter: 'rss', label: 'B', enabled: true },
    { key: 'c', adapter: 'rss', label: 'C', enabled: true },
    { key: 'd', adapter: 'rss', label: 'D', enabled: false },
    { key: 'e', adapter: 'rss', label: 'E', enabled: true },
  ] };
  const rows = sourceHealth(town, [
    { source: 'a', last_run: now - 60e3, last_ok: now - 60e3, last_error: null },
    { source: 'b', last_run: now, last_ok: now - 20 * 60e3, last_error: 'HTTP 500', failing_since: now - 20 * 60e3 },
    { source: 'c', last_run: now, last_ok: now - 3 * 3600e3, last_error: 'HTTP 403', failing_since: now - 2 * 3600e3 },
  ], now);
  assert.deepEqual(rows.map((r) => r.color), ['green', 'amber', 'red', 'paused', 'amber']);
  assert.equal(rows[2].note, 'Failing for 2 hours');
  assert.equal(townColor(rows), 'red');
});

test('failing_since stays at the first failure and clears on success', () => {
  const db = openDb(':memory:');
  db.recordRun('t', 'x', 'boom');
  const first = db.sourceStatus('t')[0].failing_since;
  db.recordRun('t', 'x', 'boom again');
  assert.equal(db.sourceStatus('t')[0].failing_since, first);
  assert.equal(db.sourceStatus('t')[0].error_count, 2);
  db.recordRun('t', 'x', null);
  assert.equal(db.sourceStatus('t')[0].failing_since, null);
});

test('iCal: all-day, UTC and TZID events; simple weekly repeats move to the next date', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a1', 'SUMMARY:Town council\\, regular meeting', 'DTSTART;TZID=America/Denver:20261201T180000',
    'LOCATION:Town Hall', 'URL:https://x.example/e/1', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a2', 'SUMMARY:Ice rink opens', 'DTSTART;VALUE=DATE:20261205', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a3', 'SUMMARY:Cancelled thing', 'DTSTART:20261203T010000Z', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a4', 'SUMMARY:Farmers mar', ' ket', 'DTSTART:20261101T160000Z', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const now = Date.UTC(2026, 10, 22);
  const ev = parseIcs(ics, 'America/Denver', now);
  assert.deepEqual(ev.map((e) => e.title), ['Town council, regular meeting', 'Ice rink opens', 'Farmers market']);
  assert.equal(ev[0].start, Date.UTC(2026, 11, 2, 1, 0)); // 6 PM MST = 01:00 UTC next day
  assert.equal(ev[1].allDay, true);
  assert.ok(ev[2].start >= now - 86400e3 && ev[2].start < now + 7 * 86400e3);
  assert.equal(nextOccurrence(0, 'FREQ=DAILY;COUNT=2', 10 * 86400e3), null);
});

test('About page lists sources automatically when the brand has no hand-written list', () => {
  const rows = aboutRows({ sources: [
    { key: 'nws-alerts', adapter: 'nws-alerts', label: 'National Weather Service', enabled: true },
    { key: 'feed-x', adapter: 'rss', label: 'City of Ouray', about: 'City news', everyMin: 60, enabled: true },
    { key: 'feed-y', adapter: 'rss', label: 'Paused', enabled: false },
  ] });
  assert.deepEqual(rows.map((r) => r[0]), ['National Weather Service', 'City of Ouray']);
  assert.deepEqual(rows[1].slice(1), ['City news', 'Every 1 hour']);
});

// ---------- admin API ----------
function fakeReq(method, pathname, { body, cookie, origin, host = 'telluride.buzz', type = 'application/json' } = {}) {
  return {
    req: { method, headers: { host, cookie, origin, 'content-type': type, 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '1.2.3.4' } },
    url: new URL(`https://${host}${pathname}`),
    read: async () => body || {},
  };
}

test('admin: off without a password, sign-in required, wrong passwords throttled', async () => {
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const off = createAdmin({ db, password: '', log: quiet });
  const r0 = fakeReq('GET', '/api/admin/towns');
  assert.equal((await off.handle(r0.req, r0.url, r0.read)).status, 404);

  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet });
  const r1 = fakeReq('GET', '/api/admin/towns');
  assert.equal((await admin.handle(r1.req, r1.url, r1.read)).status, 401);
  const bad = fakeReq('POST', '/api/admin/login', { body: { password: 'nope' } });
  assert.equal((await admin.handle(bad.req, bad.url, bad.read)).status, 401);
  const good = fakeReq('POST', '/api/admin/login', { body: { password: 'correct horse battery' } });
  const res = await admin.handle(good.req, good.url, good.read);
  assert.equal(res.status, 200);
  assert.match(res.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  const r2 = fakeReq('GET', '/api/admin/towns', { cookie });
  assert.equal((await admin.handle(r2.req, r2.url, r2.read)).body.towns.length, 2);
  const forged = fakeReq('GET', '/api/admin/towns', { cookie: `buzz_admin=${Date.now() + 1e9}.AAAA` });
  assert.equal((await admin.handle(forged.req, forged.url, forged.read)).status, 401);
  const xsite = fakeReq('POST', '/api/admin/town', { cookie, origin: 'https://evil.example', body: {} });
  assert.equal((await admin.handle(xsite.req, xsite.url, xsite.read)).status, 403);
  const form = fakeReq('POST', '/api/admin/town', { cookie, type: 'application/x-www-form-urlencoded' });
  assert.equal((await admin.handle(form.req, form.url, form.read)).status, 415);
  for (let i = 0; i < 8; i++) await admin.handle(bad.req, bad.url, bad.read);
  assert.equal((await admin.handle(good.req, good.url, good.read)).status, 429);
});

test('admin: add a town and its sources with no code change; changes trigger a reload', async () => {
  const db = openDb(':memory:');
  importConfigs(db, configs);
  let reloads = 0;
  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet, onChange: () => reloads++ });
  const login = fakeReq('POST', '/api/admin/login', { body: { password: 'correct horse battery' } });
  const cookie = (await admin.handle(login.req, login.url, login.read)).headers['Set-Cookie'].split(';')[0];
  const call = async (method, p, body) => { const r = fakeReq(method, p, { cookie, body }); return admin.handle(r.req, r.url, r.read); };

  let r = await call('POST', '/api/admin/town', { create: true, town: { id: 'ouray', name: 'Ouray', state: 'CO', location: { lat: 38.0228, lon: -107.6714 } } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual(r.body.town.sources.map((s) => s.key), ['nws-alerts', 'nws-forecast']);
  assert.equal(r.body.town.status, 'draft');
  r = await call('POST', '/api/admin/town', { create: true, town: { id: 'ouray', name: 'Ouray', location: { lat: 38, lon: -107 } } });
  assert.match(r.body.error, /already a town/);

  r = await call('POST', '/api/admin/source', { create: true, town: 'ouray', source: { adapter: 'cdot', label: 'CDOT', settings: { routes: '[{"match":["550"],"label":"US-550"}]', keyPlaces: 'Red Mountain\nRidgway' } } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual(r.body.source.settings.keyPlaces, ['Red Mountain', 'Ridgway']);
  r = await call('POST', '/api/admin/source', { create: true, town: 'ouray', source: { adapter: 'rss', label: 'Ouray County Plaindealer', settings: { url: 'https://example.com/feed/', category: 'news' } } });
  assert.equal(r.body.source.key, 'feed-ouray-county-plaindealer');
  r = await call('POST', '/api/admin/source/toggle', { town: 'ouray', key: 'feed-ouray-county-plaindealer', enabled: false });
  assert.equal(r.status, 200);
  r = await call('POST', '/api/admin/source', { town: 'ouray', source: { key: 'feed-ouray-county-plaindealer', adapter: 'rss', label: 'Plaindealer', enabled: false, settings: { url: 'https://example.com/feed/', category: 'news' } } });
  assert.equal(r.status, 200);
  assert.equal(db.listSources('ouray').find((s) => s.key === 'feed-ouray-county-plaindealer').label, 'Plaindealer');

  r = await call('GET', '/api/admin/health');
  const ouray = r.body.towns.find((t) => t.id === 'ouray');
  assert.equal(ouray.sources.length, 4);
  assert.equal(ouray.sources.find((s) => s.key === 'feed-ouray-county-plaindealer').color, 'paused');

  r = await call('POST', '/api/admin/town', { town: { id: 'ouray', status: 'live' } });
  assert.equal(r.body.town.status, 'live');
  assert.equal(r.body.town.name, 'Ouray'); // fields not sent are kept
  r = await call('POST', '/api/admin/town/delete', { town: 'ouray', confirm: 'ouray' });
  assert.match(r.body.error, /draft before deleting/);
  await call('POST', '/api/admin/town', { town: { id: 'ouray', status: 'draft' } });
  r = await call('POST', '/api/admin/town/delete', { town: 'ouray', confirm: 'ouray' });
  assert.equal(r.status, 200);
  assert.equal(db.listSources('ouray').length, 0);
  assert.ok(reloads >= 7);
});

test('every adapter has a name, fields and a job builder', () => {
  for (const [type, a] of Object.entries(ADAPTERS)) {
    assert.ok(a.name && a.description && a.defaultEvery > 0 && Array.isArray(a.fields), type);
    assert.equal(typeof a.job, 'function', type);
  }
});

test('health rows say which feed a source fills, for the admin filter', async () => {
  const { sourceHealth, feedOf } = await import('../src/health.js');
  assert.equal(feedOf({ adapter: 'rss', settings: { category: 'alerts' } }), 'alerts');
  assert.equal(feedOf({ adapter: 'cdot', settings: {} }), 'roads');
  assert.equal(feedOf({ adapter: 'nws-forecast' }), 'weather');
  assert.equal(feedOf({ adapter: 'snow-report' }), 'lifts');
  assert.equal(feedOf({ adapter: 'meander', settings: {} }), 'news');
  const [row] = sourceHealth({ sources: [{ key: 'ical-x', adapter: 'ical', label: 'X', settings: {} }] });
  assert.equal(row.feed, 'events');
});

test('town lookup: Nominatim results become town suggestions with state, slug and time zone', async () => {
  const { townsFromNominatim, guessTimezone, geocodeTown } = await import('../src/geocode.js');
  const sample = [
    { lat: '38.0227', lon: '-107.6714', addresstype: 'town', name: 'Ouray', display_name: 'Ouray, Ouray County, Colorado, United States',
      address: { town: 'Ouray', county: 'Ouray County', state: 'Colorado', 'ISO3166-2-lvl4': 'US-CO' } },
    { lat: '38.1', lon: '-107.7', addresstype: 'county', name: 'Ouray County', display_name: 'Ouray County, Colorado',
      address: { county: 'Ouray County', 'ISO3166-2-lvl4': 'US-CO' } },
    { lat: '47.6', lon: '-116.8', addresstype: 'city', name: "Coeur d'Alene", display_name: "Coeur d'Alene, Idaho",
      address: { city: "Coeur d'Alene", 'ISO3166-2-lvl4': 'US-ID' } },
  ];
  const m = townsFromNominatim(sample);
  assert.deepEqual([m[0].name, m[0].state, m[0].id, m[0].lat, m[0].lon, m[0].timezone], ['Ouray', 'CO', 'ouray', 38.0227, -107.6714, 'America/Denver']);
  assert.match(m[0].maps, /google\.com\/maps.*38\.0227,-107\.6714/);
  assert.equal(m.find((x) => x.state === 'ID').timezone, 'America/Los_Angeles', 'north Idaho is Pacific');
  assert.equal(m.find((x) => x.state === 'ID').id, 'coeurdalene');
  assert.equal(guessTimezone('AZ', 34, -111), 'America/Phoenix');
  // Open-Meteo answers first; "Fort Collins, CO" is split into name and state.
  const meteo = { results: [
    { name: 'Fort Collins', latitude: 40.5853, longitude: -105.0844, feature_code: 'PPLA2', country_code: 'US', admin1: 'Colorado', admin2: 'Larimer', timezone: 'America/Denver', population: 170000 },
    { name: 'Fort Collins', latitude: 30, longitude: -90, feature_code: 'PPL', country_code: 'US', admin1: 'Louisiana', timezone: 'America/Chicago', population: 10 },
  ] };
  const asked = [];
  let got = await geocodeTown('Fort Collins, CO', '', { fetchJsonImpl: async (url) => { asked.push(url); return meteo; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /geocoding-api\.open-meteo\.com\/v1\/search.*countryCode=US.*name=Fort%20Collins/);
  assert.deepEqual([got.length, got[0].name, got[0].state, got[0].id, got[0].lat, got[0].timezone], [1, 'Fort Collins', 'CO', 'fortcollins', 40.5853, 'America/Denver']);
  // Open-Meteo down: Nominatim answers.
  asked.length = 0;
  got = await geocodeTown('Ouray', 'CO', { fetchJsonImpl: async (url) => { asked.push(url); if (/open-meteo/.test(url)) throw new Error('HTTP 503'); return sample; } });
  assert.match(asked[1], /nominatim\.openstreetmap\.org\/search.*countrycodes=us.*q=Ouray%2C%20CO/);
  assert.equal(got[0].name, 'Ouray');
  // Both down: one error naming both.
  await assert.rejects(geocodeTown('Ouray', 'CO', { fetchJsonImpl: async () => { throw new Error('nope'); } }), /nope/);
});

test('admin: Create town with Claude\'s answer saves its sources and starter resources', async () => {
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet });
  const login = fakeReq('POST', '/api/admin/login', { body: { password: 'correct horse battery' } });
  const cookie = (await admin.handle(login.req, login.url, login.read)).headers['Set-Cookie'].split(';')[0];
  const call = async (method, p, body) => { const r = fakeReq(method, p, { cookie, body }); return admin.handle(r.req, r.url, r.read); };
  const fromClaude = {
    suggestedSources: [
      { label: 'Denver7 (KMGH)', type: 'rss', url: 'https://www.denver7.com/news/front-range/fort-collins.rss', why: 'Fort Collins news feed; confirmed working RSS.' },
      { label: 'CBS Colorado', type: 'rss', url: 'https://www.cbsnews.com/latest/rss/local-news-northern-colorado', why: 'Latest items looked stale, so check it updates.' },
      { label: 'City of Fort Collins', type: 'other', url: 'https://www.fortcollins.gov/Home/Tabs/News', why: 'Official city news. No RSS URL confirmed.' },
      { label: 'City events', type: 'ical', url: 'https://example.com/events.ics', why: 'City calendar' },
      { label: 'CDOT', type: 'cdot', url: 'https://www.cotrip.org', why: 'Roads' },
      { label: 'Broken', type: 'rss', url: 'not a url' },
      { label: 'Denver7 again', type: 'rss', url: 'https://www.denver7.com/news/front-range/fort-collins.rss' },
    ],
    // The town column says something else: a new town's starter list goes in that town anyway.
    resourcesCsv: 'id,town,category,name,phone\n,fort-collins,emergency,Emergency,911\n,fort-collins,government,City Hall,970-221-6500\n,fort-collins,nonsense,Bad row,1',
  };
  const r = await call('POST', '/api/admin/town', { create: true, fromClaude, town: { id: 'fortcollins', name: 'Fort Collins', state: 'CO', location: { lat: 40.5853, lon: -105.0844 } } });
  assert.equal(r.status, 200, r.body.error);
  const fc = r.body.fromClaude;
  assert.deepEqual(fc.sources.map((s) => [s.adapter, s.label, s.enabled]), [
    ['rss', 'Denver7 (KMGH)', true], ['rss', 'CBS Colorado', false], ['rss', 'City of Fort Collins', false], ['ical', 'City events', true]]);
  assert.deepEqual(fc.skipped.map((x) => x.label), ['CDOT', 'Broken', 'Denver7 again']);
  const saved = db.listSources('fortcollins');
  assert.equal(saved.length, 6); // + NWS alerts and forecast
  assert.equal(saved.find((s) => s.label === 'City of Fort Collins').settings.category, 'town');
  assert.equal(saved.find((s) => s.label === 'Denver7 (KMGH)').settings.category, 'news');
  assert.equal(fc.resources.added, 2);
  assert.equal(fc.resources.errors.length, 1);
  assert.deepEqual(db.listResources('fortcollins').map((x) => x.name).sort(), ['City Hall', 'Emergency']);
});

test('header messages: every-town message, town message and the preview note', async () => {
  const { normalizeNotice, noticesFor, renderNotices } = await import('../src/notice.js');
  assert.deepEqual(normalizeNotice({ text: '  ', level: 'warn' }), { notice: null });
  assert.deepEqual(normalizeNotice({ text: 'Town Hall closed Friday', level: 'nope', until: '2026-11-27' }), { notice: { text: 'Town Hall closed Friday', level: 'info', until: '2026-11-27' } });
  assert.match(normalizeNotice({ text: 'x'.repeat(300) }).error, /280/);
  assert.match(normalizeNotice({ text: 'x', until: 'Friday' }).error, /date/);
  const town = { id: 'durango', name: 'Durango', timezone: 'America/Denver', brand: { siteName: 'Durango Buzz', notice: { text: 'Main Ave closed <Sat>', level: 'warn', until: '2026-11-28' } } };
  const now = Date.parse('2026-11-23T20:00:00Z');
  let list = noticesFor(town, { text: 'Snowstorm tonight', level: 'urgent' }, now);
  assert.deepEqual(list.map((n) => n.level), ['urgent', 'warn', 'preview']);
  assert.match(list[2].text, /Durango Buzz is in early testing/);
  list = noticesFor({ ...town, brand: { ...town.brand, preview: false } }, { text: 'Old', until: '2026-11-01' }, now);
  assert.deepEqual(list.map((n) => n.level), ['warn']); // expired every-town message, preview off
  const html = renderNotices(list);
  assert.match(html, /class="note note-warn"/);
  assert.match(html, /Main Ave closed &lt;Sat&gt;/);
  assert.equal(renderNotices([]), '');

  const db = openDb(':memory:');
  importConfigs(db, configs);
  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet });
  const login = fakeReq('POST', '/api/admin/login', { body: { password: 'correct horse battery' } });
  const cookie = (await admin.handle(login.req, login.url, login.read)).headers['Set-Cookie'].split(';')[0];
  const call = async (method, p, body) => { const r = fakeReq(method, p, { cookie, body }); return admin.handle(r.req, r.url, r.read); };
  let r = await call('POST', '/api/admin/notice', { text: 'Snowstorm tonight', level: 'urgent' });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/admin/notice')).body.notice.text, 'Snowstorm tonight');
  r = await call('POST', '/api/admin/notice', { text: '' });
  assert.equal(r.body.notice, null);
  const id = (await call('GET', '/api/admin/towns')).body.towns[0].id;
  r = await call('POST', '/api/admin/town', { town: { id, brand: { notice: { text: 'Road work', level: 'warn' }, preview: false } } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([r.body.town.brand.notice.text, r.body.town.brand.preview], ['Road work', false]);
  r = await call('POST', '/api/admin/town', { town: { id, brand: { notice: { text: '' }, preview: true } } });
  assert.deepEqual([r.body.town.brand.notice, r.body.town.brand.preview], [undefined, undefined]);
});

test('logo: long town names wrap to two lines or shrink so they never run off the edge', async () => {
  const { logoSvg } = await import('../src/brand.js');
  const names = (svg) => [...svg.matchAll(/<text[^>]*class="logo-name"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(names(logoSvg({ name: 'Telluride', brand: {} })), ['telluride']);
  assert.doesNotMatch(logoSvg({ name: 'Telluride', brand: {} }), /scale\(/);
  assert.deepEqual(names(logoSvg({ name: 'Fort Collins', brand: {} })), ['fort', 'collins']);
  assert.deepEqual(names(logoSvg({ name: 'Steamboat Springs', brand: {} })), ['steamboat', 'springs']);
  assert.deepEqual(names(logoSvg({ name: 'Mt. Crested Butte', brand: {} })), ['mt. crested', 'butte']);
  const breck = logoSvg({ name: 'Breckenridge', brand: {} });
  assert.deepEqual(names(breck), ['breckenridge']);
  assert.ok(Number(breck.match(/scale\(([\d.]+)\)/)[1]) < 0.7);
});

test('roads: CDOT highways picked from the map point; tiles and disclaimer follow the sources', async () => {
  const { routeLabel, routesNear, suggestCdotSource } = await import('../src/cdot-routes.js');
  const { tileGaps, renderTemplate } = await import('../src/brand.js');
  assert.deepEqual(['I 25', 'I-25', 'Interstate 25', 'US 287', 'US-287', 'CO 14', 'SH 14', 'County Road 5'].map((x) => routeLabel(x)?.label),
    ['I-25', 'I-25', 'I-25', 'US-287', 'US-287', 'CO-14', 'CO-14', undefined]);
  const line = (name, coords) => ({ type: 'Feature', properties: { routeName: name }, geometry: { type: 'LineString', coordinates: coords } });
  const fc = { lat: 40.5853, lon: -105.0844 }; // Fort Collins
  const feats = [
    line('I 25', [[-105.0, 40.4], [-105.0, 40.7]]), // ~7 km east
    line('US 287', [[-105.08, 40.5], [-105.08, 40.7]]), // through town
    line('CO 14', [[-105.2, 40.586], [-104.9, 40.586]]), // through town
    line('I 70', [[-105.5, 39.7], [-105.0, 39.7]]), // Denver area, ~100 km
    { type: 'Feature', properties: { routeName: 'CO 1' }, geometry: { type: 'Point', coordinates: [-105.06, 40.66] } }, // ~8 km
  ];
  assert.deepEqual(routesNear(feats, fc).map((r) => r.label), ['US-287', 'CO-14', 'I-25', 'CO-1']);
  assert.deepEqual(routesNear(feats, fc)[0].match, ['287']);

  const asked = [];
  const json = async (url) => { asked.push(url); return url.includes('roadConditions') ? { features: feats } : []; };
  const ok = await suggestCdotSource({ name: 'Fort Collins', state: 'CO', location: fc }, { json, cdotKey: 'k' });
  assert.equal(ok.source.adapter, 'cdot');
  assert.deepEqual(JSON.parse(ok.source.settings.routes).map((r) => r.label), ['US-287', 'CO-14', 'I-25', 'CO-1']);
  assert.match((await suggestCdotSource({ name: 'Shiprock', state: 'NM', location: { lat: 36.79, lon: -108.69 } }, { json, cdotKey: 'k' })).error, /Colorado/);
  assert.match((await suggestCdotSource({ name: 'Fort Collins', state: 'CO', location: fc }, { json, cdotKey: '' })).error, /API key/);

  // Admin: a Colorado town gets roads on Create town; one click adds them later. (New Mexico: see the NMRoads test.)
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet, deps: { json, cdotKey: 'k' } });
  const login = fakeReq('POST', '/api/admin/login', { body: { password: 'correct horse battery' } });
  const cookie = (await admin.handle(login.req, login.url, login.read)).headers['Set-Cookie'].split(';')[0];
  const call = async (method, p, body) => { const r = fakeReq(method, p, { cookie, body }); return admin.handle(r.req, r.url, r.read); };
  let r = await call('POST', '/api/admin/town', { create: true, town: { id: 'fortcollins', name: 'Fort Collins', state: 'CO', location: fc } });
  assert.deepEqual(r.body.roads.routes, ['US-287', 'CO-14', 'I-25', 'CO-1']);
  assert.equal(db.listSources('fortcollins').find((s) => s.adapter === 'cdot').settings.routes[0].label, 'US-287');
  r = await call('POST', '/api/admin/source/cdot-auto', { town: 'fortcollins' });
  assert.match(r.body.error, /already has CDOT/);
  r = await call('POST', '/api/admin/town', { create: true, town: { id: 'shiprock', name: 'Shiprock', state: 'NM', location: { lat: 36.79, lon: -108.69 } } });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.roads.error, /NMRoads lists no highway/); // this fake feed has no NM events
  assert.equal(db.listSources('shiprock').some((s) => s.adapter === 'cdot'), false);

  // Route editor: the highways CDOT lists near the town, with distances, to add.
  let nr = await call('POST', '/api/admin/source/nearby-routes', { town: 'fortcollins', adapter: 'cdot' });
  assert.deepEqual(nr.body.routes.map((x) => x.label), ['US-287', 'CO-14', 'I-25', 'CO-1']);
  assert.ok(nr.body.routes[0].km < 1 && nr.body.routes[2].km > 5);
  nr = await call('POST', '/api/admin/source/nearby-routes', { town: 'shiprock', adapter: 'cdot' });
  assert.match(nr.body.error, /Colorado/);
  nr = await call('POST', '/api/admin/source/nearby-routes', { town: 'fortcollins', adapter: 'rss' });
  assert.match(nr.body.error, /no route list/);
  nr = await call('GET', '/api/admin/adapters');
  assert.equal(nr.body.adapters.find((a) => a.type === 'cdot').nearbyRoutes, true);
  assert.equal(r.body.town.timezone, 'America/Denver');
  r = await call('POST', '/api/admin/source/cdot-auto', { town: 'shiprock' });
  assert.match(r.body.error, /NMRoads lists no highway/);

  const towns = loadTowns(db);
  const ship = towns.find((t) => t.id === 'shiprock');
  const fcol = towns.find((t) => t.id === 'fortcollins');
  assert.equal(tileGaps(ship), 'no-roads no-lifts');
  assert.equal(tileGaps(fcol), 'no-lifts');
  const page = '<body class="{{bodyClass}}">{{roadsDisclaimer}}</body>';
  assert.equal(renderTemplate(page, '.html', ship, towns), '<body class="no-roads no-lifts"></body>');
  assert.match(renderTemplate(page, '.html', fcol, towns), /Road data source:<\/strong> The data made available here/);
});

test('town picker and hub: grouped by state A-Z, towns A-Z, searchable', async () => {
  const { groupByState, townMenu, townSearchText } = await import('../src/brand.js');
  const t = (id, name, state) => ({ id, name, state, hostnames: [`${id}.thetown.buzz`], brand: {} });
  const towns = [t('telluride', 'Telluride', 'CO'), t('shiprock', 'Shiprock', 'NM'), t('durango', 'Durango', 'CO'), t('moab', 'Moab', 'UT'), t('x', 'Nowhere', '')];
  assert.deepEqual(groupByState(towns).map((g) => [g.state, g.towns.map((x) => x.name)]),
    [['Colorado', ['Durango', 'Telluride']], ['New Mexico', ['Shiprock']], ['Utah', ['Moab']], ['Other', ['Nowhere']]]);
  assert.equal(townSearchText(towns[1]), 'shiprock nm new mexico shiprock.thetown.buzz');
  const html = townMenu(towns[0], towns);
  assert.match(html, /data-town-search/);
  assert.ok(html.indexOf('>Colorado<') < html.indexOf('>New Mexico<') && html.indexOf('>New Mexico<') < html.indexOf('>Utah<'));
  assert.ok(html.indexOf('Durango, CO') < html.indexOf('Telluride, CO'));
});

test('roads: NMRoads (New Mexico) feeds the Roads tile, picks highways and shows its fine print', async () => {
  const { nmroadsToItems, nmLevel, suggestNmroadsSource, NM_FEED } = await import('../src/sources/nmroads.js');
  const { tileGaps, renderTemplate } = await import('../src/brand.js');
  // A trimmed copy of nmroads.com/nmroads.json (Nov 23 2026); the US-491 roadwork is made up for the test.
  const feed = JSON.parse(fx('nmroads.json'));
  const shiprock = { lat: 36.7856, lon: -108.687 };
  const now = Date.parse('2026-11-23T22:00:00Z');

  assert.equal(nmLevel({ event_type: 'Closure', name: 'Closure' }), 'closed');
  assert.equal(nmLevel({ event_type: 'Seasonal Closure' }), 'closed');
  assert.equal(nmLevel({ event_type: 'Difficult Driving Conditions' }), 'caution');
  assert.equal(nmLevel({ event_type: 'work-zone', name: 'Lane Closure', vehicle_impact: 'unknown' }), 'caution');
  assert.equal(nmLevel({ event_type: 'work-zone', name: 'Roadwork', vehicle_impact: 'unknown' }), 'ok');
  assert.equal(nmLevel({ event_type: 'work-zone', name: 'Roadwork', vehicle_impact: 'Right lane closed.' }), 'caution');

  const town = { id: 'shiprock', bbox: { minLat: 36.43, maxLat: 37.14, minLon: -109.14, maxLon: -108.24 },
    cdot: { routes: [{ label: 'US-491', match: ['US-491'] }, { label: 'US-64', match: ['US-64'] }], keyPlaces: ['Shiprock'] } };
  const items = nmroadsToItems(feed, town, now);
  assert.deepEqual(items.map((i) => i._route).sort(), ['US-491', 'US-64']); // NM-134 and US-550 are outside the box
  const lane = items.find((i) => i._route === 'US-64');
  assert.equal(lane._level, 'caution');
  assert.equal(lane.sourceLabel, 'NMDOT NMRoads');
  assert.equal(lane.expiresAt, null); // NMRoads' 2099 "until further notice"
  assert.match(lane.title, /^US-64: Lane Closure, US 64/);
  assert.ok(items.find((i) => i._route === 'US-491').expiresAt > now);

  // Highways picked from the map point: the ones NMRoads has events on nearby.
  const asked = [];
  const json = async (url) => { asked.push(url); return feed; };
  const ok = await suggestNmroadsSource({ name: 'Shiprock', state: 'NM', location: shiprock }, { json });
  assert.equal(ok.source.adapter, 'nmroads');
  assert.deepEqual(JSON.parse(ok.source.settings.routes), [{ match: ['US-64'], label: 'US-64' }, { match: ['US-491'], label: 'US-491' }]);
  assert.deepEqual(asked, [NM_FEED]);
  assert.match((await suggestNmroadsSource({ name: 'Durango', state: 'CO', location: shiprock }, { json })).error, /New Mexico/);

  // Admin: a New Mexico town gets NMRoads on Create town; the source runs and fills the tile.
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet, deps: { json } });
  const login = fakeReq('POST', '/api/admin/login', { body: { password: 'correct horse battery' } });
  const cookie = (await admin.handle(login.req, login.url, login.read)).headers['Set-Cookie'].split(';')[0];
  const call = async (method, p, body) => { const r = fakeReq(method, p, { cookie, body }); return admin.handle(r.req, r.url, r.read); };
  let r = await call('POST', '/api/admin/town', { create: true, town: { id: 'shiprock', name: 'Shiprock', state: 'NM', location: shiprock } });
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual(r.body.roads, { routes: ['US-64', 'US-491'], dot: 'NMRoads' });
  r = await call('POST', '/api/admin/source/cdot-auto', { town: 'shiprock' });
  assert.match(r.body.error, /already has NMRoads/);
  let nr = await call('POST', '/api/admin/source/nearby-routes', { town: 'shiprock', adapter: 'nmroads' });
  assert.deepEqual(nr.body.routes.map((x) => x.label).slice(0, 2), ['US-64', 'US-491']);
  assert.deepEqual(nr.body.routes[0].match, ['US-64']);

  const towns = loadTowns(db);
  const ship = towns.find((t) => t.id === 'shiprock');
  const src = ship.sources.find((s) => s.adapter === 'nmroads');
  await jobFor(ship, src, { json }).run(db);
  const tile = db.getTiles('shiprock').roads;
  assert.equal(tile.shortName, 'NMDOT');
  assert.equal(tile.link, 'https://nmroads.com/');
  assert.deepEqual(tile.routes.map((x) => [x.label, x.level]), [['US-64', 'caution'], ['US-491', 'ok']]);
  assert.ok(db.feed('shiprock').some((i) => i.source === 'nmroads-events'));
  assert.equal(tileGaps(ship), 'no-lifts');
  assert.match(renderTemplate('{{roadsDisclaimer}}', '.html', ship, towns), /Road data source:<\/strong> Road information comes from the New Mexico Department of Transportation/);
  assert.match(renderTemplate('{{aboutRoadsFine}}', '.html', ship, towns), /NMRoads/);
  assert.doesNotMatch(renderTemplate('{{aboutRoadsFine}}', '.html', ship, towns), /CDOT/);
  const tel = towns.find((t) => t.id === 'telluride');
  assert.match(renderTemplate('{{aboutRoadsFine}}', '.html', tel, towns), /Department of Transportation \(CDOT\)/);

  // A failed fetch keeps the tile honest.
  await assert.rejects(jobFor(ship, src, { json: async () => { throw new Error('HTTP 403'); } }).run(openDb(':memory:')), /403/);
});
