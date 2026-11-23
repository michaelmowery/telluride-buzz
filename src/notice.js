// The header's message area: the space right of the town picker.
//
// It shows, most important first:
//   1. a message for every town (set on the admin's All towns page, kept in meta)
//   2. this town's own message (town Settings, kept in brand.notice)
//   3. the "Preview: early testing" note, unless the town turns it off (brand.preview === false)
// A message can end on a date (inclusive, in the town's time zone).
import { townDay } from './resources.js';

export const NOTICE_LEVELS = { info: 'Note', warn: 'Heads up', urgent: 'Alert' };
export const ALL_TOWNS_KEY = 'notice:all';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Clean up a message from the admin. A blank text clears it (notice: null). */
export function normalizeNotice(input) {
  const text = String(input?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return { notice: null };
  if (text.length > 280) return { error: 'Keep the message under 280 characters.' };
  const level = NOTICE_LEVELS[input.level] ? input.level : 'info';
  const until = String(input.until || '').trim();
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { error: 'End date must be a date.' };
  return { notice: { text, level, ...(until ? { until } : {}) } };
}

const live = (n, day) => n && n.text && (!n.until || day <= n.until);

/** The messages to show for a town today, most important first. */
export function noticesFor(town, allTowns, now = Date.now()) {
  const day = townDay(town, now);
  const site = town.brand?.siteName || `${town.name} Buzz`;
  const list = [];
  for (const n of [allTowns, town.brand?.notice]) {
    if (live(n, day)) list.push({ label: NOTICE_LEVELS[n.level] || 'Note', text: n.text, level: n.level || 'info' });
  }
  if (town.brand?.preview !== false) {
    list.push({ label: 'Preview', level: 'preview', text: `${site} is in early testing. Information may be wrong or out of date, so check the original source before you rely on it.` });
  }
  const rank = { urgent: 0, warn: 1, info: 2, preview: 3 };
  return list.sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * Markup for the header. Each message is a <details>: on a wide screen the summary
 * shows the text on one line (opening it shows all of it); on a phone it shrinks to
 * a small pill and opens into a panel under the header.
 */
export function renderNotices(list) {
  if (!list.length) return '';
  return `<div class="notes" aria-label="Site messages">${list.map((n) =>
    `<details class="note note-${n.level}"><summary><span class="note-dot" aria-hidden="true"></span><strong>${esc(n.label)}<span class="note-text">:</span></strong><span class="note-text">${esc(n.text)}</span></summary><div class="note-full"><strong>${esc(n.label)}:</strong> ${esc(n.text)}</div></details>`).join('')}</div>`;
}
