import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPage, resourceFromUrl, cleanUrl, privateIp, formatHours, formatPhone, nameFromTitle, contactLink } from '../src/page-info.js';
import { createAdmin } from '../src/admin.js';
import { openDb } from '../src/db.js';

const RESTAURANT = `<!doctype html><html><head>
<title>Home | La Cocina de Luz – Telluride</title>
<meta name="description" content="Organic Mexican food on Colorado Avenue. Order at the counter, eat in or take out. We also cater!">
<meta property="og:site_name" content="La Cocina de Luz">
<link rel="canonical" href="https://www.lacocinadeluz.com/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"WebSite","name":"La Cocina de Luz","url":"https://www.lacocinadeluz.com/"},
 {"@type":"Restaurant","name":"La Cocina de Luz","telephone":"(970) 728-9355",
  "address":{"@type":"PostalAddress","streetAddress":"123 E Colorado Ave","addressLocality":"Telluride","addressRegion":"CO","postalCode":"81435"},
  "servesCuisine":["Mexican"],"priceRange":"$$","url":"https://www.lacocinadeluz.com/",
  "openingHoursSpecification":[
   {"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday"],"opens":"09:00","closes":"21:00"},
   {"@type":"OpeningHoursSpecification","dayOfWeek":"https://schema.org/Saturday","opens":"10:00","closes":"21:00"}]}]}
</script></head><body><h1>La Cocina de Luz</h1></body></html>`;

test('page info: schema.org restaurant fills every field', () => {
  const { resource: r, found } = readPage(RESTAURANT, 'https://www.lacocinadeluz.com/');
  assert.equal(r.name, 'La Cocina de Luz');
  assert.equal(r.category, 'food');
  assert.equal(r.phone, '970-728-9355');
  assert.equal(r.address, '123 E Colorado Ave, Telluride, CO 81435');
  assert.equal(r.hours, 'Mon to Fri 9 a.m. to 9 p.m., Sat 10 a.m. to 9 p.m.');
  assert.equal(r.tags, 'Mexican · $$');
  assert.equal(r.website, 'https://www.lacocinadeluz.com/');
  assert.match(r.note, /^Organic Mexican food/);
  assert.equal(found.phone, 'structured data');
});

test('page info: no structured data falls back to tags, tel: links and page text', () => {
  const html = `<html><head><title>Welcome - Mountain Lodge at Telluride</title>
    <meta property="og:description" content="Ski-in ski-out hotel rooms and condos."></head>
    <body><a href="tel:+19707285000">Call us</a><footer>Find us at 457 Mountain Village Blvd, Telluride, CO 81435 &middot; Hours: Daily 7am - 10pm</footer></body></html>`;
  const { resource: r, found } = readPage(html, 'https://mountainlodge.example.com/');
  assert.equal(r.name, 'Mountain Lodge at Telluride');
  assert.equal(r.phone, '970-728-5000');
  assert.equal(r.address, '457 Mountain Village Blvd, Telluride, CO 81435');
  assert.equal(r.category, 'lodging');
  assert.equal(found.category, 'a guess from the words on the page');
  assert.match(r.hours, /Daily 7am - 10pm/);
});

test('page info: helpers', () => {
  assert.equal(formatPhone('+1 (970) 728-3848'), '970-728-3848');
  assert.equal(formatPhone('970.728.3848'), '970-728-3848');
  assert.equal(formatPhone('nope'), '');
  assert.equal(formatHours({ openingHours: ['Mo-Su 00:00-23:59'] }), 'Open 24 hours');
  assert.equal(formatHours({ openingHours: 'Mo-Fr 08:00-17:00, Sa 09:00-12:00' }), 'Mon to Fri 8 a.m. to 5 p.m., Sat 9 a.m. to noon');
  assert.equal(formatHours({ openingHours: 'Fr-Sa 17:30-22:00' }), 'Fri and Sat 5:30 p.m. to 10 p.m.');
  assert.equal(nameFromTitle('Home | Town of Telluride'), 'Town of Telluride');
  assert.equal(contactLink('<a href="/about">About</a><a href="https://x.org/contact-us/">Contact</a><a href="https://other.org/contact">x</a>', 'https://x.org/'), 'https://x.org/contact-us/');
});

