// Sample data for local development and screenshots (DEMO=1). Never used in production.
import { buildRoadsTile } from './sources/cdot.js';

export function seedDemo(db, town) {
  const now = Date.now();
  const min = 60e3, hr = 3600e3, day = 86400e3;
  db.setTile(town.id, 'weather', {
    ok: true, temp: 24, unit: 'F', short: 'Light Snow', wind: '10 mph SW', hi: 29, lo: 12, snow: '3 to 5 inches',
    periods: [
      { name: 'This Afternoon', temp: 29, isDaytime: true, short: 'Light Snow' },
      { name: 'Tonight', temp: 12, isDaytime: false, short: 'Snow Showers' },
      { name: 'Saturday', temp: 27, isDaytime: true, short: 'Mostly Sunny' },
      { name: 'Saturday Night', temp: 8, isDaytime: false, short: 'Clear' },
    ],
    link: 'https://forecast.weather.gov/', sourceLabel: 'National Weather Service',
  });

  const incidents = [
    { _route: 'CO-145', _level: 'caution', title: 'CO-145: Traction law in effect, Lizard Head Pass' },
  ];
  db.setTile(town.id, 'roads', buildRoadsTile(town, {
    incidents,
    conditions: { 'CO-62': [{ text: 'Snow packed, icy spots', level: 'caution' }], 'US-550': [{ text: 'Dry', level: 'ok' }] },
  }));

  db.setTile(town.id, 'lifts', {
    ok: true, new24: 6, new48: 9, base: 31, liftsOpen: 9, liftsTotal: 19, trailsOpen: 42, trailsTotal: 148,
    link: town.lifts?.linkUrl || '#', sourceLabel: town.lifts?.label || 'Ski Resort',
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
    extId: 'demo-snow', sourceLabel: town.lifts?.label || 'Ski Resort', category: 'lifts',
    title: '6" of new snow in the last 24 hours', summary: 'Base depth 31".', link: town.lifts?.linkUrl, publishedAt: now - 3 * hr,
  }]);

  db.syncItems(town.id, 'feed-town-news', [
    { extId: 'demo-t1', sourceLabel: 'Town of Telluride', category: 'town', title: 'Gondola winter hours begin Thanksgiving week',
      summary: 'The free gondola runs 6:30 a.m. to midnight starting November 26.', link: 'https://www.telluride-co.gov/', publishedAt: now - 2 * hr },
    { extId: 'demo-t2', sourceLabel: 'Town of Telluride', category: 'town', title: 'Overnight parking restrictions for snow removal',
      summary: 'No parking on Colorado Ave. between 2 and 6 a.m. on plow nights.', link: 'https://www.telluride-co.gov/', publishedAt: now - 7 * hr },
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
      summary: 'Rebekah Hall', link: 'https://www.telluride-co.gov/', publishedAt: now - day, startsAt: evAt(1, 9) },
    { extId: 'demo-e2', sourceLabel: 'Town of Telluride', category: 'events', title: 'Opening Day: Lifts spin at 9 a.m.',
      summary: 'Mountain Village Core', link: '#', publishedAt: now - day, startsAt: evAt(2, 9) },
    { extId: 'demo-e3', sourceLabel: 'Town of Telluride', category: 'events', title: 'Holiday tree lighting',
      summary: 'Elks Park', link: '#', publishedAt: now - day, startsAt: evAt(3, 17) },
  ]);
}
