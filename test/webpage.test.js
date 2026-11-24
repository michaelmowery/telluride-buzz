import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { pageToPosts, webpageJob, findDate } from '../src/sources/webpage.js';
import { kindOf, validateSource } from '../src/adapters.js';

const PAGE = `<html><body>
<nav><a href="/news/">News</a><a href="/about/">About</a></nav>
<div class="post"><h3><a href="/news/opening-day-moved-to-dec-5/">Opening Day Moved to December 5</a></h3>
  <span class="date">November 18, 2026</span><a href="/news/opening-day-moved-to-dec-5/">Read more</a></div>
<div class="post"><h3>Gondola Reopens for the Winter Season</h3>
  <time datetime="2026-11-20T08:00:00-07:00">Nov 20</time><a href="/news/gondola-reopens">Read more</a></div>
<div class="post"><a href="https://www.example.org/news/solar-park-breaks-ground?x=1#top">Solar Park Breaks Ground Near Town</a></div>
<a href="/news/category/press/">Press releases archive</a>
<a href="https://elsewhere.com/news/a-story-on-another-site">A story on another site entirely</a>
</body></html>`;
const cfg = { url: 'https://example.org/news/', linkPattern: '/news/', exclude: '/category/' };

test('webpage: reads post links, headlines and dates; skips nav, other sites and excluded links', () => {
  const posts = pageToPosts(PAGE, cfg);
  assert.deepEqual(posts.map((p) => p.title), ['Opening Day Moved to December 5', 'Gondola Reopens for the Winter Season', 'Solar Park Breaks Ground Near Town']);
  assert.equal(posts[0].link, 'https://example.org/news/opening-day-moved-to-dec-5/');
  assert.equal(new Date(posts[0].date).toISOString(), '2026-11-18T07:00:00.000Z');
  assert.equal(new Date(posts[1].date).toISOString(), '2026-11-20T15:00:00.000Z');
  assert.equal(posts[2].link, 'https://www.example.org/news/solar-park-breaks-ground?x=1');
});

test('webpage: dates in several formats', () => {
  assert.ok(findDate('Posted 11/18/2026 by staff', 'America/Denver'));
  assert.ok(findDate('18 November 2026', 'America/Denver'));
  assert.ok(findDate('Sept. 3, 2026', 'America/Denver'));
  assert.equal(findDate('no date here', 'America/Denver'), null);
});

test('webpage job: undated posts keep the time first seen; first read sinks them below today', async () => {
  const db = openDb(':memory:');
  const town = { id: 't', timezone: 'America/Denver' };
  let html = '<a href="/news/old-story-one">An older story from last month</a>';
  const job = webpageJob(town, { url: 'https://x.org/news', linkPattern: '/news/', key: 'page-x', label: 'X' }, { get: async () => html });
  await job.run(db);
  const first = db.firstSeen('t', 'page-x').get('https://x.org/news/old-story-one');
  assert.ok(first < Date.now() - 2 * 86400e3);
  html = '<a href="/news/brand-new-story">A brand new story just posted</a>' + html;
  await job.run(db);
  const seen = db.firstSeen('t', 'page-x');
  assert.equal(seen.get('https://x.org/news/old-story-one'), first);
  assert.ok(seen.get('https://x.org/news/brand-new-story') > Date.now() - 60e3);
  db.close();
});

test('webpage source: kind comes from settings and pattern is required', () => {
  assert.equal(kindOf({ adapter: 'webpage', settings: { category: 'town' } }), 'town');
  assert.match(validateSource({ adapter: 'webpage', key: 'page-x', label: 'X', settings: { url: 'https://x.org', category: 'news' } }, { name: 'T' }), /contain/);
});

test('webpage: "only links with a date" drops undated menu links when post addresses share nothing', () => {
  const html = `<nav><a href="/member-newsletter-and-annual-meeting-info">Member Newsletter and Annual Meeting</a></nav>
    <div><a href="/smpa-pursues-historic-renewable-energy-purchase">SMPA Pursues Historic Renewable Energy Purchase</a><p>October 6, 2026</p></div>`;
  const posts = pageToPosts(html, { url: 'https://www.smpa.com/Posts', linkPattern: '/^\\/[a-z0-9-]{20,}$/', requireDate: true });
  assert.deepEqual(posts.map((p) => p.title), ['SMPA Pursues Historic Renewable Energy Purchase']);
});
