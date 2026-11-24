// Per-town branding. index.html, about.html, the manifest and the service worker
// are templates with {{placeholders}}; the server fills them from the town's
// config (picked by hostname), so every town runs the same code and files.
//
// Logo rule (decided 2026-11-21): a town whose [town].buzz domain we own keeps
// its own logo ("own": town name + .buzz in the circle). Every other town uses
// "thetown" style: town name beside the circle, "thetown" stacked above ".buzz"
// inside it, so no logo implies we own that town's .buzz domain.

import { buildInfo } from './version.js';
import { ADAPTERS } from './adapters.js';
import { DEFAULT_DISCLAIMER } from './sources/cdot.js';
import { NM_DISCLAIMER } from './sources/nmroads.js';
import { stateName } from './geocode.js';
import { formLinks } from './forms.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsStr = (s) => JSON.stringify(String(s ?? '')).slice(1, -1);

const WAVES = `
        <path class="logo-wave" d="M423.8 61.1 A92 92 0 0 1 488.9 126.2"/>
        <path class="logo-wave" d="M429 41.8 A112 112 0 0 1 508.2 121"/>
        <path class="logo-wave" d="M434.2 22.5 A132 132 0 0 1 527.5 115.8"/>`;

// Optional town accents on the thetown-style logo (brand.logo). Each keeps
// "thetown .buzz" in the circle, so none implies we own [town].buzz.
export const LOGO_STYLES = {
  own: 'Own domain style (we own [town].buzz)',
  thetown: 'thetown.buzz style (town name + "thetown" circle)',
  rock: 'thetown.buzz style, red rock circle',
  ridge: 'thetown.buzz style, mountain ridge in the circle',
  rail: 'thetown.buzz style, railroad under the town name',
};
let clipN = 0;

// Rough Roboto Slab Bold widths (in em) for sizing the town name to fit its space.
// Measured in Chromium: most letters 0.6, i/l/r/t/f/j 0.33, m/w 0.93.
const NARROW = new Set([...'fijlrt.,\'-']);
const WIDE = new Set([...'mw']);
export const nameWidth = (s, px = 70) => [...String(s)].reduce((w, c) => w + (c === ' ' ? 0.26 : NARROW.has(c) ? 0.33 : WIDE.has(c) ? 0.93 : 0.6), 0) * px;
const NAME_ROOM = 284; // from the left edge of the logo (x 30) to the name's right end (x 318), less a little

/**
 * The town name, right-aligned against the circle. A name too long for one line at
 * full size goes on two lines (at a space) or is scaled down to fit, so "Fort Collins"
 * or "Steamboat Springs" never runs off the left edge. Scaling is a transform: the
 * page's CSS sets the font size and the CSP allows no inline styles.
 */
function nameText(word, y) {
  const fit = (w, max) => Math.min(max, NAME_ROOM / w);
  const one = nameWidth(word);
  if (one <= NAME_ROOM) return `<text x="318" y="${y}" text-anchor="end" class="logo-name">${esc(word)}</text>`;
  const at = word.indexOf(' ', Math.floor(word.length / 2) - 3) > 0 ? word.indexOf(' ', Math.floor(word.length / 2) - 3) : word.lastIndexOf(' ');
  if (at > 0) {
    const lines = [word.slice(0, at), word.slice(at + 1)];
    const k = +fit(Math.max(...lines.map((l) => nameWidth(l))), 0.86).toFixed(3);
    const lead = Math.round(70 * k * 0.92);
    return lines.map((l, i) => `<text transform="translate(318 ${y + 4 - (1 - i) * lead}) scale(${k})" text-anchor="end" class="logo-name">${esc(l)}</text>`).join('');
  }
  const k = +fit(one, 1).toFixed(3);
  return `<text transform="translate(318 ${y - Math.round((1 - k) * 25)}) scale(${k})" text-anchor="end" class="logo-name">${esc(word)}</text>`;
}

