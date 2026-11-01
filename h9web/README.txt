===============================================================================
 H9WEB -- HAVOC 9 ACCOUNTS, SESSIONS AND THE WEB CLIENT RELAY
===============================================================================

 One Node.js service (Node 24 or newer; no packages to install, nothing to
 build). It serves:
   * the accounts API under /api/: sign up, sign in, sign out, who am I,
     password change, the player id, the live server list;
   * the web client's relay at /webclient/relay: WebSocket to UDP, for
     signed-in players only, to H9's servers only, with its own master server
     for the game's server browser;
   * a module registry, so the forum (or anything else) plugs in without
     editing these files (section 13); the forum is one (section 15);
   * the admin panel's API with the audit log (section 16), and username
     changes (section 17);
   * Discord linking and the registered role, a module too (section 18).

 The pages that use it live in the site:
   havoc9.org/account/            the account page (and the privacy note)
   havoc9.org/account/login/      SIGN IN
   havoc9.org/account/signup/     CREATE ACCOUNT
   havoc9.org/account/forms.js    the three pages' script
   havoc9.org/assets/account.js   every page: SIGN IN / CREATE ACCOUNT, or the
                                  username and ACCOUNT, in the nav
   havoc9.org/assets/account.css  the account pages' styles
   havoc9.org/webclient/auth.js   the web client's sign-in gate
   havoc9.org/forum/              the forum's pages (section 15)
   havoc9.org/admin/              the admin panel (section 16)

 Nothing in this folder or in those pages is secret. The secrets live in the
 data folder (section 7), which is never in git and never in the site.

 CONTENTS
    1. Files
    2. Security design
    3. The API
    4. Player ids
    5. The relay
    6. servers.json (the one server list)
    7. Setup on the VPS, first start and secrets
    8. systemd
    9. nginx
   10. Logs, backups and restore
   11. Admin tasks
   12. Local test, one origin
   13. Extension points: modules (the forum)
   14. Tests
   15. The forum
   16. The admin panel and the audit log
   17. Username changes
   18. Discord: the registered role


 1. FILES
 --------
   server.js               the service: node server.js --config <file>
   bin/h9web-admin.js      admin tasks (section 11)
   lib/app.js              puts it together
   lib/config.js           settings (DEFAULTS lists every one) and secrets
   lib/db.js               SQLite (node:sqlite), migrations, backups
   lib/auth.js             the shared auth layer: sessions, cookie, CSRF,
                           requireSession / requireRole / optionalSession
   lib/accounts.js         accounts, roles, suspensions, player ids
   lib/passwords.js        scrypt hashing and the password rules
   lib/usernames.js        the username rules
   lib/playerid.js         the player id and what servers see of it
   lib/clientids.js        each account's h9_clientid on a game server, for
                           modules (section 13)
   lib/ratelimit.js        RateLimiter (backoff) and TokenBucket
   lib/http.js             router, JSON, cookies, client address
   lib/api.js              the core routes
   lib/websocket.js        WebSocket server side (RFC 6455), own code
   lib/relay.js            the relay
   lib/master.js           the master server the relay plays
   lib/servers.js          servers.json, and the live status poller
   lib/modules.js          the module registry
   lib/audit.js            the audit log (section 16)
   lib/admin.js            the admin panel's API (section 16)
   lib/renames.js          username changes (section 17)
   lib/static.js           local testing only: serves the site (section 12)
   config.example.json     settings for the VPS
   servers.example.json    the server list's format
   modules/                where modules go: forum/ (section 15), discord/
                           (section 18), presence/ (its own README.txt)
   test/                   node:test tests (section 14)
   .gitignore              keeps data/, config.json, servers.json out of git

 Why no WebSocket package: the relay needs binary messages, the handshakes,
 ping/pong, fragments and limits, and nothing else (no compression, no
 subprotocols). That is lib/websocket.js, about 280 lines, tested frame by
 frame (test/websocket.test.js) and against Node's own WebSocket client. It
 keeps the service free of npm installs on the VPS.


 2. SECURITY DESIGN
 ------------------
 Passwords
   * scrypt, N = 2^15, r = 8, p = 3 (32 MiB a hash; one of OWASP's
     equal-strength settings), a random 16-byte salt per hash, 32-byte output,
     compared with crypto.timingSafeEqual. The password is NFKC-normalised and
     run through HMAC-SHA256 with a server-side pepper (secrets.json) first,
     so a copy of the database alone is not enough to try guesses offline.
   * Each hash records its own cost ($scrypt$ln=15,r=8,p=3,k=1$salt$hash); a
     raised cost re-hashes each account at its next sign-in.
   * At most 2 hashes run at once (memory bound), 64 more may wait; past
     that the API answers 503 "busy" instead of piling up.
   * Rules: 10 to 256 characters. No rules about kinds of characters. A short
     list of the commonest picks, a single repeated character and the
     username itself are refused.
   * A sign-in for a name with no account does the same scrypt work against a
     stand-in hash, so the answer time does not tell whether a name exists.
 Usernames
   * 3 to 20 characters: letters, digits, . _ - ; starting and ending with a
     letter or digit; no two separators in a row; at least one letter.
   * Unique without regard to case, and by a look-alike skeleton too (case
     folded, separators dropped, 0->o 1->l i->l 3->e 4->a 5->s 7->t 8->b
     rn->m vv->w): "Ne0" cannot sit beside "neo".
   * Reserved: admin, moderator, havoc9/havocnine, official, staff, sysop,
     webmaster, h9team/h9staff anywhere in the name; names starting with msr
     or h9; and a list of exact names (mod, root, system, server, owner,
     support, msr, havoc, ...). lib/usernames.js has the lists.
   * The username is the display name, shown as typed at sign-up.
 Sessions
   * The cookie holds 32 bytes from crypto.randomBytes (base64url). The
     database keeps only its SHA-256, so a copy of the database signs nobody
     in.
   * Cookie: __Host-h9_session=<token>; Path=/; HttpOnly; Secure;
     SameSite=Strict; Max-Age=2592000. The __Host- prefix binds it to this
     exact host, site-wide (nginx sends www.havoc9.org to havoc9.org).
   * A session ends on sign-out (its row is deleted), 30 days after sign-in,
     after 14 days unused, on a password change (every session of the
     account; this browser gets a fresh one), when an admin resets the
     password or suspends the account, and on "sign out everywhere".
     Expired rows are swept hourly. Signing in again replaces the browser's
     old session.
 CSRF
   * SameSite=Strict keeps the cookie off requests other sites start.
   * Every POST/PUT/PATCH/DELETE must carry an Origin (or, without one, a
     Referer) in allowedOrigins, and a request the browser marks
     Sec-Fetch-Site: cross-site is refused. The router applies this to every
     route, modules included.
   * Only application/json bodies are read, which a cross-site form cannot
     send. No CORS headers are ever sent.
 Rate limits (in memory; config "limits")
   * sign-in: 20 tries per 10 minutes per IP; 8 failures per 15 minutes per
     username, from any IP. A block starts at 1 minute (IP) or 5 minutes
     (username) and doubles with each further block, up to 1 hour.
   * sign-up: 5 per hour per IP (a form filled in wrong is not counted),
     blocks from 1 hour, doubling up to a day.
   * password change: 10 wrong current passwords per 15 minutes per account.
   * relay upgrades: 60 a minute per IP.
   * the admin panel's password confirmations: 5 wrong ones per 15 minutes
     per account; username change requests: 10 a day per account; the
     forum's posting limits are its own (section 15).
   * IPv6 addresses count per /64. Over a limit: 429 with Retry-After.
 Errors and input
   * A failed sign-in always answers 401 "Wrong username or password.",
     whether the name exists or not. A suspended account learns of its
     suspension only after giving its right password.
   * Bodies are at most 4 KiB, fields are type- and length-checked, and every
     answer is Cache-Control: no-store, nosniff, with a CSP that renders
     nothing.
 Logs
   * One line per event on stdout (journald): sign-up, sign-in, failed
     sign-in (the username only when it is an account, so a password typed
     into the name box is never logged), sign-out, password change, relay
     open and close, and the forum's and the admin panel's events (sections
     15 and 16). Never a password, a token or a cookie; the tests check.
 Secrets
   * <dataDir>/secrets.json, made on the first start with mode 0600 and never
     written again: playerIdKey (player ids) and passwordPepper. The service
     refuses to start on a damaged file rather than make new ones (new ones
     would lose every password and every player id). It refuses a dataDir
     inside a folder it serves.
 Roles and suspensions
   * user, moderator, admin. Moderators and admins work in the admin panel
     (section 16), which moves accounts between user and moderator; only the
     admin script (section 11) makes or unmakes an admin, the first one too.
   * Every moderator and admin action is in the audit log (section 16).
   * A suspended account (banned_until in the future) cannot sign in, gets
     403 on every signed-in route, and the relay refuses and closes its
     sockets.


 3. THE API
 ----------
 JSON in and out. Errors: { "error": code, "message": text } with the status.

   POST /api/signup    { username, password }
                       201 { ok, user: { username, role } }, signed in
                       400 invalid_username | invalid_password
                       409 username_taken      429 rate_limited
   POST /api/login     { username, password }
                       200 { ok, user }, signed in
                       401 bad_credentials     429 rate_limited
                       403 account_suspended { until (null: no end), reason }
   POST /api/logout    {} or { everywhere: true }    200 { ok }
   GET  /api/me        200 { signedIn: false } or
                           { signedIn: true, user: { username, role } }
   GET  /api/account   signed in: { username, role, created, lastLogin,
                       passwordChanged, playerIdShort, sessions,
                       servers: [{ name, address, clientId }] }
   POST /api/password  signed in: { currentPassword, newPassword }
                       200 { ok } (other sessions end; a new cookie)
                       403 bad_credentials     400 invalid_password
   GET  /api/player    signed in: { playerId } (the web client only)
   GET  /api/servers   { gamedir, generated, servers: [{ address, kind, name,
                       map, mode, players, max, bots, ping_ms }] }: the
                       listed servers that answered lately, the shape
                       servers/index.html reads (data-master="/api/servers")

 Username changes: section 17. The admin panel's API: section 16. The
 forum's: section 15.

 Signed-in routes answer 401 not_signed_in or 403 account_suspended. Every
 POST needs the site's Origin (403 csrf) and Content-Type: application/json
 (415).


 4. PLAYER IDS
 -------------
 H9XASH has cl_h9_userid (engine-h9-userid.patch, docs\CUSTOM_XASH_USERID.txt):
 on every connect the engine sends the userinfo key
     h9_clientid = MD5( cl_h9_userid as text + the server's 4 IPv4 bytes )
 so each server sees its own value and two servers cannot match a player up.

 For an account, cl_h9_userid is the account's player id:
     HMAC-SHA256( secrets.playerIdKey, "h9web player id v1" NUL uid )
     first 32 hex characters
 uid is 16 random bytes made at sign-up and never changed. So the id
   * is the same for the account forever (and on every device), so a server
     sees the same h9_clientid for the same account every time;
   * has the shape of H9XASH's own ids (32 lowercase hex);
   * cannot be worked out from the database without secrets.json, and a
     deleted account's id never comes back.
 After sign-in the web client page (webclient/auth.js) fetches it from
 GET /api/player and hands it to client.js as window.h9webAccount.playerId;
 client.js writes cl_h9_userid into the engine's userid_resolved.cfg. It is
 never kept in the browser's storage. The account page shows its first 8
 characters, and what each listed server sees (its h9_clientid), which is
 what a server admin can use to tell a player apart. SHOW and COPY in its
 PLAYER ID row fetch the whole id from GET /api/player when pressed (SHOW puts
 it in the row until HIDE or the page is left; COPY copies it without showing
 it), and keep it nowhere: a player who wants the downloaded H9XASH to count as the same
 player puts it into H9XASH\user_id.ini with enter_userid.cmd
 (docs\CUSTOM_XASH_USERID.txt, section 2). Optional: H9XASH's own random id
 keeps working. Whoever has the id is that player to H9's servers, so the
 page tells players to keep it to themselves.

 What it is not: proof of identity. The value is client-asserted, like every
 h9_clientid: a modified client can send any value, and h9_clientid is
 ordinary userinfo, so other players on a server can read it. It identifies
 honest clients; it is not a password. If a server ever needs to know for
 certain which account a browser player is, the relay knows (each relay UDP
 port belongs to one signed-in account), which is the place to build that.
 The salt is the address the engine connects to, so it stays the same only
 while the server keeps its address (the same as for native players).


 5. THE RELAY
 ------------
 The contract with the page (client.js) is webclient\DEPLOY.txt section 6: the
 framing, the master, and how the page backs off. The relay's side of it:

 Upgrade at relay.path (/webclient/relay). Refused with a plain HTTP status:
   401 not signed in, signed out, expired or suspended
   403 the Origin is missing or not in allowedOrigins
   429 a socket cap (4 per account, 12 per IP, 512 in all) or too many
       upgrades from the IP
   400/426 not a valid WebSocket version 13 upgrade
 Every binary message, both ways: 4 bytes IPv4 + 2 bytes port (network order)
 + one UDP payload; to the relay the address is the destination, from it the
 source. A message is one datagram, payload up to relay.maxDatagram (4096).

 Each WebSocket gets its own UDP socket, one port for its whole life, so a
 game server sees one stable address per player socket. A datagram goes out
 only to
   * the master address (relay.master, 192.0.2.1:27010): the relay answers the
     engine's master query itself with the listed servers (the FWGS form with
     its 7F block when the query has \clver\ or \key\, the GoldSrc form
     otherwise; filtered by \gamedir\); or
   * a server on servers.json: sent to its target.
 Anything else is dropped; datagrams reaching the relay's UDP port from
 anything but a listed server's target are dropped too. It is never an open
 relay.

 Limits (config "relay"): per account 300 datagrams and 256 KiB a second
 (bursts of 600 / 512 KiB), per IP 800 and 1 MiB (1600 / 2 MiB), shared by
 all the sockets of that account or IP; over the rate a datagram is dropped,
 and a socket that keeps sending mostly dropped datagrams for 10 seconds is
 closed. Idle (no datagram from the page) for 180 seconds closes it. A ping
 every 30 seconds; a browser answers by itself. The session is checked again
 every 60 seconds, and at once when this process signs it out, changes the
 password or suspends the account.

 Close codes: 4401 session ended, 4403 suspended, 4408 idle, 4429 too much
 traffic, 1001 restart, 1003 text message, 1007 message under 6 bytes, 1009
 message too big, 1011 the relay's UDP socket failed.

 Game servers: every browser player comes from the relay's address. Raise
 sv_query_rate_limit (default 1 reply a second per address) and set
 sv_connect_max_per_ip 0 on each H9 server; webclient\DEPLOY.txt section 7.


 6. SERVERS.JSON (THE ONE SERVER LIST)
 -------------------------------------
 /etc/h9web/servers.json (config "serversFile"), read again within 2 seconds
 of any change. The relay sends only to it, its master lists it, the account
 page shows each server's h9_clientid from it, and /api/servers (the website's
 SERVERS page) lists it live.

   {
     "servers": [
       { "name": "HAVOC 9", "address": "203.0.113.10:27015" },
       { "name": "HAVOC 9 (on this VPS)", "address": "198.51.100.20:27015",
         "target": "127.0.0.1:27015" },
       { "name": "HAVOC 9 test", "address": "203.0.113.10:27016",
         "listed": false }
     ]
   }

   name     shown on the website and the account page (default: the
            server's own name from its answer)
   address  the server's public IPv4:port, as players and the engine know it
   target   where the relay really sends (default: address). For a game
            server on the relay's own machine use 127.0.0.1:port; the page
            and the engine still see "address"
   gamedir  default "ts"
   listed   default true; false: joinable through the relay, but not in the
            server browser or on the website
   notes    free text, not read
 A file that does not parse leaves the last good list in place; a bad entry
 is skipped with a line in the log. Host names are not taken (the browser
 engine resolves none). The master's own address is refused.

 The SERVERS page reads /api/servers (data-master="/api/servers" in
 servers/index.html). serverlist-bot (the native client's HTTP list) keeps
 its own servers.txt; to make this file its only source too, have the bot
 seed from the "address" fields here.


 7. SETUP ON THE VPS, FIRST START AND SECRETS
 --------------------------------------------
   * Node.js 24 or newer (node:sqlite): from nodejs.org or NodeSource.
     node --version must print v24 or later; /usr/bin/node below.
   * Places:
       /opt/h9web/               this folder (code only), owned by root
       /etc/h9web/config.json    settings (from config.example.json)
       /etc/h9web/servers.json   the server list (from servers.example.json)
       /var/lib/h9web/           data: secrets.json, h9web.db, backups/
   * Commands:
       sudo useradd --system --home /var/lib/h9web --shell /usr/sbin/nologin h9web
       sudo mkdir -p /opt/h9web /etc/h9web
       sudo cp -r server.js package.json lib bin modules README.txt /opt/h9web/
       sudo cp config.example.json /etc/h9web/config.json
       sudo cp servers.example.json /etc/h9web/servers.json
       sudo nano /etc/h9web/config.json      (allowedOrigins, paths)
       sudo nano /etc/h9web/servers.json     (the real servers)
     then the systemd unit (section 8) and nginx (section 9).
   * config.json for the VPS, as config.example.json has it:
       listen 127.0.0.1:8090 (nginx only), allowedOrigins
       ["https://havoc9.org"], trustProxy true (X-Real-IP from nginx),
       dataDir /var/lib/h9web, serversFile /etc/h9web/servers.json.
     Every other setting has a default in lib/config.js (DEFAULTS).
     Never set insecureCookies on the VPS.
   * First start: systemctl enable --now h9web. The service makes
     /var/lib/h9web/secrets.json (mode 0600) and h9web.db, and says so in the
     log:  journalctl -u h9web | grep secrets.created
     Back secrets.json up at once, offline (a password manager or an
     encrypted drive), and never into git or the site:
       sudo cat /var/lib/h9web/secrets.json
     It never changes after this. Losing it loses every password and every
     player id; the database alone cannot be used without it.
   * The first admin: sign up on the site, then
       sudo -u h9web node /opt/h9web/bin/h9web-admin.js --config /etc/h9web/config.json set-role <name> admin
   * Updates: copy the new code into /opt/h9web, systemctl restart h9web. A
     schema change runs at start (migrations) after the service copies the
     database to /var/lib/h9web/backups/pre-migrate-*.db.


 8. SYSTEMD
 ----------
 /etc/systemd/system/h9web.service:

   [Unit]
   Description=HAVOC 9 accounts and web client relay (h9web)
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=h9web
   Group=h9web
   WorkingDirectory=/opt/h9web
   ExecStart=/usr/bin/node /opt/h9web/server.js --config /etc/h9web/config.json
   Restart=always
   RestartSec=5
   StateDirectory=h9web
   StateDirectoryMode=0700
   UMask=0077
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   PrivateDevices=true
   ProtectKernelTunables=true
   ProtectKernelModules=true
   ProtectControlGroups=true
   RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
   RestrictNamespaces=true
   LockPersonality=true
   MemoryMax=512M
   LimitNOFILE=8192

   [Install]
   WantedBy=multi-user.target

   sudo systemctl daemon-reload
   sudo systemctl enable --now h9web
   journalctl -u h9web -f

 StateDirectory makes /var/lib/h9web, owned by h9web, mode 0700: the only
 place the service can write (ProtectSystem=strict). Do not add
 MemoryDenyWriteExecute (it breaks Node's JIT). SIGTERM closes every relay
 socket with 1001 and stops cleanly.

 This one unit replaces the separate h9web-relay.service an earlier draft of
 DEPLOY.txt had: accounts and relay are one process.


 9. NGINX
 --------
 In the havoc9.org server block (webclient\DEPLOY.txt section 8 has the whole
 file). proxy_pass has no path, so h9web sees the paths as they are.

     # h9web: the accounts API
     location /api/ {
         proxy_pass http://127.0.0.1:8090;
         proxy_http_version 1.1;
         proxy_set_header Host $host;
         proxy_set_header X-Real-IP $remote_addr;
         proxy_set_header Connection "";
         client_max_body_size 16k;
         proxy_read_timeout 30s;
         add_header Strict-Transport-Security "max-age=31536000" always;
     }

     # h9web: the web client's relay (a WebSocket)
     location = /webclient/relay {
         proxy_pass http://127.0.0.1:8090;
         proxy_http_version 1.1;
         proxy_set_header Host $host;
         proxy_set_header Upgrade $http_upgrade;
         proxy_set_header Connection "upgrade";
         proxy_set_header X-Real-IP $remote_addr;
         proxy_buffering off;
         client_max_body_size 1k;
         proxy_read_timeout 300s;
         proxy_send_timeout 300s;
         add_header Strict-Transport-Security "max-age=31536000" always;
     }

 * X-Real-IP is set (not passed through) by nginx, so a client cannot fake
   it; h9web trusts it only from 127.0.0.1 (trustProxy).
 * h9web checks the Origin itself (allowedOrigins), on the relay and on every
   POST; nginx needs no Origin rule of its own.
 * A location with an add_header of its own drops the server block's, hence
   the repeated Strict-Transport-Security.
 * Optional, a second rate limit in front: in the http block
     limit_req_zone $binary_remote_addr zone=h9api:10m rate=5r/s;
   and in location /api/
     limit_req zone=h9api burst=20 nodelay;
 * The forum (section 15) needs one location of its own, for its picture
   upload: location = /api/forum/avatar, with client_max_body_size 11m.
 * A module that serves pages (pages: true, section 13) needs its own
   location, for example (the forum serves none: its pages are site files):
     location /notes/ { proxy_pass http://127.0.0.1:8090; proxy_set_header Host $host;
                        proxy_set_header X-Real-IP $remote_addr; proxy_http_version 1.1;
                        add_header Strict-Transport-Security "max-age=31536000" always; }
 * Checks after nginx -t and a reload:
     curl -s https://havoc9.org/api/me                  {"signedIn":false}
     curl -s -X POST https://havoc9.org/api/logout      403 csrf (no Origin)
     curl -sI https://havoc9.org/webclient/relay        404 (only a WebSocket upgrade is answered there)


 10. LOGS, BACKUPS AND RESTORE
 -----------------------------
 Logs: journalctl -u h9web. The privacy note on the account page says logs
 are kept up to 30 days; make that true:
   * /etc/systemd/journald.conf: MaxRetentionSec=30day, then
     systemctl restart systemd-journald
   * nginx's access logs: Debian's /etc/logrotate.d/nginx keeps 14 days
     (rotate 14, daily); keep it at 30 or less.

 Backups: the database, daily; secrets.json, once, offline (section 7).
   sudo -u h9web node /opt/h9web/bin/h9web-admin.js --config /etc/h9web/config.json backup /var/lib/h9web/backups/h9web-$(date +%F).db
 is a consistent copy while the service runs (SQLite VACUUM INTO). Never copy
 h9web.db itself while it runs (its -wal file holds the newest writes).

 A daily timer, /etc/systemd/system/h9web-backup.service:
   [Unit]
   Description=h9web database backup
   [Service]
   Type=oneshot
   User=h9web
   ExecStart=/bin/sh -c '/usr/bin/node /opt/h9web/bin/h9web-admin.js --config /etc/h9web/config.json backup /var/lib/h9web/backups/h9web-$(date +%%F).db && find /var/lib/h9web/backups -name "h9web-*.db" -mtime +14 -delete'
 and /etc/systemd/system/h9web-backup.timer:
   [Unit]
   Description=Daily h9web database backup
   [Timer]
   OnCalendar=daily
   Persistent=true
   [Install]
   WantedBy=timers.target
   sudo systemctl enable --now h9web-backup.timer
 Then copy /var/lib/h9web/backups off the machine (rsync, scp) on a schedule
 of your own. A backup holds password hashes: keep it as private as the
 server.

 Restore:
   sudo systemctl stop h9web
   sudo cp h9web-YYYY-MM-DD.db /var/lib/h9web/h9web.db
   sudo rm -f /var/lib/h9web/h9web.db-wal /var/lib/h9web/h9web.db-shm
   sudo chown h9web:h9web /var/lib/h9web/h9web.db && sudo chmod 600 /var/lib/h9web/h9web.db
   (secrets.json must be the one the backup was made with)
   sudo systemctl start h9web


 11. ADMIN TASKS
 ---------------
 Run as the service's user, with the service's config:
   A="sudo -u h9web /usr/bin/node /opt/h9web/bin/h9web-admin.js --config /etc/h9web/config.json"

   $A list [--limit N] [--offset N]       accounts, oldest first
   $A show <name>                         one account
   $A set-role <name> <user|moderator|admin>    (the first admin too; the
                                          panel never makes an admin)
   $A rename <name> <new name>            a username change at once (section 17)
   $A reset-password <name>               a new random password, printed
                                          once; every session ends. Hand it
                                          over privately; they change it
                                          under ACCOUNT
   $A ban <name> [--days N] [--reason T]  suspend (no --days: until unban);
                                          every session ends
   $A unban <name>
   $A revoke-sessions <name>              sign out everywhere
   $A create <name> [--role R]            an account with a random password
   $A delete <name> --yes                 the account and its sessions
   $A backup <file>                       section 10

 There is no email, so there is no self-service reset: a player who lost
 their password asks an admin (Discord), who runs reset-password. Changes
 count at once on the API; open relay sockets notice within 60 seconds.
 Passwords are never taken as arguments (shell history). Every command that
 changes an account goes into the audit log as "(command line)" (section 16).
 Day to day, moderators and admins use the admin panel instead (section 16).


 12. LOCAL TEST, ONE ORIGIN
 --------------------------
 The pages, the API and the relay must share one origin (the cookie is
 SameSite=Strict and the relay checks the Origin). devStatic makes h9web
 serve folders as the site, on this PC only. A config.json beside server.js
 (git-ignored):

   {
     "listen": { "host": "127.0.0.1", "port": 8090 },
     "allowedOrigins": ["http://127.0.0.1:8090"],
     "dataDir": "./data",
     "serversFile": "./servers.json",
     "scrypt": { "ln": 15, "r": 8, "p": 3 },
     "devStatic": {
       "/": "../havoc9.org",
       "/webclient/engine/": "../webclient-build/stage/engine",
       "/webclient/game/": "../webclient-build/stage/game"
     }
   }

 and a servers.json naming a LAN server, then node server.js and
 http://127.0.0.1:8090/. Browsers keep Secure cookies on http://127.0.0.1
 and localhost. On another machine without HTTPS add
 "insecureCookies": true (never on the VPS). Ctrl+C stops it.


 13. EXTENSION POINTS: MODULES (THE FORUM)
 -----------------------------------------
 A module is a folder modules/<name>/ with index.js, loaded when config.json
 lists it ("modules": ["forum"]), in that order, after the core. It never
 edits a core file.

   // modules/forum/index.js
   export default {
     name: "forum",            // the folder's name: a-z 0-9 -, not reserved
     pages: true,              // optional: also route /forum and /forum/...
     migrations: [
       { version: 1, description: "threads and posts", up(db) {
           db.exec(`CREATE TABLE forum_threads (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
             title TEXT NOT NULL, created_at INTEGER NOT NULL)`);
       } },
     ],
     async setup(ctx) {
       ctx.router.get("/api/forum/threads", async (req, res, rc) => rc.json(200, { threads: [] }));
       ctx.router.post("/api/forum/threads", ctx.auth.requireSession(async (req, res, rc) => {
         const body = await rc.body();          // JSON, 4 KiB unless { maxBytes }
         rc.json(201, { by: ctx.accounts.publicView(rc.account) });
       }));
       ctx.router.delete("/api/forum/posts/:id", ctx.auth.requireRole("moderator", async (req, res, rc) => {
         rc.json(200, { ok: true, id: rc.params.id });
       }));
     },
     async stop() {},          // optional
   };

 ctx, what a module gets:
   router      get/post/put/patch/delete(pattern, handler, opts): patterns
               under /api/<name> (and /<name> with pages: true) only, with
               :params and a trailing *. handler(req, res, rc); rc has url,
               path, params, query, ip, body(), json(), send(), account,
               session. Throw ctx.http.HttpError(status, code, message) to
               refuse. Every POST/PUT/PATCH/DELETE passes the CSRF check
               first ({ csrf: false } in opts only for a route with its own
               authentication, never for a browser form).
   auth        requireSession(h), requireRole("user"|"moderator"|"admin", h),
               optionalSession(h), roleAtLeast(account, role), ROLES,
               checkSameOrigin(req), sessionFromRequest(req). The guards set
               rc.account (the accounts row) and rc.session; a suspended
               account is refused by all of them.
               lastActive(accountId) -> unix seconds of the account's last
               signed-in request (any request sessionFromRequest answered;
               after a restart the sessions' last_seen_at), or null;
               activeSince(unixSeconds) -> the account ids with one since then
               confirmAdmin(rc, password), in an admin-only route: the acting
               admin's own password, sent with the request, checked as the
               admin panel checks it (section 16); returns the admin's row
               read again, or throws 400 password_required, 403 bad_password
               or 429
   accounts    getById(id), getByUsername(name), publicView(account) ->
               { id, username, role, created }, isBanned(account)
               clientIdIndex(address) -> { get(h9_clientid) -> account id,
               has, size }: each account's h9_clientid on the game server at
               "a.b.c.d:port" (lib/clientids.js; no player id leaves core)
               verifyIdProof(accountId, { nonce, server, devmask, proof }) ->
               { valid, device }: a game client's answer to the id challenge
               (docs\H9_PRESENCE.txt section 8); device is a hash
               resetPlayerId(accountId): a new player id, the old one dead;
               movePlayerId(fromId, toId): toId takes fromId's player id,
               fromId gets a new one, toId's old one dies. Both plain
               statements: run them inside ctx.transaction
               nameInUse(name) -> true when a name is a username, looks like
               one, or is held after a username change (the sign-up rule)
   servers     get(address) -> { name, address, listed, gamedir } or null,
               listed() -> the listed entries, status(address) -> { name, map,
               mode, players, max, bots } from the last A2S answer, or null
   db          the shared node:sqlite DatabaseSync (foreign keys on, WAL);
               transaction(fn) runs fn in BEGIN IMMEDIATE ... COMMIT
   limits      RateLimiter({ max, windowSeconds, blockSeconds,
               maxBlockSeconds }).hit(key) -> { ok, retryAfter },
               TokenBucket, ipKey(ip)
   http        HttpError, sendJson, readJson, clientIp(req)
   audit       record({ actor, action, target, subject, detail }): a row in
               the audit log (section 16); actor and target are accounts rows
   events      account-created { id }, account-role { id, role },
               account-banned { id, until }, account-unbanned { id },
               account-password { id }, account-deleted { id, username }
               (before the row goes), session-ended { tokenHash },
               account-sessions-ended { accountId }, account-renamed
               { id, from, to }, account-player-id { id } (resetPlayerId,
               movePlayerId); from the relay: relay-open { accountId },
               relay-close { accountId }, relay-game-start { accountId,
               server } (the socket began sending that listed server the
               game's own traffic) and relay-game-end { accountId, server }
               (15 seconds without, or the socket closed). In this process
               only: the admin script's changes reach the database, not the
               events.
   log         log.info(event, { fields }) etc.; never pass a password,
               token or cookie
   settings    config.json's "moduleSettings": { "<name>": { ... } }
   site        { origins }: the site's own origins
   dataDir     <dataDir>/modules/<name>, for files (make it when needed)

 Rules for a module:
   * Tables are named <name>_... . Migrations run 1, 2, 3 ... in order, each
     in a transaction, recorded in schema_migrations under the module's name,
     with a copy of the database made first; never edit a migration that has
     shipped, add the next one.
   * Point at accounts(id) with ON DELETE CASCADE or SET NULL: deleting an
     account deletes its row (the admin script's delete, possibly from
     another process), and foreign keys are enforced.
   * Display names: accounts.username, as publicView gives it; role badges
     from role. Usernames are unique without regard to case and look-alikes.
   * Escape everything a user wrote before it goes into HTML; send a
     Content-Security-Policy with module pages.
   * Limit posting with a RateLimiter per account (and per ipKey).
   * A module with pages needs an nginx location (section 9); a module whose
     pages are static files in the site folder needs none (its scripts call
     /api/<name>/... with fetch, credentials "same-origin", JSON bodies).
   * test/fixtures/modules/notes is a small working example the tests load.


 14. TESTS
 ---------
   cd h9web
   node --test --test-timeout=30000 "test/*.test.js"      (or: npm test)

 183 tests in the files below, about 10 seconds, light on the CPU (scrypt at a
 test cost). They
 start the service on a free port in a temporary folder:
   units.test.js       username rules, passwords (scrypt, pepper, rehash),
                       player id and the engine's h9_clientid, rate limits,
                       master query and reply (read the way CL_ServerList
                       reads it), servers.json checks, A2S answers,
                       migrations, secrets, settings
   api.test.js         sign-up, sign-in, sign-out (and everywhere), sessions,
                       forged and expired cookies, CSRF (no Origin, foreign
                       Origin, Sec-Fetch-Site, Referer, form bodies, size),
                       password change, player id, suspension, the module
                       registry and its guards, the admin script, rate limits
                       per IP and per username, and no secret in the logs
   websocket.test.js   RFC 6455 frame by frame: lengths, fragments, ping,
                       closing handshake, and each kind of bad frame
   relay.test.js       refused upgrades (no session, foreign or no Origin,
                       dead cookie, suspended), the framing to a local UDP
                       echo, target mapping, the allowlist both ways, the
                       master (both forms, gamedir filter), bad messages,
                       socket caps, sign-out and suspension closing sockets,
                       servers.json reload, /api/servers from a fake server,
                       datagram rate limits and the flood close, idle close,
                       the events modules get (relay-open, relay-close,
                       relay-game-start on game traffic only, relay-game-end)
   forum.test.js       the forum: guests reading (on and off), roles, posting,
                       edits and the edit window, soft deletes and empty
                       threads, locks, pins, moves, hidden categories, reports,
                       title search, posting turned off, pagination, posting
                       limits (and new accounts'), CSRF on every write,
                       suspended accounts, likes and dislikes (each rule, the
                       totals, removed posts, their limit), migrations, the logs
   forum-markup.test.js  the renderer: the formatting, and XSS (script tags,
                       javascript: links, attribute breakouts, unicode tricks),
                       hostile input in linear time
   forum-pictures.test.js  pictures: each format's metadata stripped (a JPEG
                       with GPS EXIF), SVG and polyglots refused or cut, GIF
                       frames and screen, WebP flags, upload, serving and its
                       headers, sizes, types, a cross-site upload, uploads at
                       once, the quota, moderators removing
   admin.test.js       the admin panel: roles and the hierarchy, the account
                       list (players for moderators, sorts, filters, the
                       look-alike search, paging, its limit), password
                       confirmations and their limit, CSRF on every write, the
                       audit log, username changes (case, look-alikes, held
                       names, the cooldown, a race at approval), the admin
                       command's rename
   discord.test.js     Discord linking, against a stand-in for Discord's API:
                       the callback without the session cookie, states used
                       once, expired and forged, the binding cookie (a state
                       finished in another browser, a cookie from another
                       flow, an expired one), one link each way, pending
                       until the player joins and the reconcile, a free
                       taking the role, suspension and deletion, a 429
                       waited out, the off switch, removeUnlinked, and no
                       secret in the logs
   presence.test.js    who is in game (modules/presence/README.txt section 7),
                       and core's hooks for it: site activity (a request
                       counts, the relay's re-check does not), clientIdIndex
                       as accounts come, go, reset and move ids, nameInUse


 15. THE FORUM
 -------------
 modules/forum/ is a module (section 13): categories, threads and posts in a small
 formatting subset, profile pictures, and the moderators' side. Its pages are static
 files in the site that call its API with fetch:
   havoc9.org/forum/             the categories, the rules, what the forum keeps
   havoc9.org/forum/category/    a category's threads (?c=general)
   havoc9.org/forum/thread/      a thread (?t=12, &page=, &post=)
   havoc9.org/forum/user/        a member's profile (?u=Name)
   havoc9.org/forum/search/      title search (?q=)
   havoc9.org/forum/forum.js     the one script of those pages
   havoc9.org/forum/forum.css    their styles (and the admin panel's)
   havoc9.org/assets/avatar-default.png    the picture of a member who has none
 Each page sends a Content-Security-Policy (script-src 'self', img-src 'self',
 connect-src 'self'). The report queue, the removed threads, the category editor and
 the posting switches are in the admin panel (section 16).

 Switching it on
   config.json: "modules": ["forum"]. The first start makes its tables (migrations 1
   to 3, after a copy of the database) and seven categories: Announcements (only
   moderators and admins start threads), General, Servers and Match Mode, Roleplay,
   Modding (maps, models, sounds, plugins), Web Client and Support, Off-topic. Admins
   change them in the admin panel.
   nginx: the pages need nothing new (they are site files; the API is under /api/),
   but a picture upload is up to 10 MB, more than location /api/ takes, so it gets a
   location of its own, in the havoc9.org server block beside location /api/:
     location = /api/forum/avatar {
         proxy_pass http://127.0.0.1:8090;
         proxy_http_version 1.1;
         proxy_set_header Host $host;
         proxy_set_header X-Real-IP $remote_addr;
         proxy_set_header Connection "";
         client_max_body_size 11m;
         proxy_read_timeout 60s;
         add_header Strict-Transport-Security "max-age=31536000" always;
     }
   Without it nginx refuses a picture over 16 KiB with its own 413 page.
   location /api/'s client_max_body_size 16k holds a 10,000-character post in a Latin
   script (about 10 KiB of JSON); other scripts take 2 or 3 bytes a character, so for
   long posts in those, raise it to 64k.

 Settings: config.json "moduleSettings": { "forum": { ... } }, all optional:
   guestRead           true        guests read the forum (false: members only, 401)
   threadsPerPage      25
   postsPerPage        20
   titleMax            120         characters in a title
   postMax             10000       characters in a post
   editWindowMinutes   60          how long authors may edit a post or their title
   newAccountHours     24          accounts younger than this post more slowly
   pictureMaxBytes     10485760    10 MB a picture
   pictureMaxSide      512         width and height: the picture, a GIF's screen,
                                   a WebP's canvas and every frame
   pictureMaxFrames    300         frames in a GIF or a WebP
   pictureInlineBytes  524288      beside posts, a picture larger than this shows the
                                   default one until it is hovered, focused or tapped
   pictureQuotaBytes   1073741824  all pictures together (1 GiB); 0: pictures off
   picturesAtOnce      2           uploads read at the same time (memory)
   limits.<name>       { max, windowSeconds, blockSeconds, maxBlockSeconds }, as the
                       core's limits (section 2); the defaults:
     thread      1 in 2 minutes            newThread    1 in 15 minutes
     post        1 in 15 seconds           newPost      1 a minute
     postHour    60 an hour                newPostHour  15 an hour
     threadPerIp 20 an hour, one address   postPerIp    200 an hour, one address
     edit        20 in 10 minutes          report       10 an hour
     preview     30 in 5 minutes           picture      10 uploads an hour
     vote        30 a minute
   A new thread counts as a post too. Over a limit: 429 with Retry-After and a message
   that says how long. The new* limits are for accounts under newAccountHours, and
   say so; moderators and admins are never new. A bad value stops the start with a
   message naming it.

 Writing
   Posts are plain text. The formatting (modules/forum/markup.js): a blank line for a
   paragraph, a line break kept; **bold**, *italic* (at word edges only, so 5*3*2
   stays); `code`; a line of ``` before and after a code block; > for a quote (nested
   4 deep); a bare http(s) address, or [words](https://...), for a link. Nothing else
   is markup: <tags> and &entities; are text. The renderer never makes HTML from what
   was written: it turns it into a tree of plain data, and the pages build elements
   from that with createElement and textContent (never innerHTML). Links are http or
   https only, as the URL parser normalises them, never with a user name or password,
   and get rel="nofollow ugc noopener noreferrer". No pictures in posts (a remote
   picture would tell its host every reader's address) and no uploads but profile
   pictures. Text is cleaned on the way in: control characters, the bidi override and
   isolate characters, zero-width spaces and other invisible fillers are dropped, NFC,
   at most 4 combining marks on a character, and a lone surrogate becomes U+FFFD.
   A post is rendered when read, the latest 400 texts kept in memory.

 Reading, writing and roles
   * Guests read unless guestRead is false; a suspended account reads as a guest.
   * Starting a thread and replying need a signed-in account that is not suspended
     and whose posting is on. Each category says who starts threads and who replies
     (everyone, moderators and up, or admins), and whether everyone sees it: a hidden
     category, and all in it, is there only for moderators and admins.
   * Authors edit a post, and the title of their thread, for editWindowMinutes, and
     remove their own posts at any time (not in a locked thread). A moderator edits
     any post at any time; readers see "edited by a moderator".
   * QUOTE puts a post into the reply as a quote. Threads list pinned ones first, then
     by their last post; both lists are paged. Profiles show the join date and the
     post, like and thread counts.
   * Likes and dislikes (migration 4, forum_votes): one vote per account per post,
     like (+1), dislike (-1), or taken back (0): PUT /api/forum/posts/<id>/vote
     { value }, which answers the post's new counts. Not on your own post, not while
     suspended or with posting off, not on a removed post; a lock stops replies, not
     votes. Every post shows its likes and dislikes, to guests too; the author block
     beside the picture shows the author's likes received in all, next to the post
     count. The thread page works out the counts, the viewer's own votes and the
     authors' totals in one grouped query each, not one per post. A removed post
     keeps its votes, which are not shown or counted until it is restored; deleting an
     account deletes the votes it cast.

 Moderation (moderators and admins; each step goes into the audit log, section 16)
   * In a category's thread list each row has PIN / UNPIN and LOCK / UNLOCK for staff,
     so a thread is pinned or locked without opening it; the MODERATE bar inside a
     thread has the rest.
   * Threads: pin and unpin; lock and unlock (no new replies while locked: moderators
     and admins can still reply); rename; move to another category; remove and
     restore. Posts: edit, remove and restore.
   * Removing is soft. A removed post leaves "Removed by a moderator" or "Removed by
     its author" in its place; moderators still see its text and can restore it. A
     thread whose every post is removed is hidden (removed, kind "empty") and comes back
     by itself when one of its posts is restored. A thread a moderator removed comes
     back only when a moderator restores it. Removed threads are listed in the panel.
   * REPORT under a post sends it, with a reason, to the queue in the admin panel; the
     queue keeps a copy of the post as it was when reported. A reader has one open
     report per post. Removing the post closes its reports.
   * Posting off: a moderator turns an account's posting off, with a reason and an
     optional end; the account still signs in, reads, reports and plays, and is told
     the reason when it tries to post (403 posting_disabled). It stops new threads,
     replies, edits and picture changes. Moderators do this to players only, admins to
     players and moderators. Separate from a suspension.
   * Categories (admins): add, rename, describe, reorder, choose who starts threads
     and who replies, hide and show; delete one when it is empty, or with its threads
     moved to another category first.

 Profile pictures
   * Under ACCOUNT, PROFILE PICTURE: a member uploads, replaces and removes their own.
     It shows beside their posts and on their profile; no picture shows
     assets/avatar-default.png. Moderators remove pictures of accounts below them.
   * The upload is the picture's own bytes, PUT /api/forum/avatar with Content-Type
     image/png, image/jpeg, image/webp or image/gif. A cross-site page cannot send such
     a request without a preflight, which this service never answers, and the Origin
     check of section 2 applies as on every PUT.
   * The format comes from the file's first bytes, never its name or the type it was
     sent as; SVG and everything else is refused. The size comes from the format's own
     headers: the picture, a GIF's logical screen, a WebP's canvas and every frame must
     fit pictureMaxSide, with at most pictureMaxFrames frames, so a small file cannot
     unpack into a huge picture in readers' browsers.
   * Kept of it (modules/forum/images.js, nothing decoded or re-encoded): PNG keeps
     IHDR, PLTE, IDAT, IEND and tRNS (so an animated PNG keeps its first frame); JPEG
     drops every APPn (EXIF with its GPS block, XMP, ICC, JFIF) but APP14, and COM;
     WebP drops EXIF, XMP and unknown chunks; GIF drops Comment and Plain Text
     extensions and every Application extension but NETSCAPE2.0 and ANIMEXTS1.0.
     Anything after the format's own end is dropped, so nothing appended to a picture
     is stored. EXIF's orientation goes with EXIF: a sideways photo stays sideways.
   * Stored as <dataDir>/modules/forum/avatars/<account id>-<version>.<ext> (never in
     the site), at most picturesAtOnce read at once (503 busy), the uploads limited per
     account, all pictures together within pictureQuotaBytes (507). A file nothing
     points at any more goes at the next start; a deleted account's goes at once.
   * Served at /api/forum/avatars/<id>?v=<version> with the checked Content-Type,
     X-Content-Type-Options: nosniff, Content-Security-Policy: default-src 'none',
     Cross-Origin-Resource-Policy: same-origin, and, for the current version,
     Cache-Control max-age=31536000, immutable (a new picture is a new version).

 Privacy and logs
   * No IP address is stored with a post, a thread, a report or a picture; the posting
     limits per address live in memory only.
   * Log lines: forum.thread, forum.post, forum.report, forum.picture, and
     forum.moderation for each moderator step, with the account and the thread or post
     number; never a title, a post's text, a password, a token or a cookie.
   * A deleted account's posts stay, shown as from a deleted account (every reference
     is ON DELETE SET NULL); its picture and posting switch go with it.

 The API (modules/forum/index.js's header lists every route): GET categories,
 categories/<slug>, threads/<id>, users/<name>, search, avatars/<id> (readers);
 POST categories/<slug>/threads, threads/<id>/posts, posts/<id>/report, preview;
 PATCH and DELETE posts/<id>; PUT posts/<id>/vote; PATCH threads/<id>; GET, PUT
 and DELETE avatar (members); and the moderators' and admins' routes, all under
 /api/forum/.


 16. THE ADMIN PANEL AND THE AUDIT LOG
 -------------------------------------
 havoc9.org/admin/ (admin/admin.js), for moderators and admins; the nav shows ADMIN
 to them (assets/account.js). The server checks every request: the link and the
 panel only show what a role may do. The panel's tabs: REPORTS (the forum's report
 queue: dismiss, or remove the post), FORUM (removed threads; categories, for
 admins), ACCOUNTS (the account list, then suspend, posting on the forum, remove a
 profile picture; admins open an account from the list and act on it), NAME CHANGES
 (the requests WAITING FOR A DECISION; SHOW DECIDED lists the ones approved, denied
 or cancelled), PRESENCE (admins, with the presence module: its flags, and one
 account's devices, RESET THE PLAYER ID and MOVE THE PLAYER ID, on
 /api/presence/admin/..., modules/presence/README.txt) and AUDIT LOG (admins).

 The account list: GET /api/admin/accounts?q=&sort=&role=&filter=&page=&per=
   * Shown as ACCOUNTS opens, newest first; sort oldest, lastlogin (the latest sign-in
     first) or name. Moderators get the players (the accounts they may act on), admins
     everyone. A row: username, role, joined, last sign-in, and SUSPENDED or POSTING OFF
     with its end. Nothing more: no address, no reason (the account's own page has the
     reason).
   * q: the start of a name, as it is typed, without regard to case or look-alikes
     (it matches username_key or username_skeleton, lib/usernames.js). role: user,
     moderator or admin. filter: suspended, or postingoff (the forum's switch, when
     the forum is there).
   * 50 a page by default, per up to 100. limits.adminListPerAccount (120 a minute per
     account) keeps a search-as-you-type from hammering the database.
   * An admin's click on a row opens the account; a moderator's fills its name into
     the suspend, posting and picture forms below.

 The rules (lib/admin.js)
   * Nobody acts on an account of their own role or above: so nobody suspends,
     deletes or demotes themselves, moderators act on players only, and admins on
     players and moderators.
   * Moderators: the report queue; locks, pins, moves, removals and restores; remove a
     profile picture; turn posting off and on; suspend a player for 1 to
     admin.modSuspendMaxDays (7) days, with a reason the player sees.
   * Admins: all of that, and list, search and open accounts; suspend for any time, and
     lift a suspension; sign an account out everywhere; reset a password (a random one,
     shown once in the panel); delete an account (typing its username exactly); move
     an account between player and moderator; approve or deny name changes; read the
     audit log.
   * Making an admin, or unmaking one, is for the admin command alone (section 11),
     so a stolen admin session can neither make admins nor lock the real ones out.
   * Reset password, delete, a role change, a suspension with no end and approving a
     name change need the acting admin's own password in that same request, and so do
     the presence module's reset-id and move-id (ctx.auth.confirmAdmin). The
     panel asks for it only then: a small prompt opens under the button, with one line
     saying why; the password goes with that one request and is not kept. It is
     checked with the sign-in hasher; wrong ones are limited by
     limits.reauthPerAccount (5 in 15 minutes, then a block of 15 minutes).
   * The panel's API is under /api/admin/ (lib/admin.js's header lists it): JSON only,
     the Origin check on every POST, no-store and the API's CSP on every answer, as
     everywhere else.

 The audit log (lib/audit.js; table audit_log, core migration 2)
   * One row for every moderator and admin action, from the panel, from the forum's
     tools and from the admin command ("(command line)"): when, who (and their name
     then), the action (account.suspend, account.role, account.rename,
     forum.post.remove, forum.posting.off, ...), the account acted on (and its name
     then, which outlives the account), what it was about (thread 3, post 12) and the
     reason or details. Never a password.
   * Admins read it in the panel, all of it or by a name. Rows older than
     admin.auditRetentionDays (90) are deleted every hour. The privacy note on the
     ACCOUNT page says so.

 Settings: config.json "admin": { ... }, all optional:
   modSuspendMaxDays    7    the longest suspension a moderator gives
   auditRetentionDays   90
   renameCooldownDays   30   section 17
   renameHoldDays       30   section 17
 and limits.reauthPerAccount, limits.renamePerAccount (section 2's format).

 For a module, ctx.audit.record({ actor, action, target, subject, detail }) adds a
 row (section 13): actor and target are accounts rows.


 17. USERNAME CHANGES
 --------------------
 lib/renames.js. A player asks for a new name under ACCOUNT, CHANGE USERNAME; an
 admin approves (with their own password) or denies it, with a reason the player
 sees, under NAME CHANGES in the panel; the admin command renames at once:
   $A rename <username> <new name>
 The new name passes the sign-up checks when it is asked for, and again inside the
 transaction that applies it: the username rules (lib/usernames.js); no other
 account's name in any case and no look-alike; no name still held. Two requests for
 the same name (or two look-alikes) can both wait; only the first approved gets it.
 On a change
   * username, username_key and username_skeleton change together; the account keeps
     its sessions, its player id (made from its uid, which never changes) and all it
     wrote (posts point at its id); the forum shows the new name at once;
   * the old name is held for admin.renameHoldDays (30): nobody else can sign up as
     it, as its look-alikes, or ask for it, so it cannot be taken at once to pass as its
     owner. Its owner may take it back;
   * the audit log records old and new (account.rename).
 A player has one request waiting at a time and may cancel it; after a change they
 ask again only after admin.renameCooldownDays (30). Requests are limited by
 limits.renamePerAccount (10 a day; a name that breaks the rules costs nothing). The
 admin command's rename has the same checks and hold, but no request and no
 cooldown, and cancels a request the account had waiting.
   GET    /api/account/rename    { request: the latest or null, cooldownUntil, holdDays }
   POST   /api/account/rename    { username }     201 { request }
   DELETE /api/account/rename    the waiting request, cancelled


 18. DISCORD: THE REGISTERED ROLE
 --------------------------------
 modules/discord/ (a module, section 13). A player links their Discord account to
 their HAVOC 9 account under ACCOUNT, DISCORD, once, and gets the registered role in
 H9's Discord (role 1566395367036035123). Only an admin frees a link (the admin panel,
 ACCOUNTS, an account, FREE THE LINK), for a player who lost their Discord account and
 needs to link another; freeing takes the role away. Players cannot replace or unlink
 a link themselves.

 How it works
   * One Discord application, the server-list bot's: its OAuth2, scope identify and
     nothing more, for the link; its bot token, through Discord's REST API, to give and
     take the role (PUT and DELETE /guilds/<guild>/members/<user>/roles/<role>, with an
     audit-log reason). serverlist-bot itself does not change.
   * SYNC YOUR DISCORD posts to /api/discord/sync (the Origin check applies). h9web
     makes a random state and a random binding value, keeps only their SHA-256, for one
     use and 10 minutes, sets the binding value as the cookie __Host-h9_dsync (HttpOnly,
     Secure, SameSite=Lax, Path=/, Max-Age=600), and sends the browser to Discord's
     consent page.
   * Discord sends the browser back to /api/discord/callback. The session cookie is
     SameSite=Strict and is not sent on that return from discord.com (and stays so), so
     the account is found by the state. The binding cookie is Lax, so it comes back on
     that top-level return, and it must match the state's (compared in constant time).
     The state is used up and the cookie cleared on every return; a missing, wrong or
     expired cookie or state links nothing, ends on the same "start again from ACCOUNT"
     page, and a refused cookie goes into the audit log (discord.link.refused). So a
     SYNC finishes only in the browser that started it: nobody can start one and get
     another player to finish it on Discord, linking that player's Discord to their own
     account. h9web exchanges the code, reads
     /users/@me, keeps the Discord user id and display name, and drops the token (it is
     never stored). Its answer is a small page that goes on to /account/ by itself, a
     same-site step that carries the session cookie again, where the player reads what
     happened.
   * Unique both ways: one Discord account per HAVOC 9 account, one HAVOC 9 account per
     Discord account. A Discord account linked elsewhere is refused with a clear message.
   * Not in H9's Discord yet: the link waits ("pending"), and the role follows once the
     player joins, at the next reconcile.
   * The reconcile, every reconcileMinutes (15): gives and takes the role to match the
     links (so a change made by hand in Discord is put back), takes it from freed links
     and deleted accounts, and from suspended accounts while suspensionRemovesRole is on;
     restoreOnUnsuspend gives it back when the suspension ends. With removeUnlinked on it
     also takes the role from members holding it with no link; off by default, so staff
     may give the role by hand. This process's own changes (a suspension, its lifting, a
     deletion from the panel) act at once; the admin command's wait for the reconcile.
     Admins run it at once with RECONCILE NOW in the panel.
   * Discord's rate limits: a 429 is waited out (Retry-After) and tried again.
   * Audit log: discord.link, discord.link.refused, discord.free, discord.role.give,
     discord.role.take. Log lines: discord.link, discord.link.refused, discord.free,
     discord.reconcile, discord.rate_limited and discord.off, never a secret, a code, a
     state, a binding cookie or a token.
   * The binding cookie needs a secure context, as the session cookie does: HTTPS, or
     http://127.0.0.1 and localhost on this PC (section 12).

 Setup on the VPS
   1. Discord Developer Portal, the server-list bot's application:
        * OAuth2, Redirects: add  https://havoc9.org/api/discord/callback  exactly;
        * note the Client ID, and copy (or reset) the Client Secret;
        * Bot: copy the bot's token (the bot serverlist-bot uses);
        * only for removeUnlinked: Bot, Privileged Gateway Intents, SERVER MEMBERS
          INTENT on (listing the server's members needs it).
   2. H9's Discord: the bot needs the Manage Roles permission, and the bot's own role
      must sit ABOVE the registered role in Server Settings, Roles: a bot only gives
      roles below its highest one. Copy the server's id (User Settings, Advanced,
      Developer Mode on; then right-click the server, Copy Server ID).
   3. The secrets, in a file of their own: never in config.json, git or the site.
        sudo -u h9web mkdir -p /var/lib/h9web/modules/discord
        sudo -u h9web nano /var/lib/h9web/modules/discord/secrets.json
            { "clientSecret": "...", "botToken": "..." }
        sudo chmod 600 /var/lib/h9web/modules/discord/secrets.json
      (or a file in /etc/h9web, owned by h9web, mode 0600, named in secretsFile). Never
      logged; a file that others can read is warned about at start.
   4. config.json: add "discord" to "modules", and
        "moduleSettings": { "discord": { "clientId": "<application id>", "guildId": "<server id>" } }
      then  sudo systemctl restart h9web. When something is missing, the log says
      discord.off and why (journalctl -u h9web | grep discord.off); the rest of the site
      runs either way, and ACCOUNT shows no DISCORD section.

 Settings: "moduleSettings": { "discord": { ... } }; clientId and guildId are needed:
   enabled                true
   clientId               the application's id (not secret)
   guildId                H9's Discord server's id
   roleId                 "1566395367036035123", the registered role
   redirectUri            "https://havoc9.org/api/discord/callback", as in the portal
   inviteUrl              "https://discord.gg/b76pqqVsNY", for players not in it yet
   reconcileMinutes       15
   removeUnlinked         false
   suspensionRemovesRole  true
   restoreOnUnsuspend     true
   secretsFile            <dataDir>/modules/discord/secrets.json
   apiBase, authorizeUrl  Discord's own; the tests point them at a stand-in

 The API
   GET  /api/discord/status            (signed in) { enabled, link, inviteUrl }
   POST /api/discord/sync              (signed in) { url }, Discord's authorize address
   GET  /api/discord/callback          Discord's return; a page that goes on to /account/
   GET  /api/discord/links/<name>      (admin) the account's link
   POST /api/discord/links/<name>/free (admin) { reason }
   POST /api/discord/reconcile         (admin) the reconcile, at once
   GET  /api/discord/admin             (admin) on or off, the counts, the last reconcile
