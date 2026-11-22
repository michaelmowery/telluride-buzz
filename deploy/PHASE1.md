# Phase 1 (towns in the database): server steps

Nothing here is needed for the existing towns to keep working. The first start of the
new version imports `config/telluride.json` and `config/durango.json` into the database
with the same source names, so posts, tiles and push subscriptions carry over.

## 1. Turn on the admin (required to use it)

On the server, add a password of at least 10 characters to `/opt/telluride-buzz/.env`:

```
ADMIN_PASSWORD=pick-a-long-passphrase
```

Then restart the container so it reads the new value:

```
cd /opt/telluride-buzz && docker compose up -d
```

Sign in at https://telluride.buzz/admin (works on any town's address). Without the
password set, /admin answers "Not found".

## 2. Wildcard subdomains (optional, one time)

Without this, every new town still needs a DNS record and a Caddy block, as Durango did.
With it, a town added in the admin at `<name>.thetown.buzz` works within a minute of
its first visit, and Caddy only issues certificates for addresses that belong to a town
in the database (it asks the app at `/api/tls-ask` first).

**Porkbun DNS for thetown.buzz:** add A record, host `*`, answer `2.28.70.5`. (The
existing `durango`, `@` and `www` records stay.)

**Caddy** (`/opt/meander.me/infra/Caddyfile`): add to the global options block at the
very top (create one if there is none; keep anything already in it):

```
{
	on_demand_tls {
		ask http://telluride-buzz:3000/api/tls-ask
	}
}
```

and add this site block (the explicit `durango.thetown.buzz` and `thetown.buzz` blocks
can stay; specific blocks win over the wildcard):

```
*.thetown.buzz {
	tls {
		on_demand
	}
	encode zstd gzip
	reverse_proxy telluride-buzz:3000
}
```

Validate and reload:

```
cd /opt/meander.me/infra && cp Caddyfile Caddyfile.bak-$(date +%Y%m%d) \
  && docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile \
  && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

A town with its own domain (like telluride.buzz) still needs its own DNS record and
Caddy block.

## Adding a town (no code change)

1. /admin → Towns → Add a town: name, address name (e.g. `ouray`), map point. It starts
   as a draft with NWS alerts and forecast already added.
2. Add sources: CDOT with the town's highways, a snow report per nearby resort, town and
   county RSS, the local paper, an events calendar (RSS or .ics). Press Test on each to
   see the posts it would show before saving.
3. Watch the health board turn green, open the town's address, then set Status to Live.
   Live towns appear in the town picker and on thetown.buzz.

Changes take effect immediately; no restart or deploy. "Download town as JSON" on the
town page is a backup in the same format as `config/*.json`.

## Rolling back

The new tables are additive. Deploying the previous version keeps working: it reads
`config/*.json` again and ignores the new tables. Towns added in the admin would not
appear until the new version is back.
