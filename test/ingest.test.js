import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { alertsToItems, forecastToTile, nwsJobs } from '../src/sources/nws.js';
import { incidentsToItems, workZonesToItems, buildRoadsTile, cdotJobs, classify, cleanCondition } from '../src/sources/cdot.js';
import { feedToItems } from '../src/sources/feeds.js';
import { parseSnowReport, liftsJobs } from '../src/sources/lifts.js';
import { parseLocalDateTime } from '../src/time.js';
import { redact } from '../src/http.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const fxj = (f) => JSON.parse(fx(f));
const town = JSON.parse(fs.readFileSync(path.join(dir, '..', '..', 'config', 'telluride.json'), 'utf8'));

test('NWS alerts map severity: warnings go to the banner, advisories do not', () => {
  const items = alertsToItems(fxj('nws-alerts.json'));
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Winter Storm Warning');
  assert.equal(items[0].severity, 2);
  assert.equal(items[1].severity, 1);
  assert.ok(items[0].summary.includes('8 to 14 inches'));
});

test('NWS forecast builds the weather tile', () => {
  const t = forecastToTile(fxj('nws-forecast.json'), fxj('nws-hourly.json'), town);
  assert.equal(t.temp, 24);
  assert.equal(t.hi, 29);
  assert.equal(t.lo, 12);
  assert.equal(t.snow, '3 to 5 inches');
});

test('CDOT incidents: keeps local routes, drops Denver and far stretches of CO-145', () => {
  const items = incidentsToItems(fxj('cdot-incidents.json'), town);
  assert.deepEqual(items.map((i) => i.extId).sort(), ['inc-1', 'inc-2']);
  const closure = items.find((i) => i.extId === 'inc-2');
  assert.equal(closure.severity, 2);
  assert.equal(closure._route, 'CO-62');
  assert.equal(items.find((i) => i.extId === 'inc-1')._level, 'caution');
});

test('CDOT classify does not treat a lane closure as a road closure', () => {
  assert.equal(classify('Right lane closed for maintenance'), 'ok');
  assert.equal(classify('Road closed both directions'), 'closed');
  assert.equal(classify('Chain law in effect'), 'caution');
});

test('Roads tile summarises each route and carries the CDOT disclaimer', () => {
  const tile = buildRoadsTile(town, {
    incidents: incidentsToItems(fxj('cdot-incidents.json'), town),
    workZones: workZonesToItems(fxj('cdot-wzdx.json'), town),
  });
  const byRoute = Object.fromEntries(tile.routes.map((r) => [r.label, r]));
  assert.equal(byRoute['CO-62'].level, 'closed');
  assert.equal(byRoute['CO-145'].level, 'caution');
  assert.equal(byRoute['US-550'].level, 'ok');
  assert.match(tile.disclaimer, /State of Colorado, Department of Transportation \(CDOT\)/);
});

test('CDOT without a key fails gracefully: error recorded, tile says unavailable', async () => {
  const db = openDb(':memory:');
  const [job] = cdotJobs(town, { apiKey: '' });
  await assert.rejects(job.run(db), /CDOT_API_KEY/);
  const tile = db.getTiles(town.id).roads;
  assert.equal(tile.ok, false);
  assert.ok(tile.updatedAt);
  assert.ok(tile.routes.every((r) => r.level === 'unknown'), 'no green dots without data');
});

test('API keys are redacted from URLs in errors', () => {
  assert.equal(redact('https://x/api/v1/incidents?apiKey=SECRET123&b=1'), 'https://x/api/v1/incidents?apiKey=***&b=1');
});

test('CivicPlus calendar RSS yields an event with a local start time', () => {
  const feed = town.feeds.find((f) => f.id === 'town-calendar');
  const [ev] = feedToItems(fx('civic-calendar.xml'), feed, town);
  assert.equal(ev.title, 'Town Council Regular Meeting');
  assert.equal(new Date(ev.startsAt).toISOString(), '2099-12-01T15:30:00.000Z'); // 8:30 MST
  assert.ok(ev.summary.startsWith('Rebekah Hall'));
});

test('WordPress RSS: entities decoded, HTML stripped, old posts skipped', () => {
  const feed = town.feeds.find((f) => f.id === 'koto');
  const items = feedToItems(fx('wp-feed.xml'), feed, town);
  // the 2026-11-20 post is only kept if it is within 21 days of "now"
  const recent = items.filter((i) => i.title.startsWith('Commissioners'));
  assert.ok(items.every((i) => i.title !== 'Old story'));
  if (recent.length) {
    assert.equal(recent[0].title, 'Commissioners & council meet on housing');
    assert.match(recent[0].summary, /^The joint session focused on workforce housing/);
    assert.ok(!recent[0].summary.includes('<'));
  }
});

