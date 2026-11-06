#!/usr/bin/env bash
# nginx-setup.sh -- the site's nginx on the VPS (Debian or Ubuntu), fresh or not, as
# havoc9.org/webclient/DEPLOY.txt section 8 describes it. Keep the two in step.
#
# Run it as root once DNS points the names at this server. In order, it:
#   1. installs nginx, curl and openssl where missing, and lets ports 80 and 443 through ufw
#      when ufw is on;
#   2. makes sure there is a real certificate: with none yet, it runs https-setup.sh from this
#      folder, a test certificate first and then the real one;
#   3. makes the folders the site is served from: /var/www/<domain> (the site),
#      /var/www/<domain>/downloads/files (the downloads' file index), /srv/h9web/game (the web
#      client's game files) and /var/www/letsencrypt (Let's Encrypt's checks);
#   4. writes /etc/nginx/snippets/<domain>-tls.conf (TLS: TLS 1.2 and 1.3, Mozilla's
#      intermediate ciphers without the DHE ones), /etc/nginx/snippets/<domain>-headers.conf
#      (the security headers every page gets) and /etc/nginx/sites-available/<domain> for the
#      domain and its aliases, and enables it. The site file holds the rate limits in front of
#      h9web and the rules that keep dot files, backups, sources and scripts from visitors (what
#      an Apache site would put in .htaccess: nginx reads no .htaccess). An older site file is
#      kept beside it with the date. http2 is written the way this nginx's version takes it, and
#      the IPv6 lines only where the VPS has IPv6. The stand-in port-80 site https-setup.sh made
#      goes: this site's port-80 block answers Let's Encrypt from now on. If nginx -t refuses
#      it, what was there before is put back;
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
SNIPPETS="/etc/nginx/snippets"
TLS_SNIPPET="$SNIPPETS/$DOMAIN-tls.conf"
HEADERS_SNIPPET="$SNIPPETS/$DOMAIN-headers.conf"
H9WEB="127.0.0.1:8090"
SERVERLIST="127.0.0.1:8081"
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
mkdir -p "$SITE_ROOT" "$SITE_ROOT/downloads/files" "$GAME_ROOT" "$WEBROOT/.well-known/acme-challenge"
[ -e "$SITE_ROOT/index.html" ] || warn "$SITE_ROOT has no index.html yet: copy the site in (DEPLOY.txt section 5)"
[ -n "$(ls -A "$GAME_ROOT" 2>/dev/null)" ] || warn "$GAME_ROOT is empty: the web client's game files go there (DEPLOY.txt section 5)"
# the published downloads and the downloads' file index are for visitors
leftovers="$(find "$SITE_ROOT" -path "$SITE_ROOT/downloads/files" -prune -o \( -name '.*' -o -name '*.bak*' -o -name '*.orig' -o -name '*~' -o -name '*.zip' \) \
  -not -path "$SITE_ROOT" -not -path "$SITE_ROOT/downloads/H9XASH.zip" -not -path "$SITE_ROOT/downloads/H9XASH-linux.zip" -print 2>/dev/null | head -n 5 || true)"
[ -z "$leftovers" ] || warn "the site folder holds files that are not for visitors (nginx answers 404 for them; better removed): $(tr '\n' ' ' <<<"$leftovers")"

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
    server_tokens off;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include snippets/$DOMAIN-tls.conf;
    add_header Strict-Transport-Security \"max-age=31536000\" always;
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
snippet_backup=()
mkdir -p "$SNIPPETS"
for f in "$TLS_SNIPPET" "$HEADERS_SNIPPET"; do
  if [ -e "$f" ]; then cp -p "$f" "$f.bak-setup"; snippet_backup+=("$f"); fi
done

cat > "$TLS_SNIPPET" <<'EOF'
# TLS for the site, written by havoc9.org/deploy/nginx-setup.sh (DEPLOY.txt section 8): TLS 1.2
# and 1.3 only, Mozilla's "intermediate" ciphers without the DHE ones (so no dhparam file is
# needed; every TLS 1.2 client in use has ECDHE). Included by each of the site's 443 blocks.
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ecdh_curve X25519:prime256v1:secp384r1;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_prefer_server_ciphers off;
ssl_session_timeout 1d;
ssl_session_cache shared:H9SSL:10m;
ssl_session_tickets off;
EOF

