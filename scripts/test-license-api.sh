#!/usr/bin/env bash
# Manual integration checks for the license API.
# Requires:
#   - Dev server running (npm run dev)
#   - DATABASE_URL pointing at a Vercel Postgres / Neon instance with schema applied
#     (psql "$DATABASE_URL" -f scripts/init-db.sql)
#   - ENDSTATE_LICENSE_PRIVATE_KEY, PADDLE_WEBHOOK_SECRET, RESEND_API_KEY set
#
# Usage:
#   BASE=http://localhost:3000 bash scripts/test-license-api.sh

set -euo pipefail

BASE="${BASE:-http://localhost:3000}"

if [[ -z "${PADDLE_WEBHOOK_SECRET:-}" ]]; then
  echo "PADDLE_WEBHOOK_SECRET must be set to sign the webhook"
  exit 1
fi

TXN_ID="txn_test_$(date +%s)"
EMAIL="test+$(date +%s)@example.com"

WEBHOOK_BODY=$(cat <<JSON
{"event_type":"transaction.completed","data":{"id":"$TXN_ID","customer":{"email":"$EMAIL"}}}
JSON
)

TS=$(date +%s)
SIG_INPUT="${TS}:${WEBHOOK_BODY}"
H1=$(printf '%s' "$SIG_INPUT" | openssl dgst -sha256 -hmac "$PADDLE_WEBHOOK_SECRET" -hex | awk '{print $2}')

echo "== 1. webhook creates a license =="
curl -sS -o /dev/stdout -w "\nHTTP %{http_code}\n" \
  -X POST "$BASE/api/license/webhook" \
  -H "Content-Type: application/json" \
  -H "Paddle-Signature: ts=$TS;h1=$H1" \
  --data "$WEBHOOK_BODY"

echo
echo "Check your inbox (or the Resend dashboard) for the license key, then export it as LICENSE_KEY and rerun the activation block below."
echo
cat <<'EOF'
# Fill in LICENSE_KEY, then run the rest:
#
# LICENSE_KEY="<paste from email>"
#
# echo "== 2. activate device 1 =="
# curl -sS -X POST "$BASE/api/license/activate" -H 'Content-Type: application/json' \
#   -d "{\"key\":\"$LICENSE_KEY\",\"fingerprint\":\"fp-1\",\"machine_name\":\"PC-1\"}"
#
# echo "== 3. activate same fingerprint is idempotent =="
# curl -sS -X POST "$BASE/api/license/activate" -H 'Content-Type: application/json' \
#   -d "{\"key\":\"$LICENSE_KEY\",\"fingerprint\":\"fp-1\",\"machine_name\":\"PC-1\"}"
#
# echo "== 4. activate devices 2 and 3 =="
# curl -sS -X POST "$BASE/api/license/activate" -H 'Content-Type: application/json' \
#   -d "{\"key\":\"$LICENSE_KEY\",\"fingerprint\":\"fp-2\",\"machine_name\":\"PC-2\"}"
# curl -sS -X POST "$BASE/api/license/activate" -H 'Content-Type: application/json' \
#   -d "{\"key\":\"$LICENSE_KEY\",\"fingerprint\":\"fp-3\",\"machine_name\":\"PC-3\"}"
#
# echo "== 5. 4th device is rejected with 409 =="
# curl -sS -i -X POST "$BASE/api/license/activate" -H 'Content-Type: application/json' \
#   -d "{\"key\":\"$LICENSE_KEY\",\"fingerprint\":\"fp-4\",\"machine_name\":\"PC-4\"}"
#
# echo "== 6. deactivate device 1, then re-activate a new one =="
# INSTANCE_ID="<from step 2 response>"
# curl -sS -X POST "$BASE/api/license/deactivate" -H 'Content-Type: application/json' \
#   -d "{\"key\":\"$LICENSE_KEY\",\"instance_id\":\"$INSTANCE_ID\"}"
# curl -sS -X POST "$BASE/api/license/activate" -H 'Content-Type: application/json' \
#   -d "{\"key\":\"$LICENSE_KEY\",\"fingerprint\":\"fp-4\",\"machine_name\":\"PC-4\"}"
EOF
