import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { feedToItems } from '../src/sources/feeds.js';
import { parseIcs } from '../src/ical.js';
import { kindOf } from '../src/adapters.js';
import { categoryGuess, planClaudeSources } from '../src/claude-town.js';
import { eventEnd } from '../src/relevance.js';

const H = 3600e3;
const town = { id: 't', name: 'Testville', state: 'CO', timezone: 'America/Denver', sources: [] };

function seed(items) {
  const db = openDb(':memory:');
  const bySource = Map.groupBy(items, (i) => i.source || 'x');
  for (const [src, list] of bySource) db.syncItems('t', src, list.map((i, n) => ({ extId: `${src}-${n}`, sourceLabel: src, ...i })));
  return db;
}

test('feed: news by publish time, events by how close they are, urgent alerts on top', () => {
  const now = Date.now();
  const db = seed([
    { title: 'News 1h old', category: 'news', publishedAt: now - 1 * H },
    { title: 'News 5h old', category: 'news', publishedAt: now - 5 * H },
    { title: 'News 2 days old', category: 'news', publishedAt: now - 48 * H },
    // Published (fetched) just now, but happening in 2 days: must not jump to the top.
    { title: 'Event in 2 days', category: 'events', publishedAt: now, startsAt: now + 48 * H },
    { title: 'Event in 4h', category: 'events', publishedAt: now, startsAt: now + 4 * H },
    { title: 'Event in 10 days', category: 'events', publishedAt: now, startsAt: now + 240 * H },
    { title: 'Event ended', category: 'events', publishedAt: now - 30 * H, startsAt: now - 5 * H, expiresAt: now - 1 * H },
    { title: 'Advisory', category: 'weather', severity: 1, publishedAt: now - 3 * H, source: 'nws' },
    { title: 'Warning', category: 'weather', severity: 2, publishedAt: now - 20 * H, source: 'nws' },
  ]);
  const titles = db.feed('t').map((i) => i.title);
  assert.deepEqual(titles, [
    'Warning',          // pinned
    'News 1h old',
    'Event in 4h',      // ranks like 2h-old news
    'Advisory',
    'News 5h old',
    'Event in 2 days',  // ranks like 24h-old news
    'News 2 days old',
  ]);
});

test('feed: the Events filter lists every upcoming event by start time; ended ones are gone', () => {
  const now = Date.now();
  const db = seed([
    { title: 'Later', category: 'events', startsAt: now + 240 * H },
    { title: 'Soon', category: 'events', startsAt: now + 2 * H },
    { title: 'Over', category: 'events', startsAt: now - 6 * H, expiresAt: now - H },
    { title: 'Over, no end given', category: 'events', startsAt: now - 6 * H },
  ]);
  assert.deepEqual(db.feed('t', { category: 'events' }).map((i) => i.title), ['Soon', 'Later']);
});

test('feed: paging by offset continues where the first page stopped', () => {
  const now = Date.now();
  const db = seed(Array.from({ length: 7 }, (_, n) => ({ title: `N${n}`, category: 'news', publishedAt: now - n * H })));
  const a = db.feed('t', { limit: 4 }).map((i) => i.title);
  const b = db.feed('t', { limit: 4, offset: 4 }).map((i) => i.title);
  assert.deepEqual([...a, ...b], ['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6']);
});

test('eventEnd: own end, else 3 hours, or the whole day for all-day events', () => {
  assert.equal(eventEnd(1000, 5000), 5000);
  assert.equal(eventEnd(0, null), null);
  assert.equal(eventEnd(H, null), 4 * H);
  assert.equal(eventEnd(H, null, true), 25 * H);
});

test('iCal: DTEND is read so events leave the feed when they end', () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
SUMMARY:Concert
DTSTART:20991201T020000Z
DTEND:20991201T040000Z
END:VEVENT
END:VCALENDAR`;
  const [e] = parseIcs(ics, 'America/Denver', Date.UTC(2099, 0, 1));
  assert.equal(e.end - e.start, 2 * H);
});

test('mixed news feed: posts with a clear upcoming date become events only when ticked', () => {
  const d = new Date(Date.now() + 5 * 86400e3);
  const when = d.toLocaleDateString('en-US', { timeZone: 'America/Denver', month: 'long', day: 'numeric', year: 'numeric' });
  const xml = `<rss><channel>
    <item><title>Holiday market</title><guid>1</guid><pubDate>${new Date().toUTCString()}</pubDate><description>Join us ${when} at 6:00 PM in the park.</description></item>
    <item><title>Council approves budget</title><guid>2</guid><pubDate>${new Date().toUTCString()}</pubDate><description>The vote was unanimous.</description></item>
  </channel></rss>`;
  const plain = feedToItems(xml, { label: 'Paper', category: 'news' }, town);
  assert.deepEqual(plain.map((i) => i.category), ['news', 'news']);
  const mixed = feedToItems(xml, { label: 'Paper', category: 'news', findEvents: true }, town);
  assert.deepEqual(mixed.map((i) => i.category), ['events', 'news']);
  assert.ok(mixed[0].startsAt > Date.now());
  assert.equal(mixed[0].expiresAt - mixed[0].startsAt, 3 * H);
});

test('events feed: a date with no time is all day', () => {
  const d = new Date(Date.now() + 3 * 86400e3);
  const when = d.toLocaleDateString('en-US', { timeZone: 'America/Denver', month: 'long', day: 'numeric', year: 'numeric' });
  const xml = `<rss><channel><item><title>Art walk</title><guid>1</guid><description>${when}</description></item></channel></rss>`;
  const [e] = feedToItems(xml, { label: 'Cal', category: 'events' }, town);
  assert.equal(e.expiresAt - e.startsAt, 24 * H);
});

test('kind: set by the feed for RSS, fixed by type for the rest', () => {
  assert.equal(kindOf({ adapter: 'rss', settings: { category: 'events' } }), 'events');
  assert.equal(kindOf({ adapter: 'ical', settings: {} }), 'events');
  assert.equal(kindOf({ adapter: 'nws-alerts', settings: {} }), 'alerts');
  assert.equal(kindOf({ adapter: 'cdot', settings: {} }), 'roads');
});

test('Claude feeds: its "kind" wins over the guess, and hasEvents ticks Some posts are events', () => {
  assert.equal(categoryGuess({ label: 'Sheriff', kind: 'news' }), 'news');
  assert.equal(categoryGuess({ label: 'Sheriff alerts' }), 'alerts');
  const { sources } = planClaudeSources([
    { label: 'Daily Planet', type: 'rss', kind: 'news', hasEvents: true, url: 'https://planet.example/feed' },
    { label: 'Library', type: 'rss', kind: 'events', url: 'https://lib.example/events/feed' },
  ], town, []);
  assert.deepEqual(sources.map((s) => [s.settings.category, !!s.settings.findEvents]), [['news', true], ['events', false]]);
});