cat > "$HEADERS_SNIPPET" <<'EOF'
# The security headers of the site's pages and files, written by havoc9.org/deploy/nginx-setup.sh
# (DEPLOY.txt section 8). Included by the server block and by every location that sets a header
# of its own (a location with any add_header drops the server's). h9web's answers under /api/
# carry their own (h9web/lib/http.js), so those locations add Strict-Transport-Security only.
#   Content-Security-Policy here only says who may frame a page and closes <base> and plugins;
#   the forum, admin and account pages carry their full policy in a <meta> tag, and the web
#   client's page allows https: frames for a server's splash MOTD.
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Content-Security-Policy "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" always;
add_header Permissions-Policy "camera=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), display-capture=(), browsing-topics=()" always;
EOF

cat > "$AVAILABLE" <<EOF
# $DOMAIN, written by havoc9.org/deploy/nginx-setup.sh (DEPLOY.txt section 8 explains each
# part). After an edit by hand: nginx -t && systemctl reload nginx

# Rate limits in front of h9web, per client address (h9web keeps its own as well); over one,
# nginx answers 429. Sign-in, sign-up and the password and name forms share a stricter one.
map \$uri \$h9web_auth_limit {
    ~^/api/(?:login|signup|password|account/rename)\$  \$binary_remote_addr;
    default                                           "";
}
limit_req_zone \$binary_remote_addr zone=h9web_api:10m rate=10r/s;
limit_req_zone \$h9web_auth_limit zone=h9web_auth:10m rate=6r/m;

# H9XASH-Updater's own requests, by its X-H9-Updater header and its User-Agent: only those get
# the files under /files/ (DEPLOY.txt section 8). It hides the folder; it is not access control.
map "\$http_x_h9_updater:\$http_user_agent" \$h9_updater {
    ~^1:H9XASH-Updater/  1;
    default              0;
}

