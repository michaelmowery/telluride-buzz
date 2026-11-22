// Resort alert banner (e.g. Purgatory: "Opening Day Is Here!", wind holds, lift
// closures). Mountain Capital Partners resort sites publish it as a small JSON
// file: [{ headline, content, starts: "YYYYMMDDHHMM", expires, link: { links_to } }].
import { fetchJson } from '../http.js';
import { zonedEpoch } from '../time.js';

function stamp(tz, s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? zonedEpoch(tz, +m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}

export function resortAlertsToItems(json, cfg, tz, now = Date.now()) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const a of json) {
    if (!a?.headline) continue;
    const starts = stamp(tz, a.starts);
    const expires = stamp(tz, a.expires);
    if (expires && expires < now) continue;
    if (starts && starts > now) continue;
    out.push({
      extId: String(a.id || `${a.headline}-${a.starts}`),
      sourceLabel: cfg.label,
      category: 'lifts',
      title: String(a.headline).trim(),
      summary: String(a.content || '').replace(/\s+/g, ' ').trim() || null,
      link: a.link?.links_to || cfg.linkUrl || null,
      severity: 0,
      publishedAt: starts || now,
      expiresAt: expires,
    });
  }
  return out;
}

export function resortAlertsJobs(town, { get = fetchJson } = {}) {
  const cfg = town.resortAlerts;
  if (!cfg?.url) return [];
  return [{
    id: 'resort-alerts',
    everyMin: cfg.everyMin || 10,
    async run(db) {
      const json = await get(`${cfg.url}${cfg.url.includes('?') ? '&' : '?'}nocache=${Date.now()}`);
      db.syncItems(town.id, 'resort-alerts', resortAlertsToItems(json, cfg, town.timezone));
    },
  }];
}
