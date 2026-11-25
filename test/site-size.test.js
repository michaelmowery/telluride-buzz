import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importConfigs } from '../src/towns.js';
import { createAdmin } from '../src/admin.js';
import { folderBytes, siteSize } from '../src/site-size.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const configs = fs.readdirSync(path.join(root, 'config')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'config', f), 'utf8')));
const quiet = { info() {}, warn() {} };
const item = (id, title) => ({ extId: id, sourceLabel: 'Test', category: 'news', title, publishedAt: Date.now() });

test('site size: database, counts per town, data files, code and disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-size-'));
  try {
    const db = openDb(path.join(dir, 'buzz.db'));
    importConfigs(db, configs);
    const town = db.listTowns()[0].id;
    db.syncItems(town, 'test', [item('a', 'One'), item('b', 'Two')]);
    db.syncItems(town, 'test', [item('a', 'One')]); // b drops out of the feed
    db.saveResource(town, { category: 'emergency', name: 'Marshal', phone: '970-555-0100' });
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.writeFileSync(path.join(dir, 'backups', 'buzz-2026-11-24.db'), Buffer.alloc(5000));
    fs.writeFileSync(path.join(dir, 'vapid.json'), '{"k":1}');

    const z = siteSize({ db, dataDir: dir, appDir: root });
    assert.ok(z.database.bytes > 0);
    assert.equal(z.totals.towns, configs.length);
    assert.equal(z.totals.items, 2);
    assert.equal(z.totals.itemsActive, 1);
    assert.equal(z.totals.resources, 1);
    assert.ok(z.totals.sources > 0 && z.totals.sourcesOn <= z.totals.sources);
    const t = z.towns.find((x) => x.id === town);
    assert.deepEqual([t.items, t.itemsActive, t.resources], [2, 1, 1]);
    assert.equal(z.towns.reduce((s, x) => s + x.sources, 0), z.totals.sources);
    assert.deepEqual(z.files.backups, { bytes: 5000, count: 1 });
    assert.equal(z.files.otherBytes, 7); // vapid.json
    assert.ok(z.files.dataFolderBytes >= z.database.bytes + 5000);
    assert.ok(z.app.bytes > 0 && z.app.publicBytes < z.app.bytes);
    assert.ok(z.disk.totalBytes > 0 && z.disk.freeBytes <= z.disk.totalBytes);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('site size: a missing folder is 0, demo mode has no files or disk', () => {
  assert.deepEqual(folderBytes('/no/such/folder'), { bytes: 0, files: 0 });
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const z = siteSize({ db, dataDir: '/no/such/folder', appDir: root, demo: true });
  assert.equal(z.database.bytes, null);
  assert.equal(z.disk, null);
  assert.equal(z.totals.towns, configs.length);
});

test('Admin settings answers with the site size (signed in only)', async () => {
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const admin = createAdmin({ db, password: 'correct horse battery', env: {}, siteSize: () => siteSize({ db, dataDir: '/nowhere', appDir: root, demo: true }), log: quiet });
  const call = (method, p, { cookie, body } = {}) => {
    const req = { method, headers: { host: 'telluride.buzz', cookie, 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '1.2.3.4' } };
    return admin.handle(req, new URL(`https://telluride.buzz${p}`), async () => body || {});
  };
  assert.equal((await call('GET', '/api/admin/server-settings')).status, 401);
  const login = await call('POST', '/api/admin/login', { body: { password: 'correct horse battery' } });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  const s = await call('GET', '/api/admin/server-settings', { cookie });
  assert.equal(s.status, 200);
  assert.equal(s.body.size.totals.towns, configs.length);
});
