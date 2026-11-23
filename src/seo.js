// Search engines and link previews.
//
// Every town site gets: a canonical address (its own townUrl, so www. and stray
// paths don't count as duplicates), Open Graph / Twitter share tags, schema.org
// JSON-LD, /robots.txt and /sitemap.xml. Draft towns are marked noindex.
//
// The guide pages (/food-drink, /shops, /lodging, /essentials) are the same lists
// as the home page tabs, on their own addresses so each can rank on its own
// ("restaurants in Telluride"). Businesses are marked up as schema.org
// FoodEstablishment / Store / LocalBusiness / LodgingBusiness. Sponsorship is
// never put in the markup (no ad copy, no ranking hints); sponsored website links
// carry rel="sponsored" on the page itself, as Google asks for paid links.
import { townUrl } from './brand.js';
import { RESOURCE_CATEGORIES, sponsorActive, townDay } from './resources.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const siteName = (town) => town.brand?.siteName || `${town.name} Buzz`;
const place = (town) => `${town.name}${town.state ? `, ${town.state}` : ''}`;
export const baseUrl = (town) => townUrl(town).replace(/\/+$/, '');
export const pageUrl = (town, p = '/') => `${baseUrl(town)}${p}`;
export const isDraft = (town) => town.status === 'draft';

/** Guide pages: path, home page tab, and the words used for titles and descriptions. */
export const GUIDE_PAGES = [
  { path: '/food-drink', tab: 'eat', label: 'Food & drink', h1: (t) => `${t.name} food & drink`,
    title: (t) => `Restaurants, Cafés & Bars in ${place(t)}`, what: 'restaurants, cafés and bars',
    lede: 'Restaurants, cafés and bars, with hours, phone numbers and maps.' },
  { path: '/shops', tab: 'shop', label: 'Shops', h1: (t) => `${t.name} shops & services`,
    title: (t) => `Shops & Local Services in ${place(t)}`, what: 'shops and local services',
    lede: 'Shops and local services, with hours, phone numbers and maps.' },
  { path: '/lodging', tab: 'stay', label: 'Lodging', h1: (t) => `${t.name} lodging`,
    title: (t) => `Lodging in ${place(t)}: Hotels & Places to Stay`, what: 'hotels and places to stay',
    lede: 'Hotels, inns and places to stay, with phone numbers and maps.' },
  { path: '/essentials', tab: 'essentials', label: 'Essentials', h1: (t) => `${t.name} essentials`,
    title: (t) => `${place(t)} Essentials: Emergency, Medical, Town Offices & Transit`, what: 'emergency numbers, medical care, town offices, transit and utilities',
    lede: 'Numbers and links worth keeping handy. Tap a number to call it, or Map for directions.' },
];
export const guideFor = (p) => GUIDE_PAGES.find((g) => g.path === p) || null;

const tabOf = (cat) => RESOURCE_CATEGORIES.find((c) => c.id === cat)?.tab || 'essentials';
/** Visible entries for a guide tab (the Emergency box counts for Essentials). */
export const guideEntries = (list, tab) => list.filter((r) => !r.hidden && (tabOf(r.category) === tab || (tab === 'essentials' && r.emergency)));

const SCHEMA_TYPE = { food: 'FoodEstablishment', shops: 'Store', services: 'LocalBusiness', lodging: 'LodgingBusiness' };

/** schema.org PostalAddress from a typed address ("135 W Columbia Ave, Telluride, CO 81435" or just "135 W Columbia Ave"). */
export function postalAddress(address, town) {
  const parts = String(address).split(',').map((s) => s.trim()).filter(Boolean);
  const out = { '@type': 'PostalAddress', streetAddress: parts[0] || address, addressLocality: town.name, addressCountry: 'US' };
  if (town.state) out.addressRegion = town.state;
  if (parts.length > 1) {
    // "Mountain Village" or "Telluride, CO 81435": take the locality and any zip.
    const rest = parts.slice(1).join(' ');
    if (!/^[A-Z]{2}\b/.test(parts[1])) out.addressLocality = parts[1];
    const zip = rest.match(/\b(\d{5})(?:-\d{4})?\b/);
    if (zip) out.postalCode = zip[1];
  }
  return out;
}

/** One business as schema.org JSON (no sponsorship fields). */
export function businessJson(r, town) {
  const o = { '@type': SCHEMA_TYPE[r.category] || 'LocalBusiness', name: r.name };
  if (r.note) o.description = r.note;
  if (r.phone) o.telephone = r.phone;
  if (r.website) o.url = r.website;
  if (r.address) o.address = postalAddress(r.address, town);
  else o.areaServed = { '@type': 'City', name: place(town) };
  return o;
}

