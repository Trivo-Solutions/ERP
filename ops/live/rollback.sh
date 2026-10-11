#!/usr/bin/env bash
# Restore the nginx site saved by cutover.sh (staging back on https://erp.trivosolutions.in). Touches nothing else.
set -uo pipefail
SITE=/etc/nginx/sites-available/trivo; SAVED=$(readlink -f /root/nginx-rollback/latest)
[ -f "$SAVED" ] || { echo "no saved config at /root/nginx-rollback/latest"; exit 1; }
cp -p "$SAVED" "$SITE" && nginx -t && systemctl reload nginx && echo "ROLLED BACK to $SAVED" && curl -s -m 10 -o /dev/null -w "https status %{http_code}\n" https://erp.trivosolutions.in/
