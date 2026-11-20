import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadVapid, vapidAuthHeader, validSubscription, pushNewAlerts } from '../src/push.js';

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'buzz-push-'));
const town = { id: 'telluride' };
const quiet = { info() {}, warn() {} };
const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('VAPID keys persist and the JWT verifies with the public key', () => {
  const dir = tmp();
  const keys = loadVapid(dir);
  assert.deepEqual(loadVapid(dir), keys, 'same keys on second load');
  assert.equal(b64(keys.publicKey).length, 65);

  const h = vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://telluride.buzz');
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [hd, cl, sig] = jwt.split('.');
  const claims = JSON.parse(b64(cl).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://telluride.buzz');
  const raw = b64(keys.publicKey);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${cl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64(sig)));
});

test('Only real push services are accepted as subscription endpoints', () => {
  assert.ok(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' }));
  assert.ok(validSubscription({ endpoint: 'https://web.push.apple.com/abc' }));
  assert.ok(validSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x' }));
  assert.ok(!validSubscription({ endpoint: 'http://fcm.googleapis.com/x' }));
  assert.ok(!validSubscription({ endpoint: 'https://evil.example.com/x' }));
  assert.ok(!validSubscription({ endpoint: 'https://googleapis.com.evil.com/x' }));
  assert.ok(!validSubscription(null));
});

test('New warnings are pushed once; stale ones and notices are not; dead subscriptions are dropped', async () => {
  const db = openDb(':memory:');
  const keys = loadVapid(tmp());
  db.addSubscription('telluride', 'https://fcm.googleapis.com/fcm/send/live');
  db.addSubscription('telluride', 'https://fcm.googleapis.com/fcm/send/dead');
  const now = Date.now();
  db.syncItems('telluride', 'nws-alerts', [
    { extId: 'warn', sourceLabel: 'NWS', category: 'weather', title: 'Winter Storm Warning', severity: 2, publishedAt: now - 60e3 },
    { extId: 'old', sourceLabel: 'NWS', category: 'weather', title: 'Old Warning', severity: 2, publishedAt: now - 5 * 3600e3 },
    { extId: 'adv', sourceLabel: 'NWS', category: 'weather', title: 'Advisory', severity: 1, publishedAt: now },
  ]);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    return { ok: !url.endsWith('dead'), status: url.endsWith('dead') ? 410 : 201 };
  };
  await pushNewAlerts(db, town, keys, 'https://telluride.buzz', { fetchImpl, log: quiet });
  assert.equal(calls.length, 2, 'one alert to two subscribers');
  assert.ok(calls[0].auth.startsWith('vapid t='));
  assert.equal(db.pushSubscriptions('telluride').length, 1, 'gone subscription removed');
  assert.equal(db.latestPush('telluride').title, 'Winter Storm Warning');

  calls.length = 0;
  await pushNewAlerts(db, town, keys, 'https://telluride.buzz', { fetchImpl, log: quiet });
  assert.equal(calls.length, 0, 'never pushed twice');
});
