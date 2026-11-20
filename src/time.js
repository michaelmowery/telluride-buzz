// Time-zone helpers without dependencies.

/** Offset in minutes of `tz` from UTC at instant `epochMs` (e.g. -420 for MST). */
export function tzOffsetMinutes(tz, epochMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - epochMs) / 60000);
}

/** Epoch ms for a wall-clock time in `tz`. */
export function zonedEpoch(tz, y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMinutes(tz, guess);
  const t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(tz, t);
  return off1 === off2 ? t : guess - off2 * 60000;
}

/**
 * Parse loose event date/time text such as "November 28, 2026" + "6:00 PM - 8:00 PM"
 * or "11/28/2026" + "18:00" into epoch ms in the town's time zone.
 */
export function parseLocalDateTime(tz, dateText, timeText) {
  if (!dateText) return null;
  let y, mo, d;
  const iso = dateText.match(/(\d{4})-(\d{2})-(\d{2})/);
  const us = dateText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (iso) [y, mo, d] = [+iso[1], +iso[2], +iso[3]];
  else if (us) [y, mo, d] = [+us[3], +us[1], +us[2]];
  else {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const m = dateText.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (!m) return null;
    mo = months.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    if (!mo) return null;
    [d, y] = [+m[2], +m[3]];
  }
  let h = 0, mi = 0;
  const t = (timeText || '').match(/(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]?/) || (timeText || '').match(/(\d{1,2}):(\d{2})/);
  if (t) {
    h = +t[1]; mi = +(t[2] || 0);
    if (t[3]) {
      const pm = t[3].toLowerCase() === 'p';
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
  }
  return zonedEpoch(tz, y, mo, d, h, mi);
}