/** JSON-LD for a guide page: breadcrumbs, plus an ItemList of the businesses on it. */
export function guideJsonLd(list, town, guide, now = Date.now()) {
  const out = [{
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: siteName(town), item: pageUrl(town, '/') },
      { '@type': 'ListItem', position: 2, name: guide.label, item: pageUrl(town, guide.path) },
    ],
  }];
  const day = townDay(town, now);
  const biz = guideEntries(list, guide.tab).filter((r) => SCHEMA_TYPE[r.category]);
  if (biz.length) {
    // Same order as the page, category by category.
    const rows = RESOURCE_CATEGORIES.filter((c) => SCHEMA_TYPE[c.id]).flatMap((c) => {
      const all = biz.filter((r) => r.category === c.id);
      return [...all.filter((r) => sponsorActive(r, day)), ...all.filter((r) => !sponsorActive(r, day))];
    });
    out.push({
      '@context': 'https://schema.org', '@type': 'ItemList', name: guide.title(town), url: pageUrl(town, guide.path),
      numberOfItems: rows.length,
      itemListElement: rows.map((r, i) => ({ '@type': 'ListItem', position: i + 1, item: businessJson(r, town) })),
    });
  }
  return out;
}

/** JSON-LD for a town's home page. */
export const homeJsonLd = (town) => [{
  '@context': 'https://schema.org', '@type': 'WebSite', name: siteName(town), url: pageUrl(town, '/'),
  description: `The real-time pulse of ${town.name}: weather, roads, snow, alerts and local news, right now, from sources you can trust.`,
  about: { '@type': 'City', name: place(town) },
}];

/** Meta description for a guide page, naming a few of the listings. */
export function guideDescription(list, town, guide) {
  const rows = guideEntries(list, guide.tab);
  if (guide.tab === 'essentials') return `${place(town)} ${guide.what}: phone numbers, addresses and links, kept up to date by ${siteName(town)}.`;
  if (!rows.length) return `${guide.label} in ${place(town)}: ${guide.what}, coming soon to ${siteName(town)}.`;
  const names = rows.slice(0, 3).map((r) => r.name).join(', ');
  return `${rows.length} ${guide.what} in ${place(town)}, with hours, phone numbers and maps: ${names}${rows.length > 3 ? ' and more' : ''}.`.slice(0, 300);
}

// JSON inside <script> must not be able to close the tag.
const ldScript = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

/**
 * Canonical, robots, share tags and JSON-LD for the <head>. Everything is escaped.
 * `noindex` also applies to every page of a draft town.
 */
export function seoHead(town, { path = '/', title, description, noindex = false, jsonLd = [], type = 'website' }) {
  const url = pageUrl(town, path);
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    isDraft(town) || noindex ? '<meta name="robots" content="noindex, follow">' : '',
    `<meta property="og:type" content="${esc(type)}">`,
    `<meta property="og:site_name" content="${esc(siteName(town))}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(pageUrl(town, '/icons/icon-512.png'))}">`,
    '<meta property="og:locale" content="en_US">',
    '<meta name="twitter:card" content="summary">',
    ...jsonLd.map(ldScript),
  ];
  return tags.filter(Boolean).join('\n  ');
}

/** robots.txt for a town site or thetown.buzz (base = https://host). */
export const robotsTxt = (base) => `User-agent: *\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${base}/sitemap.xml\n`;

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/** sitemap.xml from [{ loc, lastmod?, changefreq? }]. */
export function sitemapXml(entries) {
  const rows = entries.map((e) => `  <url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${isoDay(e.lastmod)}</lastmod>` : ''}${e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

/** A town's sitemap entries: home, about, and each guide page that has listings. Draft towns list nothing. */
export function townSitemap(town, list, { latestPost = null } = {}) {
  if (isDraft(town)) return [];
  const out = [
    { loc: pageUrl(town, '/'), lastmod: latestPost, changefreq: 'hourly' },
    { loc: pageUrl(town, '/about'), changefreq: 'monthly' },
  ];
  for (const g of GUIDE_PAGES) {
    const rows = guideEntries(list, g.tab);
    if (!rows.length) continue;
    out.push({ loc: pageUrl(town, g.path), lastmod: Math.max(...rows.map((r) => r.updatedAt || r.checkedAt || 0)) || null, changefreq: 'weekly' });
  }
  return out;
}

/** Links to the guide pages (real addresses, so crawlers can follow them). */
export function guideNav(current = '') {
  return `<nav class="guide-nav" aria-label="Local guide">${GUIDE_PAGES.map((g) =>
    `<a href="${g.path}"${g.path === current ? ' aria-current="page"' : ''}>${esc(g.label)}</a>`).join('')}</nav>`;
}

/**
 * The newest posts as plain HTML for the first paint (app.js replaces it once the
 * API answers). Gives crawlers and slow phones something real instead of an empty list.
 * Posts are other outlets' stories, so they link out and get no Article markup.
 */
export function feedSnapshot(items, town) {
  if (!items.length) return '';
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: town.timezone || 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const safe = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  return items.map((p) => {
    const link = safe(p.link);
    return `<li class="post sev-${Number(p.severity) || 0}">
    <div class="post-meta"><span class="src ${esc(p.category)}">${esc(p.sourceLabel)}</span><span>·</span><time datetime="${esc(new Date(p.publishedAt).toISOString())}">${esc(fmt.format(p.publishedAt))}</time></div>
    <h3 class="post-title">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</h3>
    ${p.summary ? `<p class="post-sum">${esc(p.summary)}</p>` : ''}
  </li>`;
  }).join('\n');
}
