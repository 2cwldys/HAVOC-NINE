#!/usr/bin/env bash
# setup.sh -- havoc9.org on this VPS (Debian 12 or later, Ubuntu 22.04 or later): h9web (the
# accounts, the forum, the relay), the site, the H9 server list, nginx with Let's Encrypt, the
# firewall, the backups. README-VPS.txt beside it is the guide.
#
# Run it as root from the unpacked package (or from vps/linux/ in a clone of the repository). It is
# safe to run again, and running it again is how a new package is put in: it brings the code,
# the site and the units up to date, takes a backup before it touches a running h9web, and
# never overwrites a setting, a key or any data.
#
#   sudo bash setup.sh                    install or update everything, and start it
#   sudo bash setup.sh --no-tls           everything but nginx and the certificate (run it
#                                         again once DNS points the domain here)
#   sudo bash setup.sh --restore FILE [--keys DIR] [--passphrase-file FILE]
#                                         the same, with FILE (an .h9backup) restored before
#                                         h9web starts; DIR holds secrets.json and data.key
#                                         unless the backup was made --with-keys
#   sudo bash setup.sh --check            only show what is installed and running
#
# DOMAIN (havoc9.org), ALIASES ("www.havoc9.org") and EMAIL go to the certificate and nginx
# scripts in havoc9.org/deploy/. GAME_PORTS ("27015/udp", space separated ufw rules) are the game
# servers' ports this VPS opens; without it, H9XASH_DIR (the H9XASH folder a game server here runs
# from) gives the port its networking.ini names (port= under [server], the one its launchers use),
# and 27015 stands for the rest. UFW=0 leaves the firewall alone; HARDEN_SSH=0 leaves SSH alone.
set -euo pipefail

DOMAIN="${DOMAIN:-havoc9.org}"
ALIASES="${ALIASES:-www.havoc9.org}"
EMAIL="${EMAIL:-}"
if [ -z "${GAME_PORTS:-}" ]; then
  # networking.ini's port= under [server], read as the launchers read it: 1 to 65535, else 27015
  game_port=27015
  if [ -n "${H9XASH_DIR:-}" ] && [ -f "$H9XASH_DIR/networking.ini" ]; then
    p="$(tr -d '\r' < "$H9XASH_DIR/networking.ini" | awk -F= '/^[ \t]*\[/ { s = tolower($0); gsub(/[ \t]/, "", s) }
      s == "[server]" && tolower($1) ~ /^[ \t]*port[ \t]*$/ { v = $2; gsub(/[ \t]/, "", v); print v }' | tail -n 1)"
    if [[ "$p" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$p" -le 65535 ]; then game_port="$p"; fi
  fi
  GAME_PORTS="$game_port/udp"
fi
UFW="${UFW:-1}"
HARDEN_SSH="${HARDEN_SSH:-1}"
export DOMAIN ALIASES EMAIL

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# the package's own folder, or the root of a clone (setup.sh in vps/linux/)
SRC="$HERE"
[ -d "$SRC/h9web" ] || SRC="$(cd "$HERE/../.." && pwd)"

H9WEB_HOME=/opt/h9web
H9WEB_ETC=/etc/h9web
H9WEB_DATA=/var/lib/h9web
LIST_HOME=/opt/h9-serverlist
LIST_DATA=/var/lib/h9-serverlist
SITE_ROOT="/var/www/$DOMAIN"
NODE=/usr/bin/node

say()  { printf '\n== %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; WARNINGS+=("$*"); }
die()  { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }
WARNINGS=()

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

RESTORE=""; KEYS=""; PASSFILE=""; NO_TLS=0; CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --restore) RESTORE="${2:-}"; shift 2 || die "--restore needs a file";;
    --keys) KEYS="${2:-}"; shift 2 || die "--keys needs a folder";;
    --passphrase-file) PASSFILE="${2:-}"; shift 2 || die "--passphrase-file needs a file";;
    --no-tls) NO_TLS=1; shift;;
    --check) CHECK=1; shift;;
    -h|--help) usage; exit 0;;
    *) usage; die "unknown option $1";;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run it as root: sudo bash $0"
. /etc/os-release 2>/dev/null || die "no /etc/os-release: this is for Debian or Ubuntu"
case " ${ID:-} ${ID_LIKE:-} " in *" debian "*|*" ubuntu "*) ;; *) die "this is for Debian or Ubuntu, not ${PRETTY_NAME:-this system}";; esac
for f in h9web/server.js h9web/bin/h9web-backup.js havoc9.org/index.html havoc9.org/deploy/nginx-setup.sh serverlist-bot/h9_serverlist.py; do
  [ -e "$SRC/$f" ] || die "$SRC/$f is missing: run this from the unpacked package"
