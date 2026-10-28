# The H9 server list

The list the H9 Internet tab reads. The game asks it for `http://<host>:<port>/v1/servers/ts`
and gets back one `ip <address>` line for each server that is up. The line format is the
engine's own, described in `xash3d-fwgs/Documentation/protocol/http-server-list.md`.

It is one Python process: an HTTP service, and, when `serverlist.cfg` has a Discord token, a
Discord bot with three slash commands.

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

To point the game at the list, set this in `networking.ini` in H9XASH, with an address the
players can reach:

    list_bot=http://<public address>:8081

The game reads it at each launch of `h9xash.bat`. Players can only reach the list if the port
is open from the internet, so forward it on the router, or host the list somewhere public.

## Discord

Create an application in the Discord developer portal, add a bot to it, and put the bot's
token in `serverlist.cfg`. Invite the bot to your server with the `applications.commands`
scope. Set `guild_id` in `serverlist.ini` to the server's id, so the commands appear at once.

* `/servers` lists the servers that answer now.
* `/addserver address` adds one. `/removeserver address` takes one off.

Who may change the list: members with `role_id` (set in `serverlist.ini`), or, when that is
empty, anyone with Manage Server.

## Heartbeats

A heartbeat adds a server. The list then keeps it the same way as any other, by querying it.
The body is JSON:

    curl -X POST http://<list address>:8081/v1/heartbeat -H "Content-Type: application/json" -d "{\"key\":\"<heartbeat_key>\",\"address\":\"<server public address>:27015\"}"

Answers: 200 when the server answered its query, 401 for a wrong or missing key, 400 for a bad
address or a body that is not JSON, and 422 when no server answered at that address, or the
server runs another game folder.

Nothing in this folder sends heartbeats for you. A plugin that sends them on a timer is not
written yet.

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
