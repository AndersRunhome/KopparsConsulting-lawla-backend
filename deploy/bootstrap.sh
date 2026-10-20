#!/usr/bin/env bash
# Förbereder en ny Ubuntu-server (Hetzner) för Lawla backend. Körs som root:
#   curl -fsSL https://raw.githubusercontent.com/AndersRunhome/KopparsConsulting-lawla-backend/main/deploy/bootstrap.sh | bash
set -euo pipefail
REPO=https://github.com/AndersRunhome/KopparsConsulting-lawla-backend
DIR=/opt/lawla-backend

echo "▶ Systemuppdatering och brandvägg"
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl git ufw unattended-upgrades
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

if ! command -v docker >/dev/null; then
  echo "▶ Docker"
  curl -fsSL https://get.docker.com | sh
fi

echo "▶ Hämtar repot till $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q "$REPO" "$DIR"; fi

cd "$DIR/deploy"
if [ ! -f .env ]; then
  cp .env.hetzner.example .env
  sed -i "s|^JWT_SECRET=$|JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" .env
  echo
  echo "✔ Klart. Fyll i hemligheterna i $DIR/deploy/.env (nano $DIR/deploy/.env), sedan:"
  echo "    cd $DIR/deploy && docker compose -f docker-compose.hetzner.yml up -d --build"
  echo "    curl https://\$API_DOMAIN/health"
else
  echo "▶ .env finns redan – bygger om och startar"
  docker compose -f docker-compose.hetzner.yml up -d --build
fi