done
[ -e "$HERE/systemd/h9web.service" ] || die "$HERE/systemd is missing: run this from the unpacked package"
if [ -n "$RESTORE" ]; then [ -f "$RESTORE" ] || die "--restore: no file $RESTORE"; RESTORE="$(cd "$(dirname "$RESTORE")" && pwd)/$(basename "$RESTORE")"; fi
if [ -n "$KEYS" ]; then [ -f "$KEYS/secrets.json" ] || die "--keys: no secrets.json in $KEYS"; fi
if [ -n "$PASSFILE" ]; then [ -s "$PASSFILE" ] || die "--passphrase-file: $PASSFILE is missing or empty"; fi

as_h9web() { runuser -u h9web -- "$@"; }
backup_cli() { as_h9web "$NODE" "$H9WEB_HOME/bin/h9web-backup.js" --config "$H9WEB_ETC/config.json" "$@"; }
active() { systemctl is-active --quiet "$1" && echo "running" || echo "NOT running"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true; }

if [ "$CHECK" = 1 ]; then
  say "what is here"
  note "node        $(command -v node >/dev/null && node --version || echo none)"
  for u in h9web h9-serverlist nginx h9web-backup.timer h9web-backup-offsite.timer; do note "$(printf '%-27s %s' "$u" "$(active "$u")")"; done
  note "h9web       $(curl -s --max-time 5 http://127.0.0.1:8090/api/me || echo 'no answer') (127.0.0.1:8090)"
  note "list        HTTP $(code http://127.0.0.1:8081/v1/servers/ts) (127.0.0.1:8081)"
  note "site        HTTP $(code "https://$DOMAIN/") (https://$DOMAIN/)"
  note "keys        $(for f in secrets.json data.key; do [ -s "$H9WEB_DATA/$f" ] && printf '%s ' "$f"; done)in $H9WEB_DATA"
  if [ -f "$H9WEB_HOME/bin/h9web-backup.js" ] && [ -d "$H9WEB_DATA/backups" ]; then
    backup_cli list --out "$H9WEB_DATA/backups" | tail -n 3 || true
  fi
  exit 0
fi

say "1. packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg rsync ufw nginx openssl python3 python3-venv unattended-upgrades

