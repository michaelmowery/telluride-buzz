// Sample data for local development and screenshots (DEMO=1). Never used in production.
import fs from 'node:fs';
import { buildRoadsTile } from './sources/cdot.js';

// Telluride's highways from OpenStreetMap (simplified), so the demo map draws whole routes.
const DEMO_SHAPES = JSON.parse(fs.readFileSync(new URL('./demo-shapes.json', import.meta.url), 'utf8'));

export function seedDemo(db, town) {
  const now = Date.now();
  const min = 60e3, hr = 3600e3, day = 86400e3;
  db.setTile(town.id, 'weather', {
    ok: true, sourceAt: now - 47 * min, temp: 24, unit: 'F', short: 'Light Snow', wind: '10 mph SW', hi: 29, lo: 12, snow: '3 to 5 inches',
    periods: [
      { name: 'This Afternoon', temp: 29, isDaytime: true, short: 'Light Snow', detail: 'Snow. High near 29. Southwest wind 10 to 15 mph. Chance of precipitation is 90%. New snow accumulation of 2 to 4 inches possible.' },
      { name: 'Tonight', temp: 12, isDaytime: false, short: 'Snow Showers', detail: 'Snow showers, mainly before midnight. Low around 12. Chance of precipitation is 70%. New snow accumulation of 1 to 2 inches possible.' },
      { name: 'Saturday', temp: 27, isDaytime: true, short: 'Mostly Sunny', detail: 'Mostly sunny, with a high near 27. West wind around 5 mph.' },
      { name: 'Saturday Night', temp: 8, isDaytime: false, short: 'Clear', detail: 'Clear, with a low around 8.' },
      { name: 'Sunday', temp: 33, isDaytime: true, short: 'Sunny', detail: 'Sunny, with a high near 33.' },
      { name: 'Sunday Night', temp: 11, isDaytime: false, short: 'Mostly Clear', detail: 'Mostly clear, with a low around 11.' },
      { name: 'Monday', temp: 30, isDaytime: true, short: 'Partly Sunny', detail: 'Partly sunny, with a high near 30.' },
      { name: 'Monday Night', temp: 14, isDaytime: false, short: 'Chance Snow Showers', detail: 'A chance of snow showers after 11pm. Low around 14. Chance of precipitation is 40%. New snow accumulation of less than one inch possible.' },
      { name: 'Tuesday', temp: 25, isDaytime: true, short: 'Snow Likely', detail: 'Snow likely. High near 25. Chance of precipitation is 70%. New snow accumulation of 3 to 7 inches possible.' },
      { name: 'Tuesday Night', temp: 6, isDaytime: false, short: 'Mostly Cloudy', detail: 'Mostly cloudy, with a low around 6.' },
      { name: 'Wednesday', temp: 28, isDaytime: true, short: 'Sunny', detail: 'Sunny, with a high near 28.' },
    ],
    hourly: Array.from({ length: 24 }, (_, i) => ({
      t: Math.floor(now / hr) * hr + (i + 1) * hr, temp: Math.round(24 - 8 * Math.sin(i / 4)),
      short: i < 6 ? 'Light Snow' : i < 10 ? 'Snow Showers' : 'Clear', pop: i < 6 ? 80 : i < 10 ? 50 : 0, wind: '10 mph',
    })),
    link: 'https://forecast.weather.gov/', sourceLabel: 'National Weather Service',
  });

  const incidents = [
    { _route: 'CO-145', _level: 'caution', _at: now - 18 * min, title: 'CO-145: Traction law in effect, Lizard Head Pass', summary: 'All vehicles must have adequate tires or chains between mile markers 56 and 64.',
      _geo: [[[37.8115, -107.9083]]] },
    { _route: 'CO-145', _level: 'ok', title: 'CO-145 work zone: Shoulder work near Ophir, expect brief delays',
      _geo: [[[37.8590, -107.8490], [37.8530, -107.8610], [37.8460, -107.8700]]] },
  ];
  const cdot = (town.sources || []).find((x) => x.adapter === 'cdot')?.settings || town.cdot || { routes: [{ match: ['145'], label: 'CO-145' }], keyPlaces: [] };
  const resort = (() => { const r = (town.sources || []).find((x) => x.adapter === 'snow-report'); return r ? { ...r.settings, label: r.label } : town.lifts; })();
  db.setTile(town.id, 'roads', buildRoadsTile({ ...town, cdot }, {
    incidents,
    conditions: {
      'CO-145': [{ segment: 'Telluride to Placerville', text: 'Wet in areas', level: 'ok', geo: [[[37.9530, -107.8730], [37.9720, -107.9300], [38.0160, -108.0530]]] }],
      'US-550': [{ segment: 'Ridgway to Ouray', text: 'Dry', level: 'ok', geo: [[[38.1520, -107.7560], [38.0900, -107.7200], [38.0230, -107.6720]]] }],
    },
    shapes: town.id === 'telluride' ? DEMO_SHAPES : {},
    okAt: now,
  }));

  db.setTile(town.id, 'lifts', {
    ok: true, sourceAt: now - 5 * hr, overnight: 2, new24: 6, new48: 9, new7d: 14, season: 48, condition: 'Packed powder', base: 31, liftsOpen: 9, liftsTotal: 19, trailsOpen: 42, trailsTotal: 148,
    link: resort?.linkUrl || resort?.url || '#', sourceLabel: resort?.label || 'Ski Resort',
  });

  db.syncItems(town.id, 'nws-alerts', [{
    extId: 'demo-wsw', sourceLabel: 'National Weather Service', category: 'weather', severity: 2,
    title: 'Winter Storm Warning',
    summary: 'Heavy snow expected above 9,000 feet. Total accumulations of 8 to 14 inches. Travel could be very difficult over Lizard Head Pass and Dallas Divide.',
    link: 'https://forecast.weather.gov/', publishedAt: now - 40 * min, expiresAt: now + 20 * hr,
  }]);

  db.syncItems(town.id, 'cdot-incidents', [{
    extId: 'demo-cdot-1', sourceLabel: 'CDOT COtrip', category: 'roads', severity: 1,
    title: 'CO-145: Traction law in effect, Lizard Head Pass (MP 56–64)',
    summary: 'All vehicles must have adequate tires or chains. Expect slow travel.',
    link: 'https://maps.cotrip.org/', publishedAt: now - 12 * min,
  }]);

  db.syncItems(town.id, 'lifts-snow', [{
    extId: 'demo-snow', sourceLabel: resort?.label || 'Ski Resort', category: 'lifts',
    title: '6" of new snow in the last 24 hours', summary: 'Base depth 31".', link: resort?.linkUrl || resort?.url, publishedAt: now - 3 * hr,
  }]);

  db.syncItems(town.id, 'feed-town-news', [
    { extId: 'demo-t1', sourceLabel: 'Town of Telluride', category: 'town', title: 'Gondola winter hours begin Thanksgiving week',
      summary: 'The free gondola runs 6:30 a.m. to midnight starting November 26.', link: 'https://telluride-co.gov/', publishedAt: now - 2 * hr },
    { extId: 'demo-t2', sourceLabel: 'Town of Telluride', category: 'town', title: 'Overnight parking restrictions for snow removal',
      summary: 'No parking on Colorado Ave. between 2 and 6 a.m. on plow nights.', link: 'https://telluride-co.gov/', publishedAt: now - 7 * hr },
  ]);

  db.syncItems(town.id, 'feed-koto', [
    { extId: 'demo-k1', sourceLabel: 'KOTO Radio', category: 'news', title: 'County commissioners approve winter transit expansion',
      summary: 'Galloping Goose adds late-night runs to Lawson Hill.', link: 'https://www.koto.org/', publishedAt: now - 5 * hr },
  ]);

  const evAt = (d, h) => {
    const t = new Date(now + d * day);
    const s = t.toLocaleDateString('en-CA', { timeZone: town.timezone });
    return Date.parse(`${s}T${String(h).padStart(2, '0')}:00:00-07:00`);
  };
  db.syncItems(town.id, 'feed-town-calendar', [
    { extId: 'demo-e1', sourceLabel: 'Town of Telluride', category: 'events', title: 'Town Council regular meeting',
      summary: 'Rebekah Hall', link: 'https://telluride-co.gov/', publishedAt: now - day, startsAt: evAt(1, 9) },
    { extId: 'demo-e2', sourceLabel: 'Town of Telluride', category: 'events', title: 'Opening Day: Lifts spin at 9 a.m.',
      summary: 'Mountain Village Core', link: '#', publishedAt: now - day, startsAt: evAt(2, 9) },
    { extId: 'demo-e3', sourceLabel: 'Town of Telluride', category: 'events', title: 'Holiday tree lighting',
      summary: 'Elks Park', link: '#', publishedAt: now - day, startsAt: evAt(3, 17) },
    { extId: 'demo-e4', sourceLabel: 'Town of Telluride', category: 'events', title: 'Planning and Zoning Commission',
      summary: 'Rebekah Hall', link: '#', publishedAt: now - day, startsAt: evAt(3, 18) },
    { extId: 'demo-e5', sourceLabel: 'Town of Telluride', category: 'events', title: 'Noel Night on Main Street',
      summary: 'Colorado Avenue', link: '#', publishedAt: now - day, startsAt: evAt(9, 0) },
  ]);
}
