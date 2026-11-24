// Sun & Moon tile: sunrise, sunset, twilight, golden hour, moonrise, moonset, moon
// phase and what's coming up in the sky (solstices, full moons, meteor showers,
// eclipses you can see from town, planets at their best).
//
// Everything is calculated here from the town's map point with Astronomy Engine
// (MIT, vendored in src/vendor/astronomy.js), so it needs no API key, no network and
// works for every town. Times are for a flat horizon: in a valley the sun clears the
// ridge later than "sunrise".

import * as A from './vendor/astronomy.js';

const DAY = 86400e3;
const KM_PER_AU = A.KM_PER_AU;

// ---------- local dates in the town's time zone ----------
const fmtCache = new Map();
function parts(tz, t) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
/** Minutes the zone is ahead of UTC at instant t (Denver in winter: -420). */
function offsetMin(tz, t) {
  const p = parts(tz, t);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000) / 60e3);
}
/** 'YYYY-MM-DD' for instant t in tz. */
export function localDate(tz, t) {
  const p = parts(tz, t);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
/** The instant of local midnight that starts the day 'YYYY-MM-DD' in tz. */
export function localMidnight(tz, ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMin(tz, guess) * 60e3;
  t = guess - offsetMin(tz, t) * 60e3; // second pass settles days when the clocks change
  return t;
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// ---------- small wrappers ----------
const ms = (at) => (at ? at.date.getTime() : null);
const riseSet = (body, obs, dir, from) => ms(A.SearchRiseSet(body, obs, dir, new Date(from), 1));
const altCross = (body, obs, dir, from, alt) => ms(A.SearchAltitude(body, obs, dir, new Date(from), 1, alt));
/** Only keep a time that falls on this local day (polar days and the moon can skip). */
const within = (t, start, end) => (t != null && t >= start && t < end ? t : null);

function altitude(body, obs, t) {
  const eq = A.Equator(body, new Date(t), obs, true, true);
  return A.Horizon(new Date(t), obs, eq.ra, eq.dec, 'normal').altitude;
}

/** Sunrise, sunset, twilight and golden hour for one local day. */
function sunDay(obs, tz, ymd) {
  const start = localMidnight(tz, ymd);
  const end = localMidnight(tz, addDays(ymd, 1));
  const sunrise = within(riseSet(A.Body.Sun, obs, +1, start), start, end);
  const sunset = within(riseSet(A.Body.Sun, obs, -1, start), start, end);
  // Solar noon: the sun's highest point (it crosses the meridian).
  let noon = null;
  try { noon = ms(A.SearchHourAngle(A.Body.Sun, obs, 0, new Date(start), +1).time); } catch { /* ignore */ }
  noon = within(noon, start, end);
  return {
    date: ymd,
    dawn: within(altCross(A.Body.Sun, obs, +1, start, -6), start, end), // civil twilight: first light
    sunrise,
    goldenEnd: within(altCross(A.Body.Sun, obs, +1, start, 6), start, end), // morning golden hour ends
    noon,
    goldenStart: within(altCross(A.Body.Sun, obs, -1, start, 6), start, end), // evening golden hour starts
    sunset,
    dusk: within(altCross(A.Body.Sun, obs, -1, start, -6), start, end), // last light
    dayLength: sunrise != null && sunset != null && sunset > sunrise ? Math.round((sunset - sunrise) / 1000) : null,
    noonAlt: noon != null ? Math.round(altitude(A.Body.Sun, obs, noon)) : null,
  };
}

const PHASE_NAMES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
/** Phase angle (0 new, 90 first quarter, 180 full, 270 last quarter) -> name. */
export function phaseName(deg) {
  const d = ((deg % 360) + 360) % 360;
  // The four main phases get a band about a day wide: the moon moves about 12.2° a day.
  const near = (x) => Math.abs(((d - x + 540) % 360) - 180) < 6.1;
  if (near(0)) return PHASE_NAMES[0];
  if (near(90)) return PHASE_NAMES[2];
  if (near(180)) return PHASE_NAMES[4];
  if (near(270)) return PHASE_NAMES[6];
  return PHASE_NAMES[d < 90 ? 1 : d < 180 ? 3 : d < 270 ? 5 : 7];
}

const QUARTER = ['new', 'first', 'full', 'last'];
// Traditional (Old Farmer's Almanac) names, by the month the full moon falls in.
const FULL_MOON_NAMES = ['Wolf Moon', 'Snow Moon', 'Worm Moon', 'Pink Moon', 'Flower Moon', 'Strawberry Moon', 'Buck Moon', 'Sturgeon Moon', 'Harvest Moon', "Hunter's Moon", 'Beaver Moon', 'Cold Moon'];
// Closer than this at full moon is what most people call a supermoon.
const SUPERMOON_KM = 360000;

/** The year's big annual meteor showers: peak night (evening date), typical rate per hour under dark skies. */
const SHOWERS = [
  { name: 'Quadrantids', m: 1, d: 3, rate: 80, from: 'Boötes, high in the northeast before dawn' },
  { name: 'Lyrids', m: 4, d: 22, rate: 18, from: 'Lyra, best after midnight' },
  { name: 'Eta Aquariids', m: 5, d: 5, rate: 30, from: 'Aquarius, low in the east before dawn' },
  { name: 'Perseids', m: 8, d: 12, rate: 100, from: 'Perseus, best after midnight' },
  { name: 'Orionids', m: 10, d: 21, rate: 20, from: 'Orion, best after midnight' },
  { name: 'Leonids', m: 11, d: 17, rate: 15, from: 'Leo, best after midnight' },
  { name: 'Geminids', m: 12, d: 13, rate: 120, from: 'Gemini, all night, best around 2 AM' },
  { name: 'Ursids', m: 12, d: 21, rate: 10, from: 'Ursa Minor, best before dawn' },
];

function moonNote(illum) {
  if (illum < 0.25) return 'dark skies';
  if (illum < 0.6) return 'some moonlight';
  return 'a bright moon will wash out fainter meteors';
}

/** Lunar eclipses (partial or total) that can be seen from the observer, from t for `years`. */
function lunarEclipses(obs, t, years) {
  const out = [];
  let e = A.SearchLunarEclipse(new Date(t));
  const stop = t + years * 365.25 * DAY;
  for (let i = 0; i < 12 && e.peak.date.getTime() < stop; i++, e = A.NextLunarEclipse(e.peak)) {
    if (e.kind === 'penumbral') continue; // too faint for most people to notice
    const peak = e.peak.date.getTime();
    const half = e.sd_partial * 60e3;
    const begin = peak - half, end = peak + half;
    // Visible if the moon is up at the start, peak or end of the partial phase.
    const ups = [begin, peak, end].map((x) => altitude(A.Body.Moon, obs, x) > 0);
    if (!ups.some(Boolean)) continue;
    out.push({
      at: peak, begin, end, kind: e.kind,
      totalBegin: e.sd_total ? peak - e.sd_total * 60e3 : null,
      totalEnd: e.sd_total ? peak + e.sd_total * 60e3 : null,
      whole: ups.every(Boolean),
      moonUpAtPeak: ups[1],
    });
  }
  return out;
}

/** The next solar eclipses seen from the observer (sun above the horizon at peak). */
function solarEclipses(obs, t, count) {
  const out = [];
  let e = A.SearchLocalSolarEclipse(new Date(t), obs);
  for (let i = 0; i < 6 && out.length < count; i++, e = A.NextLocalSolarEclipse(e.peak.time, obs)) {
    if (e.peak.altitude <= 0 || e.obscuration < 0.1) continue; // below the horizon, or just a nibble
    out.push({
      at: e.peak.time.date.getTime(),
      begin: e.partial_begin.time.date.getTime(),
      end: e.partial_end.time.date.getTime(),
      kind: e.kind, // partial, annular or total (as seen from here)
      covered: Math.round(e.obscuration * 100),
      altitude: Math.round(e.peak.altitude),
    });
  }
  return out;
}

const PLANETS = [
  { body: A.Body.Mars, name: 'Mars' },
  { body: A.Body.Jupiter, name: 'Jupiter' },
  { body: A.Body.Saturn, name: 'Saturn' },
];

/** Everything coming up in the sky from t for `days`, oldest first. */
function upcoming(obs, tz, t, days) {
  const end = t + days * DAY;
  const ev = [];
  const push = (e) => { if (e.at >= t && e.at < end) ev.push(e); };

  // Equinoxes and solstices.
  const y0 = Number(localDate(tz, t).slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const s = A.Seasons(y);
    push({ at: ms(s.mar_equinox), kind: 'season', title: 'Spring equinox', detail: 'Day and night about equal; spring begins.' });
    push({ at: ms(s.jun_solstice), kind: 'season', title: 'Summer solstice', detail: 'Longest day of the year.' });
    push({ at: ms(s.sep_equinox), kind: 'season', title: 'Fall equinox', detail: 'Day and night about equal; fall begins.' });
    push({ at: ms(s.dec_solstice), kind: 'season', title: 'Winter solstice', detail: 'Shortest day of the year; days get longer from here.' });
  }

  // Full and new moons, with names, supermoons and blue moons.
  const fullByMonth = new Map();
  let q = A.SearchMoonQuarter(new Date(t));
  for (let i = 0; i < 60 && ms(q.time) < end; i++, q = A.NextMoonQuarter(q)) {
    const at = ms(q.time);
    if (q.quarter === 2) {
      const ym = localDate(tz, at).slice(0, 7);
      const n = (fullByMonth.get(ym) || 0) + 1;
      fullByMonth.set(ym, n);
      const km = Math.round(A.GeoMoon(q.time).Length() * KM_PER_AU);
      const month = Number(ym.slice(5)) - 1;
      const name = n === 2 ? 'Blue Moon' : FULL_MOON_NAMES[month];
      const extra = [km < SUPERMOON_KM ? 'Supermoon: the moon is near its closest, so it looks a little bigger and brighter.' : '', n === 2 ? 'The second full moon this month.' : ''].filter(Boolean).join(' ');
      push({ at, kind: 'full', title: `Full moon: ${name}${km < SUPERMOON_KM ? ' (supermoon)' : ''}`, detail: extra || null, km });
    }
  }

  // Meteor showers: peak night, and how much moon there will be at 2 AM that night.
  for (const y of [y0, y0 + 1]) {
    for (const s of SHOWERS) {
      const evening = `${y}-${String(s.m).padStart(2, '0')}-${String(s.d).padStart(2, '0')}`;
      const at = localMidnight(tz, addDays(evening, 1)) + 2 * 3600e3; // 2 AM after the peak evening
      const illum = A.Illumination(A.Body.Moon, new Date(at)).phase_fraction;
      push({
        at, kind: 'meteor', allNight: true, night: evening,
        title: `${s.name} meteor shower peaks`,
        detail: `Up to about ${s.rate} an hour from dark skies, radiating from ${s.from}. Moon ${Math.round(illum * 100)}% lit: ${moonNote(illum)}.`,
      });
    }
  }

  // Planets at their best: Mars, Jupiter and Saturn at opposition (biggest and brightest,
  // up all night), and Venus at its greatest distance from the sun.
  for (const p of PLANETS) {
    try {
      const at = ms(A.SearchRelativeLongitude(p.body, 0, new Date(t)));
      push({ at, kind: 'planet', title: `${p.name} at its brightest`, detail: `${p.name} is opposite the sun: up all night, rising at sunset.` });
    } catch { /* none in range */ }
  }
  for (let i = 0, from = t; i < 3; i++) {
    const e = A.SearchMaxElongation(A.Body.Venus, new Date(from));
    const at = ms(e.time);
    if (at >= end) break;
    push({ at, kind: 'planet', title: `Venus at its best in the ${e.visibility} sky`, detail: `Venus is ${Math.round(e.elongation)}° from the sun, the brightest "star" ${e.visibility === 'evening' ? 'in the west after sunset' : 'in the east before sunrise'}.` });
    from = at + 30 * DAY;
  }

  // Eclipses you can see from town in this window.
  for (const e of lunarEclipses(obs, t, days / 365.25 + 0.01)) {
    push({ at: e.at, kind: 'eclipse', title: `${e.kind === 'total' ? 'Total' : 'Partial'} lunar eclipse`, detail: lunarDetail(e) });
  }
  for (const e of solarEclipses(obs, t, 2)) {
    push({ at: e.at, kind: 'eclipse', title: `${cap(e.kind)} solar eclipse`, detail: solarDetail(e) });
  }

  return ev.sort((a, b) => a.at - b.at);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function lunarDetail(e) {
  const how = e.whole ? 'Visible from here from start to finish.' : e.moonUpAtPeak ? 'Partly visible from here (the moon rises or sets during it).' : 'Only the start or end is visible from here.';
  return `${how} The moon ${e.kind === 'total' ? 'turns a coppery red' : 'is partly in Earth\'s shadow'}. No eye protection needed.`;
}
function solarDetail(e) {
  return `About ${e.covered}% of the sun covered from here, ${e.altitude}° above the horizon at its peak. Never look at the sun without eclipse glasses.`;
}

/** Sun and moon altitude every 30 minutes across the local day (49 points), for the chart. */
function paths(obs, start) {
  const sun = [], moon = [];
  for (let i = 0; i <= 48; i++) {
    const t = start + i * 1800e3;
    sun.push(Math.round(altitude(A.Body.Sun, obs, t) * 10) / 10);
    moon.push(Math.round(altitude(A.Body.Moon, obs, t) * 10) / 10);
  }
  return { sun, moon };
}

/** Moon now: phase angle, % lit, name, rise and set today, distance. */
function moonNow(obs, tz, ymd, t) {
  const start = localMidnight(tz, ymd);
  const end = localMidnight(tz, addDays(ymd, 1));
  const phase = A.MoonPhase(new Date(t));
  const illum = A.Illumination(A.Body.Moon, new Date(t)).phase_fraction;
  const next = {};
  let q = A.SearchMoonQuarter(new Date(t));
  const phases = [];
  for (let i = 0; i < 4; i++, q = A.NextMoonQuarter(q)) {
    phases.push({ kind: QUARTER[q.quarter], at: ms(q.time) });
    if (!next[QUARTER[q.quarter]]) next[QUARTER[q.quarter]] = ms(q.time);
  }
  return {
    phase: Math.round(phase * 10) / 10,
    illum: Math.round(illum * 1000) / 1000,
    name: phaseName(phase),
    waxing: phase < 180,
    rise: within(riseSet(A.Body.Moon, obs, +1, start), start, end),
    set: within(riseSet(A.Body.Moon, obs, -1, start), start, end),
    km: Math.round(A.GeoMoon(new Date(t)).Length() * KM_PER_AU),
    nextFull: next.full, nextNew: next.new,
    phases,
  };
}

const cache = new Map(); // town id -> { key, slow } (events and eclipses change daily)

/**
 * Everything the Sun & Moon tile and panel need for a town at instant `now`.
 * `town` needs `location: { lat, lon }` and `timezone`.
 */
export function skyFor(town, now = Date.now()) {
  const lat = Number(town?.location?.lat), lon = Number(town?.location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, error: 'This town has no map point yet.' };
  const tz = town.timezone || 'America/Denver';
  try {
    const obs = new A.Observer(lat, lon, Number(town.elevationM) || 0);
    const ymd = localDate(tz, now);
    const start = localMidnight(tz, ymd);
    // The slow parts (today's times, chart and the year's events) change once a day.
    const key = `${ymd}|${lat}|${lon}|${tz}`;
    let slow = cache.get(town.id || key);
    if (!slow || slow.key !== key) {
      const today = sunDay(obs, tz, ymd);
      const yesterday = sunDay(obs, tz, addDays(ymd, -1));
      const tomorrow = sunDay(obs, tz, addDays(ymd, 1));
      slow = {
        key,
        today: { ...today, dayChange: today.dayLength != null && yesterday.dayLength != null ? today.dayLength - yesterday.dayLength : null },
        tomorrow: { sunrise: tomorrow.sunrise, sunset: tomorrow.sunset },
        chart: { start, step: 1800e3, ...paths(obs, start) },
        events: upcoming(obs, tz, start, 400),
        eclipses: {
          lunar: lunarEclipses(obs, start, 6).slice(0, 2),
          solar: solarEclipses(obs, start, 2),
        },
      };
      cache.set(town.id || key, slow);
    }
    return {
      ok: true, tz, lat, lon,
      computedAt: now,
      today: slow.today,
      tomorrow: slow.tomorrow,
      chart: slow.chart,
      moon: moonNow(obs, tz, ymd, now),
      sunUp: altitude(A.Body.Sun, obs, now) > -0.833,
      events: slow.events.filter((e) => e.at >= now - (e.allNight ? 12 * 3600e3 : 0)).slice(0, 16),
      eclipses: slow.eclipses,
    };
  } catch (e) {
    return { ok: false, error: 'Sun and moon times are not available right now.' };
  }
}
