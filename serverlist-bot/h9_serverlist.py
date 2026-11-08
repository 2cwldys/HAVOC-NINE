"""
h9_serverlist.py -- the H9 server list: the list the Internet tab reads.

The Xash client asks each list it knows about for GET <base>/v1/servers/ts, and reads one
"ip <address>" line back per server. The format is in the engine's
Documentation/protocol/http-server-list.md. This process is that list. It keeps the servers
that answer an A2S query, asks them again every poll_seconds, and takes off any that have
been silent for expire_seconds.

HOW A SERVER GETS ON
    A line in servers.txt, a heartbeat (POST /v1/heartbeat with the shared key), or
    /addserver from Discord. Each one queries the address first, so a server that does not
    answer never gets on, and one in another game folder is refused. A server that answers
    in the GoldSrc format (REHLDS, stock hlds) is listed as a "gs" line; one that answers in
    the Source format (Xash) is listed as "ip" -- the client reads both.

HOW A SERVER GETS OFF
    It stops answering. Nothing has to tell the list that a server has shut down.

WHAT THIS DOES NOT DO
    It carries no game traffic and it does not touch Steam. The client queries each address
    the list returns for itself.

ONE PROCESS, TWO JOBS
    The HTTP list and the Discord bot share one event loop. With no discord_token (in
    serverlist.cfg, in the H9_DISCORD_TOKEN environment variable or in a systemd credential
    named discord_token) the bot is not started, and the list runs alone.
"""

import asyncio
import configparser
import hmac
import ipaddress
import os
import re
import socket
import sys
import time
from pathlib import Path

try:
    import a2s
    import aiohttp
    from a2s.info import GoldSrcInfo
    from aiohttp import web
except ImportError as exc:                                  # noqa: BLE001
    sys.exit(f"missing dependency: {exc}\n  pip install -r requirements.txt")


HERE = Path(__file__).resolve().parent
# The settings, the secrets, the seed list and the log: beside this script, or in the folder
# H9_SERVERLIST_HOME names (on the VPS the code is in /opt/h9-serverlist and these are in
# /var/lib/h9-serverlist).
DATA_DIR = Path(os.environ.get("H9_SERVERLIST_HOME") or HERE).resolve()
INI = DATA_DIR / "serverlist.ini"
SECRETS = DATA_DIR / "serverlist.cfg"
SEEDS = DATA_DIR / "servers.txt"
LOG = DATA_DIR / "serverlist.log"

DEFAULT_PORT = 27015                                        # the engine's default for a bare host
GAMEDIR_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
MAX_LISTED = 15                                             # /servers stays under Discord's message size
STATUS_SECONDS = 15                                         # how often the bot's Discord status is looked at
LIST_CHECK_SECONDS = 60                                     # how often public_url is fetched
LIST_CHECK_TIMEOUT = 10                                     # how long that fetch may take, in seconds
HEARTBEAT_FAILS = 10                                        # wrong keys one address may send in HEARTBEAT_WINDOW
HEARTBEAT_WINDOW = 600                                      # seconds; past the limit, 429 until the window ends


def log(message):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} [list] {message}"
    print(line, flush=True)
    try:
        with LOG.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass                                                # a log that cannot be written must not stop the list


def clean(text):
    """A server's own name as one short line: line breaks and runs of spaces go."""
    return " ".join(str(text or "").split())[:64]


def parse_address(text):
    """
    "host" or "host:port" to (host, port), the port defaulting to 27015. Anything else is a
    ValueError, so a typo is refused at the door rather than listed. IPv4 and host names
    only: the list does not take IPv6.
    """
    text = text.strip()
    host, _, port = text.partition(":")
    if not HOST_RE.match(host):
        raise ValueError(f"not a host name or an IPv4 address: {text!r}")
    if port == "":
        return host, DEFAULT_PORT
    if not (port.isdigit() and 0 < int(port) <= 65535):
        raise ValueError(f"bad port in {text!r}")
    return host, int(port)


