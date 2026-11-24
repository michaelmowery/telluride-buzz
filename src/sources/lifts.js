// Lifts & Snow. Telluride Ski Resort has no known public API, so this reads the
// public snow report page and pulls out what it can recognise. If the page changes
// and nothing is recognised, the tile says so and links to the resort's report
// rather than showing stale or wrong numbers.
import { fetchText } from '../http.js';
import { htmlToText } from '../rss.js';
import { parseLocalDateTime } from '../time.js';

/** "Last Updated: November 20, 2026 at 3:39pm" -> epoch ms (resort's local time). */
export function reportUpdatedAt(text, tz = 'America/Denver', now = Date.now()) {
  const m = text.match(/(?:last\s+)?updated:?\s*(?:on\s+)?([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})(?:,?\s*(?:at\s+)?(\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?))?/i);
  if (!m) return null;
  const t = parseLocalDateTime(tz, m[1], m[2] || '');
  // Ignore anything in the future or more than 60 days old: that's a mis-parse.
  return t && t <= now + 3600e3 && t > now - 60 * 86400e3 ? t : null;
}

function num(s) {
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Try embedded JSON first (many resort sites ship their report as JSON in the page). */
function fromJson(html) {
  const out = {};
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  const grab = (re) => {
    for (const s of scripts) {
      const m = s.match(re);
      if (m) return num(m[1]);
    }
    return null;
  };
  out.overnight = grab(/"(?:overnight_?snow(?:fall)?|snowOvernight|overnight)"\s*:\s*"?([\d.]+)/i);
  out.new24 = grab(/"(?:snow_?24_?hours?|twentyFourHourSnowfall|snowfall24|new_?snow_?24|last24Hours?)"\s*:\s*"?([\d.]+)/i);
  out.new48 = grab(/"(?:snow_?48_?hours?|fortyEightHourSnowfall|snowfall48|last48Hours?)"\s*:\s*"?([\d.]+)/i);
  out.new72 = grab(/"(?:snow_?72_?hours?|seventyTwoHourSnowfall|snowfall72|last72Hours?)"\s*:\s*"?([\d.]+)/i);
  out.new7d = grab(/"(?:snow_?7_?days?|sevenDaySnowfall|snowfall7d(?:ays?)?|last7Days?)"\s*:\s*"?([\d.]+)/i);
  out.season = grab(/"(?:season_?total|seasonTotal|season_?snowfall|seasonSnowfall|snowfall_?season)"\s*:\s*"?([\d.]+)/i);
  out.base = grab(/"(?:base_?depth|baseDepth|snow_?base|midMountainBase|base)"\s*:\s*"?([\d.]+)/i);
  out.liftsOpen = grab(/"(?:lifts_?open|openLifts|liftsOpen)"\s*:\s*"?(\d+)/i);
  out.liftsTotal = grab(/"(?:lifts_?total|totalLifts|liftsTotal)"\s*:\s*"?(\d+)/i);
  out.trailsOpen = grab(/"(?:trails_?open|runs_?open|openTrails|openRuns)"\s*:\s*"?(\d+)/i);
  out.trailsTotal = grab(/"(?:trails_?total|runs_?total|totalTrails|totalRuns)"\s*:\s*"?(\d+)/i);
  return out;
}

/** Then visible text, e.g. "24 Hours 6"" or "Base Depth 32 in" or "Lifts Open 12 / 19". */
function fromText(text, valueFirst = false) {
  const t = text.replace(/\s+/g, ' ');
  // Most pages put the label first ("24 Hours 6"). Some (Purgatory) put the value
  // first ('3" 24 Hr', "2 of 12 Lifts Open"); config `lifts.valueFirst` tries that first.
  const before = (label) => {
    const m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:"|”|″|in\\b|inches)\\s*${label}`, 'i'));
    return m ? num(m[1]) : null;
  };
  // Prefer a number with an inch mark after the label: Telluride's page has
  // "8" last 24 hr Details Lifts Status 0/17" before its "Last 24 hours 8"" row,
  // and the bare 0 there is the lift count, not the snowfall.
  const after = (label) => {
    const m = t.match(new RegExp(`${label}[^0-9]{0,25}(\\d+(?:\\.\\d+)?)\\s*(?:"|”|″|in\\b|inches|cm)`, 'i'))
      || t.match(new RegExp(`${label}[^0-9]{0,25}(\\d+(?:\\.\\d+)?)`, 'i'));
    return m ? num(m[1]) : null;
  };
  // A short word or two after a known condition label: "Current snow condition Variable".
  const cond = t.match(/(?:current (?:snow |surface )?conditions?|primary surface|surface conditions?|snow conditions?)\s*:?\s*([A-Za-z][A-Za-z/&-]*(?: [A-Za-z/&-]+){0,3}?)(?=\s*(?:\n|$|snow\b|last\b|lifts?\b|trails?\b|runs?\b|base\b|season\b|secondary\b|\d))/i);
  const near = (label) => (valueFirst ? before(label) ?? after(label) : after(label));
  const ratio = (label) => {
    const labelFirst = new RegExp(`${label}[^0-9]{0,25}(\\d+)\\s*(?:/|of)\\s*(\\d+)`, 'i');
    const numFirst = new RegExp(`(\\d+)\\s*(?:/|of)\\s*(\\d+)\\s*${label}`, 'i');
    const m = valueFirst ? t.match(numFirst) || t.match(labelFirst) : t.match(labelFirst) || t.match(numFirst);
    return m ? [num(m[1]), num(m[2])] : [null, null];
  };
  const [liftsOpen, liftsTotal] = ratio('lifts?(?: open)?');
  const [trailsOpen, trailsTotal] = ratio('(?:trails|runs)(?: open)?');
  return {
    overnight: near('(?:snow )?overnight'),
    new24: near('24[ -]?(?:hours?|hrs?|hr)') ?? near('new snow'),
    new48: near('48[ -]?(?:hours?|hrs?|hr)'),
    new72: near('72[ -]?(?:hours?|hrs?|hr)'),
    new7d: near('(?:7|seven)[ -]?days?'),
    season: near('season(?:al)?(?: total| snowfall| to date)'),
    condition: cond ? cond[1].trim() : null,
    base: near('(?:base depth|snow depth|mid[- ]mountain(?: base)?|base)'),
    liftsOpen, liftsTotal, trailsOpen, trailsTotal,
  };
}

export function parseSnowReport(html, tz = 'America/Denver', { valueFirst = false } = {}) {
  const j = fromJson(html);
  const text = htmlToText(html);
  const t = fromText(text, valueFirst);
  const pick = (k) => j[k] ?? t[k] ?? null;
  const r = {
    overnight: pick('overnight'), new24: pick('new24'), new48: pick('new48'),
    new72: pick('new72'), new7d: pick('new7d'), season: pick('season'), base: pick('base'),
    liftsOpen: pick('liftsOpen'), liftsTotal: pick('liftsTotal'),
    trailsOpen: pick('trailsOpen'), trailsTotal: pick('trailsTotal'),
  };
  // Sanity limits: anything outside these is a mis-parse, not a powder day.
  if (r.new24 != null && r.new24 > 60) r.new24 = null;
  if (r.overnight != null && r.overnight > 60) r.overnight = null;
  if (r.new48 != null && r.new48 > 90) r.new48 = null;
  if (r.new72 != null && r.new72 > 120) r.new72 = null;
  if (r.new7d != null && r.new7d > 200) r.new7d = null;
  if (r.season != null && r.season > 1000) r.season = null;
  if (r.base != null && r.base > 250) r.base = null;
  if (r.liftsTotal != null && (r.liftsTotal > 40 || (r.liftsOpen ?? 0) > r.liftsTotal)) r.liftsOpen = r.liftsTotal = null;
  if (r.trailsTotal != null && (r.trailsTotal > 300 || (r.trailsOpen ?? 0) > r.trailsTotal)) r.trailsOpen = r.trailsTotal = null;
  const found = Object.values(r).filter((v) => v != null).length;
  const condition = /^[A-Za-z][A-Za-z /&-]{1,40}$/.test(t.condition || '') && !/^(?:details|n\/?a|none|see)\b/i.test(t.condition) ? t.condition : null;
  return { ...r, condition, found, sourceAt: reportUpdatedAt(text, tz) };
}

/** A town's ski resorts: config `lifts` may be one resort or a list. */
export function resortsOf(town) {
  return [].concat(town.lifts || []).filter((r) => r?.url)
    .map((r, i) => ({ ...r, id: r.id || (i === 0 ? 'main' : `resort-${i + 1}`), name: r.name || r.label }));
}

const SORRY = 'See the resort’s snow report for today’s numbers.';

/**
 * One job per resort. The Lifts & Snow tile holds every resort under `resorts`
 * (in config order), and the first resort's numbers also sit at the top level for
 * older clients. Each feed post names its mountain.
 */
export function liftsJobs(town, { get = fetchText } = {}) {
  const resorts = resortsOf(town);
  const multi = resorts.length > 1;
  const saveTile = (db, entry) => {
    const prev = db.getTiles(town.id).lifts;
    const byId = new Map((prev?.resorts || []).map((r) => [r.id, r]));
    byId.set(entry.id, entry);
    const list = resorts.map((r) => byId.get(r.id)).filter(Boolean);
    const first = list.find((r) => r.ok) || list[0];
    const { id, name, ...top } = first;
    db.setTile(town.id, 'lifts', {
      ...top,
      ok: list.some((r) => r.ok),
      sourceAt: Math.max(0, ...list.map((r) => r.sourceAt || 0)) || null,
      resorts: list,
    });
  };
  const jobId = (res, i) => res.jobId || (i === 0 ? 'lifts-snow' : `lifts-snow-${res.id}`);
  return resorts.map((res, i) => ({
    id: jobId(res, i),
    everyMin: 15,
    async run(db) {
      const base = { id: res.id, name: res.name, link: res.linkUrl || res.url, sourceLabel: res.label };
      let entry;
      try {
        const html = await get(res.url);
        const r = parseSnowReport(html, town.timezone, { valueFirst: !!res.valueFirst });
        entry = { ...base, ok: r.found >= 2, ...r, error: r.found >= 2 ? null : SORRY };
      } catch (e) {
        saveTile(db, { ...base, ok: false, error: SORRY });
        throw e;
      }
      saveTile(db, entry);
      const fresh = Math.max(entry.new24 || 0, entry.overnight || 0);
      if (entry.ok && fresh >= 1) {
        // Key the post by the date of the resort's own report, not our clock, so an
        // unchanged report doesn't become a second identical post the next day.
        const reportAt = entry.sourceAt || Date.now();
        const day = new Date(reportAt).toLocaleDateString('en-CA', { timeZone: town.timezone });
        const when = entry.overnight >= entry.new24 || entry.new24 == null ? 'overnight' : 'in the last 24 hours';
        db.syncItems(town.id, jobId(res, i), [{
          extId: `new-snow-${day}`,
          sourceLabel: res.label,
          category: 'lifts',
          title: `${res.name}: ${fresh}" of new snow ${when}`,
          summary: [entry.base != null ? `Base depth ${entry.base}".` : null, entry.season != null ? `Season total ${entry.season}".` : null].filter(Boolean).join(' ') || null,
          link: entry.link,
          severity: 0,
          publishedAt: Math.min(reportAt, Date.now()),
        }], { deactivateMissing: true }); // only the latest snow report per resort stays in the feed
      }
      if (!entry.ok) throw new Error(`Snow report page parsed, but only ${entry.found} values recognised`);
    },
  }));
}
