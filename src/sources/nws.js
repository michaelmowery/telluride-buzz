// National Weather Service (api.weather.gov): forecast for the Weather tile, and
// active alerts for the banner and feed. No key needed; NWS asks for a User-Agent.
import { fetchJson } from '../http.js';

const BASE = 'https://api.weather.gov';
const LABEL = 'National Weather Service';

const pointCache = new Map(); // point -> { point, forecast, forecastHourly, at } (one per town)

async function resolvePoint(point, get) {
  const hit = pointCache.get(point);
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit;
  const data = await get(`${BASE}/points/${point}`);
  const p = data.properties || {};
  if (!p.forecast) throw new Error('NWS points lookup returned no forecast URL');
  const entry = { point, forecast: p.forecast, forecastHourly: p.forecastHourly, at: Date.now() };
  pointCache.set(point, entry);
  return entry;
}

export function severityOf(alertProps) {
  switch (alertProps.severity) {
    case 'Extreme': return 3;
    case 'Severe': return 2;
    case 'Moderate': return 1;
    default: return 0;
  }
}

export function alertsToItems(geojson, link = 'https://www.weather.gov/gjt/') {
  return (geojson.features || []).map((f) => {
    const p = f.properties || {};
    const summary = [p.headline && p.headline !== p.event ? p.headline : null, p.description, p.instruction]
      .filter(Boolean).join('\n\n');
    return {
      extId: p.id || f.id,
      sourceLabel: LABEL,
      category: 'weather',
      title: p.event || p.headline || 'Weather alert',
      summary,
      link,
      severity: severityOf(p),
      publishedAt: Date.parse(p.sent || p.effective) || Date.now(),
      expiresAt: Date.parse(p.ends || p.expires) || null,
    };
  });
}

export function forecastToTile(forecast, hourly, town) {
  const periods = forecast?.properties?.periods || [];
  const now = hourly?.properties?.periods?.[0];
  const first = periods[0];
  const pair = periods.slice(0, 2);
  const hi = pair.find((p) => p.isDaytime)?.temperature ?? null;
  const lo = pair.find((p) => !p.isDaytime)?.temperature ?? null;
  const snow = periods.slice(0, 4)
    .map((p) => (p.detailedForecast || '').match(/New snow accumulation of ([^.]+)\./i))
    .find(Boolean);
  const fp = forecast?.properties || {};
  return {
    ok: true,
    sourceAt: Date.parse(fp.updateTime || fp.updated || fp.generatedAt) || null,
    temp: now?.temperature ?? first?.temperature ?? null,
    unit: now?.temperatureUnit || first?.temperatureUnit || 'F',
    short: now?.shortForecast || first?.shortForecast || '',
    wind: now ? `${now.windSpeed || ''} ${now.windDirection || ''}`.trim() : '',
    hi, lo,
    snow: snow ? snow[1].replace(/^around\s+/i, '') : null,
    periods: periods.slice(0, 14).map((p) => ({
      name: p.name, temp: p.temperature, isDaytime: p.isDaytime, short: p.shortForecast,
      detail: p.detailedForecast || '', wind: `${p.windSpeed || ''} ${p.windDirection || ''}`.trim(),
      pop: p.probabilityOfPrecipitation?.value ?? null,
    })),
    hourly: (hourly?.properties?.periods || [])
      .filter((h) => Date.parse(h.endTime) > Date.now()).slice(0, 24)
      .map((h) => ({
        t: Date.parse(h.startTime), temp: h.temperature, short: h.shortForecast,
        pop: h.probabilityOfPrecipitation?.value ?? null, wind: h.windSpeed || '',
      })),
    link: forecastLink(town),
    sourceLabel: LABEL,
  };
}

export function nwsJobs(town, { get = fetchJson } = {}) {
  return [
    {
      id: 'nws-alerts',
      everyMin: 3,
      async run(db) {
        const data = await get(`${BASE}/alerts/active?point=${town.nws.alertPoint || town.nws.point}`);
        db.syncItems(town.id, 'nws-alerts', alertsToItems(data, forecastLink(town)));
      },
    },
    {
      id: 'nws-forecast',
      everyMin: 10,
      async run(db) {
        const pt = await resolvePoint(town.nws.point, get);
        const [forecast, hourly] = await Promise.all([
          get(pt.forecast),
          pt.forecastHourly ? get(pt.forecastHourly).catch(() => null) : null,
        ]);
        db.setTile(town.id, 'weather', forecastToTile(forecast, hourly, town));
      },
    },
  ];
}

function forecastLink(town) {
  return `https://forecast.weather.gov/MapClick.php?lat=${town.location.lat}&lon=${town.location.lon}`;
}
