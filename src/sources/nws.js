// National Weather Service (api.weather.gov): forecast for the Weather tile, and
// active alerts for the banner and feed. No key needed; NWS asks for a User-Agent.
import { fetchJson } from '../http.js';

const BASE = 'https://api.weather.gov';
const LABEL = 'National Weather Service';

let pointCache = null; // { point, forecast, forecastHourly, at }

async function resolvePoint(point, get) {
  if (pointCache && pointCache.point === point && Date.now() - pointCache.at < 24 * 3600e3) return pointCache;
  const data = await get(`${BASE}/points/${point}`);
  const p = data.properties || {};
  if (!p.forecast) throw new Error('NWS points lookup returned no forecast URL');
  pointCache = { point, forecast: p.forecast, forecastHourly: p.forecastHourly, at: Date.now() };
  return pointCache;
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
  return {
    ok: true,
    temp: now?.temperature ?? first?.temperature ?? null,
    unit: now?.temperatureUnit || first?.temperatureUnit || 'F',
    short: now?.shortForecast || first?.shortForecast || '',
    wind: now ? `${now.windSpeed || ''} ${now.windDirection || ''}`.trim() : '',
    hi, lo,
    snow: snow ? snow[1].replace(/^around\s+/i, '') : null,
    periods: periods.slice(0, 4).map((p) => ({
      name: p.name, temp: p.temperature, isDaytime: p.isDaytime, short: p.shortForecast,
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
