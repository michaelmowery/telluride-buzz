// Minimal iCalendar (.ics) reader for event calendars: Google Calendar, Outlook,
// CivicPlus, WordPress (The Events Calendar) and most town sites publish one.
// Reads VEVENTs only. Recurring events show their first upcoming date when the
// rule is a simple DAILY/WEEKLY/MONTHLY/YEARLY one; anything fancier shows once.
import { zonedEpoch } from './time.js';

/** Unfold continuation lines and split "NAME;PARAM=x:value". */
function lines(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').map((l) => {
    const i = l.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (i < 0) return null;
    const [name, ...params] = l.slice(0, i).split(';');
    return {
      name: name.toUpperCase(),
      params: Object.fromEntries(params.map((p) => { const [k, v = ''] = p.split('='); return [k.toUpperCase(), v.replace(/^"|"$/g, '')]; })),
      value: l.slice(i + 1),
    };
  }).filter(Boolean);
}

const unescape = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

/** DTSTART value to epoch ms: UTC (Z), floating/TZID (in tz), or all-day DATE. */
export function icsDate(value, params = {}, tz = 'America/Denver') {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  const zone = params.TZID && isZone(params.TZID) ? params.TZID : tz;
  return zonedEpoch(zone, +y, +mo, +d, h ? +h : 0, mi ? +mi : 0);
}

function isZone(z) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}

const STEP = { DAILY: 1, WEEKLY: 7 };

/** Next start on or after `from` for a simple RRULE, or null when the series is over. */
export function nextOccurrence(start, rrule, from) {
  if (!rrule || start >= from) return start;
  const r = Object.fromEntries(rrule.split(';').map((p) => p.split('=')));
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const until = r.UNTIL ? icsDate(r.UNTIL, {}, 'UTC') : Infinity;
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  if (r.BYDAY && r.FREQ === 'WEEKLY' && r.BYDAY.includes(',')) return null; // several days a week: not handled
  let t = start;
  for (let n = 1; n < 1000 && t < from; n++) {
    if (n >= count) return null;
    const d = new Date(t);
    if (STEP[r.FREQ]) t += STEP[r.FREQ] * interval * 86400e3;
    else if (r.FREQ === 'MONTHLY') t = d.setUTCMonth(d.getUTCMonth() + interval);
    else if (r.FREQ === 'YEARLY') t = d.setUTCFullYear(d.getUTCFullYear() + interval);
    else return null;
  }
  return t < from || t > until ? null : t;
}

/** Events from an .ics file, as plain objects. */
export function parseIcs(text, tz = 'America/Denver', now = Date.now()) {
  const out = [];
  let ev = null;
  for (const l of lines(text)) {
    if (l.name === 'BEGIN' && l.value.toUpperCase() === 'VEVENT') { ev = {}; continue; }
    if (l.name === 'END' && l.value.toUpperCase() === 'VEVENT') {
      if (ev && ev.start != null && ev.status !== 'CANCELLED') {
        const start = nextOccurrence(ev.start, ev.rrule, now - 86400e3);
        if (start != null) out.push({ ...ev, start, uid: ev.rrule ? `${ev.uid}@${start}` : ev.uid });
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    switch (l.name) {
      case 'UID': ev.uid = l.value; break;
      case 'SUMMARY': ev.title = unescape(l.value); break;
      case 'DESCRIPTION': ev.description = unescape(l.value); break;
      case 'LOCATION': ev.location = unescape(l.value); break;
      case 'URL': ev.url = l.value.trim(); break;
      case 'STATUS': ev.status = l.value.toUpperCase(); break;
      case 'RRULE': ev.rrule = l.value; break;
      case 'DTSTART': ev.start = icsDate(l.value, l.params, tz); ev.allDay = l.params.VALUE === 'DATE' || /^\d{8}$/.test(l.value); break;
      default: break;
    }
  }
  return out;
}
