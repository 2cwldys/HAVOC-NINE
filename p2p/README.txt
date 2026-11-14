===============================================================================
 P2P: JOINING A LISTEN SERVER WITHOUT PORT FORWARDING  (the relay, and its helper)
===============================================================================

 A player who hosts a listen game at home can let friends in without opening a
 port on the router. Two small programs do it, and they share one packet
 format (lib/wire.js):

   h9rv    the RELAY (this folder's service). The host's helper opens a
           session on it and makes short invites; a friend redeems an invite;
           the relay then passes the game's UDP packets between the two ends,
           or introduces them to each other so that they can talk directly
           (hole punching) and falls back to carrying the packets itself.
   h9p2p   the HELPER (lib/helper.js, bin/h9p2p.js): a Node program on the
           host's PC and on the friend's PC, next to the game. docs/P2P_JOIN.txt
           is the player's guide to it; this file is about the relay.

 The relay is plain Node.js (20 or newer; no packages, no npm install). Anybody
 can run one for their friends from this folder, with no havoc9.org account;
 havoc9.org runs one too (h9web's p2p module, or this service beside it).
 docs/P2P_HOSTING.txt is the guide to the three ways to host it (a home PC, a
 cloud VM, the havoc9.org VPS), with cost, risk, firewall and DNS.

 Two terms are used below. The CONTROL PLANE is the relay's web port (HTTP: open a game, make
 an invite, redeem a code). The DATA PLANE is its game port (UDP: the game's packets).
 docs/P2P_HOSTING.txt calls them the web port and the game port.

 Nothing here starts by itself. The relay keeps nothing on disk: sessions, invites
 and flows live in memory, a restart forgets them and the hosts open again by
 themselves. No address is ever logged (an 8-digit tag that changes at every
 start stands for one).

 CONTENTS
    1. Quick start: a relay for your friends
    2. The files
    3. relay.config.json: every key
    4. Who may host: hosts.json, havoc9.org accounts, development tokens
    5. The address of the control plane, and TLS
    6. The public list of games
    7. The HTTP calls
    8. Limits
    9. Running it
   10. Logs, counters, what is kept
   11. Tests
   12. What it cannot do


 1. QUICK START: A RELAY FOR YOUR FRIENDS
 ----------------------------------------
 On the machine that will be the relay (Windows, Linux or macOS with Node.js 20+):

   Windows:   run.bat                 Linux:   sh run.sh
 The first run makes relay.config.json and hosts.json from the examples and
 stops. Then:
   1. Edit relay.config.json: publicUdp.host is the name or address that your
      friends' PCs reach this machine by (a DNS name, or its public address),
      publicUdp.port the UDP port (27248). Nothing else is needed.
   2. Make a token for each host:   run.bat token Mike     (sh run.sh token Mike)
      It prints the token ONCE; hosts.json keeps only its hash. Give the token
      to Mike. Add or take away a token at any time: the relay reads hosts.json
      again by itself within seconds; a removed token's sessions end.
   3. Start it:   run.bat      (sh run.sh)      and leave it running.
      run.bat --check (sh run.sh --check) only reads the two files and says what is
      wrong; the relay also refuses to start while either still says CHANGE-ME.
   4. Let the network in (docs/P2P_HOSTING.txt): the UDP port (27248) must reach
      this machine, and so must the control plane's TCP port (28247, or put TLS
      in front of it: section 5). Behind a home router that is two forwarded
      ports, once, on the relay's machine, instead of one on every host's router.
   5. Mike puts the relay's address (the server setting h9_p2p_service, or p2p.ini) and his token
      (p2p.ini only: a token is never a game setting) in place (docs/P2P_JOIN.txt), turns the game's
      relay on (h9_p2p 1) and types h9_p2p_invite Anna in his game for an invite code.

 Windows will ask once whether the relay may use the network (it listens on
 0.0.0.0): allow it for private and public networks, or it is blind to the Internet.


 2. THE FILES
 ------------
   lib/service.js     the service: the control plane (createService(...).handleHttp,
                      mounted on any node:http server or h9web's router) and ONE UDP socket
   lib/wire.js        the UDP packet format (its header comment is the contract)
   lib/codes.js       invite codes (50 bits, shown as H9-XXXXX-XXXXX), loopback aliases
   lib/limits.js      RateLimiter (with backoff) and TokenBucket
   lib/auth.js        who may host: the hosts file, havoc9.org link tokens
   lib/config.js      reads relay.config.json and refuses what is unfinished
   lib/helper.js      the helper's library (HostHelper, JoinHelper)
   bin/h9rv.js        the relay's command line: run, --check, token, hosts
   bin/h9p2p.js       the helper's command line
   run.bat, run.sh    start the relay from relay.config.json (they check for Node 20+, and put
                      H9RV_SITE_URL from relay.site.ini into the environment when it is there)
   relay.config.example.json, hosts.example.json    the examples (every key below)
   relay.site.ini.example    the site address of auth.mode h9web (copy it to relay.site.ini)
   h9-p2p.service.example    the systemd unit
   package.json       "npm test" runs the tests (Node 24; Node 20 runs each file by name)
   test/              node:test files (section 11)
   .gitignore         keeps hosts.json, relay.config.json and relay.site.ini out of git

 h9web/modules/p2p/index.js runs the same service inside h9web (h9web/README.txt,
 section 20); it finds this folder's lib/ beside h9web/. The VPS packages carry
 the service's files only (no helper, no tests) in a p2p/ folder beside h9web/.


 3. RELAY.CONFIG.JSON: EVERY KEY
 -------------------------------
 JSON, UTF-8. Relative paths are relative to the file's own folder. Every key but
 auth and publicUdp.host/port may be left out: the default is the one shown.

   enabled              true     false: nothing listens (h9rv says so and exits 0)
   auth                 -        REQUIRED (not with --dev): who may host, section 4
     mode                        "tokens" or "h9web"
     hostsFile                   tokens: the hosts file, "hosts.json"
                                 h9web: the site whose accounts count is NOT a key of this file: it is the
                                 environment variable H9RV_SITE_URL ("https://havoc9.org"), which run.bat and
                                 run.sh read from relay.site.ini beside this file (never committed; copy
                                 relay.site.ini.example) and a systemd unit from an EnvironmentFile
   publicUdp            -        REQUIRED: what the relay tells players to send UDP to
     host                        a DNS name or public address, not 0.0.0.0, not CHANGE-ME
     port                        the UDP port (the same one as bind.udp.port, or the one
                                 your router forwards to it)
   bind.http.host       "127.0.0.1"   where the control plane listens. 127.0.0.1 behind a
                                 reverse proxy; "0.0.0.0" to be reached directly
   bind.http.port       28247
   bind.http.tls                 { "cert": "fullchain.pem", "key": "privkey.pem" }: serve
                                 https (section 5). Absent: plain http
   bind.udp.host        "0.0.0.0"
   bind.udp.port        27248    the data plane: ONE UDP port
   trustProxyHeader     ""       the header in which a reverse proxy puts the visitor's
                                 address ("x-real-ip" for nginx, "cf-connecting-ip" for a
                                 Cloudflare Tunnel). Empty: the socket's own address. Behind
                                 a proxy it MUST be set, or every visitor shares one
                                 address and one guesser blocks everybody. Set it only when
                                 bind.http.host is 127.0.0.1 behind that proxy: with the port
                                 open to the Internet a visitor could send the header himself
   direct.enabled       true     false: no address is ever handed to a peer: relay only
   relay.enabled        true     false: no datagram is ever relayed: direct paths only
   listing.enabled      true     false: no public list at all (section 6)
   listing.ttlSeconds   45       a listing lives this long after its last call
   listing.inviteSeconds 600     the life of a public guest invite
   publicPorts          reserved  { "range": "", "max": 0 }: for a later feature (one public UDP
                                 port per public game, so that the game's own server browser could
                                 show it). NOT implemented: the relay refuses to start while
                                 either key is set (range not empty, or max above 0)
   allowPrivatePeers    false    tests and LAN play only: accept private source addresses
   limits               {}       any of the limits of section 8, by name, to change them
   dev                           only with --dev (tests): { "hosts": { "<token>": { "id": 1,
                                 "name": "x" } }, "accounts": { "<token>": { "id": 7, "name": "y" } } }

 A key that is not in this list is ignored. A config that cannot be read, that still has
 a value that starts with CHANGE-ME, whose auth is missing or unknown, whose
 publicUdp is empty, or whose TLS files are missing, stops the relay before it
 listens, with one line for each thing wrong.


 4. WHO MAY HOST: HOSTS.JSON, HAVOC9.ORG ACCOUNTS, DEVELOPMENT TOKENS
 --------------------------------------------------------------------
 A host opens a session with a token (POST /v1/host/open, Authorization: Bearer
 <token>). The relay's auth says which tokens count. The token is sent once, at open;
 after that the host's calls are signed with a key made for the session.

 tokens (auth.mode "tokens"): the operator's own list, hosts.json. One entry per host:
     { "sha256:<64 hex digits>": { "id": 1, "name": "Mike" },
       "sha256:<64 hex digits>": { "id": 2, "name": "Anna", "public": false },
       "_note": "keys that start with an underscore are notes" }
   * The key is the SHA-256 of the token, written sha256:<hex> (the token itself is
     never stored: the file may be read by anyone who can read the machine). A key that is
     not of that form is taken as the token itself (at least 20 characters) and hashed
     when the file is read; replace such keys with hashed ones.
   * id: a whole number above 0, or letters, digits and _.:- up to 40 characters. The
     limits that count "per account" (2 sessions, 6 opens an hour, 4 GiB of relayed traffic a
     day) count per id; two tokens with one id share them.
   * name: shown to the host's helper, up to 32 characters.
   * public false: this host may not put its game on the public list. disabled true: the
     token does not work (and its sessions end) until it is removed or set to false.
   * The easy way to add and remove (nothing to hash by hand):
         node bin/h9rv.js token Mike --hosts hosts.json            make a token for Mike, add
                                                                  its hash, print it once
         node bin/h9rv.js token Anna --no-public --hosts hosts.json
         node bin/h9rv.js hosts list --hosts hosts.json            ids and names, never tokens
         node bin/h9rv.js hosts remove 2 --hosts hosts.json
     run.bat and run.sh pass --hosts hosts.json for you: run.sh token Mike. Run them as the
     user who owns the file; an existing file keeps its permissions (and, run as root, its
     owner), so a service account can go on reading it.
   * The relay looks at the file's modified time at most every 2 seconds when a host calls,
     and every 5 seconds on its own: an added token works at once, a removed or disabled one
     stops and its sessions are closed. A file that does not parse is refused at start
     and ignored while running (the table in use stays, and a log line says so).
   * Accounts: a tokens relay has no friend accounts. A host's invite or listing that asks
     for require-account is refused with 400 "accounts unavailable" (use the h9web mode).

 h9web (auth.mode "h9web", H9RV_SITE_URL "https://havoc9.org"): the token is the player's havoc9.org
   LINK token (the one a game holds after "Link your account"). The relay asks
   GET <H9RV_SITE_URL>/api/link/status?token=<token> and takes {"status":"linked","account":"Neo"} as
   the account h9:neo. An answer is kept 60 seconds (a refusal 10 seconds); at most 40 checks
   that miss the cache are made in a burst, 20 a second after. A suspended or unlinked account
   stops hosting when the answer is asked for again. Friend accounts work (require-account).
   Inside h9web the module does the same without the HTTP hop and also closes a
   suspended, deleted or unlinked account's sessions at once (h9web/README.txt, section 20).
   Open point: the game keeps the link token sealed in user_id.ini (Windows DPAPI). A launcher that
   unseals it and gives it to the helper is not built yet (docs/P2P_HOSTING.txt, section 10), so
   today a host reaches a havoc9.org relay only with a token made some other way; hosts.json
   relays work now.
   WHERE THE SITE'S ADDRESS IS WRITTEN. Not in relay.config.json (auth.url is gone from it, and a
   leftover is refused with a sentence that says so). It is the environment variable H9RV_SITE_URL:
     * run.bat and run.sh read it from relay.site.ini beside relay.config.json, a file of one line
         H9RV_SITE_URL=https://havoc9.org
       Copy relay.site.ini.example to relay.site.ini and edit it. The file is in .gitignore and
       never committed, like hosts.json and relay.config.json;
     * a systemd unit reads the same file: h9-p2p.service.example has the line
         EnvironmentFile=-/etc/h9-p2p/relay.site.ini        (the - lets the file be missing)
       so for h9web mode put relay.site.ini into /etc/h9-p2p with the other two files;
     * by hand, set the variable before  node bin/h9rv.js --config relay.config.json.
   Without it an h9web-mode relay refuses to start and says so (exit 2); a tokens-mode relay never
   looks at it.

 --dev: dev.hosts and dev.accounts of the config are the tokens. For tests. Never on the Internet.

 Without an auth (or --dev) the relay does not start: there are no default credentials.


 5. THE ADDRESS OF THE CONTROL PLANE, AND TLS
 --------------------------------------------
 Players need two addresses: the UDP one (publicUdp, handed out by the relay itself) and
 the control plane's, which they type: the service address, h9_p2p_service
 (https://relay.example.org, or https://havoc9.org/api/p2p for h9web's module).

 The control plane carries the host's token (at open), the session's key, and the invite
 codes. Over plain HTTP all of them cross the network in clear text. So:
   * plain http only on 127.0.0.1 or a trusted LAN (tests, one PC);
   * across the Internet put TLS in front, in one of three ways:
       a. a reverse proxy that owns the certificate (nginx, Caddy; blocks in
          docs/P2P_HOSTING.txt), with bind.http on 127.0.0.1 and trustProxyHeader set;
       b. bind.http.tls here: "tls": { "cert": "fullchain.pem", "key": "privkey.pem" }
          (PEM files, read at start: restart the relay after a renewal). The
          certificate must be one the helpers trust, so for a name you own (Let's
          Encrypt). The helper refuses a self-signed certificate by default;
       c. a tunnel that gives the control plane a https name (Cloudflare Tunnel, for example;
          HTTP only, the UDP port still has to be reachable).
 The UDP data plane is not TLS. Each packet carries an 8-byte keyed tag, so the relay
 answers nothing that does not verify and cannot be used to reflect traffic or to
 reach an address a sender names; the game's own traffic is not encrypted today
 either, so the relay (and anybody on the path) can read it.


 6. THE PUBLIC LIST OF GAMES
 ---------------------------
 A host may list its game (server cvar h9_p2p_public 1). The listing is a
 name, the map, players, max players, whether there is a password and whether a havoc9.org
 account is needed: never an address.
   * The host's helper repeats POST /v1/host/listing every 15 seconds; the entry is gone 45
     seconds after the last call, when the session closes, or when the host says public false.
   * GET /v1/public lists the live entries (at most 100, most populated first), the
     same answer for everybody for 5 seconds. In h9web's module it is GET /api/p2p/public,
     and the site's SERVERS page shows it as P2P GAMES, only when the module answers.
   * A visitor presses JOIN: POST /v1/public/join {"session": <the entry's id>} gives
     a one-use invite code for ten minutes, bound to that game, relay-only (no direct path,
     so the host never learns the guest's address) unless the host listed it with
     directPublic. A signed-in visitor of the site gives the host their havoc9.org name;
     a listing with requireAccount refuses a visitor who is not signed in. The guest runs
     the launcher with the code (h9_p2p_join, docs/P2P_JOIN.txt), which redeems it like any invite.
   * The host sees every public guest as a joiner labelled "public" (with the account name, if
     there is one) and can kick any of them; turning public off removes the entry and
     the unspent public invites at once.
   * Abuse: at most 4 unspent public invites and 8 public guests per game (so strangers cannot
     fill the host's room: a game takes 16 flows in all); 6 invites a minute per address, 20 an hour per
     account, 30 an hour per game, 120 a minute for the whole relay; 10 refusals a minute per
     address and that address is blocked (a minute, then twice as long, up to 6 hours);
     listing calls 10 a minute per session; 100 entries in all.
   * Off: "listing": { "enabled": false } removes the three calls (the module and the page
     see 404 and show nothing); a host token with "public": false may not list.
   * The relay's operator can end any game on the list by removing the host's token
     (section 4): its sessions, entry and invites go within seconds.


 7. THE HTTP CALLS
 -----------------
 JSON in and out (Content-Type: application/json, at most 4 KB), Cache-Control: no-store. An
 error is {"error":"<short text>"} with the status code that carries the meaning:
 400 bad request, 401 not authorised, 403 refused by policy, 404 unknown or not offered,
 413 too large, 429 slow down (with Retry-After, in seconds), 503 the relay is disabled.
 With a path prefix (h9web's /api/p2p) a client appends the call's path to the base
 URL's own path; the signature always covers the path WITHOUT the prefix (/v1/host/...).

   GET  /v1/health                 {"ok":true,"v":1,"direct":b,"relay":b,"listing":b}
   POST /v1/host/open              Bearer <host token>. {"v":1,"name":s,"directAllowed":b,
                                   "relayAllowed":b} -> {"session","ctl","hostKey" (base64url),
                                   "udp":{"host","port"},"virtual","direct","relay","limits"}
   POST /v1/host/invite            signed. {"ttl":s,"uses":n,"label":s,"requireAccount":b,
                                   "direct":b} -> {"code":"H9-XXXXX-XXXXX","id","expires" (ms),
                                   "ttl","uses"}
   POST /v1/host/poll              signed. {"wait":s<=25} -> {"events":[ {"t":"joiner",
                                   "flow","pairKey","label","invite","account","direct","at",
                                   "public"?}, {"t":"gone",...}, {"t":"closed",...} ]}
   POST /v1/host/revoke            signed. {"invite":id} | {"flow":n} | {"all":true}
   POST /v1/host/listing           signed. {"public":b,"name":s<=64,"map":s<=32,"players":n,
                                   "max":n,"password":b,"requireAccount":b,"directPublic":b}
                                   -> {"ok":true,"ttl":45,"id":"<public id>"} (public false:
                                   {"ok":true,"ttl":0,"revoked":n}). 400 "bad listing",
                                   "relay off" or "accounts unavailable"; 403 "listing disabled";
                                   429 "list full"
   POST /v1/host/close             signed. {} -> {"ok":true}
   GET  /v1/public                 -> {"sessions":[{"id","name","map","players","max",
                                   "password","direct","account"}]}
   POST /v1/public/join            {"session":"<public id>"} (+ "account":"<token>" on a relay
                                   with accounts) -> {"code","expires" (unix SECONDS),"ttl",
                                   "name","map","password"}. 401 "account required",
                                   404 "unavailable" (one answer for every other refusal)
   POST /v1/join/redeem            {"v":1,"code":s,"direct":b,"account":token?} -> {"flow",
                                   "jKey","pairKey","udp","host":{"name"},"direct","relay",
                                   "expiresIn","idleSeconds",...}; 404 {"error":"invalid"} for a
                                   wrong, used, expired, revoked or host-gone code, alike

 The signature of a host call is the header
     X-H9-Sig: s=<session>;t=<ms>;n=<nonce>;m=<hex>
 with m = HMAC-SHA256(hostKey, METHOD "\n" path "\n" t "\n" n "\n" SHA-256(body)) in lower-case
 hex. t must be within 60 seconds of the relay's clock and n (at most 64 characters) never
 repeats within 130 seconds. lib/helper.js (signHeaders) is a working client.

 In h9web every call is under /api/p2p (/api/p2p/v1/host/open, ...). The public list is also
 mounted without the version, which is what the site's page asks:
 GET /api/p2p/public and POST /api/p2p/public/join. The latter carries h9web's CSRF guard
 (it is asked for by the site's own pages); the helpers' calls do not.


 8. LIMITS
 ---------
 All are keys of "limits" in relay.config.json (or moduleSettings.p2p.limits). A limit with
 four numbers is { max, windowSeconds, blockSeconds, maxBlockSeconds }: more than max in a window
 blocks that key for blockSeconds, and every further block doubles it, up to maxBlockSeconds.

   sessionsTotal 200, sessionsPerAccount 2, flowsPerSession 16, flowsTotal 2000, invitesPerSession 16 (the host's own),
   inviteTtlMax 900, inviteTtlDefault 600, usesMax 8, sessionIdleSeconds 45, flowIdleSeconds 30,
   flowMaxSeconds 28800, sessionMaxSeconds 43200, maxBody 4096, pollMaxSeconds 25
   openPerAccount 6 an hour; invitePerSession 30 an hour; redeemPerIp 10 a minute;
   redeemFailPerIp 5 a minute (then blocked 60 s, doubling to 6 h); redeemFailGlobalPerMinute 120 (past it
   every refusal is delayed 1.5 to 2.5 seconds)
   listingPerSession 10 a minute; publicListPerIp 30 a minute; publicJoinPerIp 6 a minute;
   publicJoinPerAccount 20 an hour; publicJoinPerSession 30 an hour; publicFailPerIp 10 a minute;
   publicJoinGlobalPerMinute 120; listedMax 100; publicInvitesPerSession 4;
   publicFlowsPerSession 8; publicListCacheSeconds 5
   flowPps 800 (burst 1600), flowBps 192000 (burst 384000), unlatchedPps 50 (burst 100),
   verifyPerSecond 40000 (burst 80000): the data plane's per-flow budgets, and the whole
   relay's budget of tag checks, so a flood of forged packets costs at most that much
   relayBytesPerAccountPerDay 4 GiB (4294967296)
 A guess at an invite code: 50 bits, at most 16 live codes per game and 200 games, 5 wrong tries a
 minute per address and then that address is blocked, so the chance of a lucky guess
 is far below one in 2^38 per try.


 9. RUNNING IT
 -------------
   by hand            run.bat / sh run.sh (section 1), or  node bin/h9rv.js --config relay.config.json
   systemd (Linux)    h9-p2p.service.example, with its steps in the file's header; the VPS
                      package's setup.sh does them with P2P=standalone (README-VPS.txt, step 16)
   Windows service    setup.ps1 -P2P standalone (README-WINDOWS.txt, step 16), or Task Scheduler
                      running run.bat at logon for a PC that is always on
   inside h9web       moduleSettings.p2p (h9web/README.txt, section 20)
 Other switches of bin/h9rv.js: --check (read the files, start nothing), --quiet, --stats (a
 line of counters every 5 seconds), --dev. Ctrl+C or SIGTERM stops it cleanly. The UDP port and the
 control plane's port must be free; if not it says so in one line (exit 1).
 The VPS and cloud firewalls: open the UDP port (bind.udp.port, the same as
 publicUdp.port unless something forwards it) and, when the control plane is not behind a
 proxy, the TCP port. docs/P2P_HOSTING.txt has the commands.


 10. LOGS, COUNTERS, WHAT IS KEPT
 --------------------------------
   * Logs are JSON lines on stdout (listening, session.open, session.close, invite.make,
     redeem.ok, redeem.fail, flow.close, public.join, hosts.loaded ...). No invite code, key,
     token or payload is ever logged; an address appears only as a tag of 8 hex digits made with
     a key that changes at every start. systemd and WinSW keep them.
   * Counters: GET /v1/stats on the control plane, answered only to a caller on the same
     machine with no proxy header (never to the network): sessions, flows, invites, listed,
     packets and bytes relayed, drops by reason.
   * Kept in memory only: sessions (up to 12 hours, 200 at once), invites (their hash, not the
     code), flows (up to 8 hours, 2000 at once), the public list, the limits. A restart loses
     them all and the hosts' helpers open again by themselves. The only file is hosts.json.


 11. TESTS
 ---------
   cd p2p && npm test            (Node 24: node --test "test/*.test.js"; about 15 seconds)
   test/p2p.test.js      the protocol on loopback: relay, direct, fallback, kick, revoke, limits, floods
   test/public.test.js   the public list, the guest invites and what stops their abuse
   test/auth.test.js     the hosts file, link tokens, the config file's checks
   test/h9rv.test.js     bin/h9rv.js as a process: what it refuses, a run, a token added and removed
                         while it runs, TLS (when openssl is at hand)
   h9web/test/p2p.test.js   the module inside the real h9web
 Node 20 has no glob in --test: run each file by name (node --test test/public.test.js).
 The tests use 127.0.0.1 and ports the system picks (p2p.test.js uses 28247, 27248,
 27249 and 27251). They send nothing off the machine. A test of the real Internet (a real
 router, a carrier NAT, a long path) is not among them: see section 12.


 12. WHAT IT CANNOT DO
 ---------------------
   * It has been tested on loopback, in simulated NATs (22 pairings) and with a scripted
     client against a real headless server, not with a real home router, a real carrier
     NAT or a desktop game client over the Internet. docs/P2P_JOIN.txt says what a first
     real test should look at.
   * It sees the game's packets in clear (a relayed game's traffic is not encrypted) and, as
     any relay, both addresses. Relay-only hides each address from the other end, not from it.
   * It is IPv4 only (the wire format and the socket). A flood of raw UDP at its port needs
     the provider's and the firewall's help.
   * It does not make a game server: the host runs the game; the relay only carries packets.
   * A public game does not show in the game's own server browser (Find Servers). That list holds
     addresses that answer a plain query and accept a normal connect; a game hosted behind a
     router is neither. A public game shows on the website's SERVERS page (P2P GAMES). What the
     in-game browser would need is in docs/P2P_HOSTING.txt, section 3; the keys publicPorts.range
     and publicPorts.max are reserved for it.
   * A friend who joins through it is, to the game server, a player at a loopback address; the
     havoc9.org presence module does not know that player (docs/P2P_JOIN.txt): a game that
     requires accounts, or a ranked game, is not for this path yet.
   * The helper is a Node program: the host and the friend need Node.js 20+. A native helper
     or an engine route would remove that; neither exists. The engine's own NAT bypass
     (sv_nat) and the Discord "invite to game" button are not part of this.
