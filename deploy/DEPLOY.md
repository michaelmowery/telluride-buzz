# Deploying to the Hetzner server

The app runs as one container (`telluride-buzz`) on Caddy's Docker network
(`infra_default`). It publishes no ports; Caddy proxies to it. Memory is capped at
256 MB (it idles around 25 to 80 MB).

## First deploy

```sh
# 1. Code
sudo mkdir -p /opt/telluride-buzz && sudo chown $USER /opt/telluride-buzz
git clone https://github.com/<owner>/telluride-buzz.git /opt/telluride-buzz
cd /opt/telluride-buzz

# 2. Secrets: the CDOT key goes here and nowhere else
cp .env.example .env && chmod 600 .env
nano .env            # paste CDOT_API_KEY=..., set a contact in USER_AGENT

# 3. Data folder owned by the container's user (uid 1000)
mkdir -p data && sudo chown 1000:1000 data

# 4. Build and start
docker compose up -d --build
docker compose logs -f --tail=50

# 5. Caddy: add the block from deploy/Caddyfile.snippet to
#    /opt/meander.me/infra/Caddyfile, then reload
cd /opt/meander.me/infra && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Check: `curl -s https://<host>/api/health` should list sources with `"ok": true`.
On first CDOT success, raw samples are written to `data/samples/` to tune parsing.

## Update

```sh
cd /opt/telluride-buzz && git pull && docker compose up -d --build
```

## Push alerts

- Phones sign up with the "Turn on alerts" button. On iPhone, Buzz must be added to the
  Home Screen first (iOS 16.4+).
- New banner-level alerts (NWS warnings, CDOT closures, county emergencies) are pushed
  once each. Alerts older than 2 hours are never pushed, so restarts don't re-send.
- Signing keys live in `data/vapid.json` (created on first start). Keep it: if it is
  lost, every phone has to turn alerts on again.
- Send a test notification to every subscribed device:
  `docker compose exec buzz node --experimental-sqlite --no-warnings src/push-test.js "Test" "Hello from Buzz"`

## Backups

- In-app: nightly SQLite copy in `/opt/telluride-buzz/data/backups/` (7 days). Back up `data/vapid.json` too.
- Off-box (still to decide): turn on Hetzner Backups for the server (daily, 7 kept,
  about 20% of the server price), or copy `data/backups/` nightly to Ajax or Palmyra.
  The database only holds re-fetchable feed data, so losing it costs history, not content.

## Roll back / remove

```sh
docker compose down                 # stops the app; Caddy and other sites unaffected
# remove the Caddy block and reload Caddy to take the hostname offline
```

## Automatic deploys (GitHub Actions)

Every push to `main` runs the tests and then redeploys. One-time setup, on the Mac, from a fresh clone:

```
bash deploy/setup-autodeploy.sh
```

It installs `deploy/server-deploy.sh` as `/usr/local/bin/telluride-buzz-deploy`, adds a GitHub-only SSH key that can run only that script (`restrict,command=...` in authorized_keys), saves the `DEPLOY_*` secrets in the repo, and runs the first deploy. To revoke: delete the `github-actions-telluride-buzz` line from the server's `~/.ssh/authorized_keys`. If you change `server-deploy.sh`, reinstall just the script with `bash deploy/update-deploy-script.sh` (no new key or secrets).

## Adding a town (example: durango.thetown.buzz)

1. Add `config/<town>.json` with its hostnames, sources and `brand` block, and push to main (auto-deploys).
2. DNS: an A record for the town's hostname pointing at the server (for thetown.buzz at Porkbun: host `durango`, A, 2.28.70.5).
3. Caddy: add a block for the hostname that proxies to `telluride-buzz:3000` (see `Caddyfile.snippet`), then reload Caddy. Caddy gets the certificate on the first request.
4. Check `https://<hostname>/api/health` for each source's status.
