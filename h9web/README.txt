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
   * Discord linking and the registered role, a module too (section 18);
   * linking a downloaded game to an account with a code, and the linked games
     on the account page (section 19);
   * the P2P relay, a module too: joining a listen game without port
     forwarding, and the public list of such games (section 20).

 The pages that use it live in the site:
   havoc9.org/account/            the account page (and the privacy note)
   havoc9.org/account/login/      SIGN IN
   havoc9.org/account/signup/     CREATE ACCOUNT
   havoc9.org/account/forms.js    the three pages' script
   havoc9.org/link/               LINK A GAME: the code a game shows (section 19)
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
   19. Linking a game
   20. The P2P relay (modules/p2p)


 1. FILES
 --------
   server.js               the service: node server.js --config <file>
   bin/h9web-admin.js      admin tasks (section 11)
   bin/h9web-backup.js     backups, restores, JSON export and import
                           (section 10; lib/backup.js does the work)
   lib/app.js              puts it together
   lib/config.js           settings (DEFAULTS lists every one) and secrets
   lib/db.js               SQLite (node:sqlite), migrations, backups
   lib/auth.js             the shared auth layer: sessions, cookie, CSRF,
                           requireSession / requireRole / optionalSession
   lib/accounts.js         accounts, roles, suspensions, player ids
   lib/passwords.js        scrypt hashing and the password rules
   lib/datakey.js          the data key: encryption at rest (section 2)
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
   lib/link.js             linking a game to an account (section 19)
   lib/static.js           local testing only: serves the site (section 12)
   config.example.json     settings for the VPS
   servers.example.json    the server list's format
   backup.cmd              this PC's local site: a backup now (section 10)
   backup-task.ps1         the same on a schedule, Task Scheduler (section 10)
   modules/                where modules go: forum/ (section 15), discord/
                           (section 18), presence/ (its own README.txt),
                           p2p/ (section 20)
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
 Encryption at rest
   * <dataDir>/data.key (config "dataKeyFile" may name another place): 32
     random bytes, made on the first start with mode 0600 and never written
     again, apart from the database and its backups. lib/datakey.js seals with
     it (AES-256-GCM, a fresh nonce per value, the value's place as additional
     data) what must be read back but a copy of the database alone should not
     give away: a Discord link's Discord user id and display name (section 18),
     found through a keyed index, never stored in the clear. Modules get it as
     ctx.dataKey (section 13); the key itself never leaves core.
   * What else is stored needs no reading back or is public anyway: password
     hashes (scrypt, peppered), session token hashes, player ids (computed
     from secrets.json, never stored), the presence module's hashed devices and
     networks; usernames, forum posts and pictures. No email address, no IP
     address with an account, no Discord or other OAuth token.
   * The database, its -wal and -shm files and every backup are mode 0600, the
     data folder and its backups/ 0700 (lib/db.js, the unit's UMask=0077).
   * A damaged data.key stops the start, as a damaged secrets.json does. With
     another data.key than the links were sealed with, Discord linking turns
     itself off and keeps the links until the right file is back (section 10).
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
                       map, mode, players, max, bots, ping_ms, online,
                       requireAccount }] }: the
                       listed servers that answered lately, the shape
                       servers/index.html reads (data-master="/api/servers").
                       name is the server's own hostname (servers.json's name
                       when it has none). A query and its retry that go
                       unanswered make it online: false (players 0, ping
                       null) until status.expireSeconds after its last answer;
                       then it leaves the list, and its next answer brings it
                       back. requireAccount: the server's rules (A2S_RULES,
                       read every status.rulesSeconds, 60) say h9_require_account
                       1; rules that go unanswered count as not required;
                       a module may leave some out (ctx.servers.hideFromBoard:
                       the presence module, a private community's servers)

 Username changes: section 17. The admin panel's API: section 16. The
 forum's: section 15. Linking a game (/api/link/...): section 19.

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
 it), and keep it nowhere. A player who wants the downloaded H9XASH to count as
 the same player links it (section 19: a code, no id to paste), or, the older
 way, puts the id into H9XASH\user_id.ini with enter_userid.cmd
 (docs\CUSTOM_XASH_USERID.txt, sections 2 and 2a); the game keeps it protected
 either way. Optional: H9XASH's own random id keeps working. Whoever has the id is that player to H9's servers, so the
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
       /var/lib/h9web/           data: secrets.json, data.key, h9web.db,
                                 backups/ (the service's user, 0700; files 0600)
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
       dataDir /var/lib/h9web, serversFile /etc/h9web/servers.json,
       modulesDir /opt/h9web/modules (a relative path counts from the config
       file's folder, so without it the modules would be looked for in
       /etc/h9web/modules).
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
     It also makes /var/lib/h9web/data.key (mode 0600; log line datakey.created),
     the key of the encryption at rest (section 2). Back it up offline as well,
     apart from the database's backups (a backup and its key in one place is a
     backup anyone can open):
       sudo cat /var/lib/h9web/data.key
     Losing it loses only the Discord links (players link again; section 10).
     /etc/h9web needs no secret: config.json and servers.json hold none, so
     root-owned 0644 is fine there; the Discord secrets file, if it is put in
     /etc/h9web, is owned by h9web with mode 0600 (section 18).
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
         client_max_body_size 128k;
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

 Backups: bin/h9web-backup.js, run as the service's user with the service's
 config. Each backup is one file,
   h9web-<host>-<yyyyMMdd-HHmmss>.h9backup     (UTC; <host> from allowedOrigins)
 a gzip'd tar of manifest.json (the time, the host, the h9web version, each
 module's migration version, every table's row count, the SHA-256 of every
 file), the database (VACUUM INTO: consistent while the service runs; never
 copy h9web.db itself while it runs, its -wal file holds the newest writes)
 and <dataDir>/modules (the forum's pictures, the presence keys ...). Never
 in it: <dataDir>/backups (the copies made before migrations, restores and
 imports). secrets.json, data.key and a module's secrets.json (Discord's)
 only with --with-keys, which needs --encrypt: the database and its keys in
 one plain file would undo the encryption at rest (section 2). Back the keys
 up once, offline, apart from the backups (section 7).

   B="sudo -u h9web /usr/bin/node /opt/h9web/bin/h9web-backup.js --config /etc/h9web/config.json"
   $B backup [--out DIR] [--keep N]    a backup into DIR (default
                                       <dataDir>/backups); --keep N deletes
                                       this host's oldest ones there beyond N
   $B backup --encrypt [--with-keys] [--passphrase-file FILE]
                                       sealed: AES-256-GCM, its key from the
                                       passphrase by scrypt
   $B list [--out DIR]                 the backups in DIR, checked, with their
                                       versions and counts
   $B verify <file>                    one backup checked through: checksums,
                                       the database's quick_check, its rows
                                       against the manifest
   $B restore <file> [--only PART[,PART]] [--yes] [--allow-other-keys]
   $B export --only forum|community [--format json] [--out FILE]
   $B import <file.json> [--only forum|community] [--yes]
 The passphrase comes from H9WEB_BACKUP_PASSPHRASE or the first line of
 --passphrase-file (12 characters or more), never from the command line;
 list, verify and restore of an encrypted backup need it too. A wrong one is
 refused, as is a backup whose files do not match its manifest.

 restore and import change data, so each of them
   * refuses while h9web runs on that data (its database open in another
     process, or its listen port answering): stop it first, sudo systemctl
     stop h9web (on this PC: Ctrl+C in the local site's window);
   * checks the whole backup first, then copies the data as it is to
     <dataDir>/backups/pre-restore-<time>.h9backup (pre-import-...): undoing
     it is restoring that file;
   * shows what it will do and asks for "yes" in a terminal; elsewhere it
     needs --yes. It prints the rows per table afterwards.
 A restore brings back the sessions the backup holds, so a session revoked
 since then (a password reset, a revoke-sessions, a sign-out everywhere)
 works again. After restoring past a security incident, revoke sessions
 before the service starts: one account's with $A revoke-sessions <name>
 or reset-password (section 11), or everyone's, the service stopped:
   sudo -u h9web /usr/bin/node -e "const { DatabaseSync } = require('node:sqlite'); console.log(new DatabaseSync('/var/lib/h9web/h9web.db').prepare('DELETE FROM sessions').run().changes)"
 A whole restore replaces the database and <dataDir>/modules. Keys: a backup
 made --with-keys brings its own (the ones in place are kept beside them as
 <name>.pre-restore-<time>); otherwise the ones in place stay and must be
 the ones the backup was made with (the manifest names them by a hash):
 another secrets.json, or none, is refused (every password and player id
 would fail) unless --allow-other-keys; another data key is a warning (the
 Discord links stay sealed until it is back).

 restore --only PART puts back one part and leaves the rest as it is, in one
 transaction, with the backup's database attached:
   forum       the forum_ tables, and <dataDir>/modules/forum (the pictures)
   community   the communities: presence_communit... and every presence
               table that refers to them (staff, members, requests, invites,
               linked servers, sanctions, kicks, chat and announcements, the
               shared data and its log); no files
   accounts    core's tables: accounts, sessions, the audit log, username
               requests and held names
   <module>    a module's tables (presence, discord) and its files
 Tables are found by name (a module's are <module>_...), so a module's new
 tables join its part without a change here. A part is restored only
 between the same migration version of its module (the manifest has them);
 with another h9web, run the one the backup was made with, restore, then
 update, or restore the whole backup. A row put back whose account no
 longer exists is handled as the module handles a deleted account: ON
 DELETE CASCADE rows (votes, signatures, memberships, requests, invites,
 pictures) are left out, ON DELETE SET NULL references (a post's author, who
 invited) are cleared, so the post shows as from a deleted account; restore
 prints the counts. --only accounts does the same to every module's rows of
 the accounts it takes away.

 export and import move the forum or the communities to another h9web as
 JSON, readable, one row per line, accounts named by username:
   $B export --only forum --out /var/lib/h9web/forum.json
   (copy it over)    $B import forum.json
 import replaces that part of the target with the file's, mapping each
 username to the target's account of that name; it makes no account. A name
 with no account there is a deleted account: its own rows (votes,
 signatures, posting restrictions, memberships, requests, invites) are left
 out, and where someone else's row names it (a post's or a thread's author,
 who added, invited or moderated) the name is cleared, so its posts show as
 from a deleted account. Profile pictures are not in an export (files named
 by account id): the target keeps its own; they move with a backup. Both
 sides need the same migration version of the module (the export says
 which). import refuses while h9web runs, takes a safety backup first, works
 in one transaction and prints each table's rows before and after, and what
 was left out or cleared.

 On the VPS: the daily timer, encrypted copies off the machine, restoring on
 a new VPS and the order of a move are in havoc9.org/webclient/DEPLOY.txt,
 section 13. On this PC (the local site that local-site.cmd starts):
   backup.cmd                    a backup now, into
                                 %USERPROFILE%\Documents\h9web-backups (the
                                 newest 30 kept); double-click it
   backup-task.ps1 -Install [-Time 04:00] [-Daily|-Hourly] [-Out DIR] [-Keep N]
                                 the same in Task Scheduler, as you, only
                                 while you are signed in (no stored
                                 password, no admin); each run logged to
                                 h9web-backup.log beside the backups
   backup-task.ps1 -Status | -RunNow | -Remove        (-WhatIf: show only)
 docs/H9WEB_ADMIN.txt section 18 is the short version for admins.

 After an update that seals values that were stored in the clear before (the
 Discord links: the log says discord.sealed), the older backups and the
 backups/pre-migrate-*.db copy still hold them in the clear: once the new
 start is checked, delete those (the timer's --keep 14 does it in time).

 A plain .db copy (h9web-admin backup, backups/pre-migrate-*.db) goes back by
 hand: stop the service, copy it over /var/lib/h9web/h9web.db, delete
 h9web.db-wal and h9web.db-shm, chown h9web:h9web and chmod 600 it, start.
 secrets.json and data.key must be the ones it was made with.

 The data key lost (data.key gone or damaged, and no copy):
   * A damaged file stops the start (log: datakey ... is not a data key).
     Restore the copy; nothing else can open what it sealed.
   * With no copy: move the damaged file away and start; a new data.key is
     made, and the log says discord.datakey: Discord linking is off, the links
     are kept. To give them up: "dropUnreadable": true in moduleSettings.discord,
     restart (log: discord.dropped; the audit log too), take the setting out
     again; their players link again under ACCOUNT. Their Discord role stays
     until removeUnlinked takes it or staff do.
   * A data.key restored over a new one: restart; the links open again and
     linking is back on.


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
 serve folders as the site, on this PC only.

 The launcher is bin/local-site.js. From the root of a checkout that has
 havoc9.org beside h9web it sets all of this up at every start and runs the
 service (docs\WEBSITE.txt, section 2, is its guide):

   node h9web/bin/local-site.js --port 8090
   h9web\local-site.cmd                    the same, and it opens the browser

   --port N       the port (default 8090; H9WEB_PORT sets another default)
   --stage DIR    the web client package; else H9WEB_STAGE, else
                  webclient-build\stage in the checkout
   --files DIR    the packages folder behind /downloads/files/ (below)
   --open         open the site in the default browser

 It serves havoc9.org as it is, every module in modules/ that has an
 index.js, and the web client at /webclient/. This PC's accounts, secrets and
 settings stay outside the checkout, in %LOCALAPPDATA%\h9web-local
 (~/.h9web-local elsewhere; H9WEB_LOCAL names another folder). Take a free
 port (Steam's web helper can hold 127.0.0.1:8080) and give the game the same
 one: cl_h9_site 127.0.0.1:8090 in its console.

 By hand, the same thing: a config.json beside server.js (git-ignored):

   {
     "listen": { "host": "127.0.0.1", "port": 8090 },
     "allowedOrigins": ["http://127.0.0.1:8090"],
     "dataDir": "./data",
     "serversFile": "./servers.json",
     "scrypt": { "ln": 15, "r": 8, "p": 3 },
     "devStatic": {
       "/": "../havoc9.org",
       "/webclient/engine/": "../webclient-build/stage/engine",
       "/webclient/game/": "../webclient-build/stage/game",
       "/downloads/files/": { "dir": "../dist", "listing": true }
     }
   }

 and a servers.json naming a LAN server, then node server.js and
 http://127.0.0.1:8090/. Browsers keep Secure cookies on http://127.0.0.1
 and localhost. On another machine without HTTPS add
 "insecureCookies": true (never on the VPS). Ctrl+C stops it.
 No folder is listed but one given as { "dir", "listing": true }: the
 downloads' file index, as the VPS serves /downloads/files/ (the .zip, .exe
 and .txt files in it, read-only; no dot files, subfolders or links).
 bin/local-site.js (local-site.cmd) does all of this by itself; its
 --files <folder> names the packages folder (dist\ in the checkout when
 there is one).


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
               activeSince(unixSeconds) -> the account ids with one since then,
               leaving out any signed out after it;
               signedOutAt(accountId) -> unix seconds its last live session
               ended (signing out, or every session revoked), or null
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
               mode, players, max, bots } from the last A2S answer, or null;
               hideFromBoard(fn): fn(address) -> true keeps that server off the
               site's server board (/api/servers) for as long as fn answers so
               (it stays in servers.json, the relay and the master's list; a fn
               that throws hides nothing); returns a function that takes the
               filter away. The presence module hides private communities'
               servers with it
   db          the shared node:sqlite DatabaseSync (foreign keys on, WAL);
               transaction(fn) runs fn in BEGIN IMMEDIATE ... COMMIT
   limits      RateLimiter({ max, windowSeconds, blockSeconds,
               maxBlockSeconds }).hit(key) -> { ok, retryAfter },
               TokenBucket, ipKey(ip)
   http        HttpError, sendJson, readJson, clientIp(req)
   audit       record({ actor, action, target, subject, detail }): a row in
               the audit log (section 16); actor and target are accounts rows
   dataKey     encryption at rest with the data key (section 2, lib/datakey.js):
               seal(text, purpose) -> "h9e1...." to store; open(sealed, purpose)
               -> the text, or throws (code other_key, damaged or not_sealed);
               index(text, purpose) -> 64 hex, to look a value up or keep it
               unique without storing it; keyIdOf(sealed), keyId. purpose names
               the value's place (a-z 0-9 . _ -, such as "discord.user"): a
               value opens only for the purpose it was sealed with. For what
               must be read back but a copy of the database should not show
   events      account-created { id }, account-role { id, role },
               account-banned { id, until }, account-unbanned { id },
               account-password { id }, account-deleted { id, username }
               (before the row goes), session-ended { tokenHash },
               account-sessions-ended { accountId }, account-renamed
               { id, from, to }, account-player-id { id } (resetPlayerId,
               movePlayerId), account-link { id, link, device } (a game was
               linked to the account; device its device hash, presence's
               form, or null) and account-unlink { id, link, device, reason }
               (reason revoked, unlinked, replaced or player-id; section 19);
               from the relay: relay-open { accountId },
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

 Run it to see how many tests there are and how long they take. They are
 light on the CPU (scrypt at a test cost), and the tests in the files below
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
   forum-media.test.js the MEDIA page: YouTube links (good and bad), posting and its
                       rules, comments for members only, staff pin, hide and remove
                       (audit log, hidden for staff only), the front page's limit and
                       the archive at the boundary, search, CSRF, rate limits, the
                       page's CSP against the code; hidden threads everywhere
   forum-needs.test.js the "What we need" page: anyone reads it, its editors save it
                       (needsEditors, the audit log, CSRF), its checks, the preview,
                       pictures by the post rules; the Suggestions category, once;
                       the DEVELOPER flag (admins only, the audit log, the views, with
                       a role, editing the page and nothing more)
   forum-signatures.test.js  signatures: the settings and their ranges, the markup
                       (no code blocks or quotes, the picture cap, plain text for
                       new accounts), the limits, SHOW SIGNATURES, removed posts,
                       posting off, suspension, CSRF, clearing and blocking
   forum-images.test.js  pictures in posts: listed https hosts only, imgur links,
                       albums as links, the alone-on-a-line rule, the limit at the
                       default and a custom value, the HTML, the CSP agreeing with
                       IMAGE_HOSTS, REMOVE PICTURE
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
   backup.test.js      h9web-backup: a backup while the database is open, the
                       manifest and checksums, a changed archive refused,
                       encryption and a wrong passphrase, keys only encrypted,
                       --keep, restore refused while the service runs, a whole
                       restore and the keys check, --only forum, community
                       and accounts leaving the rest alone, a version mismatch
                       refused, the JSON export and import by username, the
                       safety backups, nothing written inside the checkout
   p2p.test.js         the P2P module inside the real service (section 20): off
                       by default and when unfinished, a linked game's token
                       opens a session, signed host calls, the invite a friend
                       redeems, the UDP socket answering a signed HELLO, the
                       public list on both paths, the guest invite behind the
                       CSRF guard with the visitor's account, an account that
                       is suspended or unlinked losing its sessions at once,
                       and stopping h9web closing the port. Needs the p2p
                       folder beside h9web (../p2p), as in the repository


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
   to 10, after a copy of the database) and eight categories: Announcements (only
   moderators and admins start threads), General, Servers (the servers, Match Mode and
   organising games), Roleplay, Modding (maps, models, sounds, plugins), Support (the
   web client, H9XASH, getting the game to run), Off-topic, Suggestions (ideas for the
   game and the site; migration 7 adds it unless a category with its address exists).
   Their addresses: announcements, general, servers, roleplay, modding, support,
   off-topic, suggestions. Admins change them in the admin panel.
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
   Without it nginx refuses a picture over 128 KiB with its own 413 page.
   location /api/'s client_max_body_size 128k is sized for a game server's presence
   report with all 128 slots filled (about 82 KiB at most); it also holds a
   10,000-character post in any script.

 Settings: config.json "moduleSettings": { "forum": { ... } }, all optional:
   guestRead           true        guests read the forum (false: members only, 401)
   threadsPerPage      25
   postsPerPage        20
   titleMax            120         characters in a title
   postMax             10000       characters in a post
   editWindowMinutes   60          how long authors may edit a post or their title
   newAccountHours     24          accounts younger than this post more slowly
   maxImagesPerPost    25          pictures a post shows (0 to 200); the ones after
                                   that stay links. For example:
                                   "moduleSettings": { "forum": { "maxImagesPerPost": 40 } }
   signatureMaxChars   300         characters in a signature (0 to 2000; 0 switches
                                   signatures off)
   signatureMaxLines   4           its lines (1 to 20)
   signatureImages     1           pictures in it (0 to 10; 0: none)
   signatureImageHeight 100        how tall a signature's picture shows, in px (16
                                   to 480). For example:
                                   "moduleSettings": { "forum": { "signatureMaxChars": 500,
                                     "signatureMaxLines": 6, "signatureImages": 0 } }
   needsEditors        ["moderator", "developer"]   who edits the "What we need"
                                   page besides admins: moderators, accounts with the
                                   DEVELOPER flag, both, or neither ([]: admins only), e.g.
                                   "moduleSettings": { "forum": { "needsEditors": ["developer"] } }
   mediaFrontCount     30          the MEDIA page shows the pinned posts and this many
                                   others (1 to 200); older ones are in the archive, by
                                   month, e.g. "moduleSettings": { "forum": { "mediaFrontCount": 50 } }
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
     signature   10 changes an hour        signaturePreview 120 in 5 minutes
     needs       30 saves an hour          needsPreview 120 in 5 minutes
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
   and get rel="nofollow ugc noopener noreferrer". Text is cleaned on the way in: control characters, the bidi override and
   isolate characters, zero-width spaces and other invisible fillers are dropped, NFC,
   at most 4 combining marks on a character, and a lone surrogate becomes U+FFFD.
   A post is rendered when read, the latest 400 texts kept in memory.
   PREVIEW: every composer (a new thread, a reply, an edit, a wall comment, a MEDIA
   description or comment) switches between WRITE and PREVIEW. The preview is the
   server's own view of the text as it would be saved, drawn by the page's own code
   for saved ones: POST preview answers the post view a thread page gets (postView:
   the author block, the signature, the number it would get; for an edit, the post's
   author, votes and EDITED), POST wall/preview a wall comment's view, POST
   media/preview a MEDIA comment's view or a description's tree. Nothing is stored;
   sign-in, the posting size limits and the preview rate limit hold. The ACCOUNT
   page's signature preview is drawn by forum/forum.js too (window.H9Forum).

 Pictures in posts: links to pictures on other sites, shown from there
   * ![words](https://...) shows a picture, and so does a picture link alone on its
     line (its path ending in .png, .jpg, .jpeg, .gif, .webp or .avif), when it is
     https on one of the picture hosts: markup.js IMAGE_HOSTS, by default
     i.imgur.com, i.redd.it, i.postimg.cc, i.ibb.co, media.giphy.com, i.giphy.com,
     upload.wikimedia.org and images.steamusercontent.com. An imgur link to one
     picture (imgur.com/<id>) shows https://i.imgur.com/<id>.png, and .gifv shows as
     .gif; imgur albums and galleries, every other address, and a link inside a
     sentence stay links. The words between [ ] are its alt text.
   * Nothing is uploaded or copied: a reader's browser loads the picture from its host,
     which sees the reader's address as any site does. The <img> sends no Referer
     (referrerpolicy no-referrer), loads lazily, fits the post's width and about
     480 px of height, and a click opens it in a new tab (noopener noreferrer); one
     that does not load shows as its link. The tree names only https addresses on the
     list, and toHtml checks again.
   * A post shows at most maxImagesPerPost pictures (25); the ones after stay links,
     and saving such a post (and the preview) answers a note that says so.
   * The forum pages' Content-Security-Policy (img-src in havoc9.org/forum/index.html
     and forum/*/index.html) names the same hosts, so a picture from anywhere else
     never loads. To change the list, change IMAGE_HOSTS in modules/forum/markup.js
     and img-src in those five pages together; test/forum-images.test.js fails while
     the two differ.

 The "What we need" page (modules/forum/needs.js; migration 8, forum_needs)
   * havoc9.org/join/needs/ (linked from JOIN): what the team is looking for right now.
     A title, an intro, and items, each with a category (maps, models, sounds, code,
     art, direction, other), a status (needed, in_progress, done), a title and a
     description; the page lists them by status, needed first.
   * Anyone reads it: GET /api/forum/needs (with canEdit for the reader). Its editors
     (admins, and whom needsEditors names: moderators and developers by default) edit
     it in the admin panel's WHAT WE NEED tab or with EDIT THIS PAGE on the page, with a live preview (POST
     /api/forum/needs/preview) and SAVE (PUT /api/forum/needs, the whole page), each
     save in the audit log as forum.needs.edit. At most 50 items; the intro 4000
     characters, a description 2000.
   * The intro and the descriptions take the forum's markup with the post rules for
     pictures (https on IMAGE_HOSTS, maxImagesPerPost in each text), shown from their
     host; the page's CSP (and the admin panel's, for the preview) lists the same
     hosts, and test/forum-images.test.js checks it. It has
     the forum pages' CSP with img-src 'self'. The page is one row of JSON: the
     backup tool carries it with the forum's tables.

 The MEDIA page (modules/forum/media.js; migration 10, forum_media_posts and
 forum_media_comments)
   * havoc9.org/media/ (MEDIA in the header): members post YouTube videos of their
     games: a title, a link (youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, and
     youtube-nocookie.com/embed/; anything else is refused) of which only the
     11-character video id is kept, and an optional description in the forum's markup
     without pictures. The forum's posting rules hold: signed in, not suspended,
     posting on; a media post counts as a thread and a comment as a post for the
     limits, with the slower ones for new accounts.
   * The page shows i.ytimg.com's picture of each video; nothing loads from YouTube
     until a visitor presses play, which puts youtube-nocookie.com's player in its
     place. The page's CSP has img-src 'self' https://i.ytimg.com and frame-src
     https://www.youtube-nocookie.com (media.js THUMB_HOST and EMBED_HOST;
     test/forum-media.test.js checks they agree).
   * The front page: every pinned post, then the newest mediaFrontCount (30) others;
     no endless scrolling. Older posts are in the ARCHIVE, linked by year and month,
     each month 20 a page. A title search (every word, at most 30, newest first). Every
     post keeps its own page (media/?p=<id>) and its comments for good.
   * Comments: for members only, never guests (a guest sees how many there are and
     SIGN IN); the forum's markup without pictures; edit your own within
     editWindowMinutes, remove your own; staff remove any.
   * Staff (moderators and admins): PIN / UNPIN, HIDE / UNHIDE and REMOVE on each post,
     inline on the page. A hidden post is seen only by staff, marked HIDDEN, on the
     front page and in the archive alike; a removed one by nobody. The author may edit
     within editWindowMinutes and remove their own. The audit log has forum.media.pin,
     .unpin, .hide, .unhide, .remove, .edit, and forum.media.comment.edit and .remove
     for staff acting on someone else's.
   * API (under /api/forum/): GET media, media/archive/<year>/<month>, media/search,
     media/<id>; POST media, media/<id>/comments, media/preview; PATCH and DELETE
     media/<id> and media/comments/<id>.

 Profile walls (modules/forum/wall.js; migration 11, forum_wall_comments and
 forum_walls)
   * A member's page (forum/user/?u=<name>, also what a double-click on a player opens
     in game) has a WALL: comments from any member in good standing, on another's wall
     or their own, in the forum's markup with pictures, drawn as posts are (the post
     author block: picture, name, level badge, tags). The owner's pins first (the
     latest pin first), then the newest; postsPerPage a page (?wall=N).
   * Writing follows posting: signed in, not suspended, posting on, the post size
     limit, the post rate limits per account and per address (a comment counts as a
     post, slower for new accounts) and wallFlood, a limit per wall from everyone
     together. PREVIEW in the composer (POST wall/preview).
   * The author edits within editWindowMinutes (EDITED shows) and deletes; the owner
     PINs at most 5 (a 6th is refused: unpin one first), deletes any comment on their
     wall, and turns the wall off (nobody writes or edits there; the page says so) or
     on. Deletes by the author or the owner are for good.
   * Moderators and admins, on accounts below their own role: REMOVE with a note (the
     comment stays as "Removed by a moderator", its text for staff only, its pin
     gone; forum.wall.remove in the audit log, in the author's trail) and TURN OFF
     POSTING beside each comment (the forum's own sanction, forum.posting.off).
   * Deleting an account deletes its wall and its comments on walls.
   * API (under /api/forum/): GET, POST and PUT users/<name>/wall; POST wall/preview;
     PATCH and DELETE wall/<id>; PUT wall/<id>/pin; POST wall/<id>/remove.

 The DEVELOPER flag (migration 9, forum_developers)
   * A flag, not a role: it goes with player, moderator or admin alike (a developer may
     also be a moderator), so the role hierarchy stays as it is.
   * Admins give and take it in the admin panel: ACCOUNTS, open the account,
     DEVELOPER, MAKE DEVELOPER or REMOVE DEVELOPER (GET, POST and DELETE
     /api/forum/developers/<name>), into the audit log as forum.developer.add and
     forum.developer.remove.
   * The forum shows the name in purple (#be8cff, the site's purple) with a DEVELOPER
     tag: beside posts, in thread lists (started by, last by), on the front page's
     latest thread, on the thread page and on the member page (ROLE says Player,
     Developer and the like). A quote's "wrote:" line is text the writer can change, and
     the player card is the presence module's: neither is coloured.
   * Its one power: editing the "What we need" page (needsEditors). No moderation.

 Signatures (modules/forum/signatures.js; migration 6, forum_signatures)
   * ACCOUNT, FORUM SIGNATURE: a member writes a few lines, sees them as the forum will
     (a live preview from POST /api/forum/signature/preview) and saves them (PUT
     /api/forum/signature { signature }). Within signatureMaxChars and
     signatureMaxLines; refused while posting is off, while a moderator blocks it, and
     for a suspended account (the guard); limits.signature per account.
   * The post markup in one paragraph (markup.js parseSignature): bold, italic,
     `code`, links, and up to signatureImages pictures from the picture hosts, shown
     with the post rules (https, no Referer) no taller than signatureImageHeight. No
     code blocks or quotes: those marks stay text. An account younger than
     newAccountHours shows it as plain text, links and pictures as written.
   * Shown under each of the author's posts below a thin rule, muted, and on the
     member page; never under a removed post, never inside a quote (QUOTE takes the
     post's text only). A reader who turns SHOW SIGNATURES off (PUT
     /api/forum/signature { showSignatures: false }) gets nobody's.
   * Moderators, on accounts below their own role, into the audit log: CLEAR
     SIGNATURE (in the post's author box, or on the member page; POST
     /api/forum/signatures/<name>/clear { reason }: forum.signature.clear), and BLOCK
     SIGNATURE (member page; POST .../block { reason, days }, no days for no end:
     forum.signature.block; DELETE .../block lifts it: forum.signature.unblock). While
     blocked, the account cannot set one and its signature is not shown; lifting the
     block shows it again unless it was cleared.

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
     and admins can still reply); hide and unhide; rename; move to another category;
     remove and restore. Posts: edit, remove and restore.
   * HIDE (migration 10, forum_threads.hidden_at): a hidden thread is seen only by
     moderators and admins, marked HIDDEN in the lists and on the thread, and left out
     of everyone else's lists, counts, latest thread, search and profiles (404 for
     them, its author included). PATCH /api/forum/threads/<id> { hidden }; in the
     category list's row tools, the MODERATE bar, and on the thread's first post (HIDE
     THREAD); forum.thread.hide and forum.thread.unhide in the audit log. The same
     staff (moderators and admins) as pin, lock and remove.
   * REMOVE PICTURE under a picture takes that one
     picture out (POST /api/forum/posts/<id>/pictures/remove { src, reason }): each
     place the post shows it becomes "(picture removed by a moderator)", as an edit by
     the moderator, and the audit log has forum.post.picture.remove.
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
     is ON DELETE SET NULL); its picture and posting switch go with it, and so do its
     wall and its comments on walls.

 The API (modules/forum/index.js's header lists every route): GET categories,
 categories/<slug>, threads/<id>, users/<name>, search, avatars/<id> (readers);
 POST categories/<slug>/threads, threads/<id>/posts, posts/<id>/report, preview;
 PATCH and DELETE posts/<id>; PUT posts/<id>/vote; POST posts/<id>/pictures/remove; GET and PUT signature, POST signature/preview,
 POST signatures/<name>/clear, POST and DELETE signatures/<name>/block; PATCH threads/<id>; GET, PUT
 and DELETE avatar (members); the walls' (above); and the moderators' and admins' routes, all
 under /api/forum/.


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
     /users/@me, keeps the Discord user id and display name (sealed, below), and drops the token (it is
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
   dropUnreadable         false; true only when data.key is lost for good: links
                          another data key sealed are deleted at start (section 10)
   secretsFile            <dataDir>/modules/discord/secrets.json
   apiBase, authorizeUrl  Discord's own; the tests point them at a stand-in
   relayPollSeconds       3: how often each bridged channel is read (below)
   relaySendMs            1200: the least time between two of the bot's messages
                          in one bridged channel

 The community relay: the same bot carries a community's chat to the Discord
 channel an H9 admin bridged with it, and back (docs\H9_COMMUNITIES.txt section
 3a). The presence module asks over core's events (modules\presence\README.txt
 lists them); only this module holds the token. It needs the secrets file, not
 clientId or guildId, and in Discord's developer portal the bot's MESSAGE CONTENT
 intent; in the channel, View Channel, Read Message History and Send Messages.
 Lines go out with every mention switched off and Discord's markdown escaped.

 At rest: each link's Discord user id and display name are sealed with the data
 key (section 2), the user id found through a keyed index; the audit log names a
 Discord account as "Discord account #<12 hex>" (a prefix of that index), never by
 its id or name. Links from before are sealed at the first start of this version
 (log: discord.sealed); the older backups still hold them in the clear (section 10).

 The API
   GET  /api/discord/status            (signed in) { enabled, link, inviteUrl }
   POST /api/discord/sync              (signed in) { url }, Discord's authorize address
   GET  /api/discord/callback          Discord's return; a page that goes on to /account/
   GET  /api/discord/links/<name>      (admin) the account's link
   POST /api/discord/links/<name>/free (admin) { reason }
   POST /api/discord/reconcile         (admin) the reconcile, at once
   GET  /api/discord/admin             (admin) on or off, the counts, the last reconcile


 19. LINKING A GAME
 ------------------
 The downloaded game (H9XASH) gets its account's player id without anyone
 typing or pasting it: a device code, in RFC 8628's shape (lib/link.js; the
 engine's side is engine-h9-link.patch, docs\CUSTOM_XASH_USERID.txt section 2a).
   1. The game asks for a code: GET /api/link/start. It shows the user code
      (WDJB-MJHT: 8 letters with no vowels and no digits) and opens
      havoc9.org/link/?code=... in the browser when the player asks.
   2. The page (havoc9.org/link/, signed in) shows what is asking: the game's
      own word for itself (H9XASH on Windows, or under Wine or Proton), when it
      asked, and whether it asked from the network the browser is on. LINK or
      NOT ME.
   3. The game polls GET /api/link/poll every interval seconds. Once LINK is
      pressed, the next poll is answered, once, with the account's player id,
      its username and a link token, and the code is spent.
 Core, not a module: the player id leaves core only here, to the holder of the
 device code its signed-in owner approved, as it does in GET /api/player for the
 web client; modules never see a player id (section 13).

 The game's routes are GETs, with no session and no Origin: the engine's HTTP
 client sends GET only and reads a body only from a 200, so every outcome the
 game acts on is a 200 with a status:
   GET /api/link/start?v=1&device=<32 hex>&os=windows|wine
       { status: "ok", userCode, deviceCode (43 base64url), interval (5),
         expiresIn (600), linkUrl }
       { status: "busy", retryAfter }   too many codes from this address
   GET /api/link/poll?code=<deviceCode>
       { status: "pending" }   { status: "slow_down", interval }
       { status: "approved", playerId, account, token }   once
       { status: "denied" }    NOT ME, or the account suspended meanwhile
       { status: "expired" }   no such code, out of time, or spent
   GET /api/link/status?token=<token>   once a start of a linked game
       { status: "linked", account } or { status: "unlinked" }
   GET /api/link/unlink?token=<token>   the game's h9_unlink: { status: "unlinked" }
   GET /api/link/adopt/nonce?v=1        { status: "ok", nonce } (32 hex, one use,
                                        adoptNonceSeconds)
   GET /api/link/adopt?v=1&key=<32 hex>&nonce=<32 hex>&devmask=<32 hex>&proof=<64 hex>&os=
       a game that holds an account's player id already (enter_userid.cmd, or an
       id from before linking) proves it and is linked, with no code to approve:
       key = HMAC-SHA256(the player id, "h9adopt-key1"), first 32 hex (core's
       adoptIndex, lib/clientids.js, finds the account by it); devmask and proof are
       the presence ID proof's (docs\H9_PRESENCE.txt section 8) for that nonce with
       S = "h9link-adopt", checked with accounts.verifyIdProof. The raw id never
       travels.
       { status: "linked", account, token }   bound to the device the proof unmasks
       { status: "unknown" }                  the id is no account's
       { status: "refused", reason }          stale (no such nonce, or used),
                                              bad_proof, suspended, second_device
                                              (with the presence module: the account's
                                              id is bound to another device there, and
                                              an admin has not allowed this one),
                                              bad_request
   GET /api/link/profile/<account>      the scoreboard's double-click on a linked
       player's picture (the engine's h9_profile, engine-h9-avatars.patch), opened
       in the web browser: 302 to the account's forum profile,
       /forum/user/?u=<username> (Cache-Control no-store: a rename moves it), whose
       card shows only what the account's privacy switches let others see; 404
       not_found for no such account, 2147483647 (the default picture's) included.
       The account is the number the game server named for that player:
       h9_presence 1.7's H9Account (each linked player's own, from the presence
       answer's "accounts"), or else the picture's H9Avatar.
 device is the game's device hash in the presence module's form
 (SHA-256("h9device1:" + the device id), first 32 hex); a game without one sends
 none. A game that polls faster than told is told a longer interval.

 The site's routes, signed in (the CSRF guard as everywhere):
   GET  /api/link/code?code=WDJB-MJHT    { code, label, os, created, expiresIn,
                                         sameNetwork }   400 bad_code, 404 no_code
   POST /api/link/approve { code }       200 { ok }      409 code_used (answered
                                         already, by this account or another)
   POST /api/link/deny    { code }       200 { ok }
   GET  /api/link/devices                { devices: [{ id, label, os, device (its
                                         first 8 hex), linked, lastSeen }] }
   POST /api/link/devices/<id>/revoke    200 { ok }      404 not_found (no such
                                         game on this account)
 The admin panel's LINKED GAMES, on an account's page, for staff:
   GET  /api/link/accounts/<name>/devices  (moderator) { devices, can: { act } }
                                         a moderator looks at players only (403
                                         otherwise), an admin at anyone
   POST /api/link/accounts/<name>/devices/<id>/revoke   (admin) { password,
                                         note }  200 { ok }
   POST /api/link/accounts/<name>/devices/revoke-all    (admin) { password,
                                         note }  200 { ok, revoked }
 The admin's own password (the admin panel's check, 403 bad_password) and a note
 of 3 to 200 characters (400 invalid_note), never on their own account or one of
 their role or above (403); the audit log's account.link.revoke names the admin,
 with the note. It is the owner's REVOKE otherwise.
 The account page lists the account's games under LINKED GAMES, each with
 REVOKE. A revoked game hears "unlinked" at its next status check and gets an id
 of its own again. A link that ends (REVOKE, h9_unlink) also ends, with the
 presence module, the proof that game's device gave for the account: an older
 proof still in a server's report counts for nothing, and the slot loses its
 green chain at the next report answer (modules\presence\README.txt).

 Kept: a waiting code lives in memory only, for codeSeconds: the SHA-256 of its
 device code, the user code, the game's device hash and system, and the asking
 address's limiter key (to say "the same network" and to count per address). A
 restart forgets every waiting code; the game asks for a new one. A link is a
 row of account_links (core migration v3): the account, the SHA-256 of the link
 token (the token itself is sent once and kept nowhere here), the device hash,
 the system and label, when it was made and when the game last checked in.
 Every link, NOT ME, REVOKE and h9_unlink goes into the audit log (account.link,
 account.link.deny, account.link.revoke, account.link.unlink; section 16), and so
 does every adopted id (account.link.adopt) and every adopt refused for another
 device (account.link.adopt.refused). Whoever holds an account's player id is that
 account to H9's servers already, so adopting grants nothing new; it is limited,
 refused to a suspended account, and keeps presence's rule for a second device.

 A new player id (reset-id, move-id: the presence module's admin routes) ends
 every link of the account: each game holds the old id and unlinks itself at
 its next status check. Deleting an account deletes its links. Each link and
 its end are also the events account-link and account-unlink (section 13).

 Settings (link) and limits (limits):
   codeSeconds 600, intervalSeconds 5, maxPending 10000, maxPendingPerIp 5
   linkStartPerIp        10 in 10 minutes: codes a game asks for
   linkPollPerIp         400 in 10 minutes: the game's polls
   linkStatusPerIp       60 in 10 minutes: status checks and h9_unlink
   linkCodePerAccount    10 in 10 minutes, and linkCodePerIp 20: codes looked at,
                         approved or denied on the site, wrong ones included,
                         so a code cannot be guessed
   linkRevokePerAccount  30 in 10 minutes
   linkAdoptPerIp        20 in 10 minutes: adopt nonces and tries
   linkAdoptPerAccount   5 in 10 minutes: adopt proofs that did not check out; past
                         it, every try of that account waits
   linkProfilePerIp      60 in 10 minutes: profiles opened from the scoreboard
   adoptNonceSeconds     300
 Over a limit the game's routes answer 200 busy or slow_down; the site's, and the
 profile route, 429.

 nginx: nothing new (/api/ already passes). The game's routes carry the device
 code and the link token in the query string, so the access log has them: a
 device code is spent within seconds of its approval and a link token only
 checks or ends its own link, so this is no wider than the log's readers already
 are; to keep them out, give location /api/link/ its own access_log off.


 20. THE P2P RELAY (modules/p2p)
 -------------------------------
 A module that lets a friend join a home-hosted listen game with no port
 forwarded: hosts open a session and make short invites, friends redeem them,
 anybody may take a guest invite from the public list of games, and the relay
 introduces the two ends (hole punching) or carries the game's packets between
 them. The service itself is the p2p/ folder that sits beside h9web/ (p2p/README.txt
 is its reference, docs/P2P_HOSTING.txt the guide to hosting it, docs/P2P_JOIN.txt
 the players'); this module is the glue: the routes, the host's credential, the
 visitor's account, the events. The same service runs standalone (p2p/bin/h9rv.js)
 for anybody who wants a relay of their own.

 Off by default and clean when off: with moduleSettings.p2p.enabled not true the
 module registers no route, opens no UDP socket and does not even read the relay's
 code. Enabled but unfinished (no public name for the UDP port, or no p2p/lib
 beside h9web), it logs p2p.off with the reason and stays off; h9web starts anyway.

   config.json   "modules": [..., "p2p"],
                 "moduleSettings": { "p2p": { "enabled": true,
                     "publicUdp": { "host": "play.havoc9.org", "port": 27248 },
                     "bind": { "udp": { "host": "0.0.0.0", "port": 27248 } } } }
   ufw           ufw allow 27248/udp     the one new open port, on the origin's
                 own address (Cloudflare cannot carry UDP: publicUdp.host is a
                 DNS-only name)
   Cloudflare    add /api/p2p/ to the WAF skip rule that /api/link/ has (the
                 helper is not a browser); its user agent is h9_p2p/*
   nginx         nothing new (/api/ already passes). The helper's long poll holds
                 a request up to 25 seconds: nginx's default read timeout (60 s) is
                 enough
   code          ../p2p/lib beside h9web (the same layout in the repository, the VPS
                 packages and C:\havoc9); moduleSettings.p2p.libDir names another
   VPS package   setup.sh P2P=module (Windows: setup.ps1 -P2P module) puts the code
                 in place and opens the port; README-VPS.txt, step 16

 Routes (all under /api/p2p; the host's and the friend's are not browsers, so they
 carry no CSRF guard: every host call is signed, a redeem needs a code):
   GET  v1/health          what is on: {"ok":true,"v":1,"direct","relay","listing"}
   POST v1/host/open       Authorization: Bearer <the account's LINK token>
   POST v1/host/invite     signed (X-H9-Sig) -> a code
   POST v1/host/poll       signed; long poll, at most 25 s -> the friends who joined
   POST v1/host/revoke     signed -> kill an invite, kick a friend, or everything
   POST v1/host/listing    signed -> list the game on the public list, or take it off
   POST v1/host/close      signed
   POST v1/join/redeem     the code (and optionally the friend's account token)
   GET  v1/public          the public list: name, map, players, max, password, direct,
                           account; never an address. The same list at GET public
   POST v1/public/join     {"session": <the entry's id>} -> a one-use, relay-only
                           guest invite for ten minutes. Also at POST public/join. These
                           two carry the CSRF guard (the site's pages ask for them) and
                           take the visitor's account from the session cookie
 The calls, their answers and the limits are in p2p/README.txt, section 7 and 8.

 The host's credential is the account's link token (the one a linked game holds,
 section 19; the game keeps it sealed in user_id.ini, and a launcher that hands it to
 the helper is not built yet: docs/P2P_HOSTING.txt, section 10), checked against this
 service's own GET /api/link/status on this
 machine (the answer is kept a minute; a suspended or unlinked account stops hosting
 at once, because the module looks the account up at every check and drops its
 sessions on the events below). A signed-in visitor of the site needs no token to
 ask the public list for a guest invite: the session cookie says who it is, and the
 host sees that account's name. A game that lists itself with requireAccount refuses
 a visitor who is not signed in.

 The site: havoc9.org/servers shows the public list as P2P GAMES (servers/p2p.js,
 plain script, same-origin requests only). It asks GET /api/p2p/public once, and only
 when that answers (this module on and its list switched on) does the section appear.

 Settings (moduleSettings.p2p; every key optional but publicUdp; p2p/lib/service.js,
 DEFAULTS, lists them all):
   enabled false           true switches the module on
   publicUdp {host, port}  what players are told to send UDP to: a DNS-only name or
                           the VPS's public address, not 127.0.0.1 or 0.0.0.0
   bind.udp {host, port}   the UDP socket (default 0.0.0.0:27248)
   direct.enabled, relay.enabled   separate switches: no address is ever handed out,
                           or no datagram is ever relayed
   listing {enabled, ttlSeconds, inviteSeconds}   the public list: on, an entry lives
                           45 s after its last call, a guest invite 10 minutes
   limits {...}            any of the limits (README.txt of p2p/, section 8): sessions
                           200, 2 per account; flows 16 per game; invites; per address
                           redeem 10 a minute and 5 failures; public list 30 a minute,
                           guest invites 6 a minute per address, 20 an hour per
                           account; 4 unspent guest invites and 8 public guests per
                           game; relayed bytes 4 GiB per account and day
   libDir                  where the relay's code is, when it is not ../p2p/lib
   statusBase              where to ask the link status, when not this service's own
                           address (the module learns it from the requests it gets)
   publicPorts             reserved, not implemented (one public UDP port per public
                           game, for the game's own server browser): the module stays
                           off, and says so in the log, while range is not empty or
                           max is above 0
   allowPrivatePeers       tests only: accept UDP from private addresses
 Events used: account-banned, account-deleted, account-sessions-ended and
 account-unlink close that account's sessions at once, as the web client's relay
 closes its sockets (section 5). Logs: p2p.on and p2p.off at start, then the
 relay's own session.open, invite.make, redeem.ok, public.join, flow.close lines:
 no address (an 8-hex tag stands for one), no code, no key.

 Nothing is kept: sessions, invites, flows and the list live in memory. No table,
 no data folder, nothing in a backup; a restart ends the sessions and the hosts'
 helpers open again by themselves.
