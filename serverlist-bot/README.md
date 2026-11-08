# The H9 server list

The list the H9 Internet tab reads. The game asks it for `http://<host>:<port>/v1/servers/ts`
and gets back one `ip <address>` line for each server that is up. The line format is the
engine's own, described in `xash3d-fwgs/Documentation/protocol/http-server-list.md`.

It is one Python process: an HTTP service, and, when it has a Discord token (`serverlist.cfg`, or
the `H9_DISCORD_TOKEN` environment variable, or a systemd credential named `discord_token`), a Discord
bot with three slash commands whose status shows how many servers the list is tracking.

## What goes on the list

A server is listed only while it answers an A2S query. Every `poll_seconds` (30 by default)
the list asks each listed server again, and it takes a server off after `expire_seconds`
(300) with no answer. A server that shuts down leaves the list by itself.

A server gets on in one of three ways:

* `/addserver host:port` in Discord, by someone with the list role or Manage Server.
* A line in `servers.txt`, read when the list starts.
* A heartbeat: `POST /v1/heartbeat` with the shared key. See below.

Every way queries the address first. A server that does not answer is refused, and so is
one that runs a different game folder from `gamedir`.

## Setup

1. Run `install.bat`. It installs the Python packages and creates `serverlist.cfg`.
2. Open `serverlist.cfg` and set `heartbeat_key` to a long random string. Set `discord_token`
   only if you want the Discord commands. Leave it empty to run the list alone.
3. Check `serverlist.ini`. The port is 8081 by default -- not 8080: on Windows,
   Steam's own `steamwebhelper.exe` binds `127.0.0.1:8080` for its CEF remote-debugging
   port, and Windows routes loopback traffic to that more specific listener ahead of
   this list's `0.0.0.0:8080` wildcard bind, so the list would run and look fine while
   silently never receiving a single request from the game.
4. Run `run.bat` and leave its window open. The list writes `serverlist.log` beside itself.
5. Open `http://127.0.0.1:8081/v1/servers/ts` in a browser. It shows a comment line and no
   `ip` lines until a server gets on.

`serverlist.cfg` holds secrets and is git-ignored. Do not copy it anywhere that is shared.

The game finds the list through `networking.ini` in H9XASH, which ships with

    list_bot=https://havoc9.org/serverlist

On the VPS the list listens on 127.0.0.1:8081 and nginx passes `https://havoc9.org/serverlist/`
on to it (`havoc9.org/deploy/nginx-setup.sh`; `vps/linux/README-VPS.txt` sets the whole VPS up, the
list as the `h9-serverlist` service). The game reads `networking.ini` at each launch of
`h9xash.bat`. For a test list on this PC: `list_bot=http://127.0.0.1:8081` there, and in
`serverlist.ini` `public_url =` empty (and `host = 0.0.0.0` for players on the LAN, who use
`http://<this PC's LAN address>:8081`). `H9_SERVERLIST_HOME`, when set, names the folder that
holds `serverlist.ini`, `serverlist.cfg`, `servers.txt` and `serverlist.log` instead of this
one.

## Discord

Create an application in the Discord developer portal and name it what the bot should be
called in your server (for example "Master Server"), add a bot to it, and put the bot's token in
`serverlist.cfg`. The `H9_DISCORD_TOKEN` environment variable, or a systemd credential named
`discord_token` (`LoadCredential=` in the service), is read first when it holds something, so a
service can run without a secrets file in its folder.

Invite the bot to your server with the `bot` **and** `applications.commands` scopes. `bot` is what
puts it in the member list, where its coloured status shows; `applications.commands` is what makes
the slash commands appear. Set `guild_id` in `serverlist.ini` to the server's id, so the commands
appear at once.

* `/servers` lists the servers that answer now.
* `/addserver address` adds one. `/removeserver address` takes one off.

The bot's status follows the list, checked every 15 seconds:

* green, "Tracking 3 servers": at least one server on the list answers;
* yellow, "no servers to track": the list is empty;
* red, "2 servers unreachable": servers are on the list, but none has answered in the last
  two polls. A server that stays silent is taken off after `expire_seconds`, and the status
  then turns yellow;
* red, "server list unreachable": `public_url` is set in `serverlist.ini` and the list cannot
  be fetched there;
* grey: the bot is not running. Discord shows that by itself.

Who may change the list: members with `role_id` (set in `serverlist.ini`), or, when that is
empty, anyone with Manage Server.

## Heartbeats

A heartbeat adds a server. The list then keeps it the same way as any other, by querying it.
The body is JSON, in one of two kinds:

