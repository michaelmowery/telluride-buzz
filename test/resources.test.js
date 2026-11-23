// Town resources: database, admin API, seed import and the public page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importConfigs, loadTowns } from '../src/towns.js';
import { createAdmin } from '../src/admin.js';
import { importResources, normalizeResource, planCsvImport, renderResources, resourcesToCsv, sponsorActive, telHref } from '../src/resources.js';
import { renderTemplate } from '../src/brand.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const configs = fs.readdirSync(path.join(root, 'config')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'config', f), 'utf8')));
const seed = JSON.parse(fs.readFileSync(path.join(root, 'config', 'resources', 'telluride.json'), 'utf8'));
const quiet = { info() {}, warn() {} };

function setup() {
  const db = openDb(':memory:');
  importConfigs(db, configs);
  return db;
}

test('phone numbers become tel: links; junk is refused', () => {
  assert.equal(telHref('911'), 'tel:911');
  assert.equal(telHref('(970) 728-3848'), 'tel:9707283848');
  assert.equal(telHref('1-800-222-1222 ext 4'), 'tel:18002221222,4');
  assert.equal(telHref('call us'), null);
  assert.match(normalizeResource({ name: 'X', category: 'medical', phone: 'call us' }).error, /phone/);
  assert.match(normalizeResource({ name: 'X', category: 'nope', phone: '911' }).error, /category/);
  assert.match(normalizeResource({ name: 'X', category: 'medical' }).error, /at least/);
  // Emergency entries can be a note only; others can't.
  assert.equal(normalizeResource({ name: 'Mountain Rescue', category: 'emergency', note: 'Call 911 and ask for Mountain Rescue.' }).error, undefined);
  assert.equal(normalizeResource({ name: 'X', category: 'medical', emergency: true, note: 'Call 911.' }).error, undefined);
  assert.match(normalizeResource({ name: 'X', category: 'medical', note: 'Call 911.' }).error, /at least/);
  assert.match(normalizeResource({ name: 'X', category: 'emergency' }).error, /note/);
  assert.equal(normalizeResource({ name: 'X', category: 'medical', website: 'tellmed.org' }).resource.website, 'https://tellmed.org/');
  assert.match(normalizeResource({ name: 'X', category: 'medical', website: 'javascript:alert(1)' }).error, /web address/);
});

test('every seed entry is valid, and the seed imports once', () => {
  for (const r of seed.resources) assert.equal(normalizeResource(r).error, undefined, r.name);
  const db = setup();
  assert.deepEqual(importResources(db, [seed, { town: 'nowhere', resources: [{ name: 'X', category: 'medical', phone: '911' }] }]), ['telluride']);
  const list = db.listResources('telluride');
  assert.equal(list.length, seed.resources.length);
  assert.ok(list.every((r) => r.checkedAt === Date.parse(`${seed.checked}T12:00:00Z`)));
  db.deleteResource('telluride', list[0].id);
  assert.deepEqual(importResources(db, [seed]), []);
  assert.equal(db.listResources('telluride').length, seed.resources.length - 1);
  assert.equal(db.listResources('nowhere').length, 0);
});

test('admin adds, edits, reorders, checks and deletes resources', async () => {
  const db = setup();
  let changes = 0;
  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet, onResources: () => changes++ });
  const call = async (method, p, body, cookie) => admin.handle(
    { method, headers: { host: 'localhost', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, socket: {} },
    new URL(`http://localhost/api/admin${p}`), async () => body);
  const login = await call('POST', '/login', { password: 'correct horse battery' });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  assert.equal((await call('GET', '/resources?town=telluride')).status, 401);

  const a = await call('POST', '/resource', { town: 'telluride', resource: { name: 'Clinic', category: 'medical', phone: '970-555-0100' }, checked: true }, cookie);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await call('POST', '/resource', { town: 'telluride', resource: { name: 'Pharmacy', category: 'medical', website: 'example.com' } }, cookie);
  assert.ok(b.body.resource.sort > a.body.resource.sort);
  assert.ok(a.body.resource.checkedAt && !b.body.resource.checkedAt);
  assert.equal((await call('POST', '/resource', { town: 'telluride', resource: { name: '', category: 'medical', phone: '911' } }, cookie)).status, 400);
  // An id from another town can't be edited through this one.
  assert.equal((await call('POST', '/resource', { town: 'durango', resource: { ...a.body.resource, name: 'Hijack' } }, cookie)).status, 404);

  await call('POST', '/resource', { town: 'telluride', resource: { ...a.body.resource, name: 'Clinic (main)' } }, cookie);
  await call('POST', '/resource/order', { town: 'telluride', ids: [b.body.resource.id, a.body.resource.id] }, cookie);
  let list = (await call('GET', '/resources?town=telluride', undefined, cookie)).body.resources;
  assert.deepEqual(list.map((r) => r.name), ['Pharmacy', 'Clinic (main)']);
  await call('POST', '/resource/checked', { town: 'telluride', ids: [b.body.resource.id] }, cookie);
  assert.ok(db.listResources('telluride')[0].checkedAt);
  await call('POST', '/resource/delete', { town: 'telluride', id: a.body.resource.id }, cookie);
  list = db.listResources('telluride');
  assert.equal(list.length, 1);
  assert.equal(changes, 6);
});