server {
$listen80
    server_name $DOMAIN ${aliases[*]};
    server_tokens off;

    # Let's Encrypt's checks, at every renewal
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://$DOMAIN\$request_uri; }
}
$www_block
server {
$ssl_main
    server_name $DOMAIN;
    server_tokens off;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include snippets/$DOMAIN-tls.conf;

    root $SITE_ROOT;
    index index.html;
    include snippets/$DOMAIN-headers.conf;

    # only the methods the site and h9web use; small request bodies unless a location below
    # allows more; slow clients are cut off
    if (\$request_method !~ "^(?:GET|HEAD|POST|PUT|PATCH|DELETE)\$") { return 405; }
    client_max_body_size 16k;
    client_header_timeout 15s;
    client_body_timeout 30s;
    keepalive_timeout 30s;

    # the two published downloads, matched before the archive rule below
    location ~ "^/downloads/H9XASH(-linux)?\.zip\$" { }
    # the downloads' file index (vps/linux/README-VPS.txt step 13 lists what goes in it): a plain
    # listing, and the packages, their reports and the checksums in it. ^~ keeps the rules below
    # away from it, so the ones nested here stand in for them: a dot file, a subfolder or any
    # other kind of file there is a 404
    location ^~ /downloads/files/ {
        autoindex on;
        autoindex_exact_size off;
        location ~ /\. { return 404; }
        location ~* "^/downloads/files/[^/]+\.(?:zip|exe|txt)\$" { }
        location ~ "^/downloads/files/." { return 404; }
    }
    # never for visitors: dot files and folders (.git, .env, .gitattributes), backups, archives,
    # sources, scripts, keys and logs, these notes and the VPS scripts
    location ~ /\.(?!well-known/) { return 404; }
    location ~* (?:\.(?:bak[^/]*|orig|rej|old|save|swp|swo|tmp|zip|7z|rar|tar|tgz|sql|sqlite3?|db-wal|db-shm|log|pem|key|crt|p12|pfx|env|sh|ps1|bat|cmd|py|sma|inc|amxx|patch|diff)|~)\$ { return 404; }
    location = /webclient/DEPLOY.txt { return 404; }
    location ^~ /deploy/ { return 404; }

    # H9XASH-Updater's files (stage-h9xash.ps1 publishes them; tools/updater/README_UPDATER.txt):
    # the manifest, and each file under its SHA-256. Without the updater's header and User-Agent
    # every address there is a 404, so is any other name, and there is no listing. This keeps the
    # folder out of browsers and search engines; it is not access control.
    location = /files/manifest.json {
        if (\$h9_updater = 0) { return 404; }
        include snippets/$DOMAIN-headers.conf;
        add_header Cache-Control "no-cache" always;
        add_header Vary "X-H9-Updater, User-Agent" always;
    }
    location ~ "^/files/[0-9a-f]{64}\$" {
        if (\$h9_updater = 0) { return 404; }
        default_type application/octet-stream;
        include snippets/$DOMAIN-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Vary "X-H9-Updater, User-Agent" always;
    }
    location /files/ { return 404; }

    # the page, the loader and the lists change with every build
    location /webclient/ {
        include snippets/$DOMAIN-headers.conf;
        add_header Cache-Control "no-cache" always;
    }

    location /webclient/engine/ {
        types { application/wasm wasm; text/javascript js; }
        gzip_static on;
        include snippets/$DOMAIN-headers.conf;
        add_header Cache-Control "no-cache" always;
    }

    # each address carries the file's hash (?v=), so a copy may be kept long
    location /webclient/game/ {
        alias $GAME_ROOT/;
        types { application/wasm wasm; }
        default_type application/octet-stream;
        gzip_static on;
        include snippets/$DOMAIN-headers.conf;
        add_header Cache-Control "public, max-age=604800" always;
    }

    # h9web: the accounts API. ^~: the file-name rules above never apply to it (a username
    # may end in .sh)
    location ^~ /api/ {
        proxy_pass http://$H9WEB;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Connection "";
        # a game server's presence report with all 128 slots is up to about 82 KiB
        client_max_body_size 128k;
        proxy_read_timeout 30s;
        limit_req zone=h9web_api burst=60 nodelay;
        limit_req zone=h9web_auth burst=10 nodelay;
        limit_req_status 429;
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
        client_body_timeout 60s;
        proxy_read_timeout 60s;
        limit_req zone=h9web_api burst=20 nodelay;
        limit_req_status 429;
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
        limit_req zone=h9web_api burst=20 nodelay;
        limit_req_status 429;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }

    # the H9 server list (serverlist-bot, the h9-serverlist service), its prefix taken off: the
    # game's Internet tab reads /serverlist/v1/servers/ts (networking.ini's list_bot), pages
    # /serverlist/v1/servers/ts.json, and game servers may POST heartbeats to
    # /serverlist/v1/heartbeat
    location ^~ /serverlist/ {
        proxy_pass http://$SERVERLIST/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Connection "";
        client_max_body_size 4k;
        proxy_read_timeout 15s;
        limit_req zone=h9web_api burst=30 nodelay;
        limit_req_status 429;
        include snippets/$DOMAIN-headers.conf;
        add_header Cache-Control "no-cache" always;
    }
}
EOF

ln -sf "$AVAILABLE" "$ENABLED"
acme_was_on=0
if [ -e "/etc/nginx/sites-enabled/${DOMAIN}-acme" ]; then acme_was_on=1; rm -f "/etc/nginx/sites-enabled/${DOMAIN}-acme"; fi
if ! nginx -t; then
  if [ -n "$backup" ]; then cp -p "$backup" "$AVAILABLE"; else rm -f "$ENABLED" "$AVAILABLE"; fi
  for f in "$TLS_SNIPPET" "$HEADERS_SNIPPET"; do
    if [ -e "$f.bak-setup" ]; then mv -f "$f.bak-setup" "$f"; elif [ -z "$backup" ]; then rm -f "$f"; fi
  done
  [ "$acme_was_on" = 1 ] && ln -sf "/etc/nginx/sites-available/${DOMAIN}-acme" "/etc/nginx/sites-enabled/${DOMAIN}-acme"
  die "nginx -t refused the new site (above); what was there before is back"
