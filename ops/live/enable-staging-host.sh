#!/usr/bin/env bash
# Run ONLY after the DNS A record  staging.trivosolutions.in -> 151.185.58.77  exists and resolves.
# Adds a separate nginx site + Let's Encrypt cert for the staging stack (:8080) so staging stays reachable by name.
set -euo pipefail
H=staging.trivosolutions.in
getent hosts $H >/dev/null || { echo "$H does not resolve yet - add the DNS record first"; exit 1; }
cat > /etc/nginx/sites-available/trivo-staging <<NGX
server {
    server_name $H;
    client_max_body_size 10m;
    server_tokens off;
    location /api/v1/platform { return 404; }
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 120s;
    }
    listen 80;
}
NGX
ln -sfn /etc/nginx/sites-available/trivo-staging /etc/nginx/sites-enabled/trivo-staging
nginx -t && systemctl reload nginx
certbot --nginx -d $H --non-interactive --agree-tos --redirect -m "${CERTBOT_EMAIL:?set CERTBOT_EMAIL}"
curl -s -o /dev/null -w "staging https %{http_code}\n" https://$H/
