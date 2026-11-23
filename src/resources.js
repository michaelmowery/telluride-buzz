// Town resources: the phone numbers, offices and links people look up (emergency
// numbers, the clinic, transit, town hall, utilities). Kept by hand in /admin and
// shown at /resources on every town's site. Civic and essential info first; local
// businesses (food, shops, services, lodging) are their own group further down.
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
  // Local businesses: each tab of the home page shows its own categories.
  { id: 'food', label: 'Food & drink', group: 'business', tab: 'eat' },
  { id: 'shops', label: 'Shops', group: 'business', tab: 'shop' },
  { id: 'services', label: 'Local services', group: 'business', tab: 'shop' },
  { id: 'lodging', label: 'Lodging', group: 'business', tab: 'stay' },
];

/** Home page tabs after Live feed. Civic categories (no tab set) are Essentials. */
export const RESOURCE_TABS = [
  { id: 'essentials', label: 'Essentials', search: 'Search essentials', empty: 'Essentials for this town are on the way. In an emergency, call 911.' },
  { id: 'eat', label: 'Food & drink', search: 'Search food & drink', empty: 'Restaurants, cafes and bars are on the way.' },
  { id: 'shop', label: 'Shops', search: 'Search shops and services', empty: 'Shops and local services are on the way.' },
  { id: 'stay', label: 'Lodging', search: 'Search lodging', empty: 'Places to stay are on the way.' },
];
const tabOf = (cat) => RESOURCE_CATEGORIES.find((c) => c.id === cat)?.tab || 'essentials';
export const isBusiness = (cat) => RESOURCE_CATEGORIES.find((c) => c.id === cat)?.group === 'business';
const CAT_IDS = new Set(RESOURCE_CATEGORIES.map((c) => c.id));

/** Entries not checked for this long are flagged in the admin. */
export const STALE_DAYS = 180;

// tags: a short descriptor shown on the card, e.g. "Mexican · $$" or "Ski rentals".
const LIMITS = { name: 120, phone: 40, phone2: 40, website: 300, address: 200, hours: 200, note: 400, tags: 80 };

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
  // Emergency entries may be a note only (for example Mountain Rescue: "Call 911 and ask for...").
  const noteOnlyOk = out.note && (out.category === 'emergency' || out.emergency);
  if (!out.phone && !out.website && !out.address && !noteOnlyOk) {
    return { error: out.category === 'emergency' || out.emergency ? 'Add a phone number, website, address, or at least a note (for example "Call 911 and ask for Mountain Rescue").' : 'Add at least a phone number, website or address.' };
  }
  const sp = normalizeSponsor(r, out);
  if (sp.error) return sp;
  Object.assign(out, sp.sponsor);
  return { resource: out };
}

// ---------- Sponsored listings ----------
// A business listing can be sponsored between two dates (inclusive, in the town's time
// zone). While active it shows first in its category with a "Sponsored" label and an
// optional tagline and logo. Only business categories, never the Emergency box. No
// payments here: the admin turns it on by hand. After the end date it quietly goes
// back to a normal listing.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d) => DAY_RE.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().startsWith(d);
const NO_SPONSOR = { sponsored: false, sponsorFrom: '', sponsorUntil: '', sponsorTagline: '', sponsorLogo: '' };

