import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareData, distanceMi, NEARBY_MI } from '../src/compare.js';

const telluride = { id: 'telluride', name: 'Telluride', state: 'CO', hostnames: ['telluride.thetown.buzz'], location: { lat: 37.9375, lon: -107.8123 } };
const durango = { id: 'durango', name: 'Durango', state: 'CO', hostnames: ['durango.thetown.buzz'], location: { lat: 37.2753, lon: -107.8801 } };
const vail = { id: 'vail', name: 'Vail', state: 'CO', hostnames: ['vail.thetown.buzz'], location: { lat: 39.6403, lon: -106.3742 } };
const fortcollins = { id: 'fortcollins', name: 'Fort Collins', state: 'CO', hostnames: ['fortcollins.thetown.buzz'], location: { lat: 40.5853, lon: -105.0844 } };

const tiles = {
  telluride: {
    weather: { ok: true, temp: 18, short: 'Mostly Sunny', hi: 44, lo: 20, periods: [
      { name: 'Today', start: 1, temp: 44, isDaytime: true, short: 'Mostly Sunny' },
      { name: 'Tonight', start: 2, temp: 20, isDaytime: false, short: 'Mostly Cloudy' },
      { name: 'Thanksgiving Day', start: 3, temp: 43, isDaytime: true, short: 'Sunny' },
      { name: 'Friday Night', start: 4, temp: 25, isDaytime: false, short: 'Chance Snow Showers' },
    ] },
    lifts: { ok: true, resorts: [{ ok: true, name: 'Telluride Ski Resort', new24: 0, new48: 8, base: 20, liftsOpen: 0, liftsTotal: 17 }] },
  },
  durango: { weather: { ok: false }, lifts: { ok: true, name: 'Purgatory', new24: 8, liftsOpen: 3, liftsTotal: 12 } },
  vail: { lifts: { ok: true, resorts: [{ ok: false, name: 'Vail' }] } },
};

test('distance between Telluride and Durango is about 46 miles', () => {
  assert.equal(Math.round(distanceMi(telluride.location, durango.location)), 46);
  assert.equal(distanceMi(null, durango.location), null);
});

test('compare data puts this town first, nearest next, and marks nearby towns', () => {
  const d = compareData(telluride, [vail, fortcollins, durango, telluride], (t) => tiles[t.id]);
  assert.equal(d.here, 'telluride');
  assert.deepEqual(d.towns.map((t) => t.id), ['telluride', 'durango', 'vail', 'fortcollins']);
  assert.deepEqual(d.towns.map((t) => t.nearby), [true, true, true, false]);
  assert.equal(d.nearbyMi, NEARBY_MI);
  assert.equal(d.towns[0].distanceMi, 0);
  assert.equal(d.towns[1].url, 'https://durango.thetown.buzz');
  assert.equal(d.towns[1].stateName, 'Colorado');
});

test('compare data keeps only the numbers the tables need and skips failed sources', () => {
  const d = compareData(telluride, [telluride, durango, vail], (t) => tiles[t.id]);
  const [t, du, v] = d.towns;
  assert.equal(t.weather.hi, 44);
  assert.deepEqual(t.weather.days.map((x) => x.temp), [43]); // today's period is not a "next day"
  assert.equal(t.weather.snow.name, 'Friday Night');
  assert.equal(t.weather.periods, undefined);
  assert.equal(du.weather, null);
  assert.equal(du.resorts[0].name, 'Purgatory'); // single-resort tile without a resorts list
  assert.equal(du.resorts[0].new24, 8);
  assert.deepEqual(v.resorts, []); // failed report left out
});
