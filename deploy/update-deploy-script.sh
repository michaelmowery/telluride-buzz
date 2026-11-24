#!/bin/bash
# Reinstall deploy/server-deploy.sh on the server after it changes, without
# touching the deploy key or GitHub secrets. Run on your Mac from the repo folder:
#   bash deploy/update-deploy-script.sh
# Uses your "hetzner" SSH alias (or pass another one).
set -euo pipefail
ALIAS=${1:-hetzner}
cd "$(dirname "$0")/.."
ssh "$ALIAS" 'cat > /tmp/tb-deploy.sh && install -m 755 /tmp/tb-deploy.sh /usr/local/bin/telluride-buzz-deploy && rm /tmp/tb-deploy.sh' < deploy/server-deploy.sh
echo "Deploy script updated. The next push to main (or Actions > Deploy > Run workflow) uses it."
