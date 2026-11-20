// Web push without dependencies. Pushes carry no payload (so no RFC 8291 payload
// encryption is needed): the service worker wakes up, fetches /api/push/latest and
// shows that alert. Only VAPID (RFC 8292) signing is required, done with node:crypto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Load VAPID keys from DATA_DIR/vapid.json, creating them on first run. */
export function loadVapid(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), fromB64url(pub.x), fromB64url(pub.y)]);
  const keys = { publicKey: b64url(raw), privateJwk: jwk };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function vapidAuthHeader(endpoint, keys, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const data = `${header}.${claims}`;
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** Validate a PushSubscription JSON from the browser. */
export function validSubscription(s) {
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string') return false;
  if (s.endpoint.length > 1000) return false;
  let u;
  try { u = new URL(s.endpoint); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  // Only real push services, so the server can't be used to POST to arbitrary hosts.
  const okHost = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com)$/i;
  return okHost.test(u.hostname);
}

/** Send one empty push. Returns 'ok' | 'gone' | 'error:<status>'. */
export async function sendPush(endpoint, keys, subject, { fetchImpl = fetch, ttl = 3600 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: vapidAuthHeader(endpoint, keys, subject), TTL: String(ttl), Urgency: 'high', 'Content-Length': '0' },
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : `error:${res.status}`;
  } catch (e) {
    return `error:${e.name === 'AbortError' ? 'timeout' : e.message}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Push any new banner-level alert (severity >= 2) to every subscriber of the town,
 * once per alert. Alerts older than `maxAgeMs` are marked as sent without pushing,
 * so a restart or a first deploy never blasts stale alerts.
 */
export async function pushNewAlerts(db, town, keys, subject, { log = console, fetchImpl, maxAgeMs = 2 * 3600e3 } = {}) {
  const fresh = db.unpushedAlerts(town.id);
  if (!fresh.length) return 0;
  const subs = db.pushSubscriptions(town.id);
  let sent = 0;
  for (const alert of fresh) {
    db.markPushed(town.id, alert.id);
    if (Date.now() - alert.publishedAt > maxAgeMs) continue;
    db.setLatestPush(town.id, alert);
    for (const s of subs) {
      const r = await sendPush(s.endpoint, keys, subject, { fetchImpl });
      if (r === 'gone') db.removeSubscription(s.endpoint);
      else if (r === 'ok') { db.subscriptionOk(s.endpoint); sent++; } else {
        db.subscriptionFailed(s.endpoint);
        log.warn?.(`push failed (${r}) for ${new URL(s.endpoint).hostname}`);
      }
    }
    log.info?.(`pushed "${alert.title}" to ${subs.length} subscriber(s)`);
  }
  return sent;
}
