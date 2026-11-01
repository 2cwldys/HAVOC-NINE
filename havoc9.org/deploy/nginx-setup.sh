#!/usr/bin/env bash
# nginx-setup.sh -- the site's nginx on the VPS (Debian or Ubuntu), fresh or not, as
# havoc9.org/webclient/DEPLOY.txt section 8 describes it. Keep the two in step.
#
# Run it as root once DNS points the names at this server. In order, it:
#   1. installs nginx, curl and openssl where missing, and lets ports 80 and 443 through ufw
#      when ufw is on;
#   2. makes sure there is a real certificate: with none yet, it runs https-setup.sh from this
#      folder, a test certificate first and then the real one;
#   3. makes the folders the site is served from: /var/www/<domain> (the site), /srv/h9web/game
#      (the web client's game files) and /var/www/letsencrypt (Let's Encrypt's checks);
#   4. writes /etc/nginx/sites-available/<domain> for the domain and its aliases and enables it.
#      An older one is kept beside it with the date. http2 is written the way this nginx's
#      version takes it, and the IPv6 lines only where the VPS has IPv6. The stand-in port-80
#      site https-setup.sh made goes: this site's port-80 block answers Let's Encrypt from now on.
#      If nginx -t refuses it, what was there before is put back;
#   5. reloads nginx and checks the site from outside.
#
# Usage, as root (sudo -i first), from this folder:
#   bash nginx-setup.sh
# DOMAIN, ALIASES (space separated) and EMAIL change the defaults, as for https-setup.sh.
#
# It does not copy the site or the game files in (DEPLOY.txt section 5) and does not start h9web
# (h9web/README.txt sections 7 and 8): the checks at the end say what is still missing.
set -euo pipefail

DOMAIN="${DOMAIN:-havoc9.org}"
ALIASES="${ALIASES:-www.havoc9.org}"
export DOMAIN ALIASES
SITE_ROOT="/var/www/$DOMAIN"
GAME_ROOT="/srv/h9web/game"
WEBROOT="/var/www/letsencrypt"
AVAILABLE="/etc/nginx/sites-available/$DOMAIN"
ENABLED="/etc/nginx/sites-enabled/$DOMAIN"
H9WEB="127.0.0.1:8090"
HERE="$(cd "$(dirname "$0")" && pwd)"

