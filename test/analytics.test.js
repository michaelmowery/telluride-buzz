// Visit counts through the self-hosted Umami (src/analytics.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { clientIp, createAnalytics } from '../src/analytics.js';

const ID = '3f2a6c1e-8b4d-4e2a-9c1f-0a1b2c3d4e5f';
const quiet = { warn() {} };

function fakeReq({ method = 'POST', headers = {}, body = '' } = {}) {
  const r = Readable.from(body ? [Buffer.from(body)] : []);
  r.method = method;
  r.headers = headers;
  r.socket = { remoteAddress: '172.18.0.5' };
  return r;
}

test('off without a valid Website ID: no tags, /stats 404s', async () => {
  for (const env of [{}, { UMAMI_WEBSITE_ID: 'not-an-id' }]) {
    const a = createAnalytics(env, { log: quiet, fetchImpl: () => assert.fail('no fetch when off') });
    assert.equal(a.enabled, false);
    assert.equal(a.inject('<head></head>', 'telluride'), '<head></head>');
    assert.equal((await a.handle(fakeReq({ method: 'GET' }), '/stats/script.js')).status, 404);
  }
});

test('on: pages load the script from their own address, tagged with the town', () => {
  const a = createAnalytics({ UMAMI_WEBSITE_ID: ID }, { log: quiet });
  const html = a.inject('<html><head><title>x</title></head><body></body></html>', 'durango');
  assert.match(html, new RegExp(`<script defer src="/stats/script.js" data-website-id="${ID}" data-host-url="/stats" data-tag="durango"`));
  assert.match(html, /<script defer src="\/stats\.js\?v=1" data-town="durango"><\/script>\s*<\/head>/);
  assert.equal(a.dashboardUrl, 'https://analytics.meander.me');
});

test('script is fetched from Umami once and cached', async () => {
  let calls = 0;
  const a = createAnalytics({ UMAMI_WEBSITE_ID: ID, UMAMI_URL: 'http://umami:3000/' }, {
    log: quiet,
    fetchImpl: async (url) => { calls++; assert.equal(url, 'http://umami:3000/script.js'); return new Response('console.log(1)'); },
  });
  for (let i = 0; i < 2; i++) {
    const r = await a.handle(fakeReq({ method: 'GET' }), '/stats/script.js');
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), 'console.log(1)');
    assert.match(r.headers['Content-Type'], /javascript/);
  }
  assert.equal(calls, 1);
});

test('events go to Umami with the visitor address, only for our website', async () => {
  let sent = null;
  const a = createAnalytics({ UMAMI_WEBSITE_ID: ID }, {
    log: quiet,
    fetchImpl: async (url, opts) => { sent = { url, ...opts }; return new Response('{"cache":"abc"}', { headers: { 'content-type': 'application/json' } }); },
  });
  const body = JSON.stringify({ type: 'event', payload: { website: ID, hostname: 'telluride.buzz', url: '/', name: 'tab', data: { tab: 'eat' } } });
  const r = await a.handle(fakeReq({ body, headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '203.0.113.9', 'x-umami-cache': 'tok' } }), '/stats/api/send');
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), '{"cache":"abc"}');
  assert.equal(sent.url, 'http://umami:3000/api/send');
  assert.equal(sent.headers['X-Client-IP'], '203.0.113.9');
  assert.equal(sent.headers['User-Agent'], 'Mozilla/5.0');
  assert.equal(sent.headers['x-umami-cache'], 'tok');
  assert.equal(sent.body.toString(), body);

  sent = null;
  const other = JSON.stringify({ type: 'event', payload: { website: '00000000-0000-0000-0000-000000000000' } });
  assert.equal((await a.handle(fakeReq({ body: other }), '/stats/api/send')).status, 400);
  assert.equal((await a.handle(fakeReq({ body: 'nope' }), '/stats/api/send')).status, 400);
  assert.equal((await a.handle(fakeReq({ body: 'x'.repeat(20000) }), '/stats/api/send')).status, 413);
  assert.equal(sent, null);
});

test('Umami down: send answers 502, the page still works', async () => {
  const a = createAnalytics({ UMAMI_WEBSITE_ID: ID }, { log: quiet, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const body = JSON.stringify({ type: 'event', payload: { website: ID } });
  assert.equal((await a.handle(fakeReq({ body }), '/stats/api/send')).status, 502);
  assert.equal((await a.handle(fakeReq({ method: 'GET' }), '/stats/script.js')).status, 503);
});

test('client address: the entry Caddy added, else the socket', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' } }), '203.0.113.9');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
});
