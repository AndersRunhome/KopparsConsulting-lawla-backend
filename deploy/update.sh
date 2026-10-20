#!/usr/bin/env bash
# Uppdaterar till senaste main och startar om API:t. Kör på servern: /opt/lawla-backend/deploy/update.sh
set -euo pipefail
cd /opt/lawla-backend && git pull -q && cd deploy && docker compose -f docker-compose.hetzner.yml up -d --build && docker image prune -f >/dev/null
echo "✔ Uppdaterat: $(git -C /opt/lawla-backend log -1 --format='%h %s')"
