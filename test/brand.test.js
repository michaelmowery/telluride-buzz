import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../src/brand.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = (id) => JSON.parse(fs.readFileSync(path.join(root, 'config', `${id}.json`), 'utf8'));
const page = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const towns = fs.readdirSync(path.join(root, 'config')).filter((f) => f.endsWith('.json')).map((f) => cfg(f.slice(0, -5)));

test('every templated file fills every placeholder for every town', () => {
  for (const t of towns) for (const f of ['index.html', 'about.html', 'manifest.webmanifest', 'sw.js']) {
    const out = renderTemplate(page(f), path.extname(f), t, towns);
    assert.ok(!/\{\{\w+\}\}/.test(out), `${t.id} ${f} has an unfilled placeholder`);
    if (f === 'manifest.webmanifest') JSON.parse(out);
  }
});

test('Telluride keeps its own logo and name; Durango uses the thetown logo', () => {
  const tel = renderTemplate(page('index.html'), '.html', cfg('telluride'));
  assert.match(tel, /<title>Telluride\.Buzz<\/title>/);
  assert.match(tel, />telluride<\/text>/);
  assert.ok(!/>thetown<\/text>/.test(tel), 'Telluride logo must not use the thetown style');
  assert.match(tel, /href="https:\/\/thetown\.buzz"/, 'town menu links to thetown.buzz');
  const dur = renderTemplate(page('index.html'), '.html', cfg('durango'));
  assert.match(dur, /<title>Durango Buzz<\/title>/);
  assert.match(dur, />durango<\/text>/);
  assert.match(dur, />thetown<\/text>/);
  assert.ok(!/durango\.buzz/i.test(dur), 'must not imply we own durango.buzz');
});

test('exactly one default town, and hostnames never overlap', () => {
  assert.deepEqual(towns.filter((t) => t.default).map((t) => t.id), ['telluride']);
  const all = towns.flatMap((t) => t.hostnames);
  assert.equal(new Set(all).size, all.length);
});

test('logo opens a town picker listing every town in its own logo', () => {
  const tel = renderTemplate(page('index.html'), '.html', cfg('telluride'), towns);
  assert.match(tel, /id="town-menu"/);
  assert.match(tel, /href="https:\/\/durango\.thetown\.buzz"/);
  assert.match(tel, /href="\/" aria-current="page"/);
  const menu = tel.slice(tel.indexOf('id="town-menu"'));
  assert.match(menu, />telluride<\/text>[\s\S]*?>buzz<\/text>/);
  assert.match(menu, />durango<\/text>[\s\S]*?>thetown<\/text>/);
});
