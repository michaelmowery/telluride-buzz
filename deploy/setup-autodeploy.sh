#!/bin/bash
# One-time setup for automatic deploys. Run on your Mac from the repo folder:
#   bash deploy/setup-autodeploy.sh
# Uses your existing "hetzner" SSH alias. It:
#   1. installs deploy/server-deploy.sh on the server as /usr/local/bin/telluride-buzz-deploy
#   2. makes a new SSH key just for GitHub and allows it on the server ONLY to run
#      that script (forced command + "restrict": no shell, no forwarding, no file copy)
#   3. stores the key and server details as GitHub Actions secrets (with gh), or
#      prints them for you to paste
#   4. runs the first deploy
# The private key never stays on your Mac: it is deleted at the end.
set -euo pipefail
ALIAS=${1:-hetzner}
REPO=michaelmowery/thetownbuzz
cd "$(dirname "$0")/.."

cfg() { ssh -G "$ALIAS" | awk -v k="$1" '$1==k {print $2; exit}'; }
HOST=$(cfg hostname); PORT=$(cfg port); USER_=$(cfg user)
echo "Server: $USER_@$HOST port $PORT (alias $ALIAS)"

ssh "$ALIAS" 'command -v git >/dev/null && command -v rsync >/dev/null && command -v flock >/dev/null && command -v docker >/dev/null' \
  || { echo "The server needs git, rsync, flock and docker. Install the missing one and re-run."; exit 1; }

echo "1/4 Installing the deploy script on the server"
ssh "$ALIAS" 'cat > /tmp/tb-deploy.sh && install -m 755 /tmp/tb-deploy.sh /usr/local/bin/telluride-buzz-deploy && rm /tmp/tb-deploy.sh' < deploy/server-deploy.sh

echo "2/4 Creating a GitHub-only key and allowing it to run just that script"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ssh-keygen -q -t ed25519 -N '' -C "github-actions-telluride-buzz" -f "$TMP/key"
LINE="restrict,command=\"/usr/local/bin/telluride-buzz-deploy\" $(cat "$TMP/key.pub")"
ssh "$ALIAS" "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; sed -i '/github-actions-telluride-buzz\$/d' ~/.ssh/authorized_keys; printf '%s\n' '$LINE' >> ~/.ssh/authorized_keys"
ssh-keyscan -p "$PORT" -t ed25519,ecdsa,rsa "$HOST" 2>/dev/null > "$TMP/known_hosts"
[ -s "$TMP/known_hosts" ] || { echo "Could not read the server's host key."; exit 1; }

echo "3/4 Saving GitHub secrets"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh secret set DEPLOY_KEY -R "$REPO" < "$TMP/key"
  gh secret set DEPLOY_KNOWN_HOSTS -R "$REPO" < "$TMP/known_hosts"
  gh secret set DEPLOY_HOST -R "$REPO" -b "$HOST"
  gh secret set DEPLOY_USER -R "$REPO" -b "$USER_"
  gh secret set DEPLOY_PORT -R "$REPO" -b "$PORT"
  echo "Secrets saved."
else
  echo
  echo "GitHub CLI isn't signed in, so add these by hand at:"
  echo "  https://github.com/$REPO/settings/secrets/actions  (New repository secret)"
  echo "  DEPLOY_HOST = $HOST"
  echo "  DEPLOY_USER = $USER_"
  echo "  DEPLOY_PORT = $PORT"
  echo "  DEPLOY_KNOWN_HOSTS = (copied next)"
  pbcopy < "$TMP/known_hosts"; read -rp "DEPLOY_KNOWN_HOSTS is on your clipboard. Paste it into GitHub, then press Return. "
  pbcopy < "$TMP/key"; read -rp "DEPLOY_KEY is on your clipboard. Paste it into GitHub, then press Return. "
  printf '' | pbcopy
fi

echo "4/4 First deploy (the same thing GitHub will run)"
ssh -i "$TMP/key" -o IdentitiesOnly=yes -o UserKnownHostsFile="$TMP/known_hosts" -p "$PORT" "$USER_@$HOST" deploy
echo
echo "Done. Every push to main now deploys automatically. Runs: https://github.com/$REPO/actions"
