import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedbackUrl, formLinks, FORMS, KIND } from '../src/forms.js';
import { renderTemplate } from '../src/brand.js';
import { renderHub } from '../src/hub.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const town = { id: 'fortcollins', name: 'Fort Collins', state: 'CO', hostnames: ['fortcollins.thetown.buzz'], brand: {}, sources: [] };

test('pre-filled links match the ones tested in ClickUp', () => {
  assert.equal(feedbackUrl({ kind: KIND.resource, town: 'Fort Collins' }),
    'https://forms.clickup.com/8533149/f/84d4x-17611/V0NYLRDN8M8Z4EBVID?What%20are%20you%20sharing%3F=Suggest%20a%20local%20resource&Which%20town%3F=Fort%20Collins');
  assert.equal(formLinks().suggestTownUrl,
    'https://forms.clickup.com/8533149/f/84d4x-17611/V0NYLRDN8M8Z4EBVID?What%20are%20you%20sharing%3F=Suggest%20a%20new%20town');
  assert.equal(formLinks('X').supportUrl, FORMS.support);
});

test('town pages link the forms in a new tab, with the town display name', () => {
  for (const f of ['index.html', 'guide.html', 'resources.html']) {
    const out = renderTemplate(page(f), '.html', town, [town]);
    assert.match(out, /Suggest a resource/, f);
    assert.ok(out.includes('Which%20town%3F=Fort%20Collins'), f);
    assert.ok(out.includes(FORMS.support), f);
    assert.ok(!/\{\{\w+\}\}/.test(out), f);
    for (const a of out.match(/<a [^>]*forms\.clickup\.com[^>]*>/g)) assert.match(a, /target="_blank" rel="noopener"/, f);
  }
  const idx = renderTemplate(page('index.html'), '.html', town, [town]);
  assert.match(idx, /Don't see your town\? <strong>Suggest a town<\/strong>/);
  assert.equal((idx.match(/Suggest a resource/g) || []).length, 4); // Food, Shops, Lodging, Essentials
});

test('hub links Suggest a town to the form', () => {
  const out = renderHub(page('hub.html'), [town], () => []);
  assert.ok(out.includes('Suggest%20a%20new%20town'));
  assert.match(out, /Don't see your town\?/);
  assert.ok(!/\{\{\w+\}\}/.test(out));
});
