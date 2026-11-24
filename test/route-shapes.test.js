import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { refPattern, shapeQuery, waysToPaths, routeShapes, simplify } from '../src/route-shapes.js';
import { buildRoadsTile } from '../src/sources/cdot.js';

const bbox = { minLat: 37.6, maxLat: 38.4, minLon: -108.3, maxLon: -107.3 };
const town = { id: 'tel', bbox, cdot: { routes: [{ label: 'CO-62', match: ['62'] }, { label: 'US-550', match: ['550'] }] } };
const way = (pts, ref = 'CO 62') => ({ type: 'way', tags: { ref, highway: 'primary' }, geometry: pts.map(([lat, lon]) => ({ lat, lon })) });

test('route refs match how OpenStreetMap writes them', () => {
  const re = (l) => new RegExp(refPattern(l));
  assert.ok(re('CO-62').test('CO 62'));
  assert.ok(re('CO-62').test('SH 62'));
  assert.ok(!re('CO-62').test('CO 620'));
  assert.ok(re('US-550').test('US 550;CO 62'));
  assert.ok(re('I-70').test('I 70'));
  assert.ok(re('NM-371').test('NM 371'));
  assert.equal(shapeQuery('Main Street', bbox), null);
  assert.match(shapeQuery('CO-62', bbox), /\(37\.6,-108\.3,38\.4,-107\.3\)/);
});

test('ways are joined end to end, clipped to the box and simplified', () => {
  const data = { elements: [
    way([[38.1, -107.9], [38.1, -107.8]]),
    way([[38.1, -107.7], [38.1, -107.8]]), // reversed, shares an end
    way([[38.1, -107.7], [38.1, -107.6], [39.5, -107.6]]), // runs out of the box
  ] };
  const paths = waysToPaths(data, bbox);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0][0], [38.1, -107.9]);
  assert.deepEqual(paths[0][paths[0].length - 1], [38.1, -107.6]);
  assert.equal(simplify([[38, -107], [38, -107.5], [38, -108]]).length, 2); // straight line keeps its ends
});

test('shapes are fetched once, cached, and a failure never breaks the tile', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const get = async (url) => {
    calls++;
    if (decodeURIComponent(url).includes('550')) throw new Error('HTTP 502');
    return { elements: [way([[38.15, -107.75], [38.0, -107.7]])] };
  };
  let shapes = await routeShapes(town, db, { get });
  assert.ok(shapes['CO-62'].length);
  assert.equal(shapes['US-550'], undefined);
  const before = calls;
  shapes = await routeShapes(town, db, { get });
  assert.equal(calls, before, 'cached shape and the failed one wait');
  assert.ok(shapes['CO-62']);
  shapes = await routeShapes(town, db, { get, now: Date.now() + 2 * 3600e3 });
  assert.ok(calls > before, 'failed route retried after an hour');

  const tile = buildRoadsTile(town, { shapes });
  const co62 = tile.routes.find((x) => x.label === 'CO-62');
  assert.equal(co62.level, 'ok');
  assert.equal(co62.status, 'No reported issues');
  assert.ok(co62.shape.length, 'clear route still drawn');
  assert.equal(tile.routes.find((x) => x.label === 'US-550').shape, null);
});
