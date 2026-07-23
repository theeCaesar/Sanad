#!/usr/bin/env bash
# Deploy and update script. Run from the repository root.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

echo "==> preflight"

if [ ! -f .env ]; then
  echo "error: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

required_vars=(DOMAIN ACME_EMAIL JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_DEVICE_SECRET GRAFANA_PASSWORD)
for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "error: $var is not set in .env" >&2
    exit 1
  fi
done

for var in JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_DEVICE_SECRET; do
  value="${!var}"
  if echo "$value" | grep -qiE 'changeme|secret|dev|test'; then
    echo "error: $var looks like a placeholder value." >&2
    echo "Generate a real one with: openssl rand -base64 48" >&2
    exit 1
  fi
done

echo "Domain: $DOMAIN"

if [ -d .git ]; then
  echo "==> pulling latest"
  git pull --ff-only
fi

echo "==> building images"
$COMPOSE build --pull

echo "==> starting data stores"
$COMPOSE up -d postgres redis kafka
sleep 5

echo "==> running migrations"
$COMPOSE run --rm migrate

echo "==> starting stack"
$COMPOSE up -d

echo "==> waiting for api readiness"
ready=false
for _ in $(seq 1 30); do
  if $COMPOSE exec -T api node -e "require('http').get('http://localhost:4000/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then
    ready=true
    break
  fi
  sleep 3
done

if [ "$ready" != "true" ]; then
  echo "error: api did not become ready in time" >&2
  $COMPOSE ps -a
  echo "--- last 60 lines of api logs ---"
  $COMPOSE logs --tail=60 api
  echo "" >&2
  echo "To roll back: git checkout <previous-commit> && ./deploy/deploy.sh" >&2
  exit 1
fi

echo "==> api is ready"

if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
  echo "https://$DOMAIN/health is reachable"
elif curl -fsS "http://$DOMAIN/health" >/dev/null 2>&1; then
  echo "http://$DOMAIN/health works but https does not yet."
  echo "The certificate is likely still issuing. Check: $COMPOSE logs --tail=40 caddy"
else
  echo "Neither http nor https reached $DOMAIN/health."
  echo "Check DNS propagation: dig +short $DOMAIN"
fi

$COMPOSE ps

cat <<EOF

Deployed.
  Driver app:        https://$DOMAIN/
  Dispatch console:  https://$DOMAIN/dispatch
  Health:            https://$DOMAIN/health
  Grafana:           https://$DOMAIN/grafana/
  Jaeger:            https://$DOMAIN/jaeger/
  Prometheus:        https://$DOMAIN/prometheus/

Conflict scenario:
  curl -X POST https://$DOMAIN/demo/scenario/conflict | jq '.data.outcome'
EOF
