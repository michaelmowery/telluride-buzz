// Add a resource from a web address: fetch the page on the server and read the
// business details it publishes for search engines (schema.org JSON-LD, OpenGraph,
// meta tags), with tel: links and the page text as a fallback. No AI and no key.
// If the home page is thin, one contact/about page on the same site is read too.
import dns from 'node:dns/promises';
import net from 'node:net';

const UA = process.env.PAGE_INFO_UA || 'Mozilla/5.0 (compatible; TheTownBuzz/0.1; +https://thetown.buzz)';
const MAX_BYTES = 3 * 1024 * 1024;

// ---------- fetching (admin only, but never let it reach the server's own network) ----------

/** https://example.com from what was typed; throws for anything that isn't a public web address. */
export function cleanUrl(raw) {
  let v = String(raw || '').trim();
  if (!v) throw new Error('Type or paste a web address first.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
  let u;
  try { u = new URL(v); } catch { throw new Error('That doesn\'t look like a web address.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https web addresses work.');
  if (u.username || u.password) throw new Error('Leave the user name and password out of the address.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes('.') || /\.(local|localhost|internal|lan|home)$/.test(host) || host === 'localhost') throw new Error('That address is not on the public web.');
  if (net.isIP(host) && privateIp(host)) throw new Error('That address is not on the public web.');
  u.hash = '';
  return u.href;
}

/** Loopback, private, link-local and other non-public ranges. */
export function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
}

async function checkHost(href, lookup) {
  const host = new URL(href).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (privateIp(host)) throw new Error('That address is not on the public web.'); return; }
  let addrs;
  try { addrs = await lookup(host, { all: true }); } catch { throw Object.assign(new Error(`Couldn't find ${host}. Check the address for typos.`), { status: 404 }); }
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('That address is not on the public web.');
}

/** A page's HTML and its final address, following up to 5 redirects (each one checked). */
export async function fetchPage(href, { timeoutMs = 12000, lookup = dns.lookup, fetchImpl = fetch } = {}) {
  let url = cleanUrl(href);
  for (let hop = 0; hop < 6; hop++) {
    await checkHost(url, lookup);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.8' } });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        url = cleanUrl(new URL(res.headers.get('location'), url).href);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      const type = res.headers.get('content-type') || '';
      if (type && !/html|xml/i.test(type)) throw new Error(`That address is a ${type.split(';')[0]} file, not a web page.`);
      if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('That page is too large to read.');
      const html = (await res.text()).slice(0, MAX_BYTES);
      return { html, url };
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error(`The site took longer than ${Math.round(timeoutMs / 1000)} seconds to answer.`), { status: 504 });
      if (e.cause && !e.status) throw new Error(`Couldn't connect (${e.cause.code || e.cause.message}).`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects.');
}

// ---------- reading ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', middot: '·', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', ntilde: 'ñ' };
export const decode = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const clean = (s) => decode(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const first = (...xs) => xs.map((x) => (Array.isArray(x) ? x[0] : x)).find((x) => x != null && String(typeof x === 'object' ? '' : x).trim() !== '');

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

/** <meta> values by name/property (lower case), first one wins. */
function metas(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const k = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (k && a.content != null && !(k in out)) out[k] = a.content.trim();
  }
  return out;
}

/** Every JSON-LD object on the page, flattened (arrays, @graph, mainEntity, nested). */
export function jsonLd(html) {
  const nodes = [];
  const walk = (x, depth = 0) => {
    if (!x || typeof x !== 'object' || depth > 6) return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, depth + 1)); return; }
    if (x['@type']) nodes.push(x);
    for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'about', 'publisher', 'provider', 'containedInPlace', 'department', 'subOrganization', 'location', 'author']) walk(x[k], depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].replace(/^\s*(<!--|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)/, '').replace(/(-->|\/\/\s*\]\]>|\]\]>)\s*$/, '').trim();
    try { walk(JSON.parse(raw)); } catch {
      try { walk(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '))); } catch { /* broken block: skip it */ }
    }
  }
  return nodes;
}

