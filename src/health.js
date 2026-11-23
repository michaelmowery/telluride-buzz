// Source health: one row per source with a plain colour.
//   green   last run worked and isn't overdue
//   amber   failing for under an hour, overdue, or waiting for its first run
//   red     failing for over an hour (the doc's alert threshold)
//   paused  turned off in the admin
import { ADAPTERS } from './adapters.js';

export const RED_AFTER_MS = 3600e3;

/** Which part of the site a source feeds, for the admin's feed filter. */
const FEED_BY_ADAPTER = {
  'nws-alerts': 'weather', 'nws-forecast': 'weather', cdot: 'roads',
  'snow-report': 'lifts', 'resort-alerts': 'lifts', ical: 'events', meander: 'news', rss: 'news',
};
export const FEED_NAMES = {
  alerts: 'Alerts', town: 'Town', news: 'News', events: 'Events', weather: 'Weather', roads: 'Roads', lifts: 'Lifts & snow', other: 'Other',
};
export function feedOf(s) {
  return s.settings?.category || FEED_BY_ADAPTER[s.adapter] || 'other';
}

export function sourceHealth(town, statusRows = [], now = Date.now()) {
  const byKey = new Map(statusRows.map((r) => [r.source, r]));
  return (town.sources || []).map((s) => {
    const st = byKey.get(s.key);
    const a = ADAPTERS[s.adapter];
    const every = Number(s.everyMin) || a?.defaultEvery || 15;
    const base = {
      key: s.key, label: s.label, adapter: s.adapter, adapterName: a?.name || s.adapter, feed: feedOf(s), everyMin: every, enabled: s.enabled !== false,
      lastRun: st?.last_run ?? null, lastOk: st?.last_ok ?? null, error: st?.last_error ?? null,
      failures: st?.error_count ?? 0, failingSince: st?.failing_since ?? null, items: st?.last_items ?? null,
    };
    let color, note;
    if (!a) { color = 'red'; note = `Unknown source type "${s.adapter}"`; }
    else if (s.enabled === false) { color = 'paused'; note = 'Paused'; }
    else if (!st) { color = 'amber'; note = 'Waiting for first run'; }
    else if (st.last_error) {
      const since = st.failing_since || st.last_run;
      color = now - since >= RED_AFTER_MS ? 'red' : 'amber';
      note = `Failing for ${ago(now - since)}`;
    } else if (now - (st.last_ok || 0) > Math.max(3 * every * 60e3 * 4, 30 * 60e3)) {
      // Allows for the scheduler's up-to-4x backoff before calling it overdue.
      color = 'amber'; note = `No successful run in ${ago(now - (st.last_ok || 0))}`;
    } else { color = 'green'; note = 'OK'; }
    return { ...base, color, note };
  });
}

/** Worst colour wins: red > amber > green; paused-only counts as paused. */
export function townColor(rows) {
  if (rows.some((r) => r.color === 'red')) return 'red';
  if (rows.some((r) => r.color === 'amber')) return 'amber';
  if (rows.some((r) => r.color === 'green')) return 'green';
  return rows.length ? 'paused' : 'amber';
}

export function ago(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}
