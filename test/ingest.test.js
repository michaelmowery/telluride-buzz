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

test('meander.me: only posts tagged for Telluride.Buzz, linked back to meander.me', async () => {
  const { meanderToItems, meanderUrl, meanderJobs } = await import('../src/sources/meander.js');
  const now = Date.parse('2026-11-22T12:00:00Z');
  const items = meanderToItems(fxj('meander-posts.json'), town.meander, now);
  assert.deepEqual(items.map((i) => i.title), ['First chair at Gold Hill', 'Backdated hike']);
  assert.equal(items[0].link, 'https://meander.me/posts/first-chair-gold-hill');
  assert.equal(items[0].sourceLabel, 'Meander.me');
  assert.equal(items[0].publishedAt, Date.parse('2026-11-20T15:00:00Z'));
  assert.equal(items[1].publishedAt, Date.parse('2026-10-05T12:00:00-07:00'));
  const url = decodeURIComponent(meanderUrl('http://strapi:1337', town.meander));
  assert.ok(url.startsWith('http://strapi:1337/api/posts?'));
  assert.ok(url.includes('filters[$or][0][tags][slug][$eqi]=telluride-buzz'));

  // Falls back to the public API when the private address is unreachable.
  const tried = [];
  const [job] = meanderJobs(town, { get: async (u) => { tried.push(u); if (u.startsWith('http://strapi')) throw new Error('ENOTFOUND'); return fxj('meander-posts.json'); } });
  const db = openDb(':memory:');
  await job.run(db);
  assert.equal(tried.length, 2);
  assert.ok(tried[1].startsWith('https://cms.meander.me/'));
});

test('Snow report: an unchanged report never shows up twice in the feed', async () => {
  const db = openDb(':memory:');
  const [job] = liftsJobs(town, { get: async () => fx('snow-report-tsr.html') });
  await job.run(db);
  // A post left over from an earlier day with the same numbers.
  db.syncItems(town.id, 'lifts-snow', [{ extId: 'new-snow-2000-01-01', sourceLabel: 'Telluride Ski Resort', category: 'lifts', title: '6" of new snow overnight', summary: 'Base depth 12".', publishedAt: Date.now() - 864e5 }], { deactivateMissing: false });
  await job.run(db);
  const snow = db.feed(town.id).filter((i) => i.category === 'lifts');
  assert.equal(snow.length, 1);
  assert.equal(snow[0].title, 'Telluride Ski Resort: 6" of new snow overnight');
});

test('Snow report: live Telluride layout reads 24h/48h/7-day, season total and condition', () => {
  const r = parseSnowReport(fx('snow-report-tsr-live.html'));
  // The "8" last 24 hr" summary box is followed by "Lifts Status 0/17"; that 0 is not snowfall.
  assert.equal(r.new24, 8);
  assert.equal(r.overnight, 3);
  assert.equal(r.new48, 8);
  assert.equal(r.new7d, 8);
  assert.equal(r.base, 20);
  assert.equal(r.season, 24);
  assert.equal(r.condition, 'Variable');
  assert.deepEqual([r.liftsOpen, r.liftsTotal, r.trailsOpen, r.trailsTotal], [0, 17, 0, 149]);
});

test('Purgatory snow report: 72 hour and season totals, value before label', () => {
  const r = parseSnowReport(fx('snow-report-purgatory-72.html'), 'America/Denver', { valueFirst: true });
  assert.deepEqual([r.new24, r.new48, r.new72, r.base, r.season], [8, 8, 11, 20, 34]);
  assert.equal(r.new7d, null);
  const older = parseSnowReport(fx('snow-report-purgatory.html'), 'America/Denver', { valueFirst: true });
  assert.deepEqual([older.new7d, older.season], [7, 26]);
});

test('Purgatory snow report: values come before labels (3" 24 Hr, 2 of 12 Lifts Open)', () => {
  const r = parseSnowReport(fx('snow-report-purgatory.html'), 'America/Denver', { valueFirst: true });
  assert.equal(r.new24, 3);
  assert.equal(r.new48, 3);
  assert.equal(r.base, 14);
  assert.deepEqual([r.liftsOpen, r.liftsTotal], [2, 12]);
  assert.deepEqual([r.trailsOpen, r.trailsTotal], [5, 114]);
});

