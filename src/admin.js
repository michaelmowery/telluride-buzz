// Admin API: add and edit towns and sources, test a source before saving, and the
// source health board. Lives at /admin on any town's address.
//
// Sign-in is one password (ADMIN_PASSWORD in the server's .env). With no password
// set, the admin is off and every admin route answers 404. The session cookie is
// signed with the password, so it survives deploys and changing the password signs
// everyone out. CSRF: the cookie is SameSite=Strict and every change is a JSON POST.
import crypto from 'node:crypto';
import { adapterCatalog, itemSourcesOf, nearbyRoutes, testSource } from './adapters.js';
import { exportTown, loadTowns, normalizeSource, normalizeTown, starterSources } from './towns.js';
import { sourceHealth, townColor, FEED_NAMES } from './health.js';
import { geocodeTown } from './geocode.js';
import { planClaudeSources } from './claude-town.js';
import { suggestCdotSource } from './cdot-routes.js';
import { suggestNmroadsSource } from './sources/nmroads.js';
import { ALL_TOWNS_KEY, normalizeNotice } from './notice.js';
import { normalizeResource, planCsvImport, resourcesToCsv, RESOURCE_CATEGORIES, STALE_DAYS, sponsorState, townDay } from './resources.js';
import { townUrl } from './brand.js';

const COOKIE = 'buzz_admin';
const SESSION_DAYS = 14;

