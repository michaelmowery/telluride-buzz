// Weather graphics for the Weather tile and panel: condition icons (inline SVG, no
// icon fonts or CDNs), the 24-hour chart, and the day-by-day forecast rows.
// Everything is drawn from the NWS fields we already store, so it works for every town.

const TZ = 'America/Denver';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** NWS shortForecast ("Chance Snow Showers then Mostly Sunny") -> one icon kind. */
export function wxKind(short = '') {
  const s = String(short).split(/\bthen\b/i)[0].toLowerCase();
  if (/thunder|t-storm|tstorm/.test(s)) return 'thunder';
  const snow = /snow|flurr|blizzard/.test(s);
  const rain = /rain|shower|drizzle/.test(s);
  if (/sleet|freezing|ice pellet|wintry/.test(s) || (snow && /rain|drizzle/.test(s))) return 'mix';
  if (snow) return 'snow';
  if (rain) return 'rain';
  if (/fog|haze|smoke|dust/.test(s)) return 'fog';
  if (/breezy|windy|blustery/.test(s) && !/cloud|sunny|clear/.test(s)) return 'wind';
  if (/mostly cloudy|overcast|^cloudy|\bcloudy$/.test(s) && !/partly/.test(s)) return 'cloudy';
  if (/partly|mostly sunny|mostly clear|few clouds|increasing clouds|decreasing clouds/.test(s)) return 'partly';
  if (/sunny|clear|fair|hot|cold/.test(s)) return 'clear';
  if (/cloud/.test(s)) return 'cloudy';
  return 'partly';
}

const CLOUD = 'M9.5 24h13a5 5 0 0 0 .7-9.95A7 7 0 0 0 9.9 15.1 4.5 4.5 0 0 0 9.5 24z';
const CLOUD_UP = 'M9.5 19h13a5 5 0 0 0 .7-9.95A7 7 0 0 0 9.9 10.1 4.5 4.5 0 0 0 9.5 19z';
const sun = (cx, cy, r) => {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4, r1 = r + 2.6, r2 = r + 5.2;
    const p = (rr) => `${(cx + rr * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)}`;
    return `M${p(r1)}L${p(r2)}`;
  }).join('');
  return `<path class="wx-ray" d="${rays}"/><circle class="wx-sun" cx="${cx}" cy="${cy}" r="${r}"/>`;
};
const moon = (cx, cy, r) => `<path class="wx-moon" d="M${cx + r * 0.35} ${cy - r}A${r} ${r} 0 1 0 ${cx + r} ${cy + r * 0.45}A${r * 0.82} ${r * 0.82} 0 0 1 ${cx + r * 0.35} ${cy - r}z"/>`;
const drops = (xs) => xs.map((x, i) => `<path class="wx-rain" d="M${x} ${22 + (i % 2) * 2}l-1.6 4.5"/>`).join('');
const flake = (x, y) => `<g class="wx-flake" transform="translate(${x} ${y})"><path d="M0-3.2V3.2M-2.8-1.6 2.8 1.6M-2.8 1.6 2.8-1.6"/></g>`;

const SHAPES = {
  clear: (day) => (day ? sun(16, 16, 6.5) : moon(16, 16, 8)),
  partly: (day) => `${day ? sun(11.5, 11.5, 5) : moon(12, 11.5, 6)}<path class="wx-cloud" d="${CLOUD}" transform="translate(3 1)"/>`,
  cloudy: () => `<path class="wx-cloud2" d="${CLOUD}" transform="translate(5 -6) scale(.8)"/><path class="wx-cloud" d="${CLOUD}" transform="translate(-1 1)"/>`,
  rain: () => `<path class="wx-cloud" d="${CLOUD_UP}"/>${drops([11.5, 16.5, 21.5])}`,
  snow: () => `<path class="wx-cloud" d="${CLOUD_UP}"/>${flake(10.5, 24)}${flake(17, 27.5)}${flake(23.5, 24)}`,
  mix: () => `<path class="wx-cloud" d="${CLOUD_UP}"/>${drops([12])}${flake(18, 26)}${drops([24])}`,
  thunder: () => `<path class="wx-cloud" d="${CLOUD_UP}"/><path class="wx-bolt" d="M17.5 18l-4 6.5h3.4l-2 5.5 5.6-7.6h-3.6l2.1-4.4z"/>`,
  fog: () => `<path class="wx-cloud" d="${CLOUD_UP}" transform="translate(0 -2)"/><path class="wx-fog" d="M6 21h20M9 25h16M7 29h14"/>`,
  wind: () => '<path class="wx-wind" d="M4 12h14a3.5 3.5 0 1 0-3.5-3.5M4 17h20a3.5 3.5 0 1 1-3.5 3.5M4 22h10"/>',
};

