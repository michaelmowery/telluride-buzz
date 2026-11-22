// Runs each source on its own interval, isolated from the others: a failing
// source records its error and retries with backoff, and never stops the rest.
//
// Sources come from the database. reload() compares the current towns and
// sources with what is running and starts, stops or restarts only what changed,
// so adding a town or a source in the admin takes effect without a restart.
import { jobFor } from './adapters.js';

/** Every enabled source of a town as a job. Unknown adapters are skipped. */
export function jobsFor(town, deps) {
  return (town.sources || []).filter((s) => s.enabled !== false)
    .map((s) => jobFor(town, s, deps)).filter(Boolean);
}

export function startScheduler(db, towns, { log = console, afterRun = null, deps } = {}) {
  const running = new Map(); // `${town}/${key}` -> { sig, timer, runNow, stop }
  let stopped = false;
  let stagger = 0;

  function start(town, job, sig) {
    const id = `${town.id}/${job.key}`;
    const entry = { sig, timer: null, busy: false, stopped: false };
    let failures = 0;
    const tick = async () => {
      if (stopped || entry.stopped || entry.busy) return;
      entry.busy = true;
      clearTimeout(entry.timer);
      try {
        await job.run(db);
        if (entry.stopped) return;
        db.recordRun(town.id, job.key, null);
        if (failures) log.info?.(`[${id}] recovered`);
        failures = 0;
        if (afterRun) await afterRun(town).catch((e) => log.warn?.(`[${town.id}] after-run: ${e.message}`));
      } catch (e) {
        if (entry.stopped) return;
        failures++;
        db.recordRun(town.id, job.key, e.message);
        log.warn?.(`[${id}] ${e.message}`);
      } finally {
        entry.busy = false;
        // Back off up to 4x the normal interval while a source keeps failing.
        const mult = Math.min(4, 1 + failures);
        const jitter = 0.9 + Math.random() * 0.2;
        if (!stopped && !entry.stopped) entry.timer = setTimeout(tick, job.everyMin * 60e3 * mult * jitter);
      }
    };
    entry.runNow = tick;
    entry.stop = () => { entry.stopped = true; clearTimeout(entry.timer); };
    // Stagger first runs so the box doesn't hit every source at once.
    entry.timer = setTimeout(tick, 500 + (stagger++ % 40) * 1500);
    running.set(id, entry);
  }

  function reload(nextTowns) {
    const want = new Map();
    for (const town of nextTowns) {
      // A snow report job depends on its sibling resorts, so they share a signature.
      const resorts = JSON.stringify((town.sources || []).filter((s) => s.adapter === 'snow-report' && s.enabled !== false).map((s) => [s.key, s.label, s.settings]));
      const townSig = JSON.stringify([town.timezone, town.location, town.bbox, town.name]);
      for (const s of (town.sources || []).filter((x) => x.enabled !== false)) {
        const sig = JSON.stringify([townSig, s.adapter, s.label, s.settings, s.everyMin, s.adapter === 'snow-report' ? resorts : '']);
        want.set(`${town.id}/${s.key}`, { town, source: s, sig });
      }
    }
    let started = 0, stoppedN = 0;
    for (const [id, entry] of running) {
      if (want.get(id)?.sig !== entry.sig) { entry.stop(); running.delete(id); stoppedN++; }
    }
    for (const [id, w] of want) {
      if (running.has(id)) continue;
      const job = jobFor(w.town, w.source, deps);
      if (!job) { log.warn?.(`[${id}] unknown source type ${w.source.adapter}`); continue; }
      start(w.town, job, w.sig);
      started++;
    }
    stagger = 0;
    return { started, stopped: stoppedN, running: running.size };
  }

  reload(towns);

  // Housekeeping: prune old items daily.
  const prune = setInterval(() => db.prune(30), 24 * 3600e3);

  return {
    reload,
    /** Run one source now (the health board's Retry). False if it isn't running. */
    runNow(townId, key) {
      const e = running.get(`${townId}/${key}`);
      if (!e) return false;
      e.runNow();
      return true;
    },
    running: () => [...running.keys()],
    stop() {
      stopped = true;
      clearInterval(prune);
      for (const e of running.values()) e.stop();
      running.clear();
    },
  };
}