test('Several resorts in one town: the tile lists each mountain by name', async () => {
  const { resortsOf } = await import('../src/sources/lifts.js');
  const two = { ...town, id: 'two', lifts: [
    { url: 'https://a.example/', label: 'Purgatory Resort', name: 'Purgatory', valueFirst: true },
    { url: 'https://b.example/', label: 'Telluride Ski Resort' },
  ] };
  assert.deepEqual(resortsOf(two).map((r) => [r.id, r.name]), [['main', 'Purgatory'], ['resort-2', 'Telluride Ski Resort']]);
  const db = openDb(':memory:');
  const pages = { 'https://a.example/': fx('snow-report-purgatory.html'), 'https://b.example/': fx('snow-report-tsr.html') };
  const jobs = liftsJobs(two, { get: async (u) => pages[u] });
  assert.deepEqual(jobs.map((j) => j.id), ['lifts-snow', 'lifts-snow-resort-2']);
  await jobs[1].run(db);
  await jobs[0].run(db);
  const tile = db.getTiles('two').lifts;
  assert.deepEqual(tile.resorts.map((r) => r.name), ['Purgatory', 'Telluride Ski Resort']); // config order
  assert.equal(tile.resorts[0].base, 14);
  assert.equal(tile.name, undefined);
  const titles = db.feed('two').filter((i) => i.category === 'lifts').map((i) => i.title).sort();
  assert.deepEqual(titles, ['Purgatory: 3" of new snow in the last 24 hours', 'Telluride Ski Resort: 6" of new snow overnight']);
});

test('Resort alerts JSON: current alert shows, expired and future ones do not', async () => {
  const { resortAlertsToItems } = await import('../src/sources/resort-alerts.js');
  const now = Date.UTC(2026, 10, 20, 20, 0); // 1:00 PM MST
  const json = [
    { id: 'a', headline: 'Opening Day Is Here!', content: 'Ski and ride  off Lift 2.', starts: '202611201216', expires: '202611201700', link: { links_to: 'https://www.purgatory.ski/x/' } },
    { id: 'b', headline: 'Old', starts: '202611190800', expires: '202611191700' },
    { id: 'c', headline: 'Later', starts: '202611210800', expires: '202611211700' },
  ];
  const items = resortAlertsToItems(json, { label: 'Purgatory Resort' }, 'America/Denver', now);
  assert.deepEqual(items.map((i) => i.title), ['Opening Day Is Here!']);
  assert.equal(items[0].summary, 'Ski and ride off Lift 2.');
  assert.equal(items[0].expiresAt, Date.UTC(2026, 10, 21, 0, 0));
  assert.equal(items[0].category, 'lifts');
});

test('Events Calendar RSS: start time from pubDate, WordPress footer removed', () => {
  const xml = `<rss><channel><item><title>Thanksgiving Dinner</title><link>https://www.purgatory.ski/event/thanksgiving-dinner/</link>
    <pubDate>Thu, 26 Nov 2099 23:30:00 +0000</pubDate><guid>e1</guid>
    <description><![CDATA[<p>Buffet at Purgy’s.</p><p>The post <a href="x">Thanksgiving Dinner</a> appeared first on <a href="y">Purgatory Resort</a>.</p>]]></description></item></channel></rss>`;
  const [ev] = feedToItems(xml, { id: 'purgatory-events', label: 'Purgatory Resort', category: 'events', startFromPubDate: true }, town);
  assert.equal(ev.startsAt, Date.UTC(2099, 10, 26, 23, 30));
  assert.equal(ev.summary, 'Buffet at Purgy’s.');
});

