// How the live feed decides what goes on top. Every post gets a "relevant time"
// and the feed sorts on it, newest first:
//
// - News, town notices, roads, snow: the time it was published.
// - Events: how close the event is to now, in either direction. An event
//   EVENT_WEIGHT x N hours away ranks like a news post N hours old, so tonight's
//   concert sits near this morning's news and a show three days out sinks below it.
//   Events leave the feed once they end, and only the next EVENT_DAYS days show in
//   the main feed (the Events tile and the Events filter show the rest).
// - Urgent alerts (severity >= PIN_SEVERITY) are pinned above everything while active.
//
// These numbers are the knobs to tune; tests in test/relevance.test.js pin the behavior.
export const EVENT_DAYS = 3;          // main feed shows events starting within this many days
export const EVENT_WEIGHT = 0.5;      // event N hours away ranks like news N * 0.5 hours old
export const PIN_SEVERITY = 2;        // warnings and emergencies stay on top
export const EVENT_HOURS = 3;         // assumed length of an event with a start time but no end
export const ALL_DAY_HOURS = 24;      // an all-day event lasts the day

/** End of an event for expires_at: its own end, else the start plus a default length. */
export function eventEnd(start, end = null, allDay = false) {
  if (!start) return null;
  if (end && end > start) return end;
  return start + (allDay ? ALL_DAY_HOURS : EVENT_HOURS) * 3600e3;
}

/** SQL for an item's relevant time (needs :now and :w bound). */
export const RANK_SQL = `CASE WHEN category = 'events' AND starts_at IS NOT NULL
  THEN :now - ABS(starts_at - :now) * :w ELSE published_at END`;

/** SQL that hides events that ended, and (main feed only) events further out than :horizon. */
export const EVENT_WINDOW_SQL = `NOT (category = 'events' AND starts_at IS NOT NULL AND (
  starts_at > :horizon OR COALESCE(expires_at, starts_at + ${EVENT_HOURS * 3600e3}) <= :now))`;

/** Same ranking in JS, for anything that sorts items outside the database. */
export function relevantTime(item, now = Date.now()) {
  return item.category === 'events' && item.startsAt
    ? now - Math.abs(item.startsAt - now) * EVENT_WEIGHT
    : item.publishedAt;
}
