#!/usr/bin/env bash

set -euo pipefail

PROM="${PROMETHEUS_URL:-http://prometheus.monitoring:9090}"
WINDOW="${CANARY_WINDOW:-2m}"

MAX_ERROR_RATE="${MAX_ERROR_RATE:-0.01}"
MAX_P95_MS="${MAX_P95_MS:-3000}"
MAX_SYNC_FAIL_RATE="${MAX_SYNC_FAIL_RATE:-0.01}"

q() {
  curl -sf --get "${PROM}/api/v1/query" \
    --data-urlencode "query=$1" \
  | jq -r '.data.result[0].value[1] // "0"'
}

fail() { echo "::error::CANARY FAILED — $1"; exit 1; }

echo "─── canary health, last ${WINDOW} ───"

ERR=$(q "sum(rate(http_request_duration_ms_count{status=~\"5..\",pod=~\"sanad-api-canary.*\"}[${WINDOW}]))
       / clamp_min(sum(rate(http_request_duration_ms_count{pod=~\"sanad-api-canary.*\"}[${WINDOW}])), 1)")
printf "  5xx rate       : %s (max %s)\n" "$ERR" "$MAX_ERROR_RATE"
awk -v a="$ERR" -v b="$MAX_ERROR_RATE" 'BEGIN{exit !(a>b)}' && fail "5xx rate ${ERR} exceeds ${MAX_ERROR_RATE}"

P95=$(q "histogram_quantile(0.95, sum(rate(sync_batch_duration_ms_bucket{pod=~\"sanad-api-canary.*\"}[${WINDOW}])) by (le))")
printf "  sync p95       : %sms (max %sms)\n" "$P95" "$MAX_P95_MS"
awk -v a="$P95" -v b="$MAX_P95_MS" 'BEGIN{exit !(a>b)}' && fail "sync p95 ${P95}ms exceeds ${MAX_P95_MS}ms"

SYNC_FAIL=$(q "sum(rate(sync_errors_total{pod=~\"sanad-api-canary.*\"}[${WINDOW}]))
             / clamp_min(sum(rate(sync_batch_size_count{pod=~\"sanad-api-canary.*\"}[${WINDOW}])), 1)")
printf "  sync fail rate : %s (max %s)\n" "$SYNC_FAIL" "$MAX_SYNC_FAIL_RATE"
awk -v a="$SYNC_FAIL" -v b="$MAX_SYNC_FAIL_RATE" 'BEGIN{exit !(a>b)}' && fail "sync failure rate ${SYNC_FAIL} exceeds ${MAX_SYNC_FAIL_RATE}"

OUTBOX=$(q "max(outbox_oldest_pending_seconds)")
printf "  outbox lag     : %ss (max 60s)\n" "$OUTBOX"
awk -v a="$OUTBOX" 'BEGIN{exit !(a>60)}' && fail "outbox backing up (${OUTBOX}s) — events are written but not flowing"

REQS=$(q "sum(increase(http_request_duration_ms_count{pod=~\"sanad-api-canary.*\"}[${WINDOW}]))")
printf "  requests seen  : %s\n" "$REQS"
awk -v a="$REQS" 'BEGIN{exit !(a<10)}' && fail "canary saw only ${REQS} requests — not enough signal to judge. Refusing to promote on no evidence."

echo "─── canary HEALTHY — promoting ───"
exit 0
