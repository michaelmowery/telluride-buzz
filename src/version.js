// Which code is running. The version comes from package.json; the build number,
// commit and deploy time come from config/build.json, which the server's deploy
// script (deploy/server-deploy.sh) writes before building the container. A copy
// run without it (local, tests, an old deploy script) says "dev build".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Build details from package.json and an optional build.json (pure, for tests). */
export function makeBuildInfo(pkg, b) {
  const version = String(pkg?.version || '0.0.0');
  const build = Number.isInteger(b?.build) && b.build > 0 ? b.build : null;
  const commit = /^[0-9a-f]{7,40}$/.test(String(b?.commit || '')) ? String(b.commit).slice(0, 7) : '';
  const deployedAt = b?.deployedAt && !Number.isNaN(Date.parse(b.deployedAt)) ? new Date(b.deployedAt).toISOString() : '';
  const label = build ? `v${version} · build ${build}${commit ? ` · ${commit}` : ''}` : `v${version} · dev build`;
  return { version, build, commit, deployedAt, label };
}

export const buildInfo = makeBuildInfo(readJson(path.join(ROOT, 'package.json')), readJson(path.join(ROOT, 'config', 'build.json')));