export function logoSvg(town, { cls = 'logo', width = 110, height = 48 } = {}) {
  const word = String(town.brand?.logoWord || town.name.toLowerCase()).trim();
  const style = LOGO_STYLES[town.brand?.logo] ? town.brand.logo : 'thetown';
  const dy = style === 'ridge' ? -12 : 0;
  const inner = style === 'own'
    ? `
        <circle cx="342" cy="160" r="8" class="logo-ink"/>
        <text x="354" y="172" class="logo-ink logo-buzz">buzz</text>`
    : `
        <text x="404" y="${128 + dy}" text-anchor="middle" class="logo-ink logo-thetown">thetown</text>
        <circle cx="342" cy="${168 + dy}" r="7" class="logo-ink"/>
        <text x="353" y="${180 + dy}" class="logo-ink logo-buzz">buzz</text>`;
  let accent = '';
  if (style === 'ridge') {
    const id = `logo-clip-${++clipN}`;
    accent = `
        <clipPath id="${id}"><circle cx="400" cy="150" r="78"/></clipPath>
        <path clip-path="url(#${id})" class="logo-ridge" d="M318 206 L342 190 L356 198 L382 176 L398 190 L414 182 L432 194 L452 180 L484 202 L484 240 L318 240Z"/>`;
  }
  let nameY = 172;
  if (style === 'rail') {
    nameY = 164;
    let ties = '';
    for (let x = 60; x <= 312; x += 21) ties += `<line x1="${x}" y1="186" x2="${x}" y2="200"/>`;
    accent = `
        <g class="logo-rail"><line x1="50" y1="186" x2="320" y2="186"/>${ties}</g>`;
  }
  return `<svg class="${cls}${style === 'rock' ? ' logo-rock' : ''}" viewBox="30 14 504 220" width="${width}" height="${height}" aria-hidden="true">
        ${nameText(word, nameY)}
        <circle cx="400" cy="150" r="78" class="logo-dot"/>${accent}${inner}${WAVES}
      </svg>`;
}

/** Public address of a town: config `url`, else its first hostname. */
export const townUrl = (t) => t.url || `https://${t.hostnames[0]}`;

/**
 * A town's other addresses are shortcuts: a page asked for on any address that
 * isn't the town's main one (its first web address, e.g. telluride.thetown.buzz)
 * forwards there, path and query kept. Sign-ins live on .thetown.buzz, so every
 * page has to end up there. /api/ stays put, so phones that turned alerts on at
 * an old address keep getting them. Local test addresses never forward.
 * Returns the address to forward to, or null.
 */
export function aliasRedirect(town, host, pathname, search = '') {
  if (!town || !host) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (!(town.hostnames || []).includes(host)) return null;
  if (pathname.startsWith('/api/') || pathname === '/healthz') return null;
  let main;
  try { main = new URL(townUrl(town)); } catch { return null; }
  if (main.hostname === host) return null;
  return `${main.origin}${pathname}${search}`;
}

/** Towns grouped by state: [{ state: 'Colorado', towns }], states A-Z (no state last), towns A-Z in each. */
export function groupByState(towns) {
  const groups = new Map();
  for (const t of towns) {
    const name = stateName(t.state) || 'Other';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(t);
  }
  return [...groups].sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b))
    .map(([state, list]) => ({ state, towns: list.sort((x, y) => x.name.localeCompare(y.name)) }));
}

/** Words a town search matches: name, state code and state name, address. */
export const townSearchText = (t) => [t.name, t.state, stateName(t.state), ...(t.hostnames || [])].filter(Boolean).join(' ').toLowerCase();

/** Town picker opened from the header logo: every town, each in its own logo. */
export function townMenu(town, towns) {
  const row = (t) => {
    const here = t.id === town.id;
    const host = townUrl(t).replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `<li data-q="${esc(townSearchText(t))}"><a class="town-opt" href="${here ? '/' : esc(townUrl(t))}"${here ? ' aria-current="page"' : ''}>
          <span class="town-logo">${logoSvg(t, { cls: 'logo logo-sm', width: 92, height: 40 })}</span>
          <span class="town-txt"><strong>${esc(t.name)}${t.state ? `, ${esc(t.state)}` : ''}</strong><small>${here ? 'You are here' : esc(host)}</small></span>
        </a></li>`;
  };
  // Grouped by state, with a search box (shown by towns.js) that filters as you type.
  const groups = groupByState(towns).map((g) => `<li class="town-group" data-group><p class="town-state">${esc(g.state)}</p>
        <ul>
        ${g.towns.map(row).join('\n        ')}
        </ul></li>`).join('\n        ');
  return `<nav class="town-menu" id="town-menu" hidden aria-label="Choose a town">
      <p class="town-menu-title">Choose a town</p>
      <input type="search" class="town-search" data-town-search placeholder="Search towns or states" aria-label="Search towns" autocomplete="off" hidden>
      <ul class="town-groups">
        ${groups}
      </ul>
      <p class="town-none" data-none hidden>No towns match.</p>
      <a class="town-all" href="https://thetown.buzz">See all towns at <strong>thetown.buzz</strong></a>
      <a class="town-suggest" href="${esc(formLinks().suggestTownUrl)}" target="_blank" rel="noopener">Don't see your town? <strong>Suggest a town</strong></a>
    </nav>`;
}

