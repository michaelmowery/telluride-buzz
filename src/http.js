// Small fetch wrapper: timeout, identifying User-Agent, size cap, clear errors.
const UA = process.env.USER_AGENT || 'TellurideBuzz/0.1 (+https://telluride.buzz; telluridebuzz@gmail.com)';
const MAX_BYTES = 5 * 1024 * 1024;

export async function fetchText(url, { timeoutMs = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${redact(url)}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error(`Response too large (${len} bytes) from ${redact(url)}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(`Response too large from ${redact(url)}`);
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs} ms: ${redact(url)}`);
    if (e.cause) throw new Error(`${e.message} (${e.cause.code || e.cause.message}): ${redact(url)}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { ...opts, headers: { Accept: 'application/json, application/geo+json', ...(opts.headers || {}) } });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${redact(url)}`);
  }
}

/** Never let an API key end up in logs, errors or the health page. */
export function redact(url) {
  return String(url).replace(/(api[_-]?key=)[^&]+/gi, '$1***');
}

/**
 * Shared fetch: towns that read the same address (CDOT's statewide feeds, a
 * shared NWS point) within `ttlMs` get one request between them. Concurrent
 * callers wait on the same request.
 */
const shared = new Map(); // `${kind} ${url}` -> { at, promise }
function sharedFetch(kind, fn, ttlMs = 60e3) {
  return (url, opts = {}) => {
    const key = `${kind} ${url}`;
    const hit = shared.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
    const promise = fn(url, opts);
    shared.set(key, { at: Date.now(), promise });
    promise.catch(() => shared.delete(key)); // never cache a failure
    if (shared.size > 500) for (const [k, v] of shared) if (Date.now() - v.at > ttlMs) shared.delete(k);
    return promise;
  };
}
export const sharedText = sharedFetch('text', fetchText);
export const sharedJson = sharedFetch('json', fetchJson);
