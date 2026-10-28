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
    The HTTP list and the Discord bot share one event loop. With no discord_token in
    serverlist.cfg the bot is not started, and the list runs alone.
"""

import asyncio
import configparser
import hmac
import re
import sys
import time
from pathlib import Path

try:
    import a2s
    from a2s.info import GoldSrcInfo
    from aiohttp import web
except ImportError as exc:                                  # noqa: BLE001
    sys.exit(f"missing dependency: {exc}\n  pip install -r requirements.txt")


HERE = Path(__file__).resolve().parent
INI = HERE / "serverlist.ini"
SECRETS = HERE / "serverlist.cfg"
SEEDS = HERE / "servers.txt"
LOG = HERE / "serverlist.log"

DEFAULT_PORT = 27015                                        # the engine's default for a bare host
GAMEDIR_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
MAX_LISTED = 15                                             # /servers stays under Discord's message size


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


class Settings:
    """serverlist.ini for the settings, serverlist.cfg for the two secrets."""

    def __init__(self):
        ini = configparser.ConfigParser(interpolation=None)
        ini.read(INI, encoding="utf-8")
        secrets = configparser.ConfigParser(interpolation=None)
        secrets.read(SECRETS, encoding="utf-8")
        self.host = ini.get("http", "host", fallback="0.0.0.0").strip()
        self.port = ini.getint("http", "port", fallback=8080)
        self.gamedir = ini.get("list", "gamedir", fallback="ts").strip()
        self.poll_seconds = ini.getfloat("list", "poll_seconds", fallback=30.0)
        self.expire_seconds = ini.getfloat("list", "expire_seconds", fallback=300.0)
        self.probe_timeout = ini.getfloat("list", "probe_timeout", fallback=2.0)
        self.guild_id = ini.get("discord", "guild_id", fallback="").strip()
        self.role_id = ini.get("discord", "role_id", fallback="").strip()
        self.heartbeat_key = secrets.get("secrets", "heartbeat_key", fallback="").strip()
        self.discord_token = secrets.get("secrets", "discord_token", fallback="").strip()
        if not GAMEDIR_RE.match(self.gamedir):
            sys.exit(f"gamedir {self.gamedir!r} in serverlist.ini is not a game folder name")
        if self.guild_id and not self.guild_id.isdigit():
            sys.exit(f"guild_id {self.guild_id!r} in serverlist.ini is not a number")


class ServerList:
    """The servers on the list, by "host:port"."""

    def __init__(self, settings):
        self.settings = settings
        self.entries = {}

    def live(self, gamedir):
        """The servers in this game folder that answered within expire_seconds."""
        now = time.time()
        return [entry for entry in self.entries.values()
                if entry["folder"] == gamedir
                and entry["seen"]
                and now - entry["seen"] <= self.settings.expire_seconds]

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
        entry = self.entries.get(address) or new_entry(host, port, source)
        entry.update(info)
        entry["seen"] = time.time()
        self.entries[address] = entry
        log(f"listed {address} ({entry['name']}, {entry['map']}) from {source}")
        return entry, None

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


def make_app(state, settings):
    app = web.Application()
    app["state"] = state
    app["settings"] = settings
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


async def handle_heartbeat(request):
    settings = request.app["settings"]
    try:
        body = await request.json()
    except ValueError:
        return web.json_response({"ok": False, "error": "the body is not JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "the body is not an object"}, status=400)
    given = str(body.get("key", "")).encode("utf-8")
    wanted = settings.heartbeat_key.encode("utf-8")
    if not wanted or not hmac.compare_digest(given, wanted):
        log(f"heartbeat from {request.remote} refused: wrong or missing key")
        return web.json_response({"ok": False, "error": "wrong or missing key"}, status=401)
    try:
        target = parse_address(str(body.get("address", "")))
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    entry, reason = await request.app["state"].add(target, f"heartbeat from {request.remote}")
    if entry is None:
        return web.json_response({"ok": False, "error": reason}, status=422)
    return web.json_response({"ok": True, "address": entry["address"], "name": entry["name"]})


def register_commands(tree, state, settings):
    from discord import app_commands

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
            text = "\n".join(f"**{e['name']}** | {e['map']} | {e['players']}/{e['max']} | `{e['address']}`"
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
            await interaction.followup.send(f"Listed {entry['address']} ({entry['name']}){tag}.", ephemeral=True)

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
            super().__init__(intents=discord.Intents.default())
            self.tree = app_commands.CommandTree(self)
            register_commands(self.tree, state, settings)

        async def setup_hook(self):
            if settings.guild_id:
                guild = discord.Object(id=int(settings.guild_id))
                self.tree.copy_global_to(guild=guild)
                await self.tree.sync(guild=guild)
            else:
                await self.tree.sync()

        async def on_ready(self):
            log(f"Discord: online as {self.user}")

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
        log("Discord is off: no discord_token in serverlist.cfg")
    try:
        await asyncio.gather(*tasks)
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("stopped")