test('Vail Resorts snow report: reads FR.snowReportData JSON, not the forecast text', async () => {
  const { fromVailResorts, reportUpdatedAt } = await import('../src/sources/lifts.js');
  const r = parseSnowReport(fx('snow-report-vail.html'));
  assert.deepEqual([r.overnight, r.new24, r.new48, r.new7d, r.base, r.season], [2, 2, 2, 13, 18, 24]);
  assert.equal(r.condition, 'Packed Powder');
  assert.ok(r.found >= 2);
  const v = fromVailResorts(fx('snow-report-vail.html'));
  const at = reportUpdatedAt(v.updatedText, 'America/Denver', Date.UTC(2026, 10, 24, 18));
  assert.equal(new Date(at).toISOString(), '2026-11-24T12:31:00.000Z');
  assert.equal(fromVailResorts('<script>FR.snowReportData = {broken;</script>'), null);
});

test('Vail Resorts lift & trail page fills lift and trail counts on the tile', async () => {
  const { fromVailTerrain } = await import('../src/sources/lifts.js');
  assert.deepEqual(fromVailTerrain(fx('terrain-status-vail.html')), { liftsOpen: 1, liftsTotal: 3, trailsOpen: 2, trailsTotal: 5 });
  assert.equal(fromVailTerrain('<p>nothing</p>'), null);
  const vail = { ...town, id: 'vail', lifts: { url: 'https://snow.example/report', liftsUrl: 'https://snow.example/terrain', name: 'Vail', label: 'Vail Mountain' } };
  const pages = { 'https://snow.example/report': fx('snow-report-vail.html'), 'https://snow.example/terrain': fx('terrain-status-vail.html') };
  const db = openDb(':memory:');
  const [job] = liftsJobs(vail, { get: async (u) => pages[u] });
  await job.run(db);
  const tile = db.getTiles('vail').lifts;
  assert.deepEqual([tile.new24, tile.base, tile.liftsOpen, tile.liftsTotal, tile.trailsOpen, tile.trailsTotal], [2, 18, 1, 3, 2, 5]);
  // A failing lift page leaves the snow numbers in place.
  const db2 = openDb(':memory:');
  const [job2] = liftsJobs(vail, { get: async (u) => { if (u.endsWith('terrain')) throw new Error('403'); return pages[u]; } });
  await job2.run(db2);
  const t2 = db2.getTiles('vail').lifts;
  assert.equal(t2.ok, true);
  assert.equal(t2.liftsTotal, null);
});

test('CDOT work zones: the same work zone listed twice (e.g. each direction) shows once', () => {
  const data = fxj('cdot-wzdx.json');
  const twin = JSON.parse(JSON.stringify(data.features[0]));
  twin.id = 'wz-1-eb';
  const items = workZonesToItems({ ...data, features: [data.features[0], twin] }, town);
  assert.equal(items.length, 1);
});

test('every resort fills the same snow fields, with a labelled headline number', async () => {
  const { normalizeSnow, SNOW_FIELDS } = await import('../src/sources/lifts.js');
  const tsr = parseSnowReport(fx('snow-report-tsr-live.html'));
  const purg = parseSnowReport(fx('snow-report-purgatory-72.html'), 'America/Denver', { valueFirst: true });
  const vail = parseSnowReport(fx('snow-report-vail.html'));
  for (const r of [tsr, purg, vail]) {
    for (const k of [...SNOW_FIELDS, 'newSnow', 'newSnowWindow']) assert.ok(k in r, `missing ${k}`);
  }
  // 24 hours wins when the resort gives it, even if overnight is bigger.
  assert.deepEqual([tsr.newSnow, tsr.newSnowWindow], [8, '24h']);
  assert.deepEqual([purg.newSnow, purg.newSnowWindow], [8, '24h']);
  assert.equal(purg.condition, null);
  const conflict = normalizeSnow({ overnight: 3, new24: 0 });
  assert.deepEqual([conflict.newSnow, conflict.newSnowWindow], [0, '24h']);
  // No 24-hour number: fall back to overnight and say so.
  const onlyOvernight = normalizeSnow({ overnight: 4 });
  assert.deepEqual([onlyOvernight.newSnow, onlyOvernight.newSnowWindow], [4, 'overnight']);
  assert.deepEqual([normalizeSnow({}).newSnow, normalizeSnow({}).newSnowWindow], [null, null]);
});