test('Snow report parser reads visible numbers and rejects nonsense', () => {
  const r = parseSnowReport(fx('snow-report.html'));
  assert.equal(r.new24, 6);
  assert.equal(r.new48, 9);
  assert.equal(r.base, 31);
  assert.equal(r.liftsOpen, 9);
  assert.equal(r.liftsTotal, 19);
  assert.equal(r.trailsOpen, 42);
  const junk = parseSnowReport('<p>Lifts 99 / 3</p><p>24 hours 400"</p>');
  assert.equal(junk.liftsOpen, null);
  assert.equal(junk.new24, null);
});

test('Snow report: Telluride page layout (overnight, snow depth, 0/17 lifts)', () => {
  const r = parseSnowReport(fx('snow-report-tsr.html'));
  assert.equal(r.overnight, 6);
  assert.equal(r.new24, 0);
  assert.equal(r.base, 12);
  assert.equal(r.liftsOpen, 0);
  assert.equal(r.liftsTotal, 17);
  assert.equal(r.trailsTotal, 149);
});

test('Lifts tile falls back to a link when the page cannot be read', async () => {
  const db = openDb(':memory:');
  const [job] = liftsJobs(town, { get: async () => '<html>Something else entirely</html>' });
  await assert.rejects(job.run(db));
  const tile = db.getTiles(town.id).lifts;
  assert.equal(tile.ok, false);
  assert.ok(tile.link.startsWith('https://'));
});

test('Items sync: banner shows warnings, cleared alerts disappear', async () => {
  const db = openDb(':memory:');
  let alerts = fxj('nws-alerts.json');
  const get = async (url) => (url.includes('/alerts/') ? alerts : null);
  const [alertJob] = nwsJobs(town, { get });
  await alertJob.run(db);
  assert.equal(db.alerts(town.id).length, 1);
  assert.equal(db.feed(town.id).length, 2);
  alerts = { features: [] };
  await alertJob.run(db);
  assert.equal(db.alerts(town.id).length, 0);
  assert.equal(db.feed(town.id).length, 0);
});

test('Local time parsing handles daylight saving', () => {
  assert.equal(new Date(parseLocalDateTime('America/Denver', 'July 4, 2027', '10:00 AM')).toISOString(), '2027-07-04T16:00:00.000Z');
  assert.equal(new Date(parseLocalDateTime('America/Denver', '12/24/2026', '6:00 PM')).toISOString(), '2026-12-25T01:00:00.000Z');
});

test('Backup writes a usable copy of the database', () => {
  const db = openDb(':memory:');
  db.setTile('telluride', 'weather', { ok: true, temp: 1 });
  const out = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'buzz-')), 'b.db');
  db.backupTo(out);
  const copy = openDb(out);
  assert.equal(copy.getTiles('telluride').weather.temp, 1);
});

test('CDOT condition codes are cleaned for display', () => {
  assert.equal(cleanCondition('4 - wet, forecast text included'), 'Wet');
  assert.equal(cleanCondition('4s - wet in areas, forecast text included'), 'Wet in areas');
  assert.equal(cleanCondition('Snow packed'), 'Snow packed');
});

test('Source update times: snow report "Last Updated" and the newest CDOT stamp', async () => {
  const { reportUpdatedAt } = await import('../src/sources/lifts.js');
  const { buildRoadsTile } = await import('../src/sources/cdot.js');
  const now = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(new Date(reportUpdatedAt('Last Updated: November 20, 2026 at 3:39pm', 'America/Denver', now)).toISOString(), '2026-11-20T22:39:00.000Z');
  assert.equal(reportUpdatedAt('Last Updated: November 20, 2030 at 3:39pm', 'America/Denver', now), null, 'future dates rejected');
  assert.equal(reportUpdatedAt('no date here'), null);
  const town = { cdot: { routes: [{ label: 'CO-145' }] } };
  const t1 = Date.now() - 3600e3, t2 = Date.now() - 600e3;
  const tile = buildRoadsTile(town, { incidents: [{ _route: 'CO-145', _level: 'caution', title: 'CO-145: x', _at: t1 }], conditions: { 'CO-145': [{ text: 'Dry', level: 'ok', at: t2 }] } });
  assert.equal(tile.sourceAt, t2);
  assert.equal(buildRoadsTile(town, {}).sourceAt, null);
});