export function createAdmin({ db, password = process.env.ADMIN_PASSWORD, onChange = () => {}, onResources = () => {}, runNow = () => false, deps = {}, log = console } = {}) {
  const enabled = typeof password === 'string' && password.length >= 10;
  if (password && !enabled) log.warn?.('ADMIN_PASSWORD is shorter than 10 characters, so the admin is off');
  const key = enabled ? crypto.createHash('sha256').update(`buzz-admin:${password}`).digest() : null;

  const sign = (exp) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
  const token = () => { const exp = Date.now() + SESSION_DAYS * 86400e3; return `${exp}.${sign(exp)}`; };
  function signedIn(req) {
    if (!enabled) return false;
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return false;
    const [exp, mac] = m[1].split('.');
    if (!exp || !mac || Number(exp) < Date.now()) return false;
    const want = Buffer.from(sign(exp));
    const got = Buffer.from(mac);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  // Login throttle: 8 wrong passwords per address per 15 minutes, 50 overall.
  const fails = new Map();
  let globalFails = { n: 0, at: Date.now() };
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  function throttled(ip) {
    const now = Date.now();
    if (now - globalFails.at > 15 * 60e3) globalFails = { n: 0, at: now };
    const f = fails.get(ip);
    if (f && now - f.at > 15 * 60e3) fails.delete(ip);
    return (fails.get(ip)?.n || 0) >= 8 || globalFails.n >= 50;
  }
  function failed(ip) {
    const f = fails.get(ip) || { n: 0, at: Date.now() };
    f.n++;
    fails.set(ip, f);
    globalFails.n++;
    if (fails.size > 5000) fails.clear();
  }

  const towns = () => loadTowns(db);
  const findTown = (id) => towns().find((t) => t.id === id);
  // Each entry's sponsorship state ("active", "scheduled", "ended" or "") for today in its town.
  const withSponsorState = (list) => {
    const days = new Map(towns().map((t) => [t.id, townDay(t)]));
    return list.map((r) => ({ ...r, sponsorState: sponsorState(r, days.get(r.townId) || townDay(null)) }));
  };
  const changed = (what) => { log.info?.(`admin: ${what}`); onChange(); };
  // The state DOT roads source for a town's state, if there is one: CDOT (Colorado), NMRoads (New Mexico).
  const roadsFor = (state) => ({
    CO: { adapter: 'cdot', name: 'CDOT', suggest: deps.suggestCdot || suggestCdotSource },
    NM: { adapter: 'nmroads', name: 'NMRoads', suggest: deps.suggestNmroads || suggestNmroadsSource },
  })[String(state || '').toUpperCase()] || null;
  // Add the state's roads source with the highways near the town's map point: { routes } or { error }.
  async function addCdotRoads(town) {
    const dot = roadsFor(town.state);
    if (!dot) return { error: `No roads feed for ${town.state || 'this state'} yet.` };
    try {
      const { source: input, error } = await dot.suggest(town, deps);
      if (error) return { error };
      const have = findTown(town.id)?.sources || [];
      const { source, error: bad2 } = normalizeSource(input, town, have);
      if (bad2) return { error: bad2 };
      db.saveSource(town.id, source);
      return { routes: source.settings.routes.map((r) => r.label) };
    } catch (e) {
      log.warn?.(`admin: ${dot.name} roads for ${town.id} failed: ${e.message}`);
      return { error: e.message };
    }
  }
  // Write a planned CSV import (planCsvImport): new rows go to the end of their town's list.
  function applyImport(plan) {
    db.raw.exec('BEGIN');
    try {
      const ends = new Map();
      for (const { town, resource } of plan.adds) {
        if (!ends.has(town)) ends.set(town, Math.max(0, ...db.listResources(town).map((r) => r.sort)));
        ends.set(town, ends.get(town) + 10);
        db.saveResource(town, { ...resource, sort: ends.get(town) });
      }
      for (const { town, resource } of plan.updates) db.saveResource(town, resource);
      db.raw.exec('COMMIT');
    } catch (e) { db.raw.exec('ROLLBACK'); throw e; }
    log.info?.(`admin: imported resources (${plan.adds.length} added, ${plan.updates.length} updated)`);
    for (const t of new Set([...plan.adds, ...plan.updates].map((x) => x.town))) onResources(t);
  }

  function healthBoard() {
    const status = db.sourceStatus();
    return towns().map((t) => {
      const rows = sourceHealth(t, status.filter((s) => s.town_id === t.id));
      return { id: t.id, name: t.name, state: t.state || '', status: t.status, url: t.url, color: townColor(rows), sources: rows };
    });
  }

  const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
  const bad = (error, status = 400) => ({ status, body: { ok: false, error } });

  /** Handle /api/admin/*. Returns { status, body, headers? } or null when not an admin route. */
  async function handle(req, url, readBody) {
    if (!url.pathname.startsWith('/api/admin/')) return null;
    if (!enabled) return { status: 404, body: { ok: false, error: 'Not found' } };
    const route = `${req.method} ${url.pathname.slice('/api/admin'.length)}`;
    const secure = req.headers['x-forwarded-proto'] === 'https' || !/^(localhost|[\w-]+\.localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''));

    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return bad('Use application/json', 415);
      const origin = req.headers.origin;
      if (origin && origin.replace(/^https?:\/\//, '') !== String(req.headers.host || '')) return bad('Cross-site request refused', 403);
    }

    if (route === 'POST /login') {
      const ip = ipOf(req);
      if (throttled(ip)) return bad('Too many tries. Wait 15 minutes.', 429);
      const body = await readBody();
      const given = crypto.createHash('sha256').update(String(body.password || '')).digest();
      const want = crypto.createHash('sha256').update(password).digest();
      if (!crypto.timingSafeEqual(given, want)) { failed(ip); return bad('Wrong password', 401); }
      fails.delete(ip);
      return { ...ok(), headers: { 'Set-Cookie': `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}` } };
    }
    if (route === 'POST /logout') {
      return { ...ok(), headers: { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}` } };
    }
    if (!signedIn(req)) return bad('Sign in first', 401);

    switch (route) {
      case 'GET /me':
        return ok();
      case 'GET /geocode': {
        // Add a town: look the name up on the map (OpenStreetMap) to fill the form.
        const name = (url.searchParams.get('q') || '').slice(0, 80);
        if (!name.trim()) return bad('Type a town name first.');
        try {
          return ok({ matches: await (deps.geocode || geocodeTown)(name, (url.searchParams.get('state') || '').slice(0, 2), { log }) });
        } catch (e) {
          log.warn?.(`admin: geocode failed: ${e.message}`);
          return bad(`The map lookup didn't answer (${e.message}). Try again, or use Edit the other fields and fill the point in by hand.`, 502);
        }
      }
      case 'GET /notice': {
        let notice = null;
        try { notice = JSON.parse(db.getMeta(ALL_TOWNS_KEY) || 'null'); } catch { /* none */ }
        return ok({ notice });
      }
      case 'GET /adapters':
        return ok({ adapters: adapterCatalog() });
      case 'GET /towns':
        return ok({ towns: towns() });
      case 'GET /health':
        return ok({ towns: healthBoard(), feeds: FEED_NAMES, now: Date.now() });
      case 'GET /resources': {
        const t = findTown(url.searchParams.get('town'));
        if (!t) return bad('No such town', 404);
        return ok({ town: { id: t.id, name: t.name, state: t.state || '', url: townUrl(t) }, categories: RESOURCE_CATEGORIES, staleDays: STALE_DAYS,
          today: townDay(t), resources: withSponsorState(db.listResources(t.id)) });
      }
      case 'GET /all-resources':
        return ok({
          towns: towns().map((t) => ({ id: t.id, name: t.name, state: t.state || '', status: t.status, url: townUrl(t) })),
          categories: RESOURCE_CATEGORIES, staleDays: STALE_DAYS, resources: withSponsorState(db.listResources(null)),
        });
      case 'GET /resources/export': {
        const id = url.searchParams.get('town') || '';
        if (id && !findTown(id)) return bad('No such town', 404);
        const day = new Date().toISOString().slice(0, 10);
        return { status: 200, body: resourcesToCsv(db.listResources(id || null)), type: 'text/csv; charset=utf-8',
          headers: { 'Content-Disposition': `attachment; filename="resources-${id || 'all-towns'}-${day}.csv"` } };
      }
      case 'GET /export': {
        const t = findTown(url.searchParams.get('town'));
        if (!t) return bad('No such town', 404);
        return { status: 200, body: exportTown(t, t.sources), headers: { 'Content-Disposition': `attachment; filename="${t.id}.json"` } };
      }
    }

    if (req.method !== 'POST') return bad('Not found', 404);
    const body = await readBody();
    const all = towns();

    switch (route) {
      case 'POST /town': {
        const existing = all.find((t) => t.id === body.town?.id);
        if (body.create && existing) return bad(`There is already a town at "${existing.id}".`);
        if (!body.create && !existing) return bad('No such town', 404);
        // Keep fields the form doesn't show (e.g. default, brand.aboutSources).
        const merged = existing ? { ...existing, ...body.town, brand: { ...existing.brand, ...body.town.brand } } : body.town;
        const { town, error } = normalizeTown(merged, all);
        if (error) return bad(error);
        // The state shows after the name in the town picker and on thetown.buzz.
        if (!/^[A-Z]{2}$/.test(town.state || '')) return bad('Add the two-letter state (like CO).');
        db.saveTown(town, town.status);
        if (body.create) for (const s of starterSources(town)) db.saveSource(town.id, s);
        // A Colorado or New Mexico town gets roads right away, with the highways near its map point.
        let roads = null;
        if (body.create && roadsFor(town.state)) roads = { ...(await addCdotRoads(town)), dot: roadsFor(town.state).name };
        // Add a town with Claude: its suggested sources and starter resources come along.
        let fromClaude = null;
        if (body.create && body.fromClaude && typeof body.fromClaude === 'object') {
          const have = findTown(town.id).sources;
          const { sources, skipped } = planClaudeSources(body.fromClaude.suggestedSources, town, have);
          for (const s of sources) db.saveSource(town.id, s);
          fromClaude = { sources: sources.map((s) => ({ key: s.key, label: s.label, adapter: s.adapter, enabled: s.enabled, url: s.settings.url, about: s.about })), skipped, resources: null };
          const csv = typeof body.fromClaude.resourcesCsv === 'string' ? body.fromClaude.resourcesCsv : '';
          if (csv.trim()) {
            const plan = planCsvImport(csv, { towns: towns(), existing: db.listResources(null), forceTown: town.id });
            fromClaude.resources = plan.error ? { added: 0, errors: [{ line: 0, error: plan.error }] } : { added: plan.adds.length, errors: plan.errors.slice(0, 50) };
            if (!plan.error && (plan.adds.length || plan.updates.length)) applyImport(plan);
          }
        }
        changed(`${body.create ? 'added' : 'saved'} town ${town.id} (${town.status})`);
        return ok({ town: findTown(town.id), fromClaude, roads });
      }
      case 'POST /notice': {
        // The header message for every town (a town's own is in its Settings).
        const { notice, error } = normalizeNotice(body);
        if (error) return bad(error);
        db.setMeta(ALL_TOWNS_KEY, JSON.stringify(notice));
        changed(notice ? 'set the message for every town' : 'cleared the message for every town');
        return ok({ notice });
      }
      case 'POST /town/delete': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        if (t.status === 'live') return bad('Switch the town to draft before deleting it.');
        if (body.confirm !== t.id) return bad(`Type "${t.id}" to confirm.`);
        db.deleteTown(t.id);
        changed(`deleted town ${t.id}`);
        return ok();
      }
      case 'POST /source': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        if (body.create && body.source?.key && t.sources.some((s) => s.key === body.source.key)) return bad('That source key is taken.');
        if (!body.create && !body.source?.key) return bad('No such source', 404);
        const { source, error } = normalizeSource(body.source, t, t.sources);
        if (error) return bad(error);
        if (!body.create && !t.sources.some((s) => s.key === source.key)) return bad('No such source', 404);
        db.saveSource(t.id, source);
        changed(`${body.create ? 'added' : 'saved'} source ${t.id}/${source.key}`);
        return ok({ source });
      }
      case 'POST /source/cdot-auto': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        const dot = roadsFor(t.state);
        if (!dot) return bad(`Roads feeds are for Colorado (CDOT) and New Mexico (NMRoads) towns. ${t.name} is in ${t.state || 'no state'}.`);
        if (t.sources.some((x) => x.adapter === dot.adapter)) return bad(`${t.name} already has ${dot.name} roads. Edit that source to change its highways.`);
        const roads = await addCdotRoads(t);
        if (roads.error) return bad(`Couldn't add roads: ${roads.error}`);
        changed(`added ${dot.name} roads to ${t.id}`);
        return ok({ roads: { ...roads, dot: dot.name } });
      }
      // Feeds tab, "Find feeds with Claude": preview Claude's suggestions (no pick), then
      // add the ones ticked (pick: positions in suggestedSources). Duplicates are skipped.
      case 'POST /source/from-claude': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        const suggested = Array.isArray(body.suggestedSources) ? body.suggestedSources.slice(0, 40) : [];
        if (!suggested.length) return bad('No suggested sources in that answer.');
        if (!Array.isArray(body.pick)) {
          const { sources, picks, skipped } = planClaudeSources(suggested, t, t.sources);
          return ok({ sources: sources.map((s, i) => ({ index: picks[i], key: s.key, label: s.label, adapter: s.adapter, url: s.settings?.url, enabled: s.enabled, about: s.about })), skipped });
        }
        const pick = new Set(body.pick.map(Number));
        const { sources } = planClaudeSources(suggested.map((x, i) => (pick.has(i) ? x : null)), t, t.sources);
        for (const s of sources) db.saveSource(t.id, s);
        if (sources.length) changed(`added ${sources.length} Claude sources to ${t.id}`);
        return ok({ added: sources.map((s) => ({ key: s.key, label: s.label, enabled: s.enabled })) });
      }
      case 'POST /source/nearby-routes': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        const r = await (deps.nearbyRoutes || nearbyRoutes)(String(body.adapter || ''), t, deps);
        if (r.error) return bad(r.error);
        return ok({ routes: r.routes });
      }
      case 'POST /source/test': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        const others = t.sources.filter((s) => s.key !== body.source?.key);
        const { source, error } = normalizeSource({ ...body.source, key: body.source?.key || undefined }, t, others);
        if (error) return bad(error);
        // Test as if saved, so a new resort shows beside the town's others on the tile.
        const view = { ...t, sources: [...others, source] };
        return ok({ result: await testSource(view, source, deps) });
      }
      case 'POST /source/toggle': {
        const t = all.find((x) => x.id === body.town);
        const s = t?.sources.find((x) => x.key === body.key);
        if (!s) return bad('No such source', 404);
        db.setSourceEnabled(t.id, s.key, !!body.enabled);
        changed(`${body.enabled ? 'resumed' : 'paused'} ${t.id}/${s.key}`);
        return ok();
      }
      case 'POST /source/delete': {
        const t = all.find((x) => x.id === body.town);
        const s = t?.sources.find((x) => x.key === body.key);
        if (!s) return bad('No such source', 404);
        db.deleteSource(t.id, s.key, itemSourcesOf(s));
        changed(`deleted source ${t.id}/${s.key}`);
        return ok();
      }
      case 'POST /source/move': {
        // Move or copy a source to another town, so one feed can serve several towns.
        const t = all.find((x) => x.id === body.town);
        const s = t?.sources.find((x) => x.key === body.key);
        if (!s) return bad('No such source', 404);
        const to = all.find((x) => x.id === body.to);
        if (!to || to.id === t.id) return bad('Pick another town.');
        const copy = body.mode === 'copy';
        const taken = to.sources.some((x) => x.key === s.key);
        if (!copy && taken) return bad(`${to.name} already has a source called "${s.key}". Copy it instead, or delete that one first.`);
        const { source, error } = normalizeSource({ ...s, key: taken ? '' : s.key, sort: undefined }, to, to.sources);
        if (error) return bad(`Can't add it to ${to.name}: ${error}`);
        for (const [k, v] of Object.entries(s.settings || {})) if (!(k in source.settings)) source.settings[k] = v; // e.g. a CDOT disclaimer
        if (copy) db.saveSource(to.id, source);
        else db.moveSource(t.id, to.id, s.key, itemSourcesOf(s), source.sort);
        changed(`${copy ? 'copied' : 'moved'} source ${t.id}/${s.key} to ${to.id}/${source.key}`);
        return ok({ town: to.id, key: source.key });
      }
      case 'POST /source/run': {
        const t = all.find((x) => x.id === body.town);
        const s = t?.sources.find((x) => x.key === body.key);
        if (!s) return bad('No such source', 404);
        if (!runNow(t.id, s.key)) return bad('That source is paused or not running.');
        return ok();
      }
      case 'POST /resource': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        const { resource, error } = normalizeResource(body.resource);
        if (error) return bad(error);
        if (resource.id && !db.listResources(t.id).some((r) => r.id === resource.id)) return bad('No such resource', 404);
        if (!resource.id && !body.resource?.sort) {
          // New entries go to the end of their category.
          resource.sort = Math.max(0, ...db.listResources(t.id).map((r) => r.sort)) + 10;
        }
        if (body.checked) resource.checkedAt = Date.now();
        const id = db.saveResource(t.id, resource);
        log.info?.(`admin: ${resource.id ? 'saved' : 'added'} resource ${t.id}/${id}`);
        onResources(t.id);
        return ok({ resource: db.listResources(t.id).find((r) => r.id === id) });
      }
      case 'POST /resources/import': {
        // Preview first (nothing written), then the same call with apply: true.
        const plan = planCsvImport(body.csv || '', { towns: all, existing: db.listResources(null), defaultTown: body.town || '', onlyTown: body.only ? body.town || '' : '' });
        if (plan.error) return bad(plan.error);
        const summary = { rows: plan.rows, adds: plan.adds.length, updates: plan.updates.length, errors: plan.errors,
          preview: [...plan.adds.map((x) => ({ ...x, action: 'add' })), ...plan.updates.map((x) => ({ ...x, action: 'update' }))]
            .sort((a, b) => a.line - b.line).slice(0, 200).map((x) => ({ line: x.line, action: x.action, town: x.town, name: x.resource.name, category: x.resource.category })) };
        if (!body.apply) return ok(summary);
        // Rows with problems are skipped; the good rows go in (summary.errors lists the skipped ones).
        if (!plan.adds.length && !plan.updates.length) return bad('Nothing to import: every row has a problem.');
        applyImport(plan);
        return ok(summary);
      }
      case 'POST /resource/delete': {
        const t = all.find((x) => x.id === body.town);
        if (!t || !db.deleteResource(t.id, Number(body.id))) return bad('No such resource', 404);
        log.info?.(`admin: deleted resource ${t.id}/${body.id}`);
        onResources(t.id);
        return ok();
      }
      case 'POST /resource/order': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        const have = new Set(db.listResources(t.id).map((r) => r.id));
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((id) => have.has(id));
        db.sortResources(t.id, ids);
        onResources(t.id);
        return ok();
      }
      case 'POST /resource/checked': {
        const t = all.find((x) => x.id === body.town);
        if (!t) return bad('No such town', 404);
        const ids = Array.isArray(body.ids) ? body.ids.map(Number) : db.listResources(t.id).map((r) => r.id);
        db.markResourcesChecked(t.id, ids);
        onResources(t.id);
        return ok();
      }
      default:
        return bad('Not found', 404);
    }
  }

  return { enabled, handle, signedIn, healthBoard };
}
