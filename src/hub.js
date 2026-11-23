// thetown.buzz: the umbrella home page above every town site.
//
// The bare domain (and www) shows a landing page that explains the network and
// lists each town with a live snapshot (weather, active alerts, new snow) read
// from the same database the town pages use. Town sites stay on their own
// addresses (telluride.buzz, durango.thetown.buzz); thetown.buzz/<town> redirects
// there, per the subdomain-per-town decision (2026-11-21).
import { groupByState, logoSvg, townSearchText, townUrl } from './brand.js';
import { formLinks } from './forms.js';

export const HUB_HOSTS = new Set(['thetown.buzz', 'www.thetown.buzz', 'thetown.localhost']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The umbrella's own logo: "thetown" beside the circle with .buzz, like telluride.buzz. */
export const hubLogo = (opts) => logoSvg({ name: 'thetown', brand: { logo: 'own', logoWord: 'thetown' } }, opts);

/** Town for a hub path like /durango, or null. */
export function townForPath(pathname, towns) {
  const id = pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  return id && !id.includes('/') ? towns.find((t) => t.id === id) || null : null;
}

/** One-line live snapshot for a town card, from its tiles and alerts. Missing data is left out. */
export function snapshot(tiles = {}, alerts = []) {
  const bits = [];
  const w = tiles.weather;
  if (w?.ok && Number.isFinite(w.temp)) bits.push({ k: 'weather', html: `<b>${Math.round(w.temp)}°</b> ${esc(w.short || '')}` });
  const l = tiles.lifts;
  if (l?.ok && Number.isFinite(l.new24) && l.new24 > 0) bits.push({ k: 'snow', html: `<b>${l.new24}″</b> new snow` });
  else if (l?.ok && Number.isFinite(l.liftsOpen) && l.liftsTotal) bits.push({ k: 'lifts', html: `<b>${l.liftsOpen}/${l.liftsTotal}</b> lifts open` });
  if (alerts.length) bits.push({ k: 'alert', html: `<b>${alerts.length}</b> active alert${alerts.length === 1 ? '' : 's'}` });
  return bits;
}

function townCard(t, snap) {
  const host = townUrl(t).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const site = t.brand?.siteName || `${t.name} Buzz`;
  const live = snap.length
    ? `<ul class="hub-live">${snap.map((b) => `<li class="hub-live-${b.k}">${b.html}</li>`).join('')}</ul>`
    : '<p class="hub-live-none">Live data loading</p>';
  return `<li data-q="${esc(townSearchText(t))}">
        <a class="hub-town" href="${esc(townUrl(t))}">
          <span class="hub-town-logo">${logoSvg(t, { cls: 'logo', width: 150, height: 66 })}</span>
          <span class="hub-town-body">
            <strong>${esc(t.name)}${t.state ? `, ${esc(t.state)}` : ''}</strong>
            ${live}
            <span class="hub-town-go"><span>Open ${esc(site)}</span><small>${esc(host)}</small></span>
          </span>
        </a>
      </li>`;
}

/** Fill hub.html. `snapFor(town)` returns that town's snapshot bits. */
export function renderHub(text, towns, snapFor) {
  const list = [...towns].sort((a, b) => a.name.localeCompare(b.name));
  const v = {
    logo: hubLogo({ cls: 'logo', width: 132, height: 58 }),
    townCount: String(list.length),
    // Grouped by state (A-Z, towns A-Z in each); towns.js filters them with the search box.
    towns: groupByState(list).map((g) => `<section class="hub-state" data-group>
      <h3 class="hub-state-h">${esc(g.state)}</h3>
      <ul class="hub-towns">
      ${g.towns.map((t) => townCard(t, snapFor(t))).join('\n      ')}
      </ul>
      </section>`).join('\n      '),
    feedbackEmail: esc(list.find((t) => t.brand?.feedbackEmail)?.brand.feedbackEmail || 'telluridebuzz@gmail.com'),
    feedbackSubject: encodeURIComponent('Buzz for my town'),
    // ClickUp forms (src/forms.js); the hub has no town, so nothing to pre-fill but the kind.
    suggestTownUrl: esc(formLinks().suggestTownUrl),
    feedbackUrl: esc(formLinks().feedbackUrl),
    supportUrl: esc(formLinks().supportUrl),
  };
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? v[k] : m));
}
