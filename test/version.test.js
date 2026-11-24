import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBuildInfo, buildInfo } from '../src/version.js';
import { serverSettings } from '../src/admin.js';

test('build label from a deploy stamp', () => {
  const b = makeBuildInfo({ version: '0.1.0' }, { build: 214, commit: 'ac97ed1f00ba', deployedAt: '2026-11-24T19:40:00Z' });
  assert.equal(b.label, 'v0.1.0 · build 214 · ac97ed1');
  assert.equal(b.commit, 'ac97ed1');
  assert.equal(b.deployedAt, '2026-11-24T19:40:00.000Z');
});

test('no stamp (local, tests) says dev build; junk is ignored', () => {
  assert.equal(makeBuildInfo({ version: '0.1.0' }, null).label, 'v0.1.0 · dev build');
  const b = makeBuildInfo({ version: '0.1.0' }, { build: 'x', commit: '<script>', deployedAt: 'nope' });
  assert.deepEqual([b.build, b.commit, b.deployedAt, b.label], [null, '', '', 'v0.1.0 · dev build']);
  assert.match(buildInfo.label, /^v\d+\.\d+\.\d+ · /);
});

test('admin Settings shows the version and deploy time', () => {
  const info = { build: makeBuildInfo({ version: '0.1.0' }, { build: 214, commit: 'ac97ed1', deployedAt: '2026-11-24T19:40:00Z' }) };
  const items = serverSettings({}, info).find((g) => g.title === 'Server').items;
  assert.equal(items.find((i) => i.label === 'Version').value, 'v0.1.0 · build 214 · ac97ed1');
  assert.equal(items.find((i) => i.label === 'Deployed').value, 'Nov 24, 2026, 12:40 PM Mountain');
});