/** Inline SVG icon for a forecast. `day` false draws a moon instead of the sun. */
export function wxIcon(short, day = true, size = 32, extraClass = '') {
  const kind = wxKind(short);
  return `<svg class="wx-icon ${extraClass}" viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-label="${esc(short || kind)}">${SHAPES[kind](day !== false)}</svg>`;
}

/** "New snow accumulation of 2 to 4 inches possible." -> [2, 4]; null when no snow is forecast. */
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
export function snowRange(detail = '') {
  const m = String(detail).match(/new snow accumulation of ([^.]+)\./i);
  if (!m) return null;
  const t = m[1].toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => WORDS[w]);
  if (/less than (a )?half/.test(t)) return [0, 0.5];
  if (/less than (one|1) inch/.test(t)) return [0, 1];
  const nums = (t.match(/\d+(\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  return nums.length > 1 ? [nums[0], nums[1]] : [nums[0], nums[0]];
}
const fmtIn = (r) => (r[1] <= 1 && r[0] === 0 ? '<1″' : r[0] === r[1] ? `${r[1]}″` : `${r[0]}–${r[1]}″`);

const local = (t, opts) => new Date(t).toLocaleString('en-US', { timeZone: TZ, ...opts });
const isDayHour = (h) => (h.isDaytime != null ? h.isDaytime : (() => { const x = Number(local(h.t, { hour: 'numeric', hour12: false })); return x >= 6 && x < 18; })());

/**
 * The next 24 hours as one chart: an icon every other hour, the temperature line
 * with labels, and blue bars for the chance of precipitation. Scrolls sideways on a phone.
 */
export function hourlyChart(hours) {
  const list = (hours || []).filter((h) => h.temp != null).slice(0, 24);
  if (list.length < 2) return '';
  const col = 48, W = list.length * col, top = 56, chartH = 64, popTop = top + chartH + 14, popH = 34, H = popTop + popH + 18;
  const temps = list.map((h) => h.temp);
  const min = Math.min(...temps), max = Math.max(...temps), span = Math.max(max - min, 6);
  const x = (i) => i * col + col / 2;
  const y = (t) => top + 10 + (chartH - 20) * (1 - (t - min) / span);
  const pts = list.map((h, i) => `${x(i).toFixed(1)},${y(h.temp).toFixed(1)}`);
  const area = `M${x(0)},${top + chartH} L${pts.join(' L')} L${x(list.length - 1)},${top + chartH} Z`;
  let out = '';
  list.forEach((h, i) => {
    const cx = x(i);
    const label = local(h.t, { hour: 'numeric' }).replace(' ', '').toLowerCase();
    out += `<text class="wx-h-time" x="${cx}" y="14">${i === 0 ? 'Now' : esc(label)}</text>`;
    out += `<g transform="translate(${cx - 16} 20)">${wxIcon(h.short, isDayHour(h), 32)}</g>`;
    out += `<text class="wx-h-temp" x="${cx}" y="${(y(h.temp) - 8).toFixed(1)}">${h.temp}°</text>`;
    const pop = h.pop || 0;
    const bh = (popH * pop) / 100;
    out += `<rect class="wx-pop-track" x="${cx - 9}" y="${popTop}" width="18" height="${popH}" rx="4"/>`;
    if (pop) out += `<rect class="wx-pop-bar" x="${cx - 9}" y="${(popTop + popH - bh).toFixed(1)}" width="18" height="${bh.toFixed(1)}" rx="4"/>`;
    out += `<text class="wx-h-pop${pop ? '' : ' none'}" x="${cx}" y="${popTop + popH + 14}">${pop ? `${pop}%` : '–'}</text>`;
  });
  return `<div class="wx-hourly" tabindex="0" aria-label="Next 24 hours: temperature and chance of precipitation">
    <svg class="wx-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <path class="wx-area" d="${area}"/>
      <polyline class="wx-line" points="${pts.join(' ')}"/>
      ${list.map((h, i) => `<circle class="wx-dot" cx="${x(i)}" cy="${y(h.temp).toFixed(1)}" r="2.6"/>`).join('')}
      ${out}
    </svg></div>
    <div class="wx-legend"><span class="wx-key line"></span>Temperature <span class="wx-key pop"></span>Chance of rain or snow</div>`;
}

/** Day and night periods paired into days: [{ label, short, day, hi, lo, pop, snow:[lo,hi] }]. */
export function forecastDays(periods) {
  const days = [];
  (periods || []).forEach((p, i) => {
    const cur = days[days.length - 1];
    const snow = snowRange(p.detail);
    if (p.isDaytime || !cur || cur.lo != null) {
      days.push({ name: p.name, start: p.start, short: p.short, day: !!p.isDaytime, hi: p.isDaytime ? p.temp : null, lo: p.isDaytime ? null : p.temp, pop: p.pop ?? popFrom(p.detail), snow, first: i === 0 });
    } else {
      cur.lo = p.temp;
      cur.pop = Math.max(cur.pop ?? 0, p.pop ?? popFrom(p.detail) ?? 0) || null;
      if (snow) cur.snow = cur.snow ? [cur.snow[0] + snow[0], cur.snow[1] + snow[1]] : snow;
    }
  });
  return days.slice(0, 7).map((d, i) => ({ ...d, label: dayName(d, i) }));
}
const popFrom = (detail = '') => { const m = String(detail).match(/chance of precipitation is (\d+)%/i); return m ? Number(m[1]) : null; };
function dayName(d, i) {
  if (i === 0) return d.day ? 'Today' : 'Tonight';
  if (d.start) return local(d.start, { weekday: 'short' });
  return String(d.name || '').slice(0, 3);
}

/** One row per day: name, icon, rain/snow, then the low-to-high range bar across the week. */
export function dayRows(periods) {
  const days = forecastDays(periods);
  if (!days.length) return '';
  const all = days.flatMap((d) => [d.hi, d.lo]).filter((v) => v != null);
  const min = Math.min(...all), max = Math.max(...all), span = Math.max(max - min, 1);
  const pct = (v) => (((v - min) / span) * 100).toFixed(1);
  return `<div class="wx-days">${days.map((d) => {
    const lo = d.lo ?? d.hi, hi = d.hi ?? d.lo;
    const precip = d.snow
      ? `<span class="wx-snow"><svg class="wx-icon" viewBox="-4.5 -4.5 9 9" width="13" height="13" aria-hidden="true">${flake(0, 0)}</svg>${esc(fmtIn(d.snow))}</span>`
      : d.pop ? `<span class="wx-rainpct">${d.pop}%</span>` : '';
    return `<div class="wx-day" title="${esc(d.short)}">
      <span class="wx-day-name">${esc(d.label)}</span>
      ${wxIcon(d.short, d.day, 30)}
      <span class="wx-day-precip">${precip}</span>
      <span class="wx-day-lo">${d.lo != null ? `${d.lo}°` : ''}</span>
      <span class="wx-range"><span class="wx-range-bar" data-left="${pct(lo)}" data-right="${(100 - pct(hi)).toFixed(1)}"></span></span>
      <span class="wx-day-hi">${d.hi != null ? `${d.hi}°` : ''}</span>
    </div>`;
  }).join('')}</div>`;
}

/** Bars of expected new snow per day; empty when none is forecast. */
export function snowBars(periods) {
  const days = forecastDays(periods);
  if (!days.some((d) => d.snow)) return '';
  const top = Math.max(...days.map((d) => (d.snow ? d.snow[1] : 0)), 1);
  return `<div class="wx-snowbars">${days.map((d) => {
    const s = d.snow;
    return `<div class="wx-sb">
      <span class="wx-sb-amt">${s ? esc(fmtIn(s)) : ''}</span>
      <span class="wx-sb-col">${s ? `<span class="wx-sb-hi" data-h="${((s[1] / top) * 100).toFixed(1)}"></span><span class="wx-sb-lo" data-h="${((s[0] / top) * 100).toFixed(1)}"></span>` : ''}</span>
      <span class="wx-sb-day">${esc(d.label)}</span></div>`;
  }).join('')}</div>`;
}
