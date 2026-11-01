#!/usr/bin/env bash
# https-setup.sh -- the site's HTTPS certificate from Let's Encrypt, on the VPS (Debian or Ubuntu).
#
# Run it as root once DNS points the names at this server, and before the full site config is
# installed: nginx refuses a site whose certificate files do not exist yet. In order, it:
#   1. installs nginx, curl and certbot (certbot from snap, the EFF's recommended way, so it
#      stays current; the distribution's package where there is no snap);
#   2. shows where each name points, and warns when ufw leaves port 80 shut;
#   3. makes nginx answer Let's Encrypt's checks over plain HTTP, from WEBROOT. Before the full
#      site is installed that is a small site of its own, which sends everything else to HTTPS.
#      Then it fetches a test file through each name, as Let's Encrypt will;
#   4. asks for one certificate for the domain and its aliases, by the webroot method.
#      STAGING=1, the default, asks Let's Encrypt's staging service: browsers do not trust its
#      certificates, but its limits are far higher, so a mistake costs nothing. Run that first,
#      then STAGING=0 for the real certificate, which takes the test one's place;
#   5. adds the hook that reloads nginx after every renewal (nginx serves a renewed certificate
#      only once it reloads), and proves renewal works with a dry run.
#
# Usage, as root (sudo -i first), from this folder on the VPS:
#   bash https-setup.sh                 a test certificate for havoc9.org and www.havoc9.org
#   STAGING=0 bash https-setup.sh       the real one
# DOMAIN, ALIASES (space separated), EMAIL and WEBROOT change the defaults below.
#
# Then install the full site (havoc9.org/webclient/DEPLOY.txt, section 8), nginx -t, and reload.
set -euo pipefail

DOMAIN="${DOMAIN:-havoc9.org}"
ALIASES="${ALIASES:-www.havoc9.org}"
EMAIL="${EMAIL:-}"                    # optional: the Let's Encrypt account's contact (it sends no expiry mail)
WEBROOT="${WEBROOT:-/var/www/letsencrypt}"
STAGING="${STAGING:-1}"
SKIP_SELFTEST="${SKIP_SELFTEST:-0}"   # 1: ask for the real one even when this server cannot fetch its own test file
ACME_SITE="${DOMAIN}-acme"

