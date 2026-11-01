===============================================================================
 H9WEB MODULE: PRESENCE
===============================================================================

 Who is in game on H9's servers, in the web client and on the site; playtime,
 last seen and the PLAYS IN GAME badge; the privacy switches; the id proof,
 device binding and the admin panel's hooks; names in game. Game servers
 enrolling for their own keys; communities: chat across servers and the site,
 find, bans, mutes and kicks, announcements and per-account shared data.
 docs\H9_PRESENCE.txt and docs\H9_COMMUNITIES.txt are the guides for game
 servers, players and the engine side. This file is for whoever runs or
 changes h9web.

 CONTENTS
    1. Files
    2. Loading it
    3. Routes
    4. The report (what h9_presence.sma sends)
    5. Settings
    6. Core hooks: what core gives it
    7. Tests

 1. FILES
 --------
   index.js          the module: routes, sessions, states, flags, admin hooks
   migrations.js     its tables (presence_*), and what each column means
   store.js          every SQL statement it runs
   keys.js           the hand-made per-server keys file
   enroll.js         enrollment: a server's own key, proven over A2S_RULES;
                     approvals, re-enrollment flags, expiry, server ids
   a2s.js            A2S_RULES over UDP (the challenge, split answers)
   serverauth.js     signed server calls: the HMAC, the time, the nonce table
   community.js      communities, linking, staff, chat and the long-poll,
                     sanctions and kicks, announcements, find, shared data
   modes.js          the mode's name, as the Discord card names it
   bin/presence-key.js   add | rotate | remove | list a hand-made key
 Data (never in git): <dataDir>/modules/presence/server-keys.json, net-key and
 enroll-key (the secret enrolled keys are worked out from), all mode 0600.

 2. LOADING IT
 -------------
 config.json: "modules": [ ..., "presence" ]. h9web's core hands it the
 hooks of section 6. Given a ctx without one of them (a test, or another
 core) it still loads and logs presence.core_hook_missing for each missing
 hook: without clientIdIndex or servers it answers reads (nobody is in game)
 and refuses reports with 503 not_ready, and the rest of section 6 says what
 each other hook turns off.

 Game servers enroll by themselves (docs\H9_PRESENCE.txt section 4a): one on
 servers.json goes live once it proves its address, any other once an admin
 approves it. A hand-made key, for a server on servers.json, as the
 service's user:
   sudo -u h9web node /opt/h9web/modules/presence/bin/presence-key.js \
     --config /etc/h9web/config.json add 203.0.113.10:27015
 It prints the two config lines once, and wins over the server's enrollment.

 3. ROUTES
 ---------
 Public (each account's privacy switches applied; Cache-Control public,
 max-age cacheSeconds; readPerIp limit):
   GET  /api/presence/now
        { generated, players, servers: [{ server: { name, address }, map,
          mode, detail, mapPicture, players: [{ username, since, minutes,
          verified }] }], elsewhere: [...in game, server hidden],
          web: [{ username }], site: [{ username }] }
   GET  /api/presence/accounts?u=name1,name2   at most batchMax (50) names
        { accounts: { "<name as asked>": view or null } }
   GET  /api/presence/account/<name>           one view, with "servers"
        a view: { username, state: game|web|site|offline, online,
          playing: { server, map, mode, detail, mapPicture, since, minutes,
          verified } or null, badge, playtimeSeconds, firstSeen, lastSeen,
          servers: [{ server, seconds }] }; a field the account hides is null
 Signed in:
   GET  /api/presence/me          everything, whatever the switches say
   GET  /api/presence/settings    { privacy, defaults }
   POST /api/presence/settings    { game, where, web, site, playtime,
                                    lastSeen }: any of them, true or false
 Admins (requireRole admin; adminPerAccount limit; audit log):
   GET  /api/presence/admin/flags?status=open|resolved|all&page=N
   POST /api/presence/admin/flags/<id>/resolve                { note }
   GET  /api/presence/admin/accounts/<name>
   POST /api/presence/admin/accounts/<name>/devices/<device>/allow   { note }
   POST /api/presence/admin/accounts/<name>/devices/<device>/unbind  { note }
   POST /api/presence/admin/accounts/<name>/move-id    { to, confirm, password, note }
   POST /api/presence/admin/accounts/<name>/reset-id   { confirm, keepDevices, password, note }
   (password: the acting admin's own, checked by core's confirmAdmin)
   GET  /api/presence/admin/servers?status=all|pending_approval|active|...
   POST /api/presence/admin/servers/<serverId>/approve | revoke | block |
        unblock | flags/resolve
   GET  /api/presence/admin/sanctions   POST /api/presence/admin/sanctions
   POST /api/presence/admin/sanctions/<id>/revoke
   POST /api/presence/admin/announce                          { text }
   Audit actions: presence.flag.resolve, presence.device.allow,
   presence.device.unbind, presence.id.move, presence.id.reset,
   presence.server.enroll, .reenroll, .approve, .revoke, .block, .unblock,
   .flags_resolve, presence.sanction.<kind>, presence.sanction.revoke,
   presence.announce.
 Communities (the site, signed in; communityPerAccount limit; staff is the
 owner, its admins and site admins; audit actions community.*):
   GET/POST /api/presence/communities, GET/PATCH/DELETE .../<slug>, and
   .../<slug>/claim, servers/<serverId>, staff, sanctions, announce, chat,
   data/log, data/rollback: docs\H9_COMMUNITIES.txt section 12.
 Game servers (csrf: false; their own authentication; reportPerIp and
 serverCallsPerIp before the signature is checked, the per-server limits
 only after):
   POST /api/presence/report         section 4
   POST /api/presence/enroll         { v, port }: a key, inactive, and a code
   POST /api/presence/enroll/status  signed: proves the code over A2S_RULES
   POST /api/presence/server/poll, chat, find, data/get, data/set, claim
                                     signed (serverauth.js): community.js

 4. THE REPORT
 -------------
   POST /api/presence/report
   Content-Type: application/json
   X-H9-Server: 203.0.113.10:27015          the address it enrolled with
   X-H9-Signature: <hex HMAC-SHA256(key as its 64 ASCII characters, raw body)>

   { "v": 1, "server": "203.0.113.10:27015", "ts": <unix seconds>,
     "reason": "tick" | "event", "map": "h9_te_neuropolis",
     "mode": "Team Elimination", "detail": "<the mode's progress>",
     "name": "<hostname>", "humans": 5, "max": 32,
     "names": true,                                       (optional)
     "players": [
       { "id": "<h9_clientid>", "slot": 3, "name": "Neo", "joined": <unix>,
         "time": <seconds in game>,
         "nonce": "<32 hex>", "devmask": "<32 hex>", "proof": "<64 hex>",
         "net": "203.0.113" },                            (the proof: optional)
       { "slot": 7, "name": "someone" }                   (names only)
     ] }

 Refusals: 400 bad_server, bad_request, bad_version, server_mismatch;
 401 bad_signature, stale (ts more than clockSkewSeconds off); 403
 unknown_server, no_key, not_enrolled, pending_approval; 409 replay (ts not
 later than the last accepted one, kept in presence_servers, so it holds
 across restarts); 413 payload_too_large, too_many_players; 415; 429; 503
 not_ready.
 The answer: { ok: true, players: <entries read>, serverId, actions: {
 "<slot>": { kick: "<reason>" } | { mute: true } } } and, when the report
 said "names": true and core can check proofs, names: { "<slot>": { set:
 "<username>" } | { taken: true } } (docs\H9_PRESENCE.txt sections 4b, 10).

 5. SETTINGS
 -----------
 moduleSettings.presence, each with a default (index.js, DEFAULTS):
   privacy { game, where, web, site, playtime, lastSeen }   all true
   requireProof false     inGameNames true      siteActiveSeconds 300
   maxBodyBytes 16384     maxPlayers 128        clockSkewSeconds 120
   sessionTimeoutSeconds 180   rejoinSeconds 120   maxCreditSeconds 150
   proofMaxAgeSeconds 86400    sweepSeconds 30     sessionRetentionDays 90
   netRetentionDays 30    flagRetentionDays 90  batchMax 50   cacheSeconds 15
   mapPicturesDir null (an absolute path)   mapPicturesUrl "/assets/maps/"
   enrollSameIp true      enrollAutoApprove false    enrollStaleDays 30
   enrollPendingMinutes 60   enrollProbeSeconds 10   enrollProbeTimeoutMs 2500
   pollHoldSeconds 20     chatMaxChars 120      chatRetentionDays 7
   chatCooldownSeconds 2  dataValueMax 512      dataKeysPerAccount 64
   dataRowsPerCommunity 200000   dataLogRetentionDays 30
   communitiesPerAccount 3   claimMinutes 15
   limits { reportPerIp, reportPerServer, readPerIp, settingsPerAccount,
            adminPerAccount, enrollPerIp, enrollPerAddress, serverCallsPerIp,
            pollPerServer, chatPerServer, chatPerAccount, chatWebPerAccount,
            findPerServer, dataReadPerServer, dataWritePerServer,
            dataWritePerAccount, claimPerServer, communityPerAccount }
            (RateLimiter options)

 6. CORE HOOKS: WHAT CORE GIVES IT
 ---------------------------------
 The module never edits core. These come in the ctx the registry hands every
 module (h9web README.txt section 13):
   ctx.accounts.clientIdIndex(address)       lib/clientids.js
        { get(h9_clientid) -> account id, has, size } for the server at
        "a.b.c.d:port". Kept per IP (the engine salts with the IP, not the
        port), current through account-created, account-deleted and
        account-player-id, rebuilt when another process (the admin script)
        changed the accounts. Without it: reports answer 503.
   ctx.accounts.verifyIdProof(accountId, { nonce, server, devmask, proof })
        lib/accounts.js; { valid, device }, the id proof of
        docs\H9_PRESENCE.txt section 8. Without it: every sighting is
        unverified, and no names are given.
   ctx.accounts.resetPlayerId(accountId), movePlayerId(fromId, toId)
        lib/accounts.js; plain statements with no transaction of their own:
        the module calls them inside its transaction, with the presence
        history it moves. Each emits account-player-id { id }. Without them:
        move-id and reset-id answer 503.
   ctx.auth.confirmAdmin(rc, password)
        lib/admin.js; the acting admin's own password, sent with move-id and
        reset-id and checked as the admin panel checks its own actions (the
        sign-in hasher, limits.reauthPerAccount). Without it: move-id and
        reset-id answer 503.
   ctx.accounts.nameInUse(name)
        lib/accounts.js; a username, a look-alike of one, or a name held
        after a username change (the sign-up rule). Without it: registered
        names are not protected in game.
   ctx.auth.lastActive(accountId), activeSince(unixSeconds)
        lib/auth.js; recorded by sessionFromRequest, not by sessionByHash,
        so the relay's re-check of its sockets is not being on the site;
        after a restart, the sessions' last_seen_at. Without them: nobody
        shows as on the site.
   ctx.servers.get(address), listed(), status(address)
        serversHook in lib/modules.js: servers.json's entries and the status
        poller's last answer. Without it: reports answer 503.
   events relay-open, relay-close { accountId }; relay-game-start,
        relay-game-end { accountId, server }
        lib/relay.js; a socket's game traffic to a listed server (a datagram
        that is not connectionless) starts a game, 15 seconds without it or
        the socket closing ends it.

 7. TESTS
 --------
   node --test --test-timeout=30000 test/presence.test.js
 53 tests, against core's own hooks. Site activity has a stand-in there that
 moves with the tests' clock; core's is tested on its own. They cover the
 report's signature, timestamp and replay guard; salted ids per server;
 unknown ids dropped and never stored or logged; the states and the six
 switches; the batch read; playtime across reports, away and rejoin, the
 silent server, a server taken off the list; the id proof (forged, for another
 server, stale, copied, requireProof, no core hook); devices, two places at
 once, the admin hooks (flags, allow, unbind, move-id, reset-id, 503 without
 core); names in game; the relay's events; map pictures and modes; rate
 limits; presence-key.js; loading through the registry with core's hooks, and
 without clientIdIndex; core's site activity and clientIdIndex (accounts made,
 deleted, reset, moved, and made by another process); no secret in the logs;
 the id proof's test vectors. test/relay.test.js has the relay's own events.

   node --test --test-timeout=30000 test/community.test.js
 20 tests: A2S_RULES (the challenge, a split answer); enrolling only one's own
 address, the inactive key, approval, re-enrolling and its flag, a stranger
 never getting a live key, blocking, expiry, the rate limit; communities,
 linking by code, staff; chat from the game (cleaned) and the site (CSRF),
 the long-poll woken and never echoing a server's own lines; deleting lines,
 mutes, announcements; community and H9-wide bans, device bans, one-off
 kicks; find and its privacy; the shared data's versions, limits, read-only
 servers, proof, log and rollback; signed calls refused when wrong, stale or
 replayed; no key or code in the logs; and every call exactly as
 h9_community.sma writes it.
