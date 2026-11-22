// meander.me blog posts tagged for Telluride.Buzz. meander.me runs Strapi on the same
// server, so we read its public REST API over the private Docker network first and fall
// back to the public address. Only published posts carrying one of the configured tags show.
import { fetchJson } from '../http.js';

const MAX_AGE_DAYS = 120;

export function meanderUrl(api, cfg) {
  const q = new URLSearchParams({
    'populate[tags]': 'true',
    'sort[0]': 'publishedAt:desc',
    'pagination[pageSize]': '25',
  });
  cfg.tags.forEach((slug, i) => q.append(`filters[$or][${i}][tags][slug][$eqi]`, slug));
  q.append(`filters[$or][${cfg.tags.length}][tags][name][$eqi]`, cfg.tagName || 'telluride.buzz');
  return `${api.replace(/\/$/, '')}/api/posts?${q}`;
}

/** displayDate (a plain date, used to backdate posts) wins over publishedAt, as on meander.me. */
function postDate(p) {
  const pub = Date.parse(p.publishedAt) || Date.now();
  if (!p.displayDate) return pub;
  const shown = Date.parse(`${p.displayDate}T12:00:00-07:00`);
  if (!shown) return pub;
  // Same day as publishing: keep the real time so it sorts properly in the feed.
  return Math.abs(shown - pub) < 36 * 3600e3 ? pub : shown;
}

export function meanderToItems(json, cfg, now = Date.now()) {
  const cutoff = now - MAX_AGE_DAYS * 86400e3;
  const want = new Set([...cfg.tags, cfg.tagName || 'telluride.buzz'].map((s) => s.toLowerCase()));
  const out = [];
  for (const p of json?.data || []) {
    if (!p?.title || !p.slug) continue;
    // Double-check the tag here too, in case the API ignores a filter.
    const tags = (p.tags || []).flatMap((t) => [t.slug, t.name]).filter(Boolean).map((s) => s.toLowerCase());
    if (!tags.some((t) => want.has(t))) continue;
    const at = Math.min(postDate(p), now);
    if (at < cutoff) continue;
    out.push({
      extId: p.documentId || p.id || p.slug,
      sourceLabel: cfg.label || 'Meander.me',
      category: cfg.category || 'news',
      title: p.title,
      summary: p.excerpt || null,
      link: `${(cfg.site || 'https://meander.me').replace(/\/$/, '')}/posts/${encodeURIComponent(p.slug)}`,
      severity: 0,
      publishedAt: at,
    });
  }
  return out;
}

export function meanderJobs(town, { get = fetchJson } = {}) {
  const cfg = town.meander;
  if (!cfg || cfg.enabled === false || !cfg.tags?.length) return [];
  const apis = [process.env.MEANDER_API, ...(cfg.api || [])].filter(Boolean);
  return [{
    id: 'meander',
    everyMin: cfg.everyMin || 15,
    async run(db) {
      let json, lastErr;
      for (const api of apis) {
        try { json = await get(meanderUrl(api, cfg), { timeoutMs: 8000 }); break; } catch (e) { lastErr = e; }
      }
      if (!json) throw lastErr || new Error('No meander.me API configured');
      // The API returns the full current list, so untagged or unpublished posts drop off.
      db.syncItems(town.id, 'meander', meanderToItems(json, cfg), { deactivateMissing: true });
    },
  }];
}
