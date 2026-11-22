// Per-town branding. index.html, about.html, the manifest and the service worker
// are templates with {{placeholders}}; the server fills them from the town's
// config (picked by hostname), so every town runs the same code and files.
//
// Logo rule (decided 2026-11-21): a town whose [town].buzz domain we own keeps
// its own logo ("own": town name + .buzz in the circle). Every other town uses
// "thetown" style: town name beside the circle, "thetown" stacked above ".buzz"
// inside it, so no logo implies we own that town's .buzz domain.

import { ADAPTERS } from './adapters.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsStr = (s) => JSON.stringify(String(s ?? '')).slice(1, -1);

const WAVES = `
        <path class="logo-wave" d="M423.8 61.1 A92 92 0 0 1 488.9 126.2"/>
        <path class="logo-wave" d="M429 41.8 A112 112 0 0 1 508.2 121"/>
        <path class="logo-wave" d="M434.2 22.5 A132 132 0 0 1 527.5 115.8"/>`;

export function logoSvg(town, { cls = 'logo', width = 110, height = 48 } = {}) {
  const word = esc(town.brand?.logoWord || town.name.toLowerCase());
  const inner = town.brand?.logo === 'own'
    ? `
        <circle cx="342" cy="160" r="8" class="logo-ink"/>
        <text x="354" y="172" class="logo-ink logo-buzz">buzz</text>`
    : `
        <text x="404" y="128" text-anchor="middle" class="logo-ink logo-thetown">thetown</text>
        <circle cx="342" cy="168" r="7" class="logo-ink"/>
        <text x="353" y="180" class="logo-ink logo-buzz">buzz</text>`;
  return `<svg class="${cls}" viewBox="30 14 504 220" width="${width}" height="${height}" aria-hidden="true">
        <text x="318" y="172" text-anchor="end" class="logo-name">${word}</text>
        <circle cx="400" cy="150" r="78" class="logo-dot"/>${inner}${WAVES}
      </svg>`;
}

/** Public address of a town: config `url`, else its first hostname. */
export const townUrl = (t) => t.url || `https://${t.hostnames[0]}`;

/** Town picker opened from the header logo: every town, each in its own logo. */
export function townMenu(town, towns) {
  const rows = [...towns].sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
    const here = t.id === town.id;
    const host = townUrl(t).replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `<li><a class="town-opt" href="${here ? '/' : esc(townUrl(t))}"${here ? ' aria-current="page"' : ''}>
          <span class="town-logo">${logoSvg(t, { cls: 'logo logo-sm', width: 92, height: 40 })}</span>
          <span class="town-txt"><strong>${esc(t.name)}${t.state ? `, ${esc(t.state)}` : ''}</strong><small>${here ? 'You are here' : esc(host)}</small></span>
        </a></li>`;
  }).join('\n        ');
  return `<nav class="town-menu" id="town-menu" hidden aria-label="Choose a town">
      <p class="town-menu-title">Choose a town</p>
      <ul>
        ${rows}
      </ul>
      <a class="town-all" href="https://thetown.buzz">See all towns at <strong>thetown.buzz</strong></a>
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

/** Values for one town. `site` is the name used in sentences ("Durango Buzz is in early testing"). */
export function brandValues(town, towns = [town]) {
  const b = town.brand || {};
  const site = b.siteName || `${town.name} Buzz`;
  const rows = (b.aboutSources || aboutRows(town)).map(([src, what, every]) =>
    `<tr><td>${esc(src)}</td><td>${esc(what)}</td><td>${esc(every)}</td></tr>`).join('\n        ');
  return {
    site,
    town: town.name,
    logo: logoSvg(town),
    townMenu: townMenu(town, towns),
    aboutSources: rows,
    notAffiliated: b.notAffiliated || 'the agencies and businesses whose information it shows',
    feedbackEmail: b.feedbackEmail || 'telluridebuzz@gmail.com',
    feedbackSubject: encodeURIComponent(`${site} feedback`),
  };
}

// Values that are already markup (or URL-encoded) and must not be escaped again.
const RAW = new Set(['logo', 'townMenu', 'aboutSources', 'feedbackSubject']);

/** Fill {{name}} placeholders. HTML files get HTML escaping; JS and JSON files get string escaping. */
export function renderTemplate(text, ext, town, towns = [town]) {
  const v = brandValues(town, towns);
  const html = ext === '.html';
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in v)) return m;
    if (RAW.has(k)) return v[k];
    return html ? esc(v[k]) : jsStr(v[k]);
  });
}

export const TEMPLATED = new Set(['/index.html', '/about.html', '/manifest.webmanifest', '/sw.js']);
