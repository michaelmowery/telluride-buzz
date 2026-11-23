// Admin: copy or move a source to another town.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importConfigs } from '../src/towns.js';
import { createAdmin } from '../src/admin.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const configs = fs.readdirSync(path.join(root, 'config')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'config', f), 'utf8')));
const quiet = { info() {}, warn() {} };

async function setup() {
  const db = openDb(':memory:');
  importConfigs(db, configs);
  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet });
  const call = async (p, body, cookie) => admin.handle(
    { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, socket: {} },
    new URL(`http://localhost/api/admin${p}`), async () => body);
  const login = await call('/login', { password: 'correct horse battery' });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  return { db, move: (body) => call('/source/move', body, cookie) };
}
const post = (extId, severity = 0) => ({ extId, sourceLabel: 'KOTO', category: 'news', title: `Post ${extId}`, severity, publishedAt: Date.now() });
const keys = (db, town) => db.listSources(town).map((s) => s.key);
const items = (db, town) => db.feed(town, { limit: 100 }).filter((i) => i.source === 'feed-koto' || i.source === 'feed-koto-2');

test('copy adds the same feed to another town and leaves the original', async () => {
  const { db, move } = await setup();
  db.syncItems('telluride', 'feed-koto', [post('a')]);
  const r = await move({ town: 'telluride', key: 'feed-koto', to: 'durango', mode: 'copy' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, town: 'durango', key: 'feed-koto' });
  assert.ok(keys(db, 'telluride').includes('feed-koto'));
  const copy = db.listSources('durango').find((s) => s.key === 'feed-koto');
  const orig = db.listSources('telluride').find((s) => s.key === 'feed-koto');
  assert.deepEqual(copy.settings, orig.settings);
  assert.equal(items(db, 'telluride').length, 1, 'original keeps its posts');
  // A second copy gets a fresh key instead of clashing.
  const again = await move({ town: 'telluride', key: 'feed-koto', to: 'durango', mode: 'copy' });
  assert.ok(again.body.key && again.body.key !== 'feed-koto', again.body.key);
});

test('move takes the source, its posts and health to the other town', async () => {
  const { db, move } = await setup();
  db.syncItems('telluride', 'feed-koto', [post('a'), post('b', 2)]);
  db.recordStatus?.('telluride', 'feed-koto', { ok: true });
  const r = await move({ town: 'telluride', key: 'feed-koto', to: 'durango', mode: 'move' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!keys(db, 'telluride').includes('feed-koto'));
  assert.ok(keys(db, 'durango').includes('feed-koto'));
  assert.equal(items(db, 'telluride').length, 0);
  assert.equal(items(db, 'durango').length, 2);
  assert.equal(db.unpushedAlerts('durango').filter((a) => a.source === 'feed-koto').length, 0, 'moved alerts are not pushed again');
});

test('move refuses a key the other town already uses, and bad targets', async () => {
  const { db, move } = await setup();
  await move({ town: 'telluride', key: 'feed-koto', to: 'durango', mode: 'copy' });
  const r = await move({ town: 'telluride', key: 'feed-koto', to: 'durango', mode: 'move' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already has a source/);
  assert.equal((await move({ town: 'telluride', key: 'feed-koto', to: 'telluride', mode: 'move' })).status, 400);
  assert.equal((await move({ town: 'telluride', key: 'nope', to: 'durango', mode: 'copy' })).status, 404);
  // One-per-town types (like CDOT) can't be doubled up.
  const c = await move({ town: 'telluride', key: 'cdot', to: 'durango', mode: 'copy' });
  assert.equal(c.status, 400);
  assert.match(c.body.error, /already has/);
  assert.ok(keys(db, 'telluride').includes('feed-koto'));
});