/** About page rows built from the town's sources when the brand doesn't list them by hand. */
export function aboutRows(town) {
  const rows = [];
  for (const s of (town.sources || []).filter((x) => x.enabled !== false)) {
    const a = ADAPTERS[s.adapter];
    if (!a) continue;
    const every = Number(s.everyMin) || a.defaultEvery;
    const row = [s.label, s.about || a.description, every >= 60 ? `Every ${Math.round(every / 60)} hour${every >= 120 ? 's' : ''}` : `Every ${every} min`];
    const same = rows.find((r) => r[0] === row[0] && r[1] === row[1]);
    if (!same) rows.push(row);
  }
  return rows;
}

const on = (town, adapters) => (town.sources || []).some((x) => x.enabled !== false && adapters.includes(x.adapter));
/** "no-roads no-lifts" for a town without a roads or ski source (see styles.css). */
export function tileGaps(town) {
  if (!Array.isArray(town.sources)) return '';
  return [on(town, ROADS) ? '' : 'no-roads', on(town, ['snow-report', 'resort-alerts']) ? '' : 'no-lifts'].filter(Boolean).join(' ');
}
// Roads sources (one per state DOT) and the road-data fine print each one shows.
const ROADS = ['cdot', 'nmroads'];
const ROADS_FINE = { cdot: DEFAULT_DISCLAIMER, nmroads: NM_DISCLAIMER };
function roadsFine(town) {
  const s = (town.sources || []).find((x) => x.enabled !== false && ROADS.includes(x.adapter));
  return s ? s.settings?.disclaimer || ROADS_FINE[s.adapter] : '';
}
function roadsDisclaimer(town) {
  const text = roadsFine(town);
  return text ? `<p id="disclaimer" class="disclaimer"><strong>Road data source:</strong> ${esc(text)}</p>` : '';
}

/** Values for one town. `site` is the name used in sentences ("Durango Buzz is in early testing"). */
export function brandValues(town, towns = [town]) {
  const b = town.brand || {};
  const site = b.siteName || `${town.name} Buzz`;
  const rows = (b.aboutSources || aboutRows(town)).map(([src, what, every]) =>
    `<tr><td>${esc(src)}</td><td>${esc(what)}</td><td>${esc(every)}</td></tr>`).join('\n        ');
  return {
    site,
    town: town.name,
    buildLabel: buildInfo.label, // footer: which deploy this is (src/version.js)
    logo: logoSvg(town),
    townMenu: townMenu(town, towns),
    aboutSources: rows,
    notAffiliated: b.notAffiliated || 'the agencies and businesses whose information it shows',
    feedbackEmail: b.feedbackEmail || 'telluridebuzz@gmail.com',
    feedbackSubject: encodeURIComponent(`${site} feedback`),
    // ClickUp forms (src/forms.js), pre-filled with this town's display name.
    ...formLinks(town.name),
    // Tiles with no source are left out (a town without state roads or a ski resort),
    // and a DOT's disclaimer shows only where that DOT's data does.
    bodyClass: tileGaps(town),
    roadsDisclaimer: roadsDisclaimer(town),
    aboutRoadsFine: roadsFine(town) ? `<p class="muted"><strong>Road data source:</strong> ${esc(roadsFine(town))}</p>` : '',
    resources: '', eat: '', shop: '', stay: '', // filled per request by the server (index and resources pages)
    seo: '', guideNav: '', feedSnapshot: '', notices: '', // search tags, guide links and first-paint posts (see seo.js)
    pageTitle: site, pageDescription: '', h1: town.name, lede: '',
  };
}

// Values that are already markup (or URL-encoded) and must not be escaped again.
const RAW = new Set(['logo', 'townMenu', 'aboutSources', 'feedbackSubject', 'resources', 'eat', 'shop', 'stay', 'seo', 'guideNav', 'feedSnapshot', 'notices', 'roadsDisclaimer', 'aboutRoadsFine']);

/** Fill {{name}} placeholders. HTML files get HTML escaping; JS and JSON files get string escaping. */
export function renderTemplate(text, ext, town, towns = [town], extra = {}) {
  const v = { ...brandValues(town, towns), ...extra };
  const html = ext === '.html';
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in v)) return m;
    if (RAW.has(k)) return v[k];
    return html ? esc(v[k]) : jsStr(v[k]);
  });
}

export const TEMPLATED = new Set(['/index.html', '/about.html', '/resources.html', '/guide.html', '/manifest.webmanifest', '/sw.js']);