test('public page: emergency box first, categories collapsible, hidden left out, text escaped', () => {
  const db = setup();
  const town = loadTowns(db).find((t) => t.id === 'telluride');
  for (const r of [
    { name: 'Emergency', category: 'emergency', phone: '911' },
    { name: 'Medical Center', category: 'medical', phone: '970-728-3848', emergency: true, address: '500 W Pacific Ave' },
    { name: '<b>Library</b>', category: 'schools', website: 'https://telluridelibrary.org' },
    { name: 'Secret', category: 'utilities', phone: '970-555-0199', hidden: true },
  ]) db.saveResource('telluride', normalizeResource(r).resource);
  const html = renderResources(db.listResources('telluride'), town);
  assert.ok(html.indexOf('res-emergency') < html.indexOf('id="medical"'));
  assert.match(html, /<details class="res-cat res-emergency"/);
  assert.match(html, /href="tel:911"/);
  assert.equal((html.match(/Medical Center/g) || []).length, 2); // emergency box and its own section
  assert.match(html, /query=500%20W%20Pacific%20Ave%2C%20Telluride%2C%20CO/);
  assert.match(html, /&lt;b&gt;Library/);
  assert.doesNotMatch(html, /Secret/);
  assert.doesNotMatch(html, /id="utilities"/);
  const page = renderTemplate(fs.readFileSync(path.join(root, 'public', 'resources.html'), 'utf8'), '.html', town, [town], { resources: html });
  assert.match(page, /<h1>Telluride essentials<\/h1>/);
  assert.match(page, /href="tel:911"/);
  assert.match(html, /class="res-search"/);
  db.saveResource('telluride', normalizeResource({ name: 'Gondola', category: 'transit', website: 'https://x.org', hours: 'Daily 6:30 a.m. to midnight' }).resource);
  assert.match(renderResources(db.listResources('telluride'), town), /class="res-hours"><span aria-hidden="true">🕒<\/span> Daily 6:30 a.m. to midnight/);
  assert.match(html, /data-cat="emergency">Emergency</);
  assert.match(html, /data-cat="schools">Schools &amp; library</);
  assert.doesNotMatch(html, /data-cat="utilities"/); // only hidden entries there
  assert.match(renderResources([], town), /on the way/);
});

test('deleting a town removes its resources', () => {
  const db = setup();
  db.saveResource('durango', normalizeResource({ name: 'X', category: 'medical', phone: '911' }).resource);
  db.deleteTown('durango');
  assert.equal(db.listResources('durango').length, 0);
});

