#!/usr/bin/env bash
# Point https://erp.trivosolutions.in at the PRODUCTION stack (client :8180, api :3101) instead of staging (:8080/:3001).
# Saves the current nginx site first and rolls back automatically if nginx -t or any post-switch check fails.
# Manual rollback at any time:  /opt/trivo-prod/ops/live/rollback.sh
set -uo pipefail
SITE=/etc/nginx/sites-available/trivo; BK=/root/nginx-rollback; HOST=erp.trivosolutions.in
mkdir -p "$BK"; chmod 700 "$BK"
fail() { echo "CUTOVER FAILED: $1 - rolling back"; /opt/trivo-prod/ops/live/rollback.sh; exit 1; }

for u in http://127.0.0.1:3101/health http://127.0.0.1:8180/; do curl -fsS -m 8 -o /dev/null "$u" || { echo "PRECHECK FAILED: $u not healthy - nothing changed"; exit 2; }; done
[ "$(docker inspect -f '{{.State.Health.Status}}' trivoprod_server)" = healthy ] || { echo "PRECHECK FAILED: prod server not healthy - nothing changed"; exit 2; }
grep -q "127.0.0.1:8080" "$SITE" || { echo "PRECHECK: $SITE does not point at staging :8080 (already switched?) - nothing changed"; exit 2; }

TS=$(date -u +%Y%m%dT%H%M%SZ); cp -p "$SITE" "$BK/trivo.$TS"; ln -sfn "$BK/trivo.$TS" "$BK/latest"; echo "saved current config -> $BK/trivo.$TS"
sed -i -e 's#http://127.0.0.1:8080#http://127.0.0.1:8180#g' -e 's#http://127.0.0.1:3001/health#http://127.0.0.1:3101/health#' "$SITE"
nginx -t 2>&1 || fail "nginx -t"
systemctl reload nginx || fail "reload"
sleep 2
before=$(docker logs trivoprod_server 2>&1 | grep -c "auth/login")
[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://$HOST/)" = 200 ] || fail "SPA over https"
curl -fsS -m 15 https://$HOST/health | grep -q '"status":"ok"' || fail "health over https"
[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST https://$HOST/api/v1/auth/login -H 'content-type: application/json' -d '{"companyCode":"OSSP","identifier":"nobody@example.invalid","password":"not-a-real-password"}')" = 401 ] || fail "login endpoint"
after=$(docker logs trivoprod_server 2>&1 | grep -c "auth/login")
[ "$after" -gt "$before" ] || fail "request did not reach the PRODUCTION api"
[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://$HOST/api/v1/platform/companies)" = 404 ] || fail "platform api exposed"
echo "CUTOVER OK: https://$HOST now served by the production stack (rollback: $BK/latest via rollback.sh)"