say()  { printf '\n== %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it as root: sudo -i, then bash $0"
read -r -a aliases <<<"$ALIASES"

say "1. nginx"
export DEBIAN_FRONTEND=noninteractive
missing=()
for p in nginx curl openssl; do command -v "$p" >/dev/null || missing+=("$p"); done
if [ "${#missing[@]}" -gt 0 ]; then apt-get update -q; apt-get install -y -q "${missing[@]}"; fi
nginx -v
fw="$(command -v ufw >/dev/null && ufw status 2>/dev/null || true)"
if grep -q "Status: active" <<<"$fw" && ! grep -q "Nginx Full" <<<"$fw"; then
  ufw allow "Nginx Full" && echo "  ufw: ports 80 and 443 are allowed"
fi

say "2. the certificate"
cert="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
is_real() { [ -e "$cert" ] && ! grep -qi "staging" <<<"$(openssl x509 -in "$cert" -noout -issuer 2>/dev/null || true)"; }
if is_real; then
  echo "  $cert"
else
  [ -f "$HERE/https-setup.sh" ] || die "no real certificate for $DOMAIN, and no https-setup.sh beside this script"
  echo "  none yet: https-setup.sh, a test certificate first, then the real one"
  STAGING=1 bash "$HERE/https-setup.sh"
  STAGING=0 bash "$HERE/https-setup.sh"
  is_real || die "still no real certificate for $DOMAIN"
fi
sans="$(openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null || true)"
for n in "$DOMAIN" "${aliases[@]}"; do
  grep -q "DNS:$n\b" <<<"$sans" || warn "the certificate does not cover $n: run https-setup.sh with ALIASES=\"$ALIASES\""
done

say "3. the folders it serves"
mkdir -p "$SITE_ROOT" "$GAME_ROOT" "$WEBROOT/.well-known/acme-challenge"
[ -e "$SITE_ROOT/index.html" ] || warn "$SITE_ROOT has no index.html yet: copy the site in (DEPLOY.txt section 5)"
[ -n "$(ls -A "$GAME_ROOT" 2>/dev/null)" ] || warn "$GAME_ROOT is empty: the web client's game files go there (DEPLOY.txt section 5)"

say "4. $AVAILABLE"
v6=0; [ -e /proc/net/if_inet6 ] && v6=1
ver="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9][0-9.]*\).*#\1#p')"
new_http2=0
if [ -n "$ver" ] && [ "$(printf '%s\n%s\n' "1.25.1" "$ver" | sort -V | head -n 1)" = "1.25.1" ]; then new_http2=1; fi
echo "  nginx $ver: $([ "$new_http2" = 1 ] && echo "http2 on;" || echo "listen ... ssl http2;"), IPv6 $([ "$v6" = 1 ] && echo "on" || echo "off")"

listen80="    listen 80;"
[ "$v6" = 1 ] && listen80+=$'\n    listen [::]:80;'
if [ "$new_http2" = 1 ]; then
  ssl_listen="    listen 443 ssl;"; [ "$v6" = 1 ] && ssl_listen+=$'\n    listen [::]:443 ssl;'
  ssl_main="$ssl_listen"$'\n    http2 on;'
else
  ssl_listen="    listen 443 ssl http2;"; [ "$v6" = 1 ] && ssl_listen+=$'\n    listen [::]:443 ssl http2;'
  ssl_main="$ssl_listen"
fi
origin_re="$(printf '%s|' "$DOMAIN" "${aliases[@]}" | sed 's/|$//; s/[.]/\\./g')"

www_block=""
if [ "${#aliases[@]}" -gt 0 ]; then
  www_block="
server {
$ssl_listen
    server_name ${aliases[*]};
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    return 301 https://$DOMAIN\$request_uri;
}
"
fi

backup=""
if [ -e "$AVAILABLE" ]; then
  backup="$AVAILABLE.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$AVAILABLE" "$backup"
  echo "  the old one: $backup"
fi

cat > "$AVAILABLE" <<EOF
# $DOMAIN, written by havoc9.org/deploy/nginx-setup.sh (DEPLOY.txt section 8 explains each
# part). After an edit by hand: nginx -t && systemctl reload nginx

server {
$listen80
    server_name $DOMAIN ${aliases[*]};

    # Let's Encrypt's checks, at every renewal
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://$DOMAIN\$request_uri; }
}
$www_block
server {
$ssl_main
    server_name $DOMAIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    root $SITE_ROOT;
    index index.html;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # backups, archives, the notes and the VPS scripts are not for visitors
    location ~ \.(bak[^/]*|zip)\$ { return 404; }
    location = /webclient/DEPLOY.txt { return 404; }
    location ^~ /deploy/ { return 404; }

    # the page, the loader and the lists change with every build
    location /webclient/ {
        add_header Cache-Control "no-cache" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }

    location /webclient/engine/ {
        types { application/wasm wasm; text/javascript js; }
        gzip_static on;
        add_header Cache-Control "no-cache" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }

    # each address carries the file's hash (?v=), so a copy may be kept long
    location /webclient/game/ {
        alias $GAME_ROOT/;
        types { application/wasm wasm; }
        default_type application/octet-stream;
        gzip_static on;
        add_header Cache-Control "public, max-age=604800" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }

    # h9web: the accounts API
    location /api/ {
        proxy_pass http://$H9WEB;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Connection "";
        client_max_body_size 64k;
        proxy_read_timeout 30s;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }

    # h9web: a profile picture, up to 10 MB
    location = /api/forum/avatar {
        proxy_pass http://$H9WEB;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Connection "";
        client_max_body_size 11m;
        proxy_read_timeout 60s;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }

    # h9web's relay: the same service and port, the path passed as it is
    location = /webclient/relay {
        if (\$http_origin !~* "^https://($origin_re)\$") { return 403; }
        proxy_pass http://$H9WEB;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
        client_max_body_size 1k;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }
}
EOF

ln -sf "$AVAILABLE" "$ENABLED"
acme_was_on=0
if [ -e "/etc/nginx/sites-enabled/${DOMAIN}-acme" ]; then acme_was_on=1; rm -f "/etc/nginx/sites-enabled/${DOMAIN}-acme"; fi
if ! nginx -t; then
  if [ -n "$backup" ]; then cp -p "$backup" "$AVAILABLE"; else rm -f "$ENABLED" "$AVAILABLE"; fi
  [ "$acme_was_on" = 1 ] && ln -sf "/etc/nginx/sites-available/${DOMAIN}-acme" "/etc/nginx/sites-enabled/${DOMAIN}-acme"
  die "nginx -t refused the new site (above); what was there before is back"
fi

say "5. reload, and check from outside"
systemctl reload nginx || systemctl restart nginx
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true; }
printf '  %-52s %s  (301 wanted)\n' "http://$DOMAIN/" "$(code "http://$DOMAIN/")"
printf '  %-52s %s  (200 once the site is copied in)\n' "https://$DOMAIN/" "$(code "https://$DOMAIN/")"
printf '  %-52s %s  (404 wanted)\n' "https://$DOMAIN/webclient/DEPLOY.txt" "$(code "https://$DOMAIN/webclient/DEPLOY.txt")"
printf '  %-52s %s  (404 wanted)\n' "https://$DOMAIN/deploy/nginx-setup.sh" "$(code "https://$DOMAIN/deploy/nginx-setup.sh")"
for n in "${aliases[@]}"; do printf '  %-52s %s  (301 wanted)\n' "https://$n/" "$(code "https://$n/")"; done
if [ "$(curl -s --max-time 10 "https://$DOMAIN/api/me" || true)" = '{"signedIn":false}' ]; then
  echo "  h9web answers at https://$DOMAIN/api/me"
else
  warn "h9web does not answer at https://$DOMAIN/api/me yet: start it (h9web/README.txt sections 7 and 8)"
fi

say "done"
echo "  nginx serves $DOMAIN from $SITE_ROOT, the game files from $GAME_ROOT, and h9web at $H9WEB."
echo "  The certificate renews by itself through the port-80 block."
