// Add a town with Claude: turn the "suggestedSources" in Claude's answer into
// sources the new town can start with.
//
// - rss and ical links become real sources. They run right away unless Claude
//   said they need checking, in which case they're saved paused.
// - "other" links (a news page, an events page) are saved paused as RSS sources,
//   so they sit on the Feeds tab waiting for a feed address to be found.
// - cdot, snow-report and resort-alerts need settings Claude can't give (the
//   town's highways, the resort's page format), so they're listed to set up by hand.
import { normalizeSource } from './towns.js';

const NEEDS_CHECK = /\b(check|checking|verify|unconfirmed|not confirmed|no (rss|feed|ical)|stale|may not|might|unsure|not sure|unclear|scrape|if available|look for)\b/i;
const BY_HAND = { 'snow-report': 'Add a Lifts & Snow source for the resort.', 'resort-alerts': 'Add a resort alerts source for the resort.' };

export function categoryGuess(x) {
  // Claude names the kind in its answer; the guess is for older answers that don't.
  const kind = String(x.kind || '').trim().toLowerCase();
  if (['news', 'town', 'events', 'alerts'].includes(kind)) return kind;
  const text = `${x.label || ''} ${x.why || ''}`;
  if (/\b(alert|emergenc|sheriff|911|evacuat|warning)/i.test(text)) return 'alerts';
  if (/\b(event|calendar|festival|concert)/i.test(text)) return 'events';
  if (/\b(city|town|county|village|government|council|utilit|transit|bus)\b/i.test(x.label || '')) return 'town';
  return 'news';
}

/**
 * @returns {{ sources: object[], picks: number[], skipped: {label, url, type, reason, index}[] }}
 *   sources are normalized and ready for db.saveSource; picks[i] is the position in
 *   `suggested` that sources[i] came from; skipped need a person.
 */
export function planClaudeSources(suggested, town, existing = []) {
  const sources = [];
  const picks = [];
  const skipped = [];
  const seen = new Set(existing.flatMap((s) => [].concat(s.settings?.url || [])).map((u) => String(u).toLowerCase()));
  const list = (Array.isArray(suggested) ? suggested : []).slice(0, 40);
  for (let index = 0; index < list.length; index++) {
    const x = list[index];
    if (!x || typeof x !== 'object') continue;
    const label = String(x.label || '').trim().slice(0, 80) || 'Source';
    const url = String(x.url || '').trim();
    const type = String(x.type || 'other').trim().toLowerCase();
    const why = String(x.why || '').trim().slice(0, 240);
    const skip = (reason) => skipped.push({ label, url, type, reason, index });
    if (type === 'cdot' || /\b(dot|roads?|cotrip|nmroads|511)\b/i.test(type) || /\b(cotrip\.org|nmroads\.com|511\w*\.(org|com|gov))\b/i.test(url)) { skip(town.state === 'CO' ? 'Roads come from CDOT automatically (or Add CDOT roads on Feeds).' : town.state === 'NM' ? 'Roads come from NMRoads automatically (or Add NMRoads roads on Feeds).' : 'No roads feed for this state yet.'); continue; }
    if (BY_HAND[type]) { skip(BY_HAND[type]); continue; }
    if (!/^(https?|webcal):\/\/\S+$/i.test(url)) { skip('No usable web address.'); continue; }
    if (seen.has(url.toLowerCase())) { skip('Already added.'); continue; }
    const feed = type === 'rss' || type === 'ical';
    const enabled = feed && !NEEDS_CHECK.test(why);
    const input = type === 'ical'
      ? { adapter: 'ical', label, about: why || null, enabled, settings: { url } }
      : { adapter: 'rss', label, enabled, settings: { url, category: categoryGuess(x), ...(x.hasEvents === true && categoryGuess(x) !== 'events' ? { findEvents: true } : {}) },
        about: feed ? why || null : `From Claude, needs a feed address: ${why || url}`.slice(0, 240) };
    const all = [...existing, ...sources];
    const { source, error } = normalizeSource(input, town, all);
    if (error) { skip(error); continue; }
    seen.add(url.toLowerCase());
    sources.push(source);
    picks.push(index);
  }
  return { sources, picks, skipped };
}
