# Telluride.Buzz

The real-time pulse of Telluride: what's happening in our town, right now, from sources you can trust.

A mobile-first web app (installable PWA) with an alert banner, four at-a-glance tiles
(Weather, Roads, Lifts & Snow, Events) and a live feed where every post carries its
source and a link. One Node process ingests the feeds on a schedule into SQLite and
serves the app. No npm dependencies.

## Run locally

Requires Node 22.13+ (Node 24 recommended).

```sh
npm run dev      # DEMO=1: sample data, no network, http://localhost:3000
npm start        # real feeds; set CDOT_API_KEY for roads
npm test
```

`/api/health` lists every source with its last success and last error.

## How it works

| Tile / area | Source | Job | Every |
|---|---|---|---|
| Weather tile | NWS api.weather.gov forecast + hourly | `nws-forecast` | 10 min |
| Alert banner + feed | NWS active alerts for Telluride | `nws-alerts` | 3 min |
| Roads tile + feed | CDOT COtrip incidents, road conditions, WZDx work zones | `cdot-*` | 5 min |
| Lifts & Snow tile | Telluride Ski Resort snow report page (parsed) | `lifts-snow` | 15 min |
| Events tile + feed | Town of Telluride calendar RSS | `feed-town-calendar` | 60 min |
| Feed | Town and county news, county alerts, KOTO | `feed-*` | 5 to 15 min |

- Everything lands in one `items` table (town, source, category, title, link, severity, time).
  Severity 2+ shows in the banner. Tiles are stored in `tiles`.
- Each job runs independently with backoff; a failing source never blocks the others,
  and tiles show when their data was last updated (red "as of" when stale).
- Roads never shows a green "no issues" without fresh CDOT data, and always shows
  CDOT's Source Data disclaimer (`cdot.disclaimer` in the town config).
- Towns and their sources live in the database (`towns`, `sources` tables) and are
  managed in the admin at `/admin` (needs `ADMIN_PASSWORD` in `.env`). Each source is a
  row naming a shared adapter in `src/adapters.js` (RSS, iCal, NWS alerts/forecast,
  CDOT, snow report page, resort alerts JSON, Meander). Adding a town needs no code
  change or deploy. The app picks the town by hostname.
- `config/*.json` is only an import format: on first start each file is imported once,
  after which the database wins. The admin can export a town back to the same format.
- The source health board is at `/admin#health` (red = failing over an hour).
- Nightly, the app writes a consistent copy of the database to `data/backups/`
  (7 days kept).

## Deploy (Hetzner, behind the existing Caddy)

See [deploy/DEPLOY.md](deploy/DEPLOY.md).

## Analytics

Visit counts go to the self-hosted Umami on the same server (no cookies, honors Do Not Track).
Set `UMAMI_WEBSITE_ID` in `.env` to turn them on (see `src/analytics.js`). Pages load Umami's
script from their own address at `/stats/script.js` and report to `/stats/api/send`, which the
app passes to Umami with the visitor's address. One Umami website covers every town: filter by
hostname, or by the tag (the town id; `hub` for thetown.buzz). Custom events, each with `town`:
`tab`, `feed-click` (source), `listing-click` and `sponsored-click` (business, action),
`suggest-click`, `feedback-click`, `town-switch`, `alerts-on`, `alerts-off`.
