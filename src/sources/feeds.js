// Town, county and local-news RSS feeds, plus calendar feeds for the Events tile.
// Sources are listed in config/<town>.json so they can change without code.
import { fetchText } from '../http.js';
import { parseFeed } from '../rss.js';
import { parseLocalDateTime } from '../time.js';

const MAX_AGE_DAYS = 21;

export function feedToItems(xml, feed, town) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400e3;
  const out = [];
  for (const e of parseFeed(xml).slice(0, 40)) {
    if (!e.title) continue;
    let startsAt = null;
    if (feed.category === 'events') {
      // The Events Calendar (WordPress) puts each event's start time in pubDate.
      startsAt = feed.startFromPubDate ? (e.publishedAt || null)
        : parseLocalDateTime(town.timezone, e.eventDates || '', e.eventTimes || '') ?? guessEventStart(e, town);
    }
    const publishedAt = e.publishedAt || Date.now();
    if (feed.category !== 'events' && publishedAt < cutoff) continue;
    if (feed.category === 'events' && startsAt && startsAt < Date.now() - 86400e3) continue;
    const isAlert = feed.category === 'alerts';
    out.push({
      extId: e.guid,
      sourceLabel: feed.label,
      category: feed.category === 'alerts' ? 'town' : feed.category,
      title: e.title,
      summary: [e.eventLocation, stripWpFooter(e.summary)].filter(Boolean).join(' · ') || null,
      link: e.link,
      // Emergency notices from the county/town go to the banner.
      severity: isAlert ? (/(evacuat|shelter in place|emergency|closure|boil water|wildfire|avalanche)/i.test(e.title) ? 2 : 1) : 0,
      publishedAt: feed.category === 'events' && startsAt ? Math.min(publishedAt, Date.now()) : publishedAt,
      startsAt,
      // Alerts drop off the banner after a day unless the source re-lists them.
      expiresAt: isAlert ? publishedAt + 24 * 3600e3 : null,
    });
  }
  return out;
}

/** WordPress adds "The post X appeared first on Y." to every feed summary. */
const stripWpFooter = (s) => (s ? s.replace(/\s*The post .{1,300}? appeared first on .{1,120}?\.?\s*$/s, '').trim() || null : s);

/** Calendar RSS without a structured date: look for one in the summary text. */
function guessEventStart(e, town) {
  const text = `${e.summary || ''} ${e.title}`;
  const m = text.match(/([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})(?:[^0-9]{0,20}(\d{1,2}(?::\d{2})?\s*[AaPp]\.?[Mm]))?/)
    || text.match(/(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}:\d{2}\s*[AaPp]?[Mm]?))?/);
  return m ? parseLocalDateTime(town.timezone, m[1], m[2] || '') : null;
}

export function feedJobs(town, { get = fetchText } = {}) {
  return (town.feeds || []).filter((f) => f.enabled !== false).map((feed) => ({
    id: `feed-${feed.id}`,
    everyMin: feed.everyMin || 15,
    async run(db) {
      // A feed may list fallback addresses (e.g. with and without www.).
      let xml, lastErr;
      for (const url of [].concat(feed.url)) {
        try { xml = await get(url, { headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' } }); break; } catch (e) { lastErr = e; }
      }
      if (xml === undefined) throw lastErr;
      const items = feedToItems(xml, feed, town);
      // News feeds roll forward, so keep older items active; calendars and alerts are authoritative lists.
      db.syncItems(town.id, `feed-${feed.id}`, items, { deactivateMissing: feed.category !== 'news' && feed.category !== 'town' });
    },
  }));
}