function normalizeSponsor(r, out) {
  if (!r.sponsored) return { sponsor: { ...NO_SPONSOR } };
  const s = {
    sponsored: true,
    sponsorFrom: String(r.sponsorFrom || '').trim(),
    sponsorUntil: String(r.sponsorUntil || '').trim(),
    sponsorTagline: String(r.sponsorTagline || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    sponsorLogo: String(r.sponsorLogo || '').trim().slice(0, 300),
  };
  if (!isBusiness(out.category)) return { error: 'Only business listings (food, shops, services, lodging) can be sponsored.' };
  if (out.emergency) return { error: 'A sponsored listing can\'t be in the Emergency box.' };
  if (!validDay(s.sponsorFrom) || !validDay(s.sponsorUntil)) return { error: 'Give the sponsorship a start and end date.' };
  if (s.sponsorUntil < s.sponsorFrom) return { error: 'The sponsorship ends before it starts.' };
  if (s.sponsorLogo) {
    try { const u = new URL(s.sponsorLogo); if (u.protocol !== 'https:') throw 0; s.sponsorLogo = u.href; } catch { return { error: 'The logo must be an https:// image address.' }; }
  }
  return { sponsor: s };
}

/** Today as yyyy-mm-dd in the town's time zone. */
export const townDay = (town, now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: town?.timezone || 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Sponsored and inside its dates today. */
export const sponsorActive = (r, day) => !!(r.sponsored && r.sponsorFrom <= day && day <= r.sponsorUntil && isBusiness(r.category) && !r.emergency);

/** "active", "scheduled", "ended" or "" for the admin. */
export function sponsorState(r, day) {
  if (!r.sponsored) return '';
  if (day < r.sponsorFrom) return 'scheduled';
  if (day > r.sponsorUntil) return 'ended';
  return 'active';
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

function card(r, town, sponsored = false) {
  const tel = (p) => { const h = telHref(p); return h ? `<a class="res-btn res-call" href="${esc(h)}">${esc(p)}</a>` : esc(p); };
  const bits = [];
  if (r.phone) bits.push(tel(r.phone));
  if (r.phone2) bits.push(tel(r.phone2));
  if (r.website) bits.push(`<a class="res-btn" href="${esc(r.website)}" target="_blank" rel="noopener">${esc(host(r.website))}</a>`);
  if (r.address) bits.push(`<a class="res-btn" href="${esc(mapHref(r.address, town))}" target="_blank" rel="noopener">Map</a>`);
  if (sponsored) {
    const logo = r.sponsorLogo ? `<img class="res-logo" src="${esc(r.sponsorLogo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
    return `<li class="res res-sponsored">
          <p class="res-sponsor-label">Sponsored</p>
          <div class="res-sponsor-head">${logo}<p class="res-name">${esc(r.name)}</p></div>
          ${r.sponsorTagline ? `<p class="res-tagline">${esc(r.sponsorTagline)}</p>` : ''}
          ${r.tags ? `<p class="res-tags">${esc(r.tags)}</p>` : ''}
          ${r.note ? `<p class="res-note">${esc(r.note)}</p>` : ''}
          ${r.hours ? `<p class="res-hours"><span aria-hidden="true">🕒</span> ${esc(r.hours)}</p>` : ''}
          ${r.address ? `<p class="res-meta">${esc(r.address)}</p>` : ''}
          <p class="res-actions">${bits.join(' ')}</p>
        </li>`;
  }
  return `<li class="res">
          <p class="res-name">${esc(r.name)}</p>
          ${r.tags ? `<p class="res-tags">${esc(r.tags)}</p>` : ''}
          ${r.note ? `<p class="res-note">${esc(r.note)}</p>` : ''}
          ${r.hours ? `<p class="res-hours"><span aria-hidden="true">🕒</span> ${esc(r.hours)}</p>` : ''}
          ${r.address ? `<p class="res-meta">${esc(r.address)}</p>` : ''}
          <p class="res-actions">${bits.join(' ')}</p>
        </li>`;
}

/** The body of /resources: an emergency box, then one collapsible section per category. */
export function renderResources(list, town, now = Date.now(), tab = null) {
  const day = townDay(town, now);
  // With a tab (home page), only that tab's categories; without (the /resources page), all.
  const T = tab ? RESOURCE_TABS.find((t) => t.id === tab) : null;
  const inTab = (cat) => !tab || tabOf(cat) === tab;
  const cats = RESOURCE_CATEGORIES.filter((c) => inTab(c.id));
  const shown = list.filter((r) => !r.hidden && inTab(r.category));
  const withEmergency = !tab || tab === 'essentials';
  if (!shown.length) return `<p class="muted">${esc(T ? T.empty : 'Resources for this town are on the way. In an emergency, call 911.')}</p>`;
  const top = withEmergency ? list.filter((r) => !r.hidden && (r.emergency || r.category === 'emergency')) : [];
  const parts = [];
  if (top.length) {
    // Collapsed like the other sections, but red, with 911 one tap away even when closed.
    parts.push(`<details class="res-cat res-emergency" id="emergency">
      <summary><h2>Emergency</h2><span class="res-count">${top.length}</span><a class="res-btn res-call res-911" href="tel:911">911</a></summary>
      <ul class="res-list">
        ${top.map((r) => card(r, town)).join('\n        ')}
      </ul>
    </details>`);
  }
  let bizHeading = false;
  for (const c of cats) {
    if (c.id === 'emergency') continue;
    const all = shown.filter((r) => r.category === c.id);
    if (!all.length) continue;
    // Active sponsors first (keeping their admin order), then everyone else.
    const rows = [...all.filter((r) => sponsorActive(r, day)), ...all.filter((r) => !sponsorActive(r, day))];
    if (c.group === 'business' && !bizHeading && !tab) {
      bizHeading = true;
      parts.push(`<h2 class="res-group" id="local-businesses">Local businesses</h2>`);
    }
    // Business tabs start open (there are only one or two sections); civic ones collapsed.
    parts.push(`<details class="res-cat" id="${c.id}"${tab && tab !== 'essentials' ? ' open' : ''}>
      <summary><h2>${esc(c.label)}</h2><span class="res-count">${rows.length}</span></summary>
      <ul class="res-list">
        ${rows.map((r) => card(r, town, sponsorActive(r, day))).join('\n        ')}
      </ul>
    </details>`);
  }
  // Search box and category sub-tabs. Without JavaScript the sub-tabs are plain jump
  // links and the search box stays hidden (towns.js turns both on).
  const subCats = cats.filter((c) => (c.id === 'emergency' ? top.length : shown.some((r) => r.category === c.id)));
  const search = T ? T.search : 'Search resources';
  // Sub-tabs only when there's more than one section to pick from.
  const subtabs = subCats.length > 1 ? `
      <nav class="res-subtabs" aria-label="${esc(T ? T.label : 'Resource')} categories">
        <a href="#${tab === 'essentials' || !tab ? 'resources' : tab}" class="res-sub" data-cat="" aria-current="true" hidden>All</a>
        ${subCats.map((c) => `<a href="#${c.id}" class="res-sub" data-cat="${c.id}">${esc(c.label)}</a>`).join('\n        ')}
      </nav>` : '';
  parts.unshift(`<div class="res-tools">
      <input type="search" class="res-search" placeholder="${esc(search)}" aria-label="${esc(search)}" autocomplete="off" hidden>${subtabs}
    </div>
    <p class="res-empty muted" hidden>Nothing matches. In an emergency, call 911.</p>`);
  const checked = shown.map((r) => r.checkedAt || r.updatedAt).filter(Boolean);
  if (checked.length) {
    const d = new Date(Math.max(...checked));
    parts.push(`<p class="muted small">Last reviewed ${esc(d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: town.timezone || 'America/Denver' }))}.</p>`);
  }
  return parts.join('\n    ');
}

// ---------- CSV (admin export and import) ----------
export const CSV_COLUMNS = ['id', 'town', 'category', 'name', 'phone', 'phone2', 'website', 'address', 'hours', 'note', 'tags', 'emergency', 'hidden', 'checked'];

const csvCell = (v) => {
  const s = String(v ?? '');
  // A leading = + - @ would run as a formula in a spreadsheet; prefix it so it shows as text.
  const safe = /^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?[\d\s().-]+$/.test(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Resources as CSV, one row each, with the town and a yyyy-mm-dd "checked" date. */
export function resourcesToCsv(list) {
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
  const rows = list.map((r) => [r.id, r.townId, r.category, r.name, r.phone, r.phone2, r.website, r.address, r.hours, r.note, r.tags,
    r.emergency ? 'yes' : '', r.hidden ? 'yes' : '', day(r.checkedAt)]);
  return [CSV_COLUMNS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const sponsorFields = (r) => ({ sponsored: r.sponsored, sponsorFrom: r.sponsorFrom, sponsorUntil: r.sponsorUntil, sponsorTagline: r.sponsorTagline, sponsorLogo: r.sponsorLogo });

/** Parse CSV text (RFC 4180: quotes, doubled quotes, newlines inside quotes) into rows of strings. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const yes = (v) => /^(y|yes|true|1|x)$/i.test(String(v || '').trim());
const unformula = (v) => String(v ?? '').replace(/^'(?=[=+\-@])/, '');

/**
 * Turn CSV text into a plan: rows to add and rows to update, plus per-row errors.
 * Rows with an id that exists in that town update it; other rows are added.
 * A blank town cell uses defaultTown. Nothing is written here.
 */
export function planCsvImport(text, { towns, existing, defaultTown = '', onlyTown = '' }) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'The file is empty.' };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  if (!head.includes('name') || !head.includes('category')) return { error: 'The first row must be the column names, including name and category. Export a CSV to see the format.' };
  const townIds = new Set(towns.map((t) => t.id));
  const cats = new Map(RESOURCE_CATEGORIES.flatMap((c) => [[c.id, c.id], [c.label.toLowerCase(), c.id]]));
  const byId = new Map(existing.map((r) => [r.id, r]));
  const adds = [];
  const updates = [];
  const errors = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const v = Object.fromEntries(head.map((h, j) => [h, unformula(cells[j]).trim()]));
    const town = v.town || defaultTown;
    if (!townIds.has(town)) { errors.push({ line, name: v.name, error: town ? `No town "${town}".` : 'Add a town column or pick a town.' }); return; }
    if (onlyTown && town !== onlyTown) { errors.push({ line, name: v.name, error: `This row is for "${town}". Switch to that town to import it.` }); return; }
    const id = v.id ? Number(v.id) : null;
    const old = id ? byId.get(id) : null;
    if (id && (!old || old.townId !== town)) { errors.push({ line, name: v.name, error: `No resource ${id} in ${town}. Clear the id to add it as new.` }); return; }
    const category = cats.get(String(v.category || '').toLowerCase()) || v.category;
    const { resource, error } = normalizeResource({
      // Sponsorship isn't in the CSV: an update keeps whatever the entry had.
      ...(old ? sponsorFields(old) : {}),
      ...v, id: id || undefined, category, sort: old?.sort,
      emergency: 'emergency' in v ? yes(v.emergency) : old?.emergency,
      hidden: 'hidden' in v ? yes(v.hidden) : old?.hidden,
    });
    if (error) { errors.push({ line, name: v.name, error }); return; }
    const checkedAt = v.checked ? Date.parse(/T/.test(v.checked) ? v.checked : `${v.checked}T12:00:00Z`) || null : null;
    if (v.checked && !checkedAt) { errors.push({ line, name: v.name, error: `"${v.checked}" isn't a date (use 2026-11-23).` }); return; }
    const item = { town, line, resource: { ...resource, ...(checkedAt ? { checkedAt } : {}) } };
    (old ? updates : adds).push(item);
  });
  return { adds, updates, errors, rows: rows.length - 1 };
}