async def probe(target, timeout):
    """
    The A2S answer for an address as a dict, or None for no answer or a timeout. "kind" is
    "gs" for a GoldSrc-format reply (stock hlds, REHLDS) and "ip" for a Source-format one
    (Xash) -- the same two kinds of line the client itself already reads (see section 1 of
    NETWORKING.txt).

    "mode" and "ping" were both already sitting unused on the a2s answer, not something
    that needed a new query or a plugin-side change:
      - info.game is the GoldSrc/Source "game description" field -- in this mod, exactly
        what ts_matchmode.sma's fw_gamedesc (FM_GetGameDescription) answers every server
        query with, switching between "Match Mode", "Siege ..." and a claimed mode's own
        name ("Capture the Uplink", "Wave Survival", "Mech Warrior") on its own a second
        at a time (see refresh_gamedesc() in ts_matchmode.sma). Every server already sends
        this on every query a browser or this bot makes; nothing here reads it back.
      - info.ping is the library's own measured round-trip time for THIS query, in
        seconds (time.monotonic() before/after the request, a2s_sync.py) -- the bot's own
        distance to the server, not a website visitor's, same limitation any server
        browser has. Converted to milliseconds for display.
    """
    try:
        info = await asyncio.to_thread(a2s.info, target, timeout)
    except Exception:                                       # noqa: BLE001
        return None
    return {
        "kind": "gs" if isinstance(info, GoldSrcInfo) else "ip",
        "name": clean(info.server_name),
        "map": clean(info.map_name),
        "folder": clean(info.folder),
        "mode": clean(info.game),
        "players": info.player_count,
        "max": info.max_players,
        "bots": info.bot_count,
        "ping": round(info.ping * 1000, 1),
    }


def plural(count, word):
    return f"{count} {word}" + ("" if count == 1 else "s")


def status_for(served, answering, silent, list_ok):
    """
    The bot's Discord status as (status, text). "dnd" (red) while the list cannot be reached
    at public_url, or while servers are on it and none of them answers; "online" (green) while
    a server on the list answers; "idle" (yellow) when nothing is on the list. While the bot
    itself is down, Discord shows it offline (grey) on its own.
    """
    if not list_ok:
        return "dnd", "server list unreachable"
    if answering:
        return "online", "Tracking " + plural(max(served, answering), "server")
    if silent:
        return "dnd", plural(silent, "server") + " unreachable"
    return "idle", "no servers to track"


