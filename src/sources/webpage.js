// News from a plain web page that has no feed: an organization's "News" or
// "Announcements" page that lists its posts as links. We read the links whose
// address matches a pattern (e.g. "/news/"), take the link text as the headline,
// and look for a date next to it. Undated posts keep the time we first saw them.
import { fetchText } from '../http.js';
import { decodeEntities, htmlToText } from '../rss.js';
import { parseLocalDateTime } from '../time.js';

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const DATE_RES = [
  new RegExp(`\\b((?:${MONTHS})\\.? \\d{1,2},? \\d{4})\\b`, 'i'),
  new RegExp(`\\b(\\d{1,2} (?:${MONTHS})\\.? \\d{4})\\b`, 'i'),
  /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/,
  /\b(\d{4}-\d{2}-\d{2})(?:T[\d:]+)?\b/,
];
const JUNK = /^(read|learn|see|view|click|more|continue|details|full story|here|next|previous|prev|older|newer|share|tweet|email|print|home|news|menu)\b/i;

/** A date in a bit of text, as epoch ms at local midnight (or null). */
export function findDate(text, tz) {
  for (const re of DATE_RES) {
    const m = text.match(re);
    if (!m) continue;
    let d = m[1].replace(/\./g, '');
    if (/^\d{1,2} [A-Za-z]/.test(d)) { const [da, mo, y] = d.split(' '); d = `${mo} ${da}, ${y}`; }
    const t = parseLocalDateTime(tz, d, '');
    if (t) return t;
  }
  return null;
}

/** The date in html[lo..hi] closest to the link at [start..end]: a <time datetime> or a written date. */
function nearestDate(html, lo, hi, start, end, tz) {
  const chunk = html.slice(lo, hi);
  const found = [];
  for (const t of chunk.matchAll(/<time[^>]*datetime=["']([^"']+)["']/gi)) {
    const v = Date.parse(t[1]);
    if (v) found.push({ at: lo + t.index, v });
  }
  // Written dates, read from the text between tags.
  for (const t of chunk.matchAll(/>([^<]{6,200})(?=<|$)/g)) {
    const v = findDate(decodeEntities(t[1]), tz);
    if (v) found.push({ at: lo + t.index, v });
  }
  const dist = (at) => (at < start ? start - at : at > end ? at - end : 0);
  found.sort((a, b) => dist(a.at) - dist(b.at));
  return found[0]?.v || null;
}

/** Turn a pattern setting ("/news/" or a /regex/) into a test function. */
export function matcher(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return () => true;
  const re = p.match(/^\/(.+)\/([i]*)$/);
  if (re) { const r = new RegExp(re[1], re[2]); return (u) => r.test(u); }
  const parts = p.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
  return (u) => parts.some((x) => u.includes(x));
}

/**
 * Posts listed on a page: [{ link, title, date }], newest page order kept.
 * cfg: { url, linkPattern, exclude, requireDate, max }.
 */
export function pageToPosts(html, cfg, tz = 'America/Denver') {
  const base = new URL(cfg.url);
  const keep = matcher(cfg.linkPattern);
  const drop = cfg.exclude ? matcher(cfg.exclude) : () => false;
  const clean = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const hits = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(clean))) {
    const href = m[1].match(/\bhref\s*=\s*["']([^"'#]+)/i)?.[1];
    if (!href || /^(mailto|tel|javascript):/i.test(href)) continue;
    let url;
    try { url = new URL(decodeEntities(href.trim()), base); } catch { continue; }
    if (url.host.replace(/^www\./, '') !== base.host.replace(/^www\./, '')) continue;
    url.hash = '';
    const link = url.href;
    const path = url.pathname + url.search;
    if (link.replace(/\/$/, '') === base.href.replace(/\/$/, '') || !keep(path) || drop(path)) continue;
    // Headline: the link text, else a title/aria-label, else the nearest heading before it.
    let title = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (title.length < 12 || JUNK.test(title)) {
      const t = m[1].match(/\b(?:title|aria-label)\s*=\s*["']([^"']{12,})["']/i)?.[1];
      title = t ? decodeEntities(t).trim() : '';
    }
    if (!title) {
      const before = clean.slice(Math.max(0, m.index - 1500), m.index);
      const hs = [...before.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
      title = hs.length ? htmlToText(hs[hs.length - 1][1]).replace(/\s+/g, ' ').trim() : '';
    }
    const ok = title.length >= 12 && title.length <= 300 && !JUNK.test(title);
    hits.push({ link, title: ok ? title : null, start: m.index, end: re.lastIndex });
  }
  // A post's date sits between its own links and the neighbouring posts' links.
  const byLink = new Map();
  hits.forEach((h, i) => {
    let lo = Math.max(0, h.start - 600), hi = Math.min(clean.length, h.end + 600);
    for (let j = i - 1; j >= 0; j--) if (hits[j].link !== h.link) { lo = Math.max(lo, hits[j].end); break; }
    for (let j = i + 1; j < hits.length; j++) if (hits[j].link !== h.link) { hi = Math.min(hi, hits[j].start); break; }
    const prev = byLink.get(h.link);
    const date = nearestDate(clean, lo, hi, h.start, h.end, tz) || prev?.date || null;
    if (!h.title) { if (!byLink.has(h.link)) byLink.set(h.link, null); else if (prev && !prev.date) prev.date = date; return; }
    if (!prev || h.title.length > prev.title.length) byLink.set(h.link, { link: h.link, title: h.title, date });
  });
  return [...byLink.values()].filter((p) => p && (!cfg.requireDate || p.date)).slice(0, Number(cfg.max) || 20);
}

export function webpageJob(town, cfg, { get = fetchText } = {}) {
  return {
    async run(db) {
      const html = await get(cfg.url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
      const posts = pageToPosts(html, cfg, town.timezone);
      if (!posts.length) throw new Error('No posts found on the page (check the link pattern)');
      const now = Date.now();
      const seen = db.firstSeen ? db.firstSeen(town.id, cfg.key) : new Map();
      // First read of a page: undated posts are old news, so they go in below today's.
      const firstRun = seen.size === 0;
      const items = posts.map((p, i) => ({
        extId: p.link,
        sourceLabel: cfg.label,
        category: cfg.category || 'news',
        title: p.title,
        summary: null,
        link: p.link,
        publishedAt: p.date ? Math.min(p.date, now) : seen.get(p.link) ?? (firstRun ? now - 3 * 86400e3 - i * 3600e3 : now),
      }));
      db.syncItems(town.id, cfg.key, items, { deactivateMissing: false });
    },
  };
}