test('CSV export round-trips through import, and import previews before writing', async () => {
  const { parseCsv, planCsvImport, resourcesToCsv } = await import('../src/resources.js');
  const db = setup();
  importResources(db, [seed]);
  const towns = loadTowns(db);
  const csv = resourcesToCsv(db.listResources('telluride'));
  const rows = parseCsv(csv);
  assert.equal(rows.length, seed.resources.length + 1);
  // Unchanged export imports as pure updates with no errors.
  let plan = planCsvImport(csv, { towns, existing: db.listResources(null) });
  assert.equal(plan.errors.length, 0, JSON.stringify(plan.errors));
  assert.equal(plan.adds.length, 0);
  assert.equal(plan.updates.length, seed.resources.length);
  // Quotes, commas, newlines and formula-looking text survive.
  assert.deepEqual(parseCsv('a,b\r\n"x, ""y""","line1\nline2"\r\n'), [['a', 'b'], ['x, "y"', 'line1\nline2']]);
  assert.match(resourcesToCsv([{ id: 1, townId: 't', category: 'medical', name: '=HYPERLINK("x")', phone: '911' }]), /'=HYPERLINK/);

  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet });
  const call = async (method, p, body, cookie) => admin.handle(
    { method, headers: { host: 'localhost', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, socket: {} },
    new URL(`http://localhost/api/admin${p}`), async () => body);
  const cookie = (await call('POST', '/login', { password: 'correct horse battery' })).headers['Set-Cookie'].split(';')[0];
  const ex = await call('GET', '/resources/export?town=telluride', undefined, cookie);
  assert.equal(ex.type, 'text/csv; charset=utf-8');
  assert.match(ex.headers['Content-Disposition'], /resources-telluride-/);
  const all = await call('GET', '/all-resources', undefined, cookie);
  assert.equal(all.body.resources.length, seed.resources.length);
  assert.equal(all.body.towns.length, 2);

  const upload = 'town,category,name,phone,hours,emergency\n'
    + 'durango,Medical,Mercy Hospital,970-247-4311,24/7,yes\n'
    + ',schools,Durango Library,970-375-3380,,\n'
    + 'durango,nope,Bad Row,970-555-0100,,\n';
  let r = await call('POST', '/resources/import', { csv: upload, town: 'durango' }, cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.adds, 2);
  assert.equal(r.body.errors.length, 1);
  assert.equal(r.body.errors[0].line, 4);
  assert.equal(db.listResources('durango').length, 0, 'preview writes nothing');
  // Apply imports the good rows and skips (and reports) the bad one.
  r = await call('POST', '/resources/import', { csv: upload, town: 'durango', apply: true }, cookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.adds, 2);
  assert.equal(r.body.errors.length, 1);
  assert.equal((await call('POST', '/resources/import', { csv: 'town,category,name\ndurango,nope,Bad', town: 'durango', apply: true }, cookie)).status, 400);
  const dur = db.listResources('durango');
  assert.deepEqual(dur.map((x) => [x.name, x.category, x.emergency, x.hours]), [['Mercy Hospital', 'medical', true, '24/7'], ['Durango Library', 'schools', false, '']]);
  // An id from another town is refused, not moved.
  plan = planCsvImport(`id,town,category,name,phone\n${dur[0].id},telluride,medical,X,911\n`, { towns, existing: db.listResources(null) });
  assert.match(plan.errors[0].error, /No resource/);
});

test('local businesses sit under their own heading, with tags', () => {
  const town = { id: 'telluride', name: 'Telluride', state: 'CO', timezone: 'America/Denver' };
  const list = [
    { id: 1, category: 'medical', name: 'Clinic', phone: '970-555-0100', sort: 10 },
    { id: 2, category: 'food', name: 'Taco Spot', phone: '970-555-0101', tags: 'Mexican · $', sort: 20 },
    { id: 3, category: 'lodging', name: 'Inn', website: 'https://inn.example', sort: 30 },
  ];
  const html = renderResources(list, town);
  const heading = html.indexOf('id="local-businesses"');
  assert.ok(heading > html.indexOf('id="medical"') && heading < html.indexOf('id="food"') && html.indexOf('id="food"') < html.indexOf('id="lodging"'));
  assert.match(html, /class="res-tags">Mexican · \$</);
  assert.equal(renderResources(list.slice(0, 1), town).includes('local-businesses'), false);
  const csv = resourcesToCsv([{ ...list[1], townId: 'telluride' }]);
  assert.match(csv.split('\r\n')[0], /,note,tags,/);
  assert.match(csv, /Mexican · \$/);
});

