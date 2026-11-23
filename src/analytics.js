// Visit counts with the self-hosted Umami on the same server (no cookies, no personal
// data). It is off until UMAMI_WEBSITE_ID is set. Every town site loads Umami's script
// from its own address (/stats/script.js) and reports to /stats/api/send, which this
// server passes on to Umami. That keeps the Content-Security-Policy at 'self' and keeps
// ad blockers from dropping the counts. One Umami website covers every town: each page
// view carries its hostname, and the town id as Umami's tag.
//
//   UMAMI_WEBSITE_ID     the Website ID from Umami's admin (Settings > Websites)
//   UMAMI_URL            where this server reaches Umami (default http://umami:3000,
//                        the container on the shared Docker network)
//   UMAMI_DASHBOARD_URL  the address you open Umami at (default https://analytics.meander.me)

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCRIPT_TTL = 60 * 60_000;
const MAX_BODY = 16 * 1024;

const attr = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

/** The visitor's address as Caddy saw it: the last X-Forwarded-For entry is the one Caddy added. */
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.socket?.remoteAddress || '';
}

export function createAnalytics(env = process.env, { fetchImpl = fetch, log = console } = {}) {
  const websiteId = String(env.UMAMI_WEBSITE_ID || '').trim();
  const enabled = ID_RE.test(websiteId);
  if (websiteId && !enabled) log.warn?.(`UMAMI_WEBSITE_ID is not a Website ID (expected a UUID); analytics stay off`);
  const upstream = String(env.UMAMI_URL || 'http://umami:3000').replace(/\/+$/, '');
  const dashboardUrl = String(env.UMAMI_DASHBOARD_URL || 'https://analytics.meander.me').replace(/\/+$/, '');
  let script = null; // { at, body }

  /** The tags that go just before </head> on a public page. Empty when analytics are off. */
  function headTags(tag) {
    if (!enabled) return '';
    return `<script defer src="/stats/script.js" data-website-id="${attr(websiteId)}" data-host-url="/stats" data-tag="${attr(tag)}" data-do-not-track="true"></script>
  <script defer src="/stats.js?v=1" data-town="${attr(tag)}"></script>
`;
  }

  /** Put the tags into a rendered page. */
  function inject(html, tag) {
    const tags = headTags(tag);
    return tags && html.includes('</head>') ? html.replace('</head>', `  ${tags}</head>`) : html;
  }

  async function getScript() {
    if (script && Date.now() - script.at < SCRIPT_TTL) return script.body;
    try {
      const r = await fetchImpl(`${upstream}/script.js`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`Umami ${r.status}`);
      script = { at: Date.now(), body: Buffer.from(await r.arrayBuffer()) };
    } catch (e) {
      log.warn?.(`analytics script fetch failed: ${e.message}`);
      if (!script) return null;
      script.at = Date.now() - SCRIPT_TTL + 5 * 60_000; // keep the old copy, retry in 5 minutes
    }
    return script.body;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /**
   * Handles /stats/*. Returns { status, headers, body } or null when the path isn't ours.
   * Only events for our own Website ID are passed on.
   */
  async function handle(req, pathname) {
    if (!pathname.startsWith('/stats/')) return null;
    if (!enabled) return { status: 404, headers: {}, body: 'Not found' };
    if (pathname === '/stats/script.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = await getScript();
      if (!body) return { status: 503, headers: { 'Cache-Control': 'no-store' }, body: '' };
      return { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }, body };
    }
    if (pathname === '/stats/api/send' && req.method === 'POST') {
      let raw;
      try { raw = await readBody(req); } catch { return { status: 413, headers: {}, body: 'Too large' }; }
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, headers: {}, body: 'Bad request' }; }
      if (payload?.payload?.website !== websiteId) return { status: 400, headers: {}, body: 'Unknown website' };
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': String(req.headers['user-agent'] || ''),
        // Umami reads the visitor's address from this header before X-Forwarded-For,
        // so visits count per visitor and not all as this server.
        'X-Client-IP': clientIp(req),
      };
      if (req.headers['x-umami-cache']) headers['x-umami-cache'] = String(req.headers['x-umami-cache']);
      if (req.headers['accept-language']) headers['Accept-Language'] = String(req.headers['accept-language']);
      try {
        const r = await fetchImpl(`${upstream}/api/send`, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(5000) });
        return { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'text/plain', 'Cache-Control': 'no-store' }, body: Buffer.from(await r.arrayBuffer()) };
      } catch (e) {
        log.warn?.(`analytics send failed: ${e.message}`);
        return { status: 502, headers: { 'Cache-Control': 'no-store' }, body: '' };
      }
    }
    return { status: 404, headers: {}, body: 'Not found' };
  }

  return { enabled, websiteId, dashboardUrl, headTags, inject, handle };
}
