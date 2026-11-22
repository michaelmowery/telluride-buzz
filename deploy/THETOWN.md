# thetown.buzz and yourtown.buzz: one-time server setup

The thetown.buzz home page is served by the same `telluride-buzz` container
(see src/hub.js). yourtown.buzz is a permanent redirect to thetown.buzz,
handled by Caddy alone.

## 1. Porkbun DNS

For **thetown.buzz** (keep the existing `durango` A record):
- Delete the ALIAS record for the bare domain that points to `pixie.porkbun.com` (Porkbun parking).
- Delete the wildcard `*` CNAME to `pixie.porkbun.com`, so unknown subdomains don't land on parking.
- Add: A, host blank (`@`), answer `2.28.70.5`
- Add: A, host `www`, answer `2.28.70.5`

For **yourtown.buzz**: same thing.
- Delete the parking ALIAS and the wildcard `*` CNAME, if present.
- Add: A, host blank, answer `2.28.70.5`
- Add: A, host `www`, answer `2.28.70.5`

## 2. Caddy (/opt/meander.me/infra/Caddyfile)

Add below the existing telluride.buzz / durango.thetown.buzz blocks:

```
thetown.buzz {
	reverse_proxy telluride-buzz:3000
}

www.thetown.buzz, yourtown.buzz, www.yourtown.buzz {
	redir https://thetown.buzz{uri} permanent
}
```

Then reload:

```
cd /opt/meander.me/infra && cp Caddyfile Caddyfile.bak-$(date +%Y%m%d) \
  && docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile \
  && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Caddy gets the HTTPS certificates on the first visit once DNS points at the server
(can take a few minutes after the Porkbun change).

## 3. Check

- https://thetown.buzz shows the home page with both towns.
- https://thetown.buzz/durango goes to https://durango.thetown.buzz
- https://yourtown.buzz/anything goes to https://thetown.buzz/anything
