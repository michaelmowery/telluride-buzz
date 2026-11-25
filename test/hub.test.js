import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_HOSTS, adminHostRedirect, renderHub, snapshot, townForPath } from '../src/hub.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const towns = fs.readdirSync(path.join(root, 'config')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'config', f), 'utf8')));
const hub = fs.readFileSync(path.join(root, 'public', 'hub.html'), 'utf8');

test('hub page lists every town with its address and fills every placeholder', () => {
  const out = renderHub(hub, towns, () => []);
  assert.ok(!/\{\{\w+\}\}/.test(out));
  assert.match(out, /href="https:\/\/telluride\.thetown\.buzz"/);
  assert.match(out, /href="https:\/\/durango\.thetown\.buzz"/);
  assert.ok(!/durango\.buzz/i.test(out), 'must not imply we own durango.buzz');
});

test('snapshot shows weather, new snow and alerts, and skips missing data', () => {
  const s = snapshot({ weather: { ok: true, temp: 23.6, short: 'Snow' }, lifts: { ok: true, new24: 4 } }, [{}, {}]);
  assert.deepEqual(s.map((b) => b.k), ['weather', 'snow', 'alert']);
  assert.match(s[0].html, /24°/);
  assert.deepEqual(snapshot({ weather: { ok: false } }, []), []);
});

test('/durango maps to the Durango town; unknown paths do not', () => {
  assert.equal(townForPath('/durango', towns)?.id, 'durango');
  assert.equal(townForPath('/Telluride/', towns)?.id, 'telluride');
  assert.equal(townForPath('/nowhere', towns), null);
  assert.equal(townForPath('/', towns), null);
});

test('admin.thetown.buzz serves only the admin; every other page goes to /admin', () => {
  assert.ok(ADMIN_HOSTS.has('admin.thetown.buzz'));
  for (const p of ['/admin', '/admin/', '/admin.js', '/admin.css', '/admin/analytics', '/api/admin/towns', '/api/admin/login', '/api/tls-ask', '/healthz', '/icons/favicon.svg', '/robots.txt']) {
    assert.equal(adminHostRedirect(p), null, p);
  }
  for (const p of ['/', '/index.html', '/about', '/food-drink', '/api/home', '/api/feed', '/sitemap.xml', '/telluride', '/app.js']) {
    assert.equal(adminHostRedirect(p), '/admin', p);
  }
});
