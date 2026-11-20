// Send a test notification to every subscriber of every town.
// On the server:  docker compose exec buzz node --experimental-sqlite --no-warnings src/push-test.js "Title" "Body"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { loadVapid, sendPush } from './push.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(ROOT, 'config');
const title = process.argv[2] || 'Test alert from Telluride.Buzz';
const summary = process.argv[3] || 'If you can read this, alerts are working on this device.';

const db = openDb(path.join(DATA_DIR, 'buzz.db'));
const vapid = loadVapid(DATA_DIR);
const subject = process.env.VAPID_SUBJECT || 'https://telluride.buzz';
for (const f of fs.readdirSync(CONFIG_DIR).filter((x) => x.endsWith('.json'))) {
  const town = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'));
  db.setLatestPush(town.id, { id: 0, sourceLabel: 'Telluride.Buzz', title, summary, link: '/', severity: 0, publishedAt: Date.now() });
  const subs = db.pushSubscriptions(town.id);
  let ok = 0;
  for (const s of subs) {
    const r = await sendPush(s.endpoint, vapid, subject);
    if (r === 'ok') ok++;
    else if (r === 'gone') db.removeSubscription(s.endpoint);
    else console.log(`  failed: ${r}`);
  }
  console.log(`${town.id}: sent to ${ok} of ${subs.length} subscriber(s)`);
}
db.close();
