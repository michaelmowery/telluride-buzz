// Search tags, structured data, sitemaps and robots.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessJson, feedSnapshot, guideDescription, guideFor, guideJsonLd, postalAddress, robotsTxt, seoHead, sitemapXml, townSitemap } from '../src/seo.js';
import { renderResources } from '../src/resources.js';

const town = { id: 'telluride', name: 'Telluride', state: 'CO', url: 'https://telluride.buzz', hostnames: ['telluride.buzz'], timezone: 'America/Denver', brand: { siteName: 'Telluride.Buzz' } };
const NOW = Date.parse('2026-12-10T18:00:00Z');
const list = [
  { id: 1, category: 'food', name: 'There Bar', phone: '970-555-0101', website: 'https://there.example/', address: '627 W Pacific Ave', note: 'Small plates', updatedAt: Date.parse('2026-11-20T12:00:00Z') },
  { id: 2, category: 'food', name: 'Paid Café', phone: '970-555-0102', website: 'https://paid.example/', address: '100 Main St, Mountain Village, CO 81435',
    sponsored: true, sponsorFrom: '2026-12-01', sponsorUntil: '2026-12-31', sponsorTagline: 'Best coffee in town!', updatedAt: Date.parse('2026-11-21T12:00:00Z') },
  { id: 3, category: 'food', name: 'Hidden Diner', phone: '970-555-0103', hidden: true },
  { id: 4, category: 'medical', name: 'Medical Center', phone: '970-728-3848', address: '333 W Pacific Ave' },
];

test('addresses become schema.org PostalAddress, keeping another locality and the zip', () => {
  assert.deepEqual(postalAddress('627 W Pacific Ave', town), { '@type': 'PostalAddress', streetAddress: '627 W Pacific Ave', addressLocality: 'Telluride', addressCountry: 'US', addressRegion: 'CO' });
  const mv = postalAddress('100 Main St, Mountain Village, CO 81435', town);
  assert.equal(mv.streetAddress, '100 Main St');
  assert.equal(mv.addressLocality, 'Mountain Village');
  assert.equal(mv.postalCode, '81435');
  assert.equal(postalAddress('1 Elk Ave, CO 81435', town).addressLocality, 'Telluride');
});

test('guide JSON-LD lists visible businesses in page order and leaves sponsorship out', () => {
  const [crumbs, items] = guideJsonLd(list, town, guideFor('/food-drink'), NOW);
  assert.equal(crumbs['@type'], 'BreadcrumbList');
  assert.equal(crumbs.itemListElement[1].item, 'https://telluride.buzz/food-drink');
  assert.equal(items['@type'], 'ItemList');
  assert.deepEqual(items.itemListElement.map((x) => x.item.name), ['Paid Café', 'There Bar']); // sponsor first, like the page; hidden left out
  assert.equal(items.itemListElement[0].item['@type'], 'FoodEstablishment');
  const json = JSON.stringify(items);
  assert.doesNotMatch(json, /Best coffee|sponsor/i);
  assert.equal(businessJson({ category: 'lodging', name: 'Inn' }, town)['@type'], 'LodgingBusiness');
  // Essentials gets breadcrumbs only (no business markup for 911 or the clinic).
  assert.equal(guideJsonLd(list, town, guideFor('/essentials'), NOW).length, 1);
});

test('sponsored website links carry rel="sponsored"; normal ones do not', () => {
  const html = renderResources(list, town, NOW, 'eat');
  assert.match(html, /href="https:\/\/paid\.example\/" target="_blank" rel="sponsored noopener"/);
  assert.match(html, /href="https:\/\/there\.example\/" target="_blank" rel="noopener"/);
});

test('head tags: canonical on the town address, escaped, noindex for drafts and when asked', () => {
  const h = seoHead(town, { path: '/food-drink', title: 'Food "&" drink', description: 'Eat <here>', jsonLd: [{ x: '</script><b>' }] });
  assert.match(h, /<link rel="canonical" href="https:\/\/telluride\.buzz\/food-drink">/);
  assert.match(h, /og:title" content="Food &quot;&amp;&quot; drink"/);
  assert.match(h, /og:description" content="Eat &lt;here&gt;"/);
  assert.doesNotMatch(h, /<\/script><b>/);
  assert.doesNotMatch(h, /noindex/);
  assert.match(seoHead(town, { title: 'x', description: 'y', noindex: true }), /noindex, follow/);
  assert.match(seoHead({ ...town, status: 'draft' }, { title: 'x', description: 'y' }), /noindex, follow/);
  // A town reached at durango.thetown.buzz without a url falls back to its first hostname.
  assert.match(seoHead({ name: 'Durango', hostnames: ['durango.thetown.buzz'] }, { title: 'x', description: 'y' }), /href="https:\/\/durango\.thetown\.buzz\/"/);
});

test('descriptions name a few listings', () => {
  assert.match(guideDescription(list, town, guideFor('/food-drink')), /^2 restaurants, cafés and bars in Telluride, CO.*There Bar, Paid Café\.$/);
  assert.match(guideDescription([], town, guideFor('/lodging')), /coming soon/);
});

test('sitemap lists home, about and guide pages with listings; drafts list nothing', () => {
  const entries = townSitemap(town, list, { latestPost: NOW });
  assert.deepEqual(entries.map((e) => e.loc), ['https://telluride.buzz/', 'https://telluride.buzz/about', 'https://telluride.buzz/food-drink', 'https://telluride.buzz/essentials']);
  const xml = sitemapXml(entries);
  assert.match(xml, /<loc>https:\/\/telluride\.buzz\/food-drink<\/loc><lastmod>2026-11-21<\/lastmod>/);
  assert.match(xml, /^<\?xml version="1\.0"/);
  assert.deepEqual(townSitemap({ ...town, status: 'draft' }, list), []);
  assert.equal(robotsTxt('https://telluride.buzz'), 'User-agent: *\nDisallow: /admin\nDisallow: /api/\n\nSitemap: https://telluride.buzz/sitemap.xml\n');
});

test('feed snapshot is escaped and only links to http(s)', () => {
  const html = feedSnapshot([
    { id: 1, category: 'news', sourceLabel: 'KOTO', title: 'Snow <b>day</b>', summary: 'More', link: 'https://koto.org/x', publishedAt: NOW, severity: 0 },
    { id: 2, category: 'town', sourceLabel: 'Town', title: 'Bad link', link: 'javascript:alert(1)', publishedAt: NOW, severity: 1 },
  ], town);
  assert.match(html, /Snow &lt;b&gt;day&lt;\/b&gt;/);
  assert.match(html, /href="https:\/\/koto\.org\/x"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /datetime="2026-12-10T18:00:00\.000Z"/);
  assert.equal(feedSnapshot([], town), '');
});
