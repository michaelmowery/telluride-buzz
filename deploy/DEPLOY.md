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

## Backups

- In-app: nightly SQLite copy in `/opt/telluride-buzz/data/backups/` (7 days).
- Off-box (still to decide): turn on Hetzner Backups for the server (daily, 7 kept,
  about 20% of the server price), or copy `data/backups/` nightly to Ajax or Palmyra.
  The database only holds re-fetchable feed data, so losing it costs history, not content.

## Roll back / remove

```sh
docker compose down                 # stops the app; Caddy and other sites unaffected
# remove the Caddy block and reload Caddy to take the hostname offline
```