test('page info: refuses addresses that are not on the public web', () => {
  assert.equal(cleanUrl('example.com/menu'), 'https://example.com/menu');
  for (const bad of ['', 'ftp://example.com', 'http://localhost:3000', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://[::1]/', 'http://printer.local/', 'http://user:pw@example.com/']) {
    assert.throws(() => cleanUrl(bad), undefined, bad);
  }
  assert.ok(privateIp('192.168.1.1') && privateIp('169.254.169.254') && privateIp('::ffff:127.0.0.1') && privateIp('fd00::1'));
  assert.ok(!privateIp('8.8.8.8') && !privateIp('2606:4700::1111'));
});

const page = (body, init = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('page info: follows redirects, reads a contact page for missing details, blocks private redirects', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === 'https://shop.example.com/') return new Response('', { status: 301, headers: { location: '/home' } });
    if (url === 'https://shop.example.com/home') return page('<title>Wagner Custom Skis</title><a href="/contact">Contact</a>');
    if (url === 'https://shop.example.com/contact') return page('Call 970-728-6901. 620 Mountain Village Blvd, Telluride, CO 81435');
    throw new Error(`unexpected ${url}`);
  };
  const out = await resourceFromUrl('shop.example.com', { fetchImpl, lookup: publicDns });
  assert.equal(out.resource.name, 'Wagner Custom Skis');
  assert.equal(out.resource.phone, '970-728-6901');
  assert.equal(out.resource.address, '620 Mountain Village Blvd, Telluride, CO 81435');
  assert.equal(out.resource.website, 'https://shop.example.com/home');
  assert.equal(out.resource.category, 'shops');
  assert.match(out.found.phone, /on \/contact$/);
  assert.deepEqual(out.pages, ['https://shop.example.com/home', 'https://shop.example.com/contact']);

  const sneaky = async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
  await assert.rejects(resourceFromUrl('https://x.example.com/', { fetchImpl: sneaky, lookup: publicDns }), /not on the public web/);
  await assert.rejects(resourceFromUrl('https://inside.example.com/', { fetchImpl: sneaky, lookup: async () => [{ address: '10.1.2.3', family: 4 }] }), /not on the public web/);
});

test('page info: a site that blocks the server says so and points to Fill with AI', async () => {
  const fetchImpl = async () => new Response('nope', { status: 403 });
  await assert.rejects(resourceFromUrl('https://blocked.example.com/', { fetchImpl, lookup: publicDns }), (e) => e.blocked === true && /Fill with AI/.test(e.message));
});

test('admin: GET /resource-from-url returns the filled resource, or the blocked error', async () => {
  const db = openDb(':memory:');
  const quiet = { info() {}, warn() {}, error() {} };
  const fetchImpl = async (url) => (url.includes('blocked') ? new Response('', { status: 429 }) : page(RESTAURANT));
  const admin = createAdmin({ db, password: 'correct horse battery', log: quiet, deps: { pageFetch: { fetchImpl, lookup: publicDns } } });
  const req = (method, p, { cookie = '', body } = {}) => ({
    req: { method, headers: { host: 'localhost:3000', cookie, 'content-type': 'application/json' } },
    url: new URL(`http://localhost:3000${p}`), read: async () => body || {},
  });
  const login = await admin.handle(...Object.values(req('POST', '/api/admin/login', { body: { password: 'correct horse battery' } })));
  const cookie = String(login.headers['Set-Cookie']).split(';')[0];
  const ok = await admin.handle(...Object.values(req('GET', '/api/admin/resource-from-url?url=lacocinadeluz.com', { cookie })));
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.resource.phone, '970-728-9355');
  const no = await admin.handle(...Object.values(req('GET', '/api/admin/resource-from-url?url=blocked.example.com', { cookie })));
  assert.equal(no.status, 502);
  assert.equal(no.body.blocked, true);
});
