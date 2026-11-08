#!/usr/bin/env bash
# Puts nginx behind Cloudflare safely: the visitor's address comes from CF-Connecting-IP, believed ONLY when the connection really
# comes from one of Cloudflare's published ranges, so h9web's rule ("nginx sets X-Real-IP to the visitor") stays true and the
# per-address limits keep working. Without it every visitor would share one address, Cloudflare's, behind the proxy.
#
#   sudo bash cloudflare-realip.sh            write /etc/nginx/conf.d/cloudflare-realip.conf from Cloudflare's lists, test, reload
#   sudo bash cloudflare-realip.sh --ufw      the same, and let ports 80 and 443 in from those ranges only (the origin then
#                                             cannot be reached directly); SSH and the game's UDP ports are not touched
#   sudo bash cloudflare-realip.sh --undo     remove the file again (and, with --ufw, put "Nginx Full" back)
#
# Run it again now and then (a cron entry or systemd timer once a week): the ranges change rarely. The game servers' UDP traffic
# does not go through Cloudflare: give them a DNS-only (grey cloud) name, or put the address itself in servers.txt.
set -euo pipefail

CONF=/etc/nginx/conf.d/cloudflare-realip.conf
UFW=0; UNDO=0
for a in "$@"; do
  case "$a" in
    --ufw) UFW=1 ;;
    --undo) UNDO=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

if [ "$UNDO" = 1 ]; then
  rm -f "$CONF"
  nginx -t && systemctl reload nginx
  if [ "$UFW" = 1 ] && command -v ufw >/dev/null; then
    ufw status numbered | grep -F "# cloudflare" | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn | while read -r n; do yes | ufw delete "$n" >/dev/null; done
    ufw allow "Nginx Full" >/dev/null
  fi
  echo "removed"; exit 0
fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsS --max-time 30 https://www.cloudflare.com/ips-v4 -o "$tmp/v4"
curl -fsS --max-time 30 https://www.cloudflare.com/ips-v6 -o "$tmp/v6"
# only well-formed CIDRs go into the config (a changed or hijacked answer must not become nginx syntax)
grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' "$tmp/v4" > "$tmp/v4.ok" || true
grep -E '^[0-9a-fA-F:]+/[0-9]{1,3}$' "$tmp/v6" > "$tmp/v6.ok" || true
n4=$(wc -l < "$tmp/v4.ok"); n6=$(wc -l < "$tmp/v6.ok")
[ "$n4" -ge 5 ] && [ "$n6" -ge 3 ] || { echo "Cloudflare's lists look wrong ($n4 IPv4, $n6 IPv6 ranges): nothing changed" >&2; exit 1; }

{
  echo "# written by cloudflare-realip.sh: Cloudflare's published ranges (https://www.cloudflare.com/ips/)"
  cat "$tmp/v4.ok" "$tmp/v6.ok" | sed 's/^/set_real_ip_from /; s/$/;/'
  echo "real_ip_header CF-Connecting-IP;"
  echo "real_ip_recursive off;"
} > "$tmp/conf"
install -m 0644 "$tmp/conf" "$CONF"
nginx -t
systemctl reload nginx
echo "nginx now takes the visitor's address from CF-Connecting-IP for connections from $n4 IPv4 and $n6 IPv6 Cloudflare ranges"

if [ "$UFW" = 1 ]; then
  command -v ufw >/dev/null || { echo "ufw is not installed" >&2; exit 1; }
  ufw status numbered | grep -F "# cloudflare" | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn | while read -r n; do yes | ufw delete "$n" >/dev/null; done
  cat "$tmp/v4.ok" "$tmp/v6.ok" | while read -r range; do
    ufw allow from "$range" to any port 80,443 proto tcp comment "# cloudflare" >/dev/null
  done
  ufw delete allow "Nginx Full" >/dev/null 2>&1 || true
  echo "ports 80 and 443 now accept only Cloudflare's ranges"
fi