say()  { printf '\n== %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it as root: sudo -i, then bash $0"
names=("$DOMAIN"); for a in $ALIASES; do names+=("$a"); done
current="/etc/letsencrypt/live/$DOMAIN/cert.pem"
is_staging_cert() { grep -qi "staging" <<<"$(openssl x509 -in "$current" -noout -issuer 2>/dev/null || true)"; }

say "1. nginx, curl and certbot"
export DEBIAN_FRONTEND=noninteractive
missing=()
for p in nginx curl openssl; do command -v "$p" >/dev/null || missing+=("$p"); done
if [ "${#missing[@]}" -gt 0 ]; then apt-get update -q; apt-get install -y -q "${missing[@]}"; fi
if ! command -v certbot >/dev/null; then
  if command -v snap >/dev/null; then
    snap install --classic certbot
    ln -sf /snap/bin/certbot /usr/bin/certbot
  else
    apt-get update -q; apt-get install -y -q certbot
  fi
fi
certbot --version

say "2. where the names point"
for n in "${names[@]}"; do
  v4="$(getent ahostsv4 "$n" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
  v6="$(getent ahostsv6 "$n" 2>/dev/null | awk '{print $1}' | grep -v '^::ffff:' | sort -u | tr '\n' ' ' || true)"
  printf '  %-24s %s%s\n' "$n" "$v4" "$v6"
  [ -n "$v4$v6" ] || warn "$n does not resolve yet: add its DNS record and give it time to spread"
done
printf '  %-24s %s\n' "this server" "$(hostname -I 2>/dev/null || true)"
echo "  Each name's addresses must be this server's (an AAAA record too: Let's Encrypt may check over IPv6)."
fw="$(command -v ufw >/dev/null && ufw status 2>/dev/null || true)"
if grep -q "Status: active" <<<"$fw" && ! grep "ALLOW" <<<"$fw" | grep -qE "\b80\b|Nginx (Full|HTTP\b)|WWW( Full)?\b"; then
  warn "ufw is on and does not allow port 80: ufw allow 'Nginx Full'"
fi
echo "  Ports 80 and 443 must also be open in the VPS provider's firewall, if it has one."

say "3. Let's Encrypt's checks over plain HTTP"
mkdir -p "$WEBROOT/.well-known/acme-challenge"
loaded="$(nginx -T 2>/dev/null || true)"
dre="$(printf '%s' "$DOMAIN" | sed 's/[.]/[.]/g')"
if grep -q "/.well-known/acme-challenge/" <<<"$loaded"; then
  echo "  nginx answers them already"
elif grep -qE "server_name[^;]*[[:space:]]${dre}[[:space:];]" <<<"$loaded"; then
  die "an nginx site serves $DOMAIN already, but not Let's Encrypt's checks. In its port-80 server block put
       location /.well-known/acme-challenge/ { root $WEBROOT; }
   as DEPLOY.txt section 8 does, then nginx -t, systemctl reload nginx, and run this again."
else
  v6listen=""
  [ -e /proc/net/if_inet6 ] && v6listen="    listen [::]:80;"
  cat > "/etc/nginx/sites-available/$ACME_SITE" <<EOF
# Let's Encrypt's checks over plain HTTP until the full site is installed (https-setup.sh).
# Everything else goes to HTTPS.
server {
    listen 80;
$v6listen
    server_name ${names[*]};
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://$DOMAIN\$request_uri; }
}
EOF
  ln -sf "/etc/nginx/sites-available/$ACME_SITE" "/etc/nginx/sites-enabled/$ACME_SITE"
  echo "  added /etc/nginx/sites-enabled/$ACME_SITE"
fi
nginx -t
systemctl reload nginx || systemctl restart nginx

probe="h9-selftest-$$"
echo "ok" > "$WEBROOT/.well-known/acme-challenge/$probe"
reached=1
for n in "${names[@]}"; do
  got="$(curl -fsS --max-time 10 "http://$n/.well-known/acme-challenge/$probe" 2>/dev/null || true)"
  if [ "$got" = "ok" ]; then
    echo "  http://$n/.well-known/acme-challenge/ answers"
  else
    warn "http://$n/.well-known/acme-challenge/ does not answer from here (DNS, a firewall, or another site?)"
    reached=0
  fi
done
rm -f "$WEBROOT/.well-known/acme-challenge/$probe"
if [ "$reached" = 0 ] && [ "$STAGING" != "1" ] && [ "$SKIP_SELFTEST" != "1" ]; then
  die "no real certificate is asked for while that fails: Let's Encrypt allows 5 failed checks per name an
   hour. Fix it, or try the staging one first. SKIP_SELFTEST=1 asks anyway, for a server that cannot
   reach its own public address."
fi

say "4. the certificate ($([ "$STAGING" = "1" ] && echo "staging: a test one" || echo "the real one"))"
args=(certonly --webroot -w "$WEBROOT" --cert-name "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring)
for n in "${names[@]}"; do args+=(-d "$n"); done
if [ -n "$EMAIL" ]; then args+=(--email "$EMAIL"); else args+=(--register-unsafely-without-email); fi
if [ "$STAGING" = "1" ]; then
  if [ -e "$current" ] && ! is_staging_cert; then
    die "a real certificate for $DOMAIN is here already. The staging run is for before it; certbot renew --dry-run tests renewal."
  fi
  args+=(--test-cert)
elif [ -e "$current" ] && is_staging_cert; then
  echo "  the test certificate goes, and the real one takes its place"
  certbot delete --cert-name "$DOMAIN" --non-interactive
fi
certbot "${args[@]}"
openssl x509 -in "$current" -noout -subject -issuer -enddate -ext subjectAltName

say "5. reload nginx after every renewal, and prove renewal works"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
# certbot runs this after each renewal: nginx serves a renewed certificate once it reloads.
nginx -t && systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
certbot renew --dry-run --cert-name "$DOMAIN"
systemctl list-timers --all 2>/dev/null | grep -i certbot \
  || warn "no certbot timer: look at 'snap services certbot' or 'systemctl status certbot.timer'"

say "done"
if [ "$STAGING" = "1" ]; then
  echo "  The test certificate came through: DNS, port 80 and nginx are right."
  echo "  Now the real one: STAGING=0 bash $0"
else
  echo "  The certificate is in /etc/letsencrypt/live/$DOMAIN/, and renews by itself."
  echo "  Next: bash nginx-setup.sh. It installs the full site (DEPLOY.txt section 8) and takes out"
  echo "  the stand-in port-80 site; the full site's port-80 block answers Let's Encrypt from then on."
fi
