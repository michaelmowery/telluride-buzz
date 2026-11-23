// Town resources: database, admin API, seed import and the public page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importConfigs, loadTowns } from '../src/towns.js';
import { createAdmin } from '../src/admin.js';
import { importResources, normalizeResource, renderResources, telHref } from '../src/resources.js';
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
  assert.match(page, /<h1>Telluride resources<\/h1>/);
  assert.match(page, /href="tel:911"/);
  assert.match(html, /class="res-search"/);
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
