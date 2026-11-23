// Town resources: the phone numbers, offices and links people look up (emergency
// numbers, the clinic, transit, town hall, utilities). Kept by hand in /admin and
// shown at /resources on every town's site. Civic and essential info only: a
// business directory or classifieds would be a separate feature.
//
// config/resources/<town>.json seeds a town once (meta key resources-imported:<id>);
// after that the database wins, like towns and sources.

/** Shared categories, in page order. Every town uses the same list. */
export const RESOURCE_CATEGORIES = [
  { id: 'emergency', label: 'Emergency' },
  { id: 'medical', label: 'Medical' },
  { id: 'government', label: 'Town & county offices' },
  { id: 'transit', label: 'Transit & parking' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'roads', label: 'Roads & travel' },
  { id: 'outdoors', label: 'Trails & outdoors' },
  { id: 'schools', label: 'Schools & library' },
];
const CAT_IDS = new Set(RESOURCE_CATEGORIES.map((c) => c.id));

/** Entries not checked for this long are flagged in the admin. */
export const STALE_DAYS = 180;

const LIMITS = { name: 120, phone: 40, phone2: 40, website: 300, address: 200, hours: 200, note: 400 };

/** Clean and validate one resource from the admin form or a seed file. */
export function normalizeResource(r = {}) {
  const out = { id: r.id ? Number(r.id) : undefined };
  for (const [k, n] of Object.entries(LIMITS)) out[k] = String(r[k] ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
  out.category = String(r.category || '').trim();
  out.emergency = !!r.emergency;
  out.hidden = !!r.hidden;
  out.sort = Number.isFinite(Number(r.sort)) ? Number(r.sort) : 0;
  if (!out.name) return { error: 'Give the resource a name.' };
  if (!CAT_IDS.has(out.category)) return { error: 'Pick a category.' };
  for (const k of ['phone', 'phone2']) {
    if (out[k] && telHref(out[k]) === null) return { error: `"${out[k]}" doesn't look like a phone number.` };
  }
  if (out.website) {
    if (!/^https?:\/\//i.test(out.website)) out.website = `https://${out.website}`;
    try { const u = new URL(out.website); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw 0; out.website = u.href; } catch { return { error: 'The website doesn\'t look like a web address.' }; }
  }
  if (!out.phone && !out.website && !out.address) return { error: 'Add at least a phone number, website or address.' };
  return { resource: out };
}

/** tel: link for a typed number ("970-728-3844", "911", "1-800-222-1222 ext 4"), or null. */
export function telHref(phone) {
  const m = String(phone).match(/^\s*(\+?[\d\s().-]{3,})(?:\s*(?:x|ext\.?)\s*(\d{1,6}))?\s*$/i);
  if (!m) return null;
  const digits = m[1].replace(/[^\d+]/g, '');
  if (digits.replace('+', '').length < 3) return null;
  return `tel:${digits}${m[2] ? `,${m[2]}` : ''}`;
}

export const mapHref = (address, town) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(/\b[A-Z]{2}\b|\d{5}/.test(address) ? address : `${address}, ${town.name}${town.state ? `, ${town.state}` : ''}`)}`;

/** Seed a town's resources from config/resources/<town>.json, once. */
export function importResources(db, seeds, { log = null } = {}) {
  const done = [];
  for (const seed of seeds) {
    if (!seed?.town || !Array.isArray(seed.resources)) continue;
    const key = `resources-imported:${seed.town}`;
    if (db.getMeta(key)) continue;
    if (!db.listTowns().some((t) => t.id === seed.town)) continue;
    let n = 0;
    seed.resources.forEach((r, i) => {
      const { resource, error } = normalizeResource({ sort: (i + 1) * 10, ...r, id: undefined });
      if (error) { log?.warn?.(`resource seed ${seed.town}/${r.name}: ${error}`); return; }
      db.saveResource(seed.town, { ...resource, checkedAt: seed.checked ? Date.parse(/T/.test(seed.checked) ? seed.checked : `${seed.checked}T12:00:00Z`) || null : null });
      n++;
    });
    db.setMeta(key, Date.now());
    done.push(seed.town);
    log?.info?.(`imported ${n} resources for ${seed.town}`);
  }
  return done;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function card(r, town) {
  const tel = (p) => { const h = telHref(p); return h ? `<a class="res-btn res-call" href="${esc(h)}">${esc(p)}</a>` : esc(p); };
  const bits = [];
  if (r.phone) bits.push(tel(r.phone));
  if (r.phone2) bits.push(tel(r.phone2));
  if (r.website) bits.push(`<a class="res-btn" href="${esc(r.website)}" target="_blank" rel="noopener">${esc(host(r.website))}</a>`);
  if (r.address) bits.push(`<a class="res-btn" href="${esc(mapHref(r.address, town))}" target="_blank" rel="noopener">Map</a>`);
  return `<li class="res">
          <p class="res-name">${esc(r.name)}</p>
          ${r.note ? `<p class="res-note">${esc(r.note)}</p>` : ''}
          ${r.address || r.hours ? `<p class="res-meta">${[r.address, r.hours].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
          <p class="res-actions">${bits.join(' ')}</p>
        </li>`;
}

/** The body of /resources: an emergency box, then one collapsible section per category. */
export function renderResources(list, town) {
  const shown = list.filter((r) => !r.hidden);
  if (!shown.length) return '<p class="muted">Resources for this town are on the way. In an emergency, call 911.</p>';
  const top = shown.filter((r) => r.emergency || r.category === 'emergency');
  const parts = [];
  if (top.length) {
    parts.push(`<section class="res-emergency" aria-labelledby="res-em">
      <h2 id="res-em">Emergency</h2>
      <ul class="res-list">
        ${top.map((r) => card(r, town)).join('\n        ')}
      </ul>
    </section>`);
  }
  const nav = [];
  for (const c of RESOURCE_CATEGORIES) {
    if (c.id === 'emergency') continue;
    const rows = shown.filter((r) => r.category === c.id);
    if (!rows.length) continue;
    nav.push(`<a href="#${c.id}">${esc(c.label)}</a>`);
    parts.push(`<details class="res-cat" id="${c.id}">
      <summary><h2>${esc(c.label)}</h2><span class="res-count">${rows.length}</span></summary>
      <ul class="res-list">
        ${rows.map((r) => card(r, town)).join('\n        ')}
      </ul>
    </details>`);
  }
  if (nav.length > 1) parts.splice(top.length ? 1 : 0, 0, `<nav class="res-jump" aria-label="Jump to a section">${nav.join(' ')}</nav>`);
  const checked = shown.map((r) => r.checkedAt || r.updatedAt).filter(Boolean);
  if (checked.length) {
    const d = new Date(Math.max(...checked));
    parts.push(`<p class="muted small">Last reviewed ${esc(d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: town.timezone || 'America/Denver' }))}.</p>`);
  }
  return parts.join('\n    ');
}
