import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skyFor, phaseName, localMidnight, localDate } from '../src/sky.js';
import { moonIcon, duration, dayChange, skyTile, skyPanel } from '../public/sky.js';

const TELLURIDE = { id: 'telluride', location: { lat: 37.9375, lon: -107.8123 }, timezone: 'America/Denver' };
const NOW = Date.parse('2026-11-24T20:40:00Z'); // 1:40 PM in Telluride
const near = (a, b, mins) => Math.abs(a - b) <= mins * 60e3;

test('local midnight and dates follow the town time zone, across DST', () => {
  assert.equal(localDate('America/Denver', NOW), '2026-11-24');
  assert.equal(new Date(localMidnight('America/Denver', '2026-11-24')).toISOString(), '2026-11-24T07:00:00.000Z');
  assert.equal(new Date(localMidnight('America/Denver', '2026-07-04')).toISOString(), '2026-07-04T06:00:00.000Z');
});

test('Telluride sun times for Nov 24, 2026', () => {
  const s = skyFor(TELLURIDE, NOW);
  assert.equal(s.ok, true);
  const t = s.today;
  assert.ok(near(t.sunrise, Date.parse('2026-11-24T14:01:00Z'), 3), new Date(t.sunrise).toISOString());
  assert.ok(near(t.sunset, Date.parse('2026-11-24T23:54:00Z'), 3), new Date(t.sunset).toISOString());
  assert.ok(t.dawn < t.sunrise && t.sunrise < t.goldenEnd && t.goldenEnd < t.noon && t.noon < t.goldenStart && t.goldenStart < t.sunset && t.sunset < t.dusk);
  assert.ok(t.dayLength > 9.7 * 3600 && t.dayLength < 10 * 3600);
  assert.ok(t.dayChange < 0, 'days are getting shorter in November');
  assert.equal(s.chart.sun.length, 49);
});

test('moon: phase, quarters and the year ahead', () => {
  const s = skyFor(TELLURIDE, NOW);
  assert.equal(s.moon.name, 'Full moon'); // full moon Nov 24, 2026
  assert.ok(s.moon.illum > 0.98);
  assert.deepEqual(s.moon.phases.map((p) => p.kind), ['last', 'new', 'first', 'full']);
  const sol = s.events.find((e) => e.title === 'Winter solstice');
  assert.ok(near(sol.at, Date.parse('2026-12-21T20:50:00Z'), 3));
  assert.ok(s.events.some((e) => /Geminids/.test(e.title)));
  assert.ok(s.events.some((e) => /Cold Moon/.test(e.title)));
  for (let i = 1; i < s.events.length; i++) assert.ok(s.events[i].at >= s.events[i - 1].at, 'events in date order');
});

test('eclipses seen from Telluride: Jan 2028 partial lunar, Jan 2029 partial solar', () => {
  const s = skyFor(TELLURIDE, NOW);
  const lunar = s.eclipses.lunar[0];
  assert.equal(lunar.kind, 'partial');
  assert.ok(near(lunar.at, Date.parse('2028-01-12T04:13:00Z'), 10), new Date(lunar.at).toISOString());
  const solar = s.eclipses.solar[0];
  assert.ok(near(solar.at, Date.parse('2029-01-14T16:42:00Z'), 30), new Date(solar.at).toISOString());
  assert.ok(solar.covered > 40);
});

test('no map point: tile says so instead of failing', () => {
  assert.equal(skyFor({ id: 'x', timezone: 'America/Denver' }, NOW).ok, false);
});

test('phase names', () => {
  assert.equal(phaseName(0), 'New moon');
  assert.equal(phaseName(45), 'Waxing crescent');
  assert.equal(phaseName(91), 'First quarter');
  assert.equal(phaseName(135), 'Waxing gibbous');
  assert.equal(phaseName(181), 'Full moon');
  assert.equal(phaseName(225), 'Waning gibbous');
  assert.equal(phaseName(270), 'Last quarter');
  assert.equal(phaseName(320), 'Waning crescent');
  assert.equal(phaseName(359), 'New moon');
});

test('moon icon draws the lit side correctly', () => {
  // Waxing crescent: lit limb on the right (sweep 1), terminator bulging right (sweep 0).
  assert.match(moonIcon(45), /A15 15 0 0 1 16 31A10\.61 15 0 0 0 16 1z/);
  // Waning crescent: lit limb on the left.
  assert.match(moonIcon(315), /A15 15 0 0 0 16 31A10\.61 15 0 0 1 16 1z/);
  assert.doesNotMatch(moonIcon(0), /sky-moon-lit/);
  assert.match(moonIcon(180), /<circle class="sky-moon-lit"/);
});

test('labels', () => {
  assert.equal(duration(35568), '9h 53m');
  assert.equal(dayChange(-88), '1m 28s shorter than yesterday');
  assert.equal(dayChange(45), '45s longer than yesterday');
});

test('tile and panel render without inline styles (CSP)', () => {
  const s = skyFor(TELLURIDE, NOW);
  const html = skyTile(s, NOW) + skyPanel(s, 'Telluride', NOW);
  assert.match(html, /7:01 AM/);
  assert.match(html, /Coming up in the sky/);
  assert.doesNotMatch(html, /style=/);
});