* Without a key, the server announces itself: the list takes the address the heartbeat comes
  from (behind nginx, the X-Real-IP it names) with the port in the body. This is what a
  dedicated server started with `h9xash_server.bat` sends every two minutes (`h9_heartbeat.ps1`
  beside it; `heartbeat=0` under `[server]` in its `networking.ini` turns that off). Any other
  server can do the same on a timer, for example from cron:

      curl -X POST https://havoc9.org/serverlist/v1/heartbeat -H "Content-Type: application/json" -d "{\"port\":27015}"

  `open_heartbeats = 0` in `serverlist.ini` refuses these.

  Who a request "comes from" is decided by `proxy_header` in the `[http]` section of `serverlist.ini`: `x-real-ip` (the default:
  nginx sets it in every location and the list believes it only from this machine), `cf-connecting-ip` (behind a Cloudflare
  Tunnel, where cloudflared forwards a visitor's own X-Real-IP untouched and only CF-Connecting-IP can be believed), or `none` (the
  connection's own address). Anything that is not exactly one valid address is ignored.
* With `heartbeat_key` from `serverlist.cfg`, any address:

      curl -X POST https://havoc9.org/serverlist/v1/heartbeat -H "Content-Type: application/json" -d "{\"key\":\"<heartbeat_key>\",\"address\":\"<server public address>:27015\"}"

A server that `servers.txt` names by a host name (`havoc9.org:27015`) and that heartbeats from
that name's address is the same entry, not a second one.

Answers: 200 when the server answered its query, 401 for a wrong key (or no key while
`open_heartbeats` is 0), 403 for a keyless heartbeat that names another address, 400 for a bad
address or port or a body that is not JSON, and 422 when no server answered at that address
(its UDP port is shut, say), or the server runs another game folder.

## For a website: the JSON list

`GET /v1/servers/<gamedir>.json` is the same live list as the plain-text one, as actual
fields instead of a `#` comment a page would otherwise have to parse:

    {
      "gamedir": "ts",
      "generated": "2026-10-24T20:55:13Z",
      "servers": [
        {
          "address": "203.0.113.10:27015",
          "kind": "ip",
          "name": "HAVOC 9 -- Main",
          "map": "h9_te_neuropolis",
          "mode": "Siege 2/5",
          "players": 7,
          "max": 16,
          "bots": 3,
          "ping_ms": 12.3
        }
      ]
    }

* **mode** comes straight from the server's own game-description answer -- in this mod,
  `ts_matchmode.sma`'s `fw_gamedesc`, which already switches between `"Match Mode"` and
  `"Siege"` (or `"Siege n/m"` once an objective round is live) on its own, once a second,
  and names a claimed mode while one runs: `"Capture the Uplink"`, `"Wave Survival"`,
  `"Mech Warrior"` (each mode plugin's `tsm_gamedesc_*` cvar).
  Nothing new to run on the plugin side; this list was already receiving it on every query
  it makes and just wasn't reading it back.
* **ping_ms** is this bot's own round-trip time to the server, not a given website
  visitor's. Treat it as a rough "how far is this server from the list" figure, the same
  caveat any server browser's ping column carries.
* **map**, read as-is, is also the thumbnail lookup key `cl_presence.c` already uses for
  Discord Rich Presence (`h9_te_neuropolis` is sent straight through as the Discord
  `large_image` asset name) -- reuse that convention for a map thumbnail on a website too:
  look up an image named after this value, and fall back to one generic image for any map
  that doesn't have one yet. No thumbnail images exist anywhere in this project yet (this
  repo has no `maps/` or `screenshots/` art folder) -- generating or commissioning a set,
  one per shipped map, named to match, is separate follow-up work, not something this list
  can hand over on its own.

A page points at this the same way it would the plain-text list -- one URL, polled on a
timer (`setInterval`) or refreshed on load, e.g.:

    fetch("http://<list address>:8081/v1/servers/ts.json")
      .then(r => r.json())
      .then(data => {
        for (const s of data.servers) {
          // s.name, s.map, s.mode, s.players + "/" + s.max, s.ping_ms + " ms", s.address
        }
      });

## Limits

* IPv4 addresses and host names only. IPv6 is refused.
* Both kinds of server. A GoldSrc server (stock hlds, REHLDS) is listed as a `gs` line, a
  Xash one as `ip`, matching what the client already reads. Whether an Xash player can
  actually join a GoldSrc server once it is listed is a separate question -- see
  NETWORKING.txt section 6A, the Steam auth broker.
* The engine's HTTPS needs a `cacert.pem`. H9XASH already carries one, in
  `valve\extras.pk3` (xash-extras' own bundle). `https://` has not been tested
  against a real list yet; plain `http://` is what every setup here has used.
