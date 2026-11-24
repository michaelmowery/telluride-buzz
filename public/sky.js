// Sun & Moon tile and panel graphics: moon phase icons, the day chart (sun and moon
// height across today), rise/set rows and the "coming up in the sky" list.
// The numbers come from the server (src/sky.js); this file only draws them.
// CSP: no inline style attributes, so positions use data-x / data-y set in app.js.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- time and date labels in the town's zone ----------
export function timeIn(tz, t) {
  if (t == null) return '–';
  return new Date(t).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
}
const dayKey = (tz, t) => new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
export function dateIn(tz, t, now = Date.now()) {
  if (dayKey(tz, t) === dayKey(tz, now)) return 'Today';
  if (dayKey(tz, t) === dayKey(tz, now + 86400e3)) return 'Tomorrow';
  const sameYear = dayKey(tz, t).slice(0, 4) === dayKey(tz, now).slice(0, 4);
  return new Date(t).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
/** 35568 -> "9h 52m". */
export function duration(sec) {
  if (sec == null) return '';
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
/** -88 -> "1m 28s shorter than yesterday". */
export function dayChange(sec) {
  if (sec == null) return '';
  if (Math.abs(sec) < 1) return 'about the same as yesterday';
  const a = Math.abs(Math.round(sec));
  const txt = a >= 60 ? `${Math.floor(a / 60)}m ${a % 60}s` : `${a}s`;
  return `${txt} ${sec < 0 ? 'shorter' : 'longer'} than yesterday`;
}

// ---------- icons ----------
/**
 * The moon as it looks tonight. phase: 0 new, 90 first quarter, 180 full, 270 last quarter.
 * Lit on the right while waxing (as seen from the northern hemisphere).
 */
export function moonIcon(phase, size = 32, label = '') {
  const r = 15, c = 16;
  const p = ((phase % 360) + 360) % 360;
  const k = Math.cos((p * Math.PI) / 180); // 1 new … -1 full
  const rx = Math.abs(k * r).toFixed(2);
  const waxing = p < 180;
  // Outer limb on the lit side, then the terminator back to the top.
  const limb = waxing ? 1 : 0;
  const crescent = k > 0;
  const term = waxing === crescent ? 0 : 1; // waxing crescent / waning gibbous bulge right
  const lit = p < 1.5 || p > 358.5 ? '' : p > 178.5 && p < 181.5
    ? `<circle class="sky-moon-lit" cx="${c}" cy="${c}" r="${r}"/>`
    : `<path class="sky-moon-lit" d="M${c} ${c - r}A${r} ${r} 0 0 ${limb} ${c} ${c + r}A${rx} ${r} 0 0 ${term} ${c} ${c - r}z"/>`;
  return `<svg class="sky-moon-icon" width="${size}" height="${size}" viewBox="0 0 32 32" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}><circle class="sky-moon-dark" cx="${c}" cy="${c}" r="${r}"/>${lit}<circle class="sky-moon-edge" cx="${c}" cy="${c}" r="${r}"/></svg>`;
}

/** Half sun on the horizon with an arrow: up for sunrise, down for sunset. */
export function horizonIcon(up, size = 22) {
  const rays = [[-9, 0], [-6.4, -6.4], [0, -9], [6.4, -6.4], [9, 0]].map(([x, y]) => `M${16 + x * 1.0} ${20 + y * 1.0}L${16 + x * 1.35} ${20 + y * 1.35}`).join('');
  const arrow = up ? 'M16 3v5M13.5 5.5 16 3l2.5 2.5' : 'M16 3v5M13.5 5.5 16 8l2.5-2.5';
  return `<svg class="sky-hz" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <path class="wx-ray" d="${rays}"/><path class="wx-sun" d="M10 20a6 6 0 0 1 12 0z"/>
    <path class="sky-hz-line" d="M4 20.5h24"/><path class="sky-hz-arrow" d="${arrow}"/></svg>`;
}

const ICONS = {
  season: '<circle class="wx-sun" cx="16" cy="16" r="6"/><path class="wx-ray" d="M16 4v3M16 25v3M4 16h3M25 16h3M7.5 7.5l2.1 2.1M22.4 22.4l2.1 2.1M7.5 24.5l2.1-2.1M22.4 9.6l2.1-2.1"/>',
  meteor: '<path class="sky-streak" d="M5 5l14 14M10 4l9 9M4 10l9 9"/><circle class="sky-star" cx="22" cy="22" r="4.2"/>',
  planet: '<circle class="sky-planet" cx="16" cy="16" r="7"/><ellipse class="sky-ring" cx="16" cy="16" rx="13" ry="4.2" transform="rotate(-20 16 16)"/>',
  eclipse: '<circle class="wx-sun" cx="16" cy="16" r="10"/><circle class="sky-eclipse-disc" cx="19.5" cy="14" r="9.4"/>',
  lunar: '<circle class="sky-moon-red" cx="16" cy="16" r="11"/><circle class="sky-moon-edge" cx="16" cy="16" r="11"/>',
};
function eventIcon(e) {
  if (e.kind === 'full') return moonIcon(180, 28);
  const key = e.kind === 'eclipse' && /lunar/i.test(e.title) ? 'lunar' : e.kind;
  return `<svg class="sky-ev-icon" width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">${ICONS[key] || ICONS.season}</svg>`;
}

// ---------- tile ----------
/** The next moonrise or moonset after now today, as "Rises 4:46 PM" (or ''). */
function nextMoonEvent(s, now) {
  const m = s.moon || {};
  const ev = [[m.rise, 'Rises'], [m.set, 'Sets']].filter(([t]) => t != null && t > now).sort((a, b) => a[0] - b[0])[0];
  return ev ? `${ev[1]} ${timeIn(s.tz, ev[0])}` : '';
}
const pct = (x) => `${Math.round((x || 0) * 100)}%`;

export function skyTile(s, now = Date.now()) {
  const d = s.today || {};
  const m = s.moon || {};
  const moonLine = [`${pct(m.illum)} lit`, nextMoonEvent(s, now)].filter(Boolean).join(' · ');
  return `<div class="sky-tile">
    <div class="sky-sun">
      <div class="sky-rs">${horizonIcon(true)}<b>${esc(timeIn(s.tz, d.sunrise))}</b></div>
      <div class="sky-rs">${horizonIcon(false)}<b>${esc(timeIn(s.tz, d.sunset))}</b></div>
      <div class="muted">${d.dayLength != null ? `${esc(duration(d.dayLength))} of daylight` : ''}</div>
    </div>
    <div class="sky-moon">${moonIcon(m.phase, 34, m.name)}<div><b>${esc(m.name || '')}</b><div class="muted">${esc(moonLine)}</div></div></div>
  </div>`;
}

// ---------- panel: day chart ----------
/**
 * Sun (and moon) height across today, midnight to midnight, over night / twilight / day
 * bands. The SVG stretches to the card; labels and the "now" dot are HTML on top.
 */
export function dayChart(s, now = Date.now()) {
  const c = s.chart;
  if (!c?.sun?.length) return '';
  const span = c.step * (c.sun.length - 1);
  const maxAlt = Math.max(...c.sun, ...c.moon);
  const hi = Math.min(90, Math.max(40, Math.ceil((maxAlt + 8) / 10) * 10));
  const lo = -18;
  const W = 1000, H = 300;
  const x = (t) => ((t - c.start) / span) * W;
  const y = (alt) => ((hi - Math.max(lo - 5, alt)) / (hi - lo)) * H;
  const pctX = (t) => Math.max(0, Math.min(100, ((t - c.start) / span) * 100)).toFixed(2);
  const pctY = (alt) => ((y(alt) / H) * 100).toFixed(2);
  const line = (arr) => arr.map((a, i) => `${i ? 'L' : 'M'}${((i / (arr.length - 1)) * W).toFixed(1)} ${y(a).toFixed(1)}`).join('');
  const d = s.today || {};
  // Background bands: night, twilight, day.
  const band = (from, to, cls) => (from != null && to != null && to > from ? `<rect class="${cls}" x="${x(from).toFixed(1)}" y="0" width="${(x(to) - x(from)).toFixed(1)}" height="${H}"/>` : '');
  const end = c.start + span;
  const dawn = d.dawn ?? d.sunrise, dusk = d.dusk ?? d.sunset;
  const bands = d.sunrise != null && d.sunset != null
    ? `<rect class="sky-b-night" x="0" y="0" width="${W}" height="${H}"/>${band(dawn, d.sunrise, 'sky-b-twi')}${band(d.sunrise, d.sunset, 'sky-b-day')}${band(d.sunset, dusk, 'sky-b-twi')}`
    : `<rect class="${c.sun[24] > 0 ? 'sky-b-day' : 'sky-b-night'}" x="0" y="0" width="${W}" height="${H}"/>`;
  const horizon = y(0).toFixed(1);
  const sunFill = `${line(c.sun)}L${W} ${H}L0 ${H}z`;
  const today = now >= c.start && now <= end;
  const i = (now - c.start) / c.step;
  const sunNow = today ? c.sun[Math.floor(i)] + (c.sun[Math.min(c.sun.length - 1, Math.floor(i) + 1)] - c.sun[Math.floor(i)]) * (i % 1) : null;
  const ticks = [6, 12, 18].map((h) => `<span class="sky-tick" data-x="${pctX(c.start + h * 3600e3)}">${h === 12 ? 'Noon' : `${h > 12 ? h - 12 : h} ${h < 12 ? 'AM' : 'PM'}`}</span>`).join('');
  const label = (t, txt, cls) => (t != null ? `<span class="sky-lbl ${cls}" data-x="${pctX(t)}" data-y="${pctY(0)}">${esc(txt)}</span>` : '');
  return `<div class="sky-chart" role="img" aria-label="Sun height through today: rises ${esc(timeIn(s.tz, d.sunrise))}, highest at ${esc(timeIn(s.tz, d.noon))}, sets ${esc(timeIn(s.tz, d.sunset))}.">
    <svg class="sky-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      ${bands}
      <defs><clipPath id="sky-above"><rect x="0" y="0" width="${W}" height="${horizon}"/></clipPath></defs>
      <rect class="sky-below" x="0" y="${horizon}" width="${W}" height="${(H - horizon).toFixed(1)}"/>
      <path class="sky-sun-fill" d="${sunFill}" clip-path="url(#sky-above)"/>
      <path class="sky-horizon" d="M0 ${horizon}H${W}" vector-effect="non-scaling-stroke"/>
      <path class="sky-moon-line" d="${line(c.moon)}" vector-effect="non-scaling-stroke"/>
      <path class="sky-sun-line below" d="${line(c.sun)}" vector-effect="non-scaling-stroke"/>
      <path class="sky-sun-line" d="${line(c.sun)}" clip-path="url(#sky-above)" vector-effect="non-scaling-stroke"/>
      ${today ? `<path class="sky-now-line" d="M${x(now).toFixed(1)} 0V${H}" vector-effect="non-scaling-stroke"/>` : ''}
    </svg>
    ${label(d.sunrise, timeIn(s.tz, d.sunrise), 'rise')}${label(d.sunset, timeIn(s.tz, d.sunset), 'set')}
    ${today ? `<span class="sky-now-dot ${sunNow > 0 ? 'up' : 'down'}" data-x="${pctX(now)}" data-y="${pctY(sunNow)}" title="Now"></span>` : ''}
    <div class="sky-ticks">${ticks}</div>
  </div>
  <div class="sky-legend"><i class="sky-key sun"></i>Sun <i class="sky-key moon"></i>Moon <i class="sky-key twi"></i>Twilight</div>`;
}

// ---------- panel ----------
const timeRow = (tz, icon, label, t, note = '') => `<div class="sky-row">${icon}<span>${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</span><b>${esc(timeIn(tz, t))}</b></div>`;
const dot = (cls) => `<i class="sky-dot ${cls}" aria-hidden="true"></i>`;

function eventWhen(tz, e, now) {
  if (e.allNight) return `Night of ${new Date(`${e.night}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })}`;
  if (e.kind === 'planet') return dateIn(tz, e.at, now);
  return `${dateIn(tz, e.at, now)} · ${timeIn(tz, e.at)}`;
}

export function skyPanel(s, townName = '', now = Date.now()) {
  const tz = s.tz;
  const d = s.today || {};
  const m = s.moon || {};
  const QN = { new: ['New moon', 0], first: ['First quarter', 90], full: ['Full moon', 180], last: ['Last quarter', 270] };
  const phases = (m.phases || []).map((p) => `<div class="sky-phase">${moonIcon(QN[p.kind][1], 36)}<b>${esc(QN[p.kind][0])}</b><span>${esc(dateIn(tz, p.at, now))}</span><span class="muted">${esc(timeIn(tz, p.at))}</span></div>`).join('');
  const events = (s.events || []).map((e) => `<div class="sky-ev sky-ev-${esc(e.kind)}">${eventIcon(e)}<div><time>${esc(eventWhen(tz, e, now))}</time><b>${esc(e.title)}</b>${e.detail ? `<p>${esc(e.detail)}</p>` : ''}</div></div>`).join('');
  const lunar = (s.eclipses?.lunar || []).slice(0, 1).map((e) => `<div class="sky-ev">${eventIcon({ kind: 'eclipse', title: 'lunar' })}<div><time>${esc(dateIn(tz, e.at, now))} · ${esc(timeIn(tz, e.begin))} to ${esc(timeIn(tz, e.end))}</time><b>${e.kind === 'total' ? 'Total' : 'Partial'} lunar eclipse</b><p>${e.totalBegin ? `Totality ${esc(timeIn(tz, e.totalBegin))} to ${esc(timeIn(tz, e.totalEnd))}. ` : ''}${e.whole ? 'Visible from start to finish.' : 'Partly visible: the moon rises or sets during it.'}</p></div></div>`).join('');
  const solar = (s.eclipses?.solar || []).slice(0, 1).map((e) => `<div class="sky-ev">${eventIcon({ kind: 'eclipse', title: 'solar' })}<div><time>${esc(dateIn(tz, e.at, now))} · ${esc(timeIn(tz, e.begin))} to ${esc(timeIn(tz, e.end))}</time><b>${esc(e.kind.charAt(0).toUpperCase() + e.kind.slice(1))} solar eclipse</b><p>About ${e.covered}% of the sun covered at ${esc(timeIn(tz, e.at))}. Use eclipse glasses.</p></div></div>`).join('');
  const where = `${Math.abs(s.lat).toFixed(3)}°${s.lat >= 0 ? 'N' : 'S'}, ${Math.abs(s.lon).toFixed(3)}°${s.lon >= 0 ? 'E' : 'W'}`;
  return `<h3>Today</h3>
    <div class="p-card sky-day-card">${dayChart(s, now)}
      <div class="sky-rows">
        ${timeRow(tz, dot('twi'), 'First light', d.dawn, 'Civil twilight')}
        ${timeRow(tz, horizonIcon(true, 24), 'Sunrise', d.sunrise)}
        ${timeRow(tz, dot('gold'), 'Golden hour ends', d.goldenEnd)}
        ${timeRow(tz, dot('noon'), 'Solar noon', d.noon, d.noonAlt != null ? `Sun ${d.noonAlt}° high` : '')}
        ${timeRow(tz, dot('gold'), 'Golden hour starts', d.goldenStart)}
        ${timeRow(tz, horizonIcon(false, 24), 'Sunset', d.sunset)}
        ${timeRow(tz, dot('twi'), 'Last light', d.dusk, 'Civil twilight')}
      </div>
      <p class="sky-daylen"><b>${esc(duration(d.dayLength))}</b> of daylight, ${esc(dayChange(d.dayChange))}.</p>
    </div>
    <h3>Moon</h3>
    <div class="p-card sky-moon-card">${moonIcon(m.phase, 76, m.name)}
      <div class="sky-moon-text"><b class="sky-moon-name">${esc(m.name || '')}</b>
        <div class="muted">${pct(m.illum)} lit · ${m.waxing ? 'growing' : 'shrinking'}</div>
        <div class="sky-moon-rs"><span>Moonrise <b>${esc(timeIn(tz, m.rise))}</b></span><span>Moonset <b>${esc(timeIn(tz, m.set))}</b></span></div>
      </div></div>
    ${phases ? `<h3>Moon phases</h3><div class="p-card sky-phases">${phases}</div>` : ''}
    ${events ? `<h3>Coming up in the sky</h3><div class="p-card sky-events">${events}</div>` : ''}
    ${lunar || solar ? `<h3>Next eclipses seen from here</h3><div class="p-card sky-events">${lunar}${solar}</div>` : ''}
    <p class="prefs-note">Calculated for ${esc(townName || 'town')} (${esc(where)}). Times are for a flat horizon: in a valley the sun clears the ridges later and drops behind them sooner. Meteor shower peaks can shift a day either way.</p>`;
}