fi
for f in "${snippet_backup[@]}"; do rm -f "$f.bak-setup"; done

say "5. reload, and check from outside"
systemctl reload nginx || systemctl restart nginx
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true; }
printf '  %-52s %s  (301 wanted)\n' "http://$DOMAIN/" "$(code "http://$DOMAIN/")"
printf '  %-52s %s  (200 once the site is copied in)\n' "https://$DOMAIN/" "$(code "https://$DOMAIN/")"
printf '  %-52s %s  (404 wanted)\n' "https://$DOMAIN/webclient/DEPLOY.txt" "$(code "https://$DOMAIN/webclient/DEPLOY.txt")"
printf '  %-52s %s  (404 wanted)\n' "https://$DOMAIN/deploy/nginx-setup.sh" "$(code "https://$DOMAIN/deploy/nginx-setup.sh")"
printf '  %-52s %s  (404 wanted)\n' "https://$DOMAIN/.git/config" "$(code "https://$DOMAIN/.git/config")"
printf '  %-52s %s  (404 wanted)\n' "https://$DOMAIN/index.html.bak" "$(code "https://$DOMAIN/index.html.bak")"
printf '  %-52s %s  (404 wanted)\n' "https://$DOMAIN/files/manifest.json" "$(code "https://$DOMAIN/files/manifest.json")"
codeu() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'X-H9-Updater: 1' -A 'H9XASH-Updater/check' "$1" || true; }
printf '  %-52s %s  (200 once files/ is published)\n' "https://$DOMAIN/files/manifest.json, as the updater" "$(codeu "https://$DOMAIN/files/manifest.json")"
printf '  %-52s %s  (200 wanted: the file index)\n' "https://$DOMAIN/downloads/files/" "$(code "https://$DOMAIN/downloads/files/")"
printf '  %-52s %s  (404 wanted)\n' "https://$DOMAIN/downloads/files/.htaccess" "$(code "https://$DOMAIN/downloads/files/.htaccess")"
for n in "${aliases[@]}"; do printf '  %-52s %s  (301 wanted)\n' "https://$n/" "$(code "https://$n/")"; done
head_out="$(curl -sI --max-time 10 "https://$DOMAIN/" || true)"
for h in "Strict-Transport-Security" "X-Content-Type-Options" "Referrer-Policy" "X-Frame-Options" "Content-Security-Policy" "Permissions-Policy"; do
  grep -qi "^$h:" <<<"$head_out" && echo "  $h: sent" || warn "https://$DOMAIN/ does not send $h"
done
if grep -qi '^server: nginx/' <<<"$head_out"; then warn "nginx still names its version (server_tokens): another site's config may set it on"; else echo "  the Server header names no version"; fi
if openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" -tls1_1 -cipher 'DEFAULT:@SECLEVEL=0' </dev/null >/dev/null 2>&1; then
  warn "TLS 1.1 is still accepted on port 443: another site may be the default for 443 with older settings (DEPLOY.txt section 8)"
else
  echo "  a TLS 1.1 handshake is refused, as it should be"
fi
if [ "$(curl -s --max-time 10 "https://$DOMAIN/api/me" || true)" = '{"signedIn":false}' ]; then
  echo "  h9web answers at https://$DOMAIN/api/me"
else
  warn "h9web does not answer at https://$DOMAIN/api/me yet: start it (h9web/README.txt sections 7 and 8)"
fi
if [ "$(code "https://$DOMAIN/serverlist/v1/servers/ts")" = "200" ]; then
  echo "  the server list answers at https://$DOMAIN/serverlist/v1/servers/ts"
else
  warn "the server list does not answer at https://$DOMAIN/serverlist/v1/servers/ts yet: start h9-serverlist (vps/linux/README-VPS.txt)"
fi

say "done"
echo "  nginx serves $DOMAIN from $SITE_ROOT, the game files from $GAME_ROOT, h9web at $H9WEB and the"
echo "  server list at $SERVERLIST (/serverlist/)."
echo "  The certificate renews by itself through the port-80 block."
