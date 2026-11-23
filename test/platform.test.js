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
  assert.equal(back.town.hostnames[0], 'telluride.buzz');
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