test('sponsored listings: business only, first in category, labelled, end on their date', () => {
  const ok = (r) => normalizeResource({ name: 'X', phone: '970-555-0100', ...r });
  const sp = { sponsored: true, sponsorFrom: '2026-12-01', sponsorUntil: '2026-12-31' };
  assert.match(ok({ category: 'medical', ...sp }).error, /business/);
  assert.match(ok({ category: 'food', emergency: true, ...sp }).error, /Emergency/);
  assert.match(ok({ category: 'food', sponsored: true }).error, /date/);
  assert.match(ok({ category: 'food', ...sp, sponsorUntil: '2026-11-01' }).error, /ends before/);
  assert.match(ok({ category: 'food', ...sp, sponsorLogo: 'http://x.example/l.png' }).error, /https/);
  assert.equal(ok({ category: 'food', sponsorFrom: '2026-12-01' }).resource.sponsorFrom, '', 'off means no dates kept');

  const db = setup();
  const save = (r) => db.saveResource('telluride', ok(r).resource);
  save({ name: 'Plain Cafe', category: 'food', sort: 10 });
  const sid = save({ name: 'Sponsor Bistro', category: 'food', sort: 20, sponsorTagline: 'Happy hour 3 to 5', sponsorLogo: 'https://bistro.example/logo.png', ...sp });
  save({ name: 'Emergency line', category: 'emergency', phone: '911', sort: 5 });
  const list = db.listResources('telluride');
  assert.ok(list.find((r) => r.id === sid).sponsored);
  const town = { id: 'telluride', name: 'Telluride', state: 'CO', timezone: 'America/Denver' };
  const at = (iso) => renderResources(list, town, Date.parse(iso));

  const during = at('2026-12-31T23:30:00-07:00'); // still Dec 31 in Telluride
  const food = during.slice(during.indexOf('id="food"'));
  assert.ok(food.indexOf('Sponsor Bistro') < food.indexOf('Plain Cafe'), 'sponsor first');
  assert.match(food, /res-sponsored[\s\S]*Sponsored[\s\S]*Happy hour 3 to 5/);
  assert.match(food, /<img class="res-logo" src="https:\/\/bistro.example\/logo.png"/);
  const emergency = during.slice(0, during.indexOf('</details>'));
  assert.equal(emergency.includes('Sponsored'), false);

  for (const when of ['2026-11-30T12:00:00-07:00', '2027-01-01T00:30:00-07:00']) {
    const html = at(when);
    assert.equal(html.includes('res-sponsored'), false, when);
    const f = html.slice(html.indexOf('id="food"'));
    assert.ok(f.indexOf('Plain Cafe') < f.indexOf('Sponsor Bistro'), 'back to admin order');
  }
  assert.equal(sponsorActive(list.find((r) => r.id === sid), '2026-12-15'), true);

  // A CSV update (no sponsor columns) keeps the sponsorship.
  const s = list.find((r) => r.id === sid);
  const plan = planCsvImport(`id,town,category,name,phone\n${sid},telluride,food,Sponsor Bistro & Bar,970-555-0100\n`,
    { towns: db.listTowns(), existing: list });
  assert.equal(plan.errors.length, 0, JSON.stringify(plan.errors));
  db.saveResource('telluride', plan.updates[0].resource);
  const after = db.listResources('telluride').find((r) => r.id === sid);
  assert.equal(after.name, 'Sponsor Bistro & Bar');
  assert.deepEqual([after.sponsored, after.sponsorUntil, after.sponsorTagline], [true, s.sponsorUntil, s.sponsorTagline]);
});

test('home page tabs: Essentials, Food & drink, Shops (shops + services), Lodging', () => {
  const town = { id: 'telluride', name: 'Telluride', state: 'CO', timezone: 'America/Denver' };
  const list = [
    { id: 1, category: 'emergency', name: 'Dispatch', phone: '911', sort: 1 },
    { id: 2, category: 'medical', name: 'Clinic', phone: '970-555-0100', sort: 2 },
    { id: 3, category: 'food', name: 'Taco Spot', phone: '970-555-0101', sort: 3 },
    { id: 4, category: 'shops', name: 'Ski Shop', phone: '970-555-0102', sort: 4 },
    { id: 5, category: 'services', name: 'Plumber', phone: '970-555-0103', sort: 5 },
    { id: 6, category: 'lodging', name: 'Inn', phone: '970-555-0104', sort: 6 },
  ];
  const tab = (t) => renderResources(list, town, Date.now(), t);
  const ess = tab('essentials');
  assert.match(ess, /res-emergency/);
  assert.match(ess, /Clinic/);
  assert.equal(/Taco|Ski Shop|Plumber|Inn/.test(ess), false);
  const eat = tab('eat');
  assert.match(eat, /Taco Spot/);
  assert.equal(/Dispatch|res-emergency|res-subtabs|local-businesses/.test(eat), false, 'one section: no sub-tabs, no emergency box');
  assert.match(eat, /<details class="res-cat" id="food" open>/);
  const shop = tab('shop');
  assert.match(shop, /Ski Shop[\s\S]*Plumber/);
  assert.match(shop, /res-subtabs[\s\S]*data-cat="shops"[\s\S]*data-cat="services"/);
  assert.match(tab('stay'), /Inn/);
  assert.match(renderResources(list.slice(0, 2), town, Date.now(), 'stay'), /Places to stay are on the way/);
});
