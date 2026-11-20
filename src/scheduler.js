// Runs each ingestion job on its own interval, isolated from the others: a failing
// feed records its error and retries with backoff, and never stops the rest.
import { nwsJobs } from './sources/nws.js';
import { cdotJobs } from './sources/cdot.js';
import { feedJobs } from './sources/feeds.js';
import { liftsJobs } from './sources/lifts.js';

export function jobsFor(town) {
  return [...nwsJobs(town), ...cdotJobs(town), ...liftsJobs(town), ...feedJobs(town)];
}

export function startScheduler(db, towns, { log = console } = {}) {
  const timers = [];
  let stopped = false;

  for (const town of towns) {
    jobsFor(town).forEach((job, i) => {
      let failures = 0;
      const tick = async () => {
        if (stopped) return;
        try {
          await job.run(db);
          db.recordRun(town.id, job.id, null);
          if (failures) log.info?.(`[${town.id}/${job.id}] recovered`);
          failures = 0;
        } catch (e) {
          failures++;
          db.recordRun(town.id, job.id, e.message);
          log.warn?.(`[${town.id}/${job.id}] ${e.message}`);
        }
        // Back off up to 4x the normal interval while a source keeps failing.
        const mult = Math.min(4, 1 + failures);
        const jitter = 0.9 + Math.random() * 0.2;
        if (!stopped) timers.push(setTimeout(tick, job.everyMin * 60e3 * mult * jitter));
      };
      // Stagger first runs so the box doesn't hit every source at once.
      timers.push(setTimeout(tick, 500 + i * 1500));
    });
  }

  // Housekeeping: prune old items daily.
  const prune = setInterval(() => db.prune(30), 24 * 3600e3);
  timers.push(prune);

  return () => {
    stopped = true;
    timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  };
}
