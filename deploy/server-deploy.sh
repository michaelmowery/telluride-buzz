#!/bin/sh
# Telluride.Buzz deploy, run on the server. Installed once as
# /usr/local/bin/telluride-buzz-deploy and tied to the GitHub deploy key with a
# forced command, so that key can run this script and nothing else.
# It clones the public repo itself; nothing is uploaded from GitHub.
set -eu
REPO=https://github.com/michaelmowery/telluride-buzz
APP=/opt/telluride-buzz

# One deploy at a time; a second push waits its turn.
exec 9>/var/lock/telluride-buzz-deploy.lock
flock -w 600 9

# The only input is the commit GitHub asks for (optional, must be a hex SHA).
WANT=${SSH_ORIGINAL_COMMAND:-}
case "$WANT" in
  *[!0-9a-f]*|'') WANT= ;;
esac
[ ${#WANT} -ge 7 ] && [ ${#WANT} -le 40 ] || WANT=

SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
git clone -q --depth 20 "$REPO" "$SRC"
if [ -n "$WANT" ]; then
  git -C "$SRC" checkout -q "$WANT" 2>/dev/null || echo "Commit $WANT not found yet, deploying latest main."
fi
echo "Deploying $(git -C "$SRC" log -1 --format='%h %s')"

rsync -a --exclude .git --exclude .env --exclude data/ "$SRC"/ "$APP"/
cd "$APP"
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true

# Wait for the container's health check.
for i in $(seq 1 30); do
  s=$(docker inspect -f '{{.State.Health.Status}}' telluride-buzz 2>/dev/null || echo unknown)
  [ "$s" = healthy ] && { echo "Deployed and healthy."; exit 0; }
  sleep 2
done
echo "Container did not report healthy within 60 s (status: $s)." >&2
docker compose logs --tail 40 buzz >&2 || true
exit 1