say "2. Node.js 24"
node_major() { if [ -x "$NODE" ]; then "$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; else echo 0; fi; }
if [ "$(node_major)" -lt 24 ]; then
  note "installing Node.js 24 from NodeSource (deb.nodesource.com)"
  ns="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$ns"
  bash "$ns"
  rm -f "$ns"
  apt-get install -y -q nodejs
fi
[ "$(node_major)" -ge 24 ] || die "$NODE is not Node.js 24 or newer ($("$NODE" --version 2>/dev/null || echo none)); the units run $NODE"
note "$NODE $("$NODE" --version)"

say "3. users and folders"
id -u h9web >/dev/null 2>&1 || useradd --system --home-dir "$H9WEB_DATA" --shell /usr/sbin/nologin h9web
id -u h9list >/dev/null 2>&1 || useradd --system --home-dir "$LIST_DATA" --shell /usr/sbin/nologin h9list
install -d -m 755 -o root -g root "$H9WEB_HOME" "$H9WEB_ETC" "$LIST_HOME" "$SITE_ROOT"
install -d -m 700 -o h9web -g h9web "$H9WEB_DATA" "$H9WEB_DATA/backups"
install -d -m 700 -o h9list -g h9list "$LIST_DATA"
note "h9web: code $H9WEB_HOME, settings $H9WEB_ETC, data $H9WEB_DATA (h9web only)"
note "list:  code $LIST_HOME, settings and data $LIST_DATA (h9list only)"

say "4. h9web"
if [ -f "$H9WEB_DATA/h9web.db" ] && [ -f "$H9WEB_HOME/bin/h9web-backup.js" ] && [ -f "$H9WEB_ETC/config.json" ]; then
  note "a backup before the update:"
  backup_cli backup --out "$H9WEB_DATA/backups" --keep 14 | sed 's/^/    /' || warn "the backup before the update failed (above); the update goes on"
fi
rsync -a --delete --exclude='/data/' --exclude='/config.json' --exclude='/servers.json' --exclude='/test/' \
  --exclude='*.bak*' --exclude='*.cmd' --exclude='*.ps1' "$SRC/h9web/" "$H9WEB_HOME/"
chown -R root:root "$H9WEB_HOME"
chmod -R u=rwX,go=rX "$H9WEB_HOME"
if [ ! -f "$H9WEB_ETC/config.json" ]; then
  sed "s/havoc9\.org/$DOMAIN/g" "$SRC/h9web/config.example.json" > "$H9WEB_ETC/config.json"
  chmod 644 "$H9WEB_ETC/config.json"
  note "made $H9WEB_ETC/config.json from config.example.json (h9web/README.txt section 7)"
else
  note "$H9WEB_ETC/config.json is kept as it is"
fi
if [ ! -f "$H9WEB_ETC/servers.json" ]; then
  printf '{ "servers": [] }\n' > "$H9WEB_ETC/servers.json"
  chmod 644 "$H9WEB_ETC/servers.json"
  note "made an empty $H9WEB_ETC/servers.json: put H9's game servers in it (h9web/README.txt section 6)"
else
  note "$H9WEB_ETC/servers.json is kept as it is"
fi
chown root:root "$H9WEB_ETC/config.json" "$H9WEB_ETC/servers.json"
chmod 644 "$H9WEB_ETC/config.json" "$H9WEB_ETC/servers.json"

say "5. the server list"
rsync -a --delete --include='/h9_serverlist.py' --include='/requirements.txt' --include='/README.md' --exclude='*' \
  "$SRC/serverlist-bot/" "$LIST_HOME/"
[ -x "$LIST_HOME/venv/bin/python" ] || python3 -m venv "$LIST_HOME/venv"
"$LIST_HOME/venv/bin/pip" install -q --disable-pip-version-check --upgrade -r "$LIST_HOME/requirements.txt"
chown -R root:root "$LIST_HOME"
chmod -R u=rwX,go=rX "$LIST_HOME"
for f in serverlist.ini servers.txt; do
  if [ ! -f "$LIST_DATA/$f" ]; then
    sed "s/havoc9\.org/$DOMAIN/g" "$SRC/serverlist-bot/$f" > "$LIST_DATA/$f"
    chown h9list:h9list "$LIST_DATA/$f"; chmod 600 "$LIST_DATA/$f"
    note "made $LIST_DATA/$f"
  fi
done
if [ ! -f "$LIST_DATA/serverlist.cfg" ]; then
  install -m 600 -o h9list -g h9list "$SRC/serverlist-bot/serverlist.cfg.example" "$LIST_DATA/serverlist.cfg"
  note "made $LIST_DATA/serverlist.cfg (no heartbeat key, no Discord token yet: README-VPS.txt step 7)"
fi
chown -R h9list:h9list "$LIST_DATA"
find "$LIST_DATA" -type f -exec chmod 600 {} +

say "6. the site"
rsync -a --delete --exclude='/deploy/' --exclude='/files/' --exclude='/webclient/engine/' --exclude='/webclient/manifest.json' \
  --exclude='/webclient/preload.json' --exclude='/webclient/DEPLOY.txt' --exclude='*.bak*' --exclude='.*' \
  --exclude='*.zip' --exclude='*.orig' --exclude='*~' --exclude='README.md' --exclude='HAVOC_NINE_MASTER_SERVER.txt' \
  "$SRC/havoc9.org/" "$SITE_ROOT/"
chown -R root:root "$SITE_ROOT"
find "$SITE_ROOT" -type d -exec chmod 755 {} + ; find "$SITE_ROOT" -type f -exec chmod 644 {} +
note "$SITE_ROOT (the downloads' ZIPs, H9XASH-Updater's files/ and the web client's files there are kept)"

if [ -n "$KEYS" ] || [ -n "$RESTORE" ]; then
  say "7. the keys and the restore"
  systemctl stop h9web 2>/dev/null || true
  if [ -n "$KEYS" ]; then
    for f in secrets.json data.key; do
      [ -f "$KEYS/$f" ] || continue
      if [ -f "$H9WEB_DATA/$f" ] && ! cmp -s "$KEYS/$f" "$H9WEB_DATA/$f"; then
        die "$H9WEB_DATA/$f is there already and differs from $KEYS/$f. Move it away first if $KEYS holds the right one"
      fi
      install -m 600 -o h9web -g h9web "$KEYS/$f" "$H9WEB_DATA/$f"
      note "$H9WEB_DATA/$f from $KEYS"
    done
  fi
  if [ -n "$RESTORE" ]; then
    copy="$H9WEB_DATA/restore-$(basename "$RESTORE")"
    install -m 600 -o h9web -g h9web "$RESTORE" "$copy"
    args=(restore "$copy" --yes)
    vargs=(verify "$copy")
    pass=""
    if [ -n "$PASSFILE" ]; then
      pass="$H9WEB_DATA/.restore-passphrase"
      install -m 600 -o h9web -g h9web "$PASSFILE" "$pass"
      args+=(--passphrase-file "$pass")
      vargs+=(--passphrase-file "$pass")
    fi
    if ! backup_cli "${vargs[@]}" | sed 's/^/    /'; then
      rm -f "$pass"
      die "the backup does not check out (above); nothing was changed"
    fi
    if ! backup_cli "${args[@]}" | sed 's/^/    /'; then
      rm -f "$pass"
      die "the restore stopped (above); nothing was started. $copy is kept"
    fi
    rm -f "$pass" "$copy"
  fi
fi

say "8. the services"
install -m 644 "$HERE"/systemd/*.service "$HERE"/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet h9web h9-serverlist h9web-backup.timer
first=0; [ -f "$H9WEB_DATA/secrets.json" ] || first=1
systemctl restart h9web
systemctl restart h9-serverlist
systemctl start h9web-backup.timer
if [ -s "$H9WEB_ETC/backup-passphrase" ]; then
  chown h9web:h9web "$H9WEB_ETC/backup-passphrase"; chmod 600 "$H9WEB_ETC/backup-passphrase"
  systemctl enable --quiet --now h9web-backup-offsite.timer
  note "encrypted copies for off the VPS: daily, into $H9WEB_DATA/offsite"
else
  note "no $H9WEB_ETC/backup-passphrase yet: the encrypted backups for off the VPS are off (README-VPS.txt step 8)"
fi
for i in $(seq 1 20); do
  [ "$(curl -s --max-time 2 http://127.0.0.1:8090/api/me || true)" = '{"signedIn":false}' ] && break
  sleep 1
done
note "h9web $(active h9web): $(curl -s --max-time 2 http://127.0.0.1:8090/api/me || echo 'no answer yet: journalctl -u h9web')"
note "list  $(active h9-serverlist): HTTP $(code http://127.0.0.1:8081/v1/servers/ts) from 127.0.0.1:8081"
if [ "$first" = 1 ] && [ -f "$H9WEB_DATA/secrets.json" ]; then
  warn "h9web made new keys: back up $H9WEB_DATA/secrets.json and $H9WEB_DATA/data.key NOW, offline (README-VPS.txt step 6)"
fi

say "9. logs, updates and SSH"
install -d /etc/systemd/journald.conf.d
install -m 644 "$HERE/hardening/journald-havoc9.conf" /etc/systemd/journald.conf.d/havoc9.conf
systemctl restart systemd-journald
install -m 644 "$HERE/hardening/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades
note "logs kept 30 days; security updates install by themselves"
if [ "$HARDEN_SSH" = 1 ]; then
  keys=0
  for d in /root "$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"; do
    [ -s "$d/.ssh/authorized_keys" ] && keys=1
  done
  if [ "$keys" = 0 ]; then
    warn "no SSH key signs in here yet (no authorized_keys): SSH passwords stay on. Add your key, then run this again"
  elif ! grep -qiE '^\s*Include\s+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
    warn "/etc/ssh/sshd_config does not read sshd_config.d: SSH left as it is"
  else
    install -m 644 "$HERE/hardening/05-havoc9-sshd.conf" /etc/ssh/sshd_config.d/05-havoc9.conf
    if sshd -t; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
      note "SSH: keys only, no passwords (/etc/ssh/sshd_config.d/05-havoc9.conf)"
    else
      rm -f /etc/ssh/sshd_config.d/05-havoc9.conf
      warn "sshd -t refused the SSH settings; they are taken out again"
    fi
  fi
fi

if [ "$UFW" = 1 ]; then
  say "10. the firewall (ufw)"
  ports="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' || true)"
  for p in ${ports:-22}; do ufw allow "$p/tcp" >/dev/null; note "allowed $p/tcp (SSH)"; done
  ufw allow "Nginx Full" >/dev/null; note "allowed 80/tcp and 443/tcp (nginx)"
  for g in $GAME_PORTS; do ufw allow "$g" >/dev/null; note "allowed $g (game servers)"; done
  ufw status | grep -q "Status: active" || ufw --force enable >/dev/null
  note "ufw is on: everything else is closed from outside (h9web and the list listen on 127.0.0.1 only)"
fi

if [ "$NO_TLS" = 1 ]; then
  say "11. nginx and the certificate: skipped (--no-tls)"
  note "once DNS points $DOMAIN here: sudo bash $0"
else
  say "11. nginx and the certificate (havoc9.org/deploy/nginx-setup.sh)"
  if ! bash "$SRC/havoc9.org/deploy/nginx-setup.sh"; then
    warn "nginx or the certificate did not finish (above). Most often DNS does not point $DOMAIN here yet: check, then run sudo bash $0 again"
  fi
fi

say "done"
note "site     https://$DOMAIN/     h9web $(active h9web)     list $(active h9-serverlist)     nginx $(active nginx)"
note "backups  daily into $H9WEB_DATA/backups (sudo -u h9web node $H9WEB_HOME/bin/h9web-backup.js --config $H9WEB_ETC/config.json list)"
note "next     README-VPS.txt: the first admin (step 6), the game servers and the list (step 7)"
for w in "${WARNINGS[@]}"; do printf '  [WARN] %s\n' "$w"; done
exit 0