async def list_reachable(settings):
    """Whether the list answers at public_url, the address players are given for it."""
    url = f"{settings.public_url.rstrip('/')}/v1/servers/{settings.gamedir}"
    try:
        timeout = aiohttp.ClientTimeout(total=LIST_CHECK_TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                return response.status == 200
    except Exception:                                       # noqa: BLE001
        return False


def new_entry(host, port, source):
    return {
        "host": host,
        "port": port,
        "address": f"{host}:{port}",
        "source": source,
        "added": time.time(),
        "seen": 0.0,
        "kind": "ip",                                        # overwritten by the first answer
        "name": "",
        "map": "",
        "folder": "",
        "mode": "",
        "players": 0,
        "max": 0,
        "bots": 0,
        "ping": 0.0,
    }


def secret_from_service(variable, credential):
    """
    A secret the service manager hands in instead of serverlist.cfg: the environment variable
    when it holds something, else the systemd credential of that name (LoadCredential= puts it
    in $CREDENTIALS_DIRECTORY). Empty when neither does.
    """
    value = os.environ.get(variable, "").strip()
    if value:
        return value
    folder = os.environ.get("CREDENTIALS_DIRECTORY", "")
    if folder and re.fullmatch(r"[A-Za-z0-9_.-]+", credential):
        try:
            return (Path(folder) / credential).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return ""


class Settings:
    """serverlist.ini for the settings, serverlist.cfg for the two secrets (the Discord token may also come from the service)."""

    def __init__(self):
        ini = configparser.ConfigParser(interpolation=None)
        ini.read(INI, encoding="utf-8")
        secrets = configparser.ConfigParser(interpolation=None)
        secrets.read(SECRETS, encoding="utf-8")
        self.host = ini.get("http", "host", fallback="127.0.0.1").strip()
        self.port = ini.getint("http", "port", fallback=8081)
        self.public_url = ini.get("http", "public_url", fallback="https://havoc9.org/serverlist").strip()
        self.open_heartbeats = ini.getboolean("http", "open_heartbeats", fallback=True)
        # Which header names the visitor when a request reaches the list from this machine: x-real-ip (nginx sets it in every
        # location), cf-connecting-ip (a Cloudflare Tunnel's cloudflared), or none (the connection's own address).
        self.proxy_header = ini.get("http", "proxy_header", fallback="x-real-ip").strip().lower()
        self.gamedir = ini.get("list", "gamedir", fallback="ts").strip()
        self.poll_seconds = ini.getfloat("list", "poll_seconds", fallback=30.0)
        self.expire_seconds = ini.getfloat("list", "expire_seconds", fallback=300.0)
        self.probe_timeout = ini.getfloat("list", "probe_timeout", fallback=2.0)
        self.guild_id = ini.get("discord", "guild_id", fallback="").strip()
        self.role_id = ini.get("discord", "role_id", fallback="").strip()
        self.heartbeat_key = secrets.get("secrets", "heartbeat_key", fallback="").strip()
        self.discord_token = (secret_from_service("H9_DISCORD_TOKEN", "discord_token")
                              or secrets.get("secrets", "discord_token", fallback="").strip())
        if not GAMEDIR_RE.match(self.gamedir):
            sys.exit(f"gamedir {self.gamedir!r} in serverlist.ini is not a game folder name")
        if self.proxy_header not in ("x-real-ip", "cf-connecting-ip", "none"):
            sys.exit(f"proxy_header {self.proxy_header!r} in serverlist.ini must be x-real-ip, cf-connecting-ip or none")
        if self.guild_id and not self.guild_id.isdigit():
            sys.exit(f"guild_id {self.guild_id!r} in serverlist.ini is not a number")
        if self.public_url and not self.public_url.startswith(("http://", "https://")):
            sys.exit(f"public_url {self.public_url!r} in serverlist.ini does not start with http:// or https://")


class ServerList:
    """The servers on the list, by "host:port"."""

    def __init__(self, settings):
        self.settings = settings
        self.entries = {}
        self.first_poll = asyncio.Event()                   # set once every seed has been asked

    def live(self, gamedir):
        """The servers in this game folder that answered within expire_seconds."""
        now = time.time()
        return [entry for entry in self.entries.values()
                if entry["folder"] == gamedir
                and entry["seen"]
                and now - entry["seen"] <= self.settings.expire_seconds]

    def standing(self, gamedir):
        """
        (served, answering, silent) for the Discord status: how many servers the list serves
        now (as live() counts them), how many answered at one of the last two polls, and how
        many are on the list without having answered in that time.
        """
        now = time.time()
        recent = 2 * (self.settings.poll_seconds + self.settings.probe_timeout)
        answering = silent = 0
        for entry in self.entries.values():
            if entry["folder"] not in (gamedir, ""):        # "" is a seed that has not answered yet
                continue
            if entry["seen"] and now - entry["seen"] <= recent:
                answering += 1
            else:
                silent += 1
        return len(self.live(gamedir)), answering, silent

    async def add(self, target, source):
        """
        Query an address and list it when it answers from this game folder. Returns
        (entry, None), or (None, reason) when it is refused.
        """
        info = await probe(target, self.settings.probe_timeout)
        if info is None:
            return None, "no answer from that address"
        if info["folder"] != self.settings.gamedir:
            return None, f"it runs the {info['folder']!r} game folder, not {self.settings.gamedir!r}"
        host, port = target
        address = f"{host}:{port}"
        if address not in self.entries:
            same = await self.same_server(host, port)
            if same:
                address = same
                host = self.entries[same]["host"]
        entry = self.entries.get(address) or new_entry(host, port, source)
        entry.update(info)
        entry["seen"] = time.time()
        self.entries[address] = entry
        log(f"listed {address} ({entry['name']}, {entry['map']}) from {source}")
        return entry, None

    async def same_server(self, host, port):
        """
        The key of an entry that names this IPv4 address and port by a host name (servers.txt's
        havoc9.org:27015, say), so that a heartbeat from that server refreshes it instead of
        listing the server twice. None when there is none.
        """
        if not IPV4_RE.match(host):
            return None
        loop = asyncio.get_running_loop()
        for key, entry in list(self.entries.items()):
            if entry["port"] != port or IPV4_RE.match(entry["host"]):
                continue
            try:
                found = await loop.getaddrinfo(entry["host"], port, family=socket.AF_INET, type=socket.SOCK_DGRAM)
            except OSError:
                continue
            if any(info[4][0] == host for info in found):
                return key
        return None

    def remove(self, target):
        host, port = target
        return self.entries.pop(f"{host}:{port}", None) is not None

    def load_seeds(self, path):
        """
        servers.txt: one host:port per line, # for comments. They are queried on the first poll
        and listed once they answer.
        """
        if not path.exists():
            return 0
        count = 0
        for line in path.read_text(encoding="utf-8").splitlines():
            text = line.split("#", 1)[0].strip()
            if not text:
                continue
            try:
                host, port = parse_address(text)
            except ValueError as exc:
                log(f"servers.txt: skipped {text!r}: {exc}")
                continue
            self.entries.setdefault(f"{host}:{port}", new_entry(host, port, "servers.txt"))
            count += 1
        return count

    async def poll(self):
        """Query every listed server again, then take off the ones that have gone quiet."""
        keys = list(self.entries)
        targets = [(self.entries[key]["host"], self.entries[key]["port"]) for key in keys]
        infos = await asyncio.gather(*(probe(target, self.settings.probe_timeout) for target in targets))
        now = time.time()
        for key, info in zip(keys, infos):
            entry = self.entries.get(key)
            if entry is not None and info is not None:
                entry.update(info)
                entry["seen"] = now
        for key, entry in list(self.entries.items()):
            if now - (entry["seen"] or entry["added"]) > self.settings.expire_seconds:
                log(f"dropped {key}: no answer for {self.settings.expire_seconds:g} s")
                del self.entries[key]
        self.first_poll.set()


def make_app(state, settings):
    app = web.Application()
    app["state"] = state
    app["settings"] = settings
    app["fails"] = {}                                       # address -> [wrong keys, when the window started]
    app.router.add_get("/v1/servers/{gamedir}", handle_list)
    app.router.add_get("/v1/servers/{gamedir}.json", handle_list_json)
    app.router.add_post("/v1/heartbeat", handle_heartbeat)
    return app


async def handle_list(request):
    """
    The engine's own list format: one "ip"/"gs" line per server, the # lines above each
    one ignored by the client (Documentation/protocol/http-server-list.md) but handed to a
    human reading this in a browser. mode and ping ride along in the comment for exactly
    that -- a plain-text line has no columns, so a page wanting them as actual fields
    (a table, not connect-address cards) wants handle_list_json below instead.
    """
    gamedir = request.match_info["gamedir"]
    if not GAMEDIR_RE.match(gamedir):
        raise web.HTTPNotFound()
    lines = [f"# H9 server list for {gamedir}, as of {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    for entry in request.app["state"].live(gamedir):
        lines.append(f"# {entry['name']} | {entry['map']} | {entry['mode']} | "
                      f"{entry['players']}/{entry['max']} | {entry['ping']:g} ms")
        lines.append(f"{entry['kind']} {entry['address']}")
    return web.Response(text="\n".join(lines) + "\n", content_type="text/plain", charset="utf-8")


async def handle_list_json(request):
    """
    The same live list as handle_list, as actual fields instead of a comment a page would
    otherwise have to parse. One object per server:
        address   "host:port" -- what a client actually connects to
        kind      "gs" (GoldSrc: stock hlds, REHLDS) or "ip" (Source-format: Xash)
        name      the server's own hostname
        map       the loaded map's bare name (e.g. "h9_te_neuropolis") -- also the
                  thumbnail key Discord Rich Presence already uses for this same map
                  (cl_presence.c sends it straight as large_image), so a page can reuse
                  that convention: look up an image named after this value, fall back to
                  a generic one for any map that doesn't have one yet
        mode      "Match Mode", or "Siege" / "Siege n/m" while an objective round is live,
                  or a claimed mode's name while it runs ("Capture the Uplink", "Wave
                  Survival", "Mech Warrior") -- ts_matchmode.sma's own fw_gamedesc, not
                  derived or guessed here
        players   current player count, bots included
        max       the server's player slots
        bots      of "players", how many are bots
        ping_ms   this bot's own measured round-trip to the server, milliseconds -- a
                  rough distance indicator, not a given website visitor's actual ping
    """
    gamedir = request.match_info["gamedir"]
    if not GAMEDIR_RE.match(gamedir):
        raise web.HTTPNotFound()
    servers = [
        {
            "address": entry["address"],
            "kind": entry["kind"],
            "name": entry["name"],
            "map": entry["map"],
            "mode": entry["mode"],
            "players": entry["players"],
            "max": entry["max"],
            "bots": entry["bots"],
            "ping_ms": entry["ping"],
        }
        for entry in request.app["state"].live(gamedir)
    ]
    body = {
        "gamedir": gamedir,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "servers": servers,
    }
    return web.json_response(body)


def heartbeat_blocked(fails, address, now):
    """Whether an address has sent HEARTBEAT_FAILS wrong keys in the current window."""
    entry = fails.get(address)
    if entry and now - entry[1] > HEARTBEAT_WINDOW:
        del fails[address]
        entry = None
    return bool(entry) and entry[0] >= HEARTBEAT_FAILS


def heartbeat_failed(fails, address, now):
    """Counts one wrong key; returns the count in this window. The table stays small."""
    if len(fails) > 10000:
        for key in [k for k, v in fails.items() if now - v[1] > HEARTBEAT_WINDOW]:
            del fails[key]
    if len(fails) > 10000:
        fails.clear()
    entry = fails.setdefault(address, [0, now])
    entry[0] += 1
    return entry[0]


def client_address(request, header="x-real-ip"):
    """
    The address a request came from. Behind nginx (havoc9.org/deploy/nginx-setup.sh) every
    request reaches the list from this machine, and nginx names the real one in X-Real-IP; behind
    a Cloudflare Tunnel cloudflared does, and the one header to believe is CF-Connecting-IP (it
    forwards a visitor's own X-Real-IP untouched). The named header is believed only from this
    machine, and only when it holds exactly one valid address; header "none" believes none.
    """
    remote = request.remote or ""
    if header != "none" and remote in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        real = request.headers.get(header, "").strip()
        try:
            return str(ipaddress.ip_address(real)) if real else remote
        except ValueError:
            return remote
    return remote


async def handle_heartbeat(request):
    """
    POST /v1/heartbeat. With the key ({"key": ..., "address": "host:port"}): any address. Without
    one ({"port": 27015}, as h9_heartbeat.ps1 sends it): the server it comes from, by the address
    it comes from and the port it names, unless open_heartbeats = 0 in serverlist.ini. Either
    way the server is listed only once it answers a query from this game folder.
    """
    settings = request.app["settings"]
    fails = request.app["fails"]
    now = time.monotonic()
    sender = client_address(request, settings.proxy_header)
    if heartbeat_blocked(fails, sender, now):
        return web.json_response({"ok": False, "error": "too many wrong keys from this address; wait"},
                                 status=429, headers={"Retry-After": str(HEARTBEAT_WINDOW)})
    try:
        body = await request.json()
    except ValueError:
        return web.json_response({"ok": False, "error": "the body is not JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "the body is not an object"}, status=400)
    given = str(body.get("key", "")).encode("utf-8")
    wanted = settings.heartbeat_key.encode("utf-8")
    keyed = bool(given) and bool(wanted) and hmac.compare_digest(given, wanted)
    if (given and not keyed) or (not given and not settings.open_heartbeats):
        count = heartbeat_failed(fails, sender, now)
        if count == 1 or count == HEARTBEAT_FAILS:
            log(f"heartbeat from {sender} refused: wrong or missing key"
                + (f" ({count} in {HEARTBEAT_WINDOW} s: refused for the rest of that time)" if count == HEARTBEAT_FAILS else ""))
        return web.json_response({"ok": False, "error": "wrong or missing key"}, status=401)
    if keyed:
        try:
            target = parse_address(str(body.get("address", "")))
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
    else:
        if not IPV4_RE.match(sender):
            return web.json_response({"ok": False, "error": "a heartbeat without the key comes over IPv4"}, status=400)
        try:
            if body.get("address"):
                host, port = parse_address(str(body["address"]))
                if host != sender:
                    return web.json_response({"ok": False, "error": "a heartbeat without the key lists only the address it comes from"}, status=403)
            else:
                port = int(body.get("port", DEFAULT_PORT))
                if not 0 < port <= 65535:
                    raise ValueError(f"bad port {port}")
        except (TypeError, ValueError) as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        target = (sender, port)
    entry, reason = await request.app["state"].add(target, f"heartbeat from {sender}")
    if entry is None:
        return web.json_response({"ok": False, "error": reason}, status=422)
    return web.json_response({"ok": True, "address": entry["address"], "name": entry["name"]})


def register_commands(tree, state, settings):
    import discord
    from discord import app_commands

    def shown(text):
        """A server's own text as it goes into a Discord message: no markdown, no mentions."""
        return discord.utils.escape_markdown(discord.utils.escape_mentions(str(text or "")))

    def may_change_list(interaction):
        user = interaction.user
        if not hasattr(user, "roles"):                      # a DM: there is no server role to check
            return False
        if settings.role_id:
            return any(str(role.id) == settings.role_id for role in user.roles)
        return user.guild_permissions.manage_guild

    @tree.command(name="servers", description="The servers on the H9 list right now")
    async def servers(interaction):
        entries = state.live(settings.gamedir)[:MAX_LISTED]
        if not entries:
            text = "No server on the list answers right now."
        else:
            text = "\n".join(f"**{shown(e['name'])}** | {shown(e['map'])} | {e['players']}/{e['max']} | `{e['address']}`"
                             for e in entries)
        await interaction.response.send_message(text)

    @tree.command(name="addserver", description="Add a server to the list. It must answer a query.")
    @app_commands.describe(address="host:port, for example 192.0.2.10:27015")
    async def addserver(interaction, address: str):
        if not may_change_list(interaction):
            await interaction.response.send_message(
                "Changing the list needs the list role, or Manage Server.", ephemeral=True)
            return
        try:
            target = parse_address(address)
        except ValueError as exc:
            await interaction.response.send_message(str(exc), ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        entry, reason = await state.add(target, f"Discord {interaction.user}")
        if entry is None:
            await interaction.followup.send(f"Not added: {reason}.", ephemeral=True)
        else:
            tag = " (GoldSrc)" if entry["kind"] == "gs" else ""
            await interaction.followup.send(f"Listed {entry['address']} ({shown(entry['name'])}){tag}.", ephemeral=True)

    @tree.command(name="removeserver", description="Take a server off the list")
    @app_commands.describe(address="host:port, as /servers shows it")
    async def removeserver(interaction, address: str):
        if not may_change_list(interaction):
            await interaction.response.send_message(
                "Changing the list needs the list role, or Manage Server.", ephemeral=True)
            return
        try:
            target = parse_address(address)
        except ValueError as exc:
            await interaction.response.send_message(str(exc), ephemeral=True)
            return
        shown = f"{target[0]}:{target[1]}"
        text = f"Removed {shown}." if state.remove(target) else f"{shown} is not on the list."
        await interaction.response.send_message(text, ephemeral=True)


def make_bot(state, settings):
    try:
        import discord
        from discord import app_commands
    except ImportError as exc:
        sys.exit(f"discord_token is set, but discord.py is not installed: {exc}\n"
                 f"  pip install -r requirements.txt")

    class ListBot(discord.Client):
        def __init__(self):
            # no message of the bot pings anyone
            super().__init__(intents=discord.Intents.default(), allowed_mentions=discord.AllowedMentions.none())
            self.tree = app_commands.CommandTree(self)
            self.shown = None                               # the (status, text) Discord shows now
            self.list_ok = True                             # the last public_url check; true when there is none
            self.status_task = None
            register_commands(self.tree, state, settings)

        async def setup_hook(self):
            if settings.guild_id:
                guild = discord.Object(id=int(settings.guild_id))
                self.tree.copy_global_to(guild=guild)
                await self.tree.sync(guild=guild)
            else:
                await self.tree.sync()
            self.status_task = asyncio.create_task(self.keep_status())

        async def on_ready(self):
            log(f"Discord: online as {self.user}")
            self.shown = None                               # a new session starts with no status: send it again

        async def keep_status(self):
            """
            Keeps the bot's status in step with the list (status_for): looked at every
            STATUS_SECONDS, sent to Discord only when it changes. The first one waits for the
            first poll, so seeds that have not been asked yet are not shown as unreachable.
            """
            await self.wait_until_ready()
            await state.first_poll.wait()
            checked = None
            while not self.is_closed():
                try:
                    if settings.public_url and (checked is None or time.monotonic() - checked >= LIST_CHECK_SECONDS):
                        self.list_ok = await list_reachable(settings)
                        checked = time.monotonic()
                    wanted = status_for(*state.standing(settings.gamedir), self.list_ok)
                    if wanted != self.shown:
                        await self.change_presence(status=discord.Status(wanted[0]),
                                                   activity=discord.CustomActivity(name=wanted[1]))
                        self.shown = wanted
                        log(f"Discord: status {wanted[0]}, {wanted[1]!r}")
                except Exception as exc:                    # noqa: BLE001
                    log(f"Discord: status not changed: {exc}")
                await asyncio.sleep(STATUS_SECONDS)

    return ListBot()


async def poll_forever(state):
    while True:
        await state.poll()
        await asyncio.sleep(state.settings.poll_seconds)


async def main():
    settings = Settings()
    state = ServerList(settings)
    state.load_seeds(SEEDS)
    if not settings.heartbeat_key:
        log("no heartbeat_key in serverlist.cfg: heartbeats are refused until there is one")
    runner = web.AppRunner(make_app(state, settings))
    await runner.setup()
    await web.TCPSite(runner, settings.host, settings.port).start()
    log(f"list on http://{settings.host}:{settings.port}/v1/servers/{settings.gamedir}")
    tasks = [asyncio.create_task(poll_forever(state))]
    if settings.discord_token:
        bot = make_bot(state, settings)
        tasks.append(asyncio.create_task(bot.start(settings.discord_token)))
    else:
        log("Discord is off: no discord_token in serverlist.cfg, H9_DISCORD_TOKEN or a service credential")
    try:
        await asyncio.gather(*tasks)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("stopped")