const typesOf = (n) => [].concat(n['@type'] || []).map((t) => String(t).replace(/^https?:\/\/schema\.org\//, ''));

// schema.org type -> our category. Checked in order; the first hit wins.
const TYPE_CATEGORY = [
  ['emergency', /^(EmergencyService|PoliceStation|FireStation)$/],
  ['medical', /^(Hospital|MedicalClinic|MedicalBusiness|MedicalOrganization|Physician|Dentist|Pharmacy|Optician|DiagnosticLab|VeterinaryCare|MedicalCenter|UrgentCare)$/],
  ['food', /^(Restaurant|FoodEstablishment|CafeOrCoffeeShop|BarOrPub|Bakery|Brewery|Winery|Distillery|FastFoodRestaurant|IceCreamShop)$/],
  ['lodging', /^(LodgingBusiness|Hotel|Motel|Resort|SkiResortLodging|BedAndBreakfast|Hostel|Campground|VacationRental|LodgingReservation)$/],
  ['schools', /^(School|EducationalOrganization|Library|CollegeOrUniversity|Preschool|ElementarySchool|MiddleSchool|HighSchool)$/],
  ['government', /^(GovernmentOffice|GovernmentOrganization|GovernmentBuilding|CityHall|Courthouse|PostOffice|Embassy|LegislativeBuilding)$/],
  ['transit', /^(BusStation|BusStop|TrainStation|Airport|ParkingFacility|TaxiService|TaxiStand|SubwayStation)$/],
  ['outdoors', /^(Park|SkiResort|SportsActivityLocation|Playground|PublicSwimmingPool|GolfCourse|TouristAttraction|LandmarksOrHistoricalBuildings|Trail|Mountain|NaturalFeature)$/],
  ['shops', /(Store|^ShoppingCenter)$/],
  ['services', /^(LocalBusiness|ProfessionalService|HomeAndConstructionBusiness|AutomotiveBusiness|AutoRepair|HealthAndBeautyBusiness|DaySpa|HairSalon|BeautySalon|FinancialService|BankOrCreditUnion|LegalService|RealEstateAgent|TravelAgency|EntertainmentBusiness|ChildCare|DryCleaningOrLaundry|EmploymentAgency|InternetCafe|SelfStorage|AnimalShelter|Electrician|Plumber|GeneralContractor|HousePainter|Locksmith|MovingCompany|RoofingContractor|HVACBusiness|ExerciseGym|SportsClub)$/],
];
const PLACE_TYPES = /^(Organization|Corporation|NGO|Place|CivicStructure|LocalBusiness|Store|.*Business|.*Service|.*Organization)$/;
export const categoryForTypes = (types) => {
  for (const [cat, re] of TYPE_CATEGORY) if (types.some((t) => re.test(t))) return cat;
  return '';
};
// Words in the name/description when the page has no structured type.
const WORD_CATEGORY = [
  ['food', /\b(restaurants?|cafe|café|coffee|bakery|bar & grill|grill|pizzeria|pizza|brewery|brewing|tavern|saloon|bistro|diner|taqueria|kitchen|eatery|sushi|deli)\b/i],
  ['lodging', /\b(hotel|motel|lodge|inn|resort|hostel|bed (and|&) breakfast|b&b|vacation rentals?|cabins|condos?|suites|campground)\b/i],
  ['medical', /\b(hospital|clinic|medical|health center|urgent care|pharmacy|dentist|dental|physician|chiropractic|veterinary|vet)\b/i],
  ['government', /\b(town of|city of|county|municipal|government|town hall|city hall|post office|courthouse)\b/i],
  ['schools', /\b(school|library|academy|college|university|preschool)\b/i],
  ['transit', /\b(airport|shuttle|transit|bus|parking|taxi|gondola)\b/i],
  ['shops', /\b(shop|store|boutique|gallery|outfitters?|market|books|rentals?|skis|ski (and|&) bike|gear|apparel|jewelry)\b/i],
];
export const categoryForWords = (text) => (WORD_CATEGORY.find(([, re]) => re.test(text)) || [''])[0];

/** 970-728-3848 for a US number; otherwise as written. */
export function formatPhone(raw) {
  const s = clean(raw).replace(/^tel:/i, '');
  const d = s.replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length === 10 && /^[2-9]/.test(ten)) return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  return d.length >= 7 && s.length <= 25 ? s : '';
}

function formatAddress(a) {
  if (!a) return '';
  if (typeof a === 'string') return clean(a);
  if (Array.isArray(a)) return formatAddress(a[0]);
  const v = (x) => clean(typeof x === 'object' ? x?.name : x);
  const street = v(a.streetAddress);
  const town = v(a.addressLocality);
  const stZip = [v(a.addressRegion), v(a.postalCode)].filter(Boolean).join(' ');
  return [street, town, stZip].filter(Boolean).join(', ');
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_CODES = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6, mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6, monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };
const dayIndex = (x) => DAY_CODES[String(x || '').replace(/^https?:\/\/schema\.org\//i, '').toLowerCase()] ?? -1;

/** 17:30 -> 5:30 p.m.; 12:00 -> noon. */
export function niceTime(t) {
  const m = String(t || '').match(/^(\d{1,2}):?(\d{2})?/);
  if (!m) return '';
  let hr = Number(m[1]);
  const min = m[2] && m[2] !== '00' ? `:${m[2]}` : '';
  if (hr === 24 || (hr === 0 && !min)) return 'midnight';
  if (hr === 12 && !min) return 'noon';
  const ap = hr >= 12 ? 'p.m.' : 'a.m.';
  hr = hr % 12 || 12;
  return `${hr}${min} ${ap}`;
}

/** Group days with the same hours: "Mon to Fri 8 a.m. to 5 p.m., Sat 9 a.m. to noon". */
function groupHours(slots) {
  // slots: day index -> "8 a.m. to 5 p.m." (several per day joined with " and ")
  if (!slots.size) return '';
  const all = [...slots.values()];
  if (slots.size === 7 && all.every((x) => x === all[0])) return all[0] === '24 hours' ? 'Open 24 hours' : `Daily ${all[0]}`;
  const parts = [];
  let i = 0;
  while (i < 7) {
    if (!slots.has(i)) { i++; continue; }
    let j = i;
    while (j + 1 < 7 && slots.get(j + 1) === slots.get(i)) j++;
    const days = j === i ? DAY_NAMES[i] : j === i + 1 ? `${DAY_NAMES[i]} and ${DAY_NAMES[j]}` : `${DAY_NAMES[i]} to ${DAY_NAMES[j]}`;
    parts.push(`${days} ${slots.get(i)}`);
    i = j + 1;
  }
  return parts.join(', ');
}

export function formatHours(node) {
  const slots = new Map();
  const add = (day, text) => { if (day >= 0) slots.set(day, slots.has(day) ? `${slots.get(day)} and ${text}` : text); };
  const span = (o, c) => {
    if (!o && !c) return '';
    if (/^0?0:00/.test(o) && /^(23:59|24:00|0?0:00)/.test(c)) return '24 hours';
    return `${niceTime(o)} to ${niceTime(c)}`;
  };
  for (const s of [].concat(node.openingHoursSpecification || [])) {
    if (!s || typeof s !== 'object' || s.validThrough && Date.parse(s.validThrough) < Date.now()) continue;
    const text = span(s.opens, s.closes);
    if (!text) continue;
    for (const d of [].concat(s.dayOfWeek || [])) add(dayIndex(d), text);
  }
  if (!slots.size) {
    // "Mo-Fr 08:00-17:00", "Sa 09:00-12:00", "Mo,We 10:00-14:00"
    for (const line of [].concat(node.openingHours || []).flatMap((x) => String(x).split(/\s*[;|]\s*|(?<=\d)\s*,\s*(?=[A-Za-z])/))) {
      const m = line.trim().match(/^([A-Za-z,\- ]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!m) continue;
      const text = span(m[2], m[3]);
      for (const part of m[1].split(',')) {
        const [a, b] = part.trim().split(/\s*-\s*/).map(dayIndex);
        if (a < 0) continue;
        if (b == null || b < 0) add(a, text);
        else for (let k = a; ; k = (k + 1) % 7) { add(k, text); if (k === b) break; }
      }
    }
  }
  return groupHours(slots);
}

// Title cleanup: "Home | The Butcher & The Baker – Telluride" -> pick the name-like part.
const GENERIC = /^(home( ?page)?|welcome|official (web)?site|main|index|about( us)?|contact( us)?)$/i;
export function nameFromTitle(title, siteName = '') {
  const parts = clean(title).split(/\s+[|–—•·:-]\s+/).map((x) => x.trim()).filter((x) => x && !GENERIC.test(x));
  if (siteName && !GENERIC.test(siteName)) return clean(siteName);
  return parts.sort((a, b) => a.length - b.length).find((x) => x.length >= 3 && x.length <= 60) || parts[0] || '';
}

const firstSentences = (s, max = 200) => {
  const t = clean(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
};

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/;
const ADDRESS_RE = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Z0-9][\w.'-]*(?:\s+[A-Z0-9][\w.'-]*){0,4}\s+(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Way|Hwy|Highway|Pl(?:ace)?|Ct|Court|Pkwy|Parkway|Trail|Loop|Cir(?:cle)?|Plaza|Sq(?:uare)?)\.?(?:\s+(?:#|Suite|Ste\.?|Unit|Apt\.?)\s*[\w-]+)?,?\s+[A-Z][a-zA-Z.' ]{1,30},?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;

/** Visible text, roughly: scripts, styles and tags out. */
const pageText = (html) => clean(html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, ', '));

/**
 * The resource fields one page gives. Returns { resource, found, types } where found
 * maps field -> where it came from ('structured data', 'page tags', 'page text').
 */
export function readPage(html, pageUrl) {
  const meta = metas(html);
  const nodes = jsonLd(html);
  const found = {};
  const r = {};
  const set = (k, v, from) => { const x = typeof v === 'string' ? v.trim() : v; if (x && !r[k]) { r[k] = x; found[k] = from; } };

  // Best structured node: a business or organization, scored by what it has.
  const score = (n) => {
    const t = typesOf(n);
    if (!t.some((x) => PLACE_TYPES.test(x) || categoryForTypes([x]))) return -1;
    return (categoryForTypes(t) && categoryForTypes(t) !== 'services' ? 3 : 1) + (n.telephone ? 2 : 0) + (n.address ? 2 : 0) + (n.openingHoursSpecification || n.openingHours ? 1 : 0) + (n.name ? 1 : 0);
  };
  const best = nodes.map((n) => [score(n), n]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0])[0]?.[1];
  const types = best ? typesOf(best) : [];
  const SD = 'structured data';
  if (best) {
    set('name', clean(first(best.name, best.legalName, best.alternateName)), SD);
    set('phone', formatPhone(first(best.telephone, best.contactPoint?.telephone, [].concat(best.contactPoint || [])[0]?.telephone) || ''), SD);
    const addr = best.address || best.location?.address || [].concat(best.location || [])[0]?.address;
    set('address', formatAddress(addr), SD);
    set('hours', formatHours(best), SD);
    const site = first(best.url, best['@id']);
    if (site && /^https?:\/\//.test(site)) { try { if (new URL(site).hostname.replace(/^www\./, '') === new URL(pageUrl).hostname.replace(/^www\./, '')) set('website', new URL(site).href, SD); } catch { /* bad url */ } }
    const cuisine = [].concat(best.servesCuisine || []).map(clean).filter(Boolean).slice(0, 2).join(', ');
    const kind = !cuisine && categoryForTypes(types) === 'lodging' ? (types.find((x) => /^(Hotel|Motel|Resort|BedAndBreakfast|Hostel|Campground|VacationRental)$/.test(x)) || '').replace('BedAndBreakfast', 'Bed & breakfast').replace('VacationRental', 'Vacation rental') : '';
    const price = /^[$€£]{1,4}$/.test(String(best.priceRange || '').trim()) ? String(best.priceRange).trim() : '';
    set('tags', [cuisine || kind, price].filter(Boolean).join(' · '), SD);
    set('note', firstSentences(best.description || ''), SD);
  }

  // Page tags: OpenGraph, business:contact_data, <title>, description, canonical.
  const TAGS = 'page tags';
  const title = (html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  set('name', nameFromTitle(meta['og:title'] || title, meta['og:site_name'] || meta['application-name'] || ''), TAGS);
  set('phone', formatPhone(meta['business:contact_data:phone_number'] || meta['og:phone_number'] || ''), TAGS);
  const cd = (k) => meta[`business:contact_data:${k}`] || meta[`og:${k.replace('_', '-')}`] || '';
  set('address', [cd('street_address'), cd('locality'), [cd('region'), cd('postal_code')].filter(Boolean).join(' ')].filter(Boolean).join(', '), TAGS);
  set('note', firstSentences(meta['og:description'] || meta.description || ''), TAGS);
  const canon = (html.match(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i) || [])[0];
  const canonHref = canon && attrs(canon).href;
  try { if (canonHref) { const c = new URL(canonHref, pageUrl); if (c.hostname.replace(/^www\./, '') === new URL(pageUrl).hostname.replace(/^www\./, '')) set('website', c.href, TAGS); } } catch { /* bad url */ }

  // Page text: a tel: link, then a phone number or street address written on the page.
  const TEXT = 'page text';
  const tel = (html.match(/href\s*=\s*["']tel:([^"']+)["']/i) || [])[1];
  set('phone', formatPhone(decodeURIComponent(tel || '')), TEXT);
  const text = pageText(html);
  if (!r.phone) { const m = text.match(PHONE_RE); if (m) set('phone', `${m[1]}-${m[2]}-${m[3]}`, TEXT); }
  if (!r.address) { const m = text.match(ADDRESS_RE); if (m) set('address', m[0].replace(/\s+,/g, ',').replace(/,?\s+([A-Z]{2})\s+(\d{5})/, ', $1 $2'), TEXT); }
  if (!r.hours) {
    // A short "Hours: ..." line on the page, taken as written.
    const m = text.match(/\b(?:hours|open)\s*:?\s*((?:(?:mon|tue|wed|thu|fri|sat|sun|daily|every ?day)[a-z.]*[\s\-–,&to]*)+[^.!?]{3,60}?\d\s*(?:am|pm|a\.m\.|p\.m\.))/i);
    if (m && m[1].length <= 90) set('hours', m[1].replace(/\s+/g, ' ').trim(), TEXT);
  }

  // Category: structured type first, then words in the name and description.
  const cat = categoryForTypes(types) || categoryForWords(`${r.name || ''} ${meta['og:type'] === 'restaurant.restaurant' ? 'restaurant' : ''} ${title} ${meta.description || ''}`);
  if (cat) { r.category = cat; found.category = types.length && categoryForTypes(types) ? SD : 'a guess from the words on the page'; }
  if (r.category === 'emergency' && /^(EmergencyService)$/.test(types[0] || '')) r.emergency = true;
  return { resource: r, found, types };
}

/** A same-site contact/about/visit page linked from this one, if any. */
export function contactLink(html, pageUrl) {
  const here = new URL(pageUrl);
  let best = null;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrs(m[1]).href;
    if (!href || /^(mailto|tel|javascript):/i.test(href)) continue;
    let u;
    try { u = new URL(href, here); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== here.hostname.replace(/^www\./, '') || u.pathname === here.pathname) continue;
    const words = `${u.pathname} ${clean(m[2])}`.toLowerCase();
    const rank = /contact/.test(words) ? 3 : /(location|visit|find[- ]us|directions|hours)/.test(words) ? 2 : /about/.test(words) ? 1 : 0;
    if (rank && (!best || rank > best.rank)) best = { rank, href: u.href.replace(/#.*$/, '') };
  }
  return best?.href || null;
}

const FIELDS = ['name', 'category', 'phone', 'website', 'address', 'hours', 'tags', 'note'];

/**
 * Look a web address up: { resource, found, missing, url, pages }. Throws an Error with
 * .status (403, 429, 404, 504...) and .blocked when the site turns our server away.
 */
export async function resourceFromUrl(raw, { fetchImpl, lookup, timeoutMs } = {}) {
  const opts = { fetchImpl, lookup, timeoutMs };
  let page;
  try { page = await fetchPage(raw, opts); } catch (e) { throw explain(e); }
  const { resource, found } = readPage(page.html, page.url);
  const pages = [page.url];
  const need = () => ['phone', 'address', 'hours'].filter((k) => !resource[k]);
  if (need().length) {
    const more = contactLink(page.html, page.url);
    if (more) {
      try {
        const p2 = await fetchPage(more, opts);
        const r2 = readPage(p2.html, p2.url);
        let added = 0;
        for (const k of ['phone', 'address', 'hours', 'category', 'tags']) {
          if (!resource[k] && r2.resource[k]) { resource[k] = r2.resource[k]; found[k] = `${r2.found[k]} on ${new URL(p2.url).pathname}`; added++; }
        }
        if (added) pages.push(p2.url);
      } catch { /* the home page is what counts */ }
    }
  }
  if (!resource.website) { resource.website = homeOrPage(raw, page.url); found.website = 'the address you gave'; }
  for (const k of Object.keys(resource)) if (typeof resource[k] === 'string') resource[k] = resource[k].slice(0, k === 'note' ? 400 : k === 'tags' ? 80 : 200);
  return { resource, found, missing: FIELDS.filter((k) => !resource[k]), url: page.url, pages };
}

// The address as typed (after redirects), minus tracking parameters.
function homeOrPage(raw, finalUrl) {
  const u = new URL(finalUrl);
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) u.searchParams.delete(k);
  return u.href;
}

function explain(e) {
  const s = e.status;
  if (s === 403 || s === 429 || s === 401 || s === 503 || s === 406) {
    return Object.assign(new Error(`The site turned our server away (HTTP ${s}). Many sites block automated visits. Use Fill with AI instead.`), { status: s, blocked: true });
  }
  if (s === 404 || s === 410) return Object.assign(new Error(s === 404 && !/HTTP/.test(e.message) ? e.message : `That page doesn't exist (HTTP ${s}). Check the address.`), { status: s });
  return Object.assign(new Error(e.message), { status: s || 502, blocked: s === 504 });
}
