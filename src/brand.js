// Per-town branding. index.html, about.html, the manifest and the service worker
// are templates with {{placeholders}}; the server fills them from the town's
// config (picked by hostname), so every town runs the same code and files.
//
// Logo rule (decided 2026-11-21): a town whose [town].buzz domain we own keeps
// its own logo ("own": town name + .buzz in the circle). Every other town uses
// "thetown" style: town name beside the circle, "thetown" stacked above ".buzz"
// inside it, so no logo implies we own that town's .buzz domain.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsStr = (s) => JSON.stringify(String(s ?? '')).slice(1, -1);

const WAVES = `
        <path class="logo-wave" d="M423.8 61.1 A92 92 0 0 1 488.9 126.2"/>
        <path class="logo-wave" d="M429 41.8 A112 112 0 0 1 508.2 121"/>
        <path class="logo-wave" d="M434.2 22.5 A132 132 0 0 1 527.5 115.8"/>`;

export function logoSvg(town) {
  const word = esc(town.brand?.logoWord || town.name.toLowerCase());
  const inner = town.brand?.logo === 'own'
    ? `
        <circle cx="342" cy="160" r="8" class="logo-ink"/>
        <text x="354" y="172" class="logo-ink logo-buzz">buzz</text>`
    : `
        <text x="404" y="128" text-anchor="middle" class="logo-ink logo-thetown">thetown</text>
        <circle cx="342" cy="168" r="7" class="logo-ink"/>
        <text x="353" y="180" class="logo-ink logo-buzz">buzz</text>`;
  return `<svg class="logo" viewBox="30 14 504 220" width="110" height="48" aria-hidden="true">
        <text x="318" y="172" text-anchor="end" class="logo-name">${word}</text>
        <circle cx="400" cy="150" r="78" class="logo-dot"/>${inner}${WAVES}
      </svg>`;
}

/** Values for one town. `site` is the name used in sentences ("Durango Buzz is in early testing"). */
export function brandValues(town) {
  const b = town.brand || {};
  const site = b.siteName || `${town.name} Buzz`;
  const rows = (b.aboutSources || []).map(([src, what, every]) =>
    `<tr><td>${esc(src)}</td><td>${esc(what)}</td><td>${esc(every)}</td></tr>`).join('\n        ');
  return {
    site,
    town: town.name,
    logo: logoSvg(town),
    aboutSources: rows,
    notAffiliated: b.notAffiliated || 'the agencies and businesses whose information it shows',
    feedbackEmail: b.feedbackEmail || 'telluridebuzz@gmail.com',
    feedbackSubject: encodeURIComponent(`${site} feedback`),
  };
}

// Values that are already markup (or URL-encoded) and must not be escaped again.
const RAW = new Set(['logo', 'aboutSources', 'feedbackSubject']);

/** Fill {{name}} placeholders. HTML files get HTML escaping; JS and JSON files get string escaping. */
export function renderTemplate(text, ext, town) {
  const v = brandValues(town);
  const html = ext === '.html';
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in v)) return m;
    if (RAW.has(k)) return v[k];
    return html ? esc(v[k]) : jsStr(v[k]);
  });
}

export const TEMPLATED = new Set(['/index.html', '/about.html', '/manifest.webmanifest', '/sw.js']);
