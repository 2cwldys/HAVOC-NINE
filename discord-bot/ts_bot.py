"""
ts_bot.py -- the Discord side of ts_advertise.

The plugin posts adverts on its own and does not need this process at all: a bot token
is a credential, not a connection, so an HTTPS POST from the game server is enough to
put a message in a channel. What a running process adds is everything INBOUND --

    * the bot showing as online, which needs a gateway connection and nothing else
    * slash commands typed in Discord (/who, /status, /advertise)
    * the RSVP buttons on an advert, which are interactions Discord pushes to us

None of which can happen over one-way HTTP.

WHAT THIS DOES NOT TALK TO
    It never talks to the plugin, and the plugin never talks to it. Everything it needs
    about the game server it gets by QUERYING THE SERVER DIRECTLY over A2S, the same
    UDP protocol the server browser uses. That keeps the two halves independent: the
    plugin posts adverts whether or not this is running, and this answers /who whether
    or not anybody has advertised. The only thing they share is a config file.

RSVP ACROSS RESTARTS
    The buttons are registered as a PERSISTENT view with fixed custom_ids, which is
    what lets this handle clicks on adverts THE PLUGIN POSTED and on adverts posted
    before the last restart. Without that, a button only works while the exact View
    object that created it is still in memory, and every restart silently breaks every
    advert already in the channel.
"""

import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import a2s
    import discord
    from discord import app_commands
except ImportError as exc:                                  # noqa: BLE001
    sys.exit(f"missing dependency: {exc}\n  pip install -r requirements.txt")


HERE = Path(__file__).resolve().parent
STATE = HERE / "rsvp.json"
PIDFILE = HERE / "bot.pid"

# The AMXX configs, relative to this folder when it sits beside the game's ts\ folder.
# Overridden with TSM_CONFIGS when it does not.
DEFAULT_CONFIGS = HERE.parent / "ts" / "addons" / "amxmodx" / "configs"

PURPLE = 0xA78BFA                                           # the plugin's embed colour


def read_cfgs():
    """
    The token, channel and server address, read from the PLUGIN'S OWN CONFIG.

    Deliberately not a config file of its own. The bot token would then exist in two
    places, and two copies of a credential is two things to rotate and one of them gets
    forgotten -- usually the one that is not obviously a secret.

    One file, the same one the plugin reads, token included. Not a config of its own:
    the token would then exist in two places, and two copies of a credential is two
    things to rotate when it leaks, one of which gets forgotten.
    """
    where = Path(os.environ.get("TSM_CONFIGS", DEFAULT_CONFIGS))
    found = {}
    for name in ("ts_advertise.cfg",):
        path = where / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            m = re.match(r'^(\w+)\s+"([^"]*)"', line)
            if m:
                found[m.group(1)] = m.group(2)
    if not found:
        sys.exit(f"no ts_advertise config found under {where}\n"
                 f"  set TSM_CONFIGS to the amxmodx configs folder")
    return found


def load_rsvp():
    if STATE.exists():
        try:
            return json.loads(STATE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass            # a corrupt file loses the RSVPs, which is better than not starting
    return {}


def save_rsvp(data):
    try:
        STATE.write_text(json.dumps(data), encoding="utf-8")
    except OSError as exc:                                  # noqa: BLE001
        print(f"[bot] could not save rsvp state: {exc}", flush=True)


SERVER_EXE = os.environ.get("TSM_SERVER_EXE", "hlds.exe")


def server_running():
    """
    Is the game server still up?

    tasklist rather than psutil, to keep this to two dependencies. A FAILED CHECK
    REPORTS True: the only thing this is used for is deciding to shut down, and a
    timeout or a blocked tasklist must never be the reason the bot quits.
    """
    try:
        out = subprocess.run(
            ["tasklist", "/fi", f"IMAGENAME eq {SERVER_EXE}", "/nh"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return SERVER_EXE.lower() in out.stdout.lower()
    except Exception:                                       # noqa: BLE001
        return True


async def watch_server(bot):
    """
    Shut the bot down when the game server goes away.

    THE LAUNCHER CANNOT BE RELIED ON TO DO THIS. ts.bat stops the bot after hlds
    returns, which covers a clean quit and nothing else: closing the console window
    kills cmd outright, and the cleanup line never runs. Task Manager, a crash, a
    reboot -- same. So the bot watches for itself, and the launcher's cleanup is
    only there to make a clean exit immediate rather than up to fifteen seconds.

    It waits until it has SEEN the server at least once before it will act on its
    absence. The launcher starts the bot first, so the server is not up yet at this
    point -- and without that latch the bot would shut down a few seconds after
    starting, every time.
    """
    if os.environ.get("TSM_WATCH", "1") == "0":
        print("[bot] TSM_WATCH=0 -- not watching the game server", flush=True)
        return
    seen = False
    while not bot.is_closed():
        await asyncio.sleep(15)
        if await asyncio.to_thread(server_running):
            seen = True
        elif seen:
            print(f"[bot] {SERVER_EXE} has gone -- shutting down", flush=True)
            await bot.close()
            return


class Bot(discord.Client):
    def __init__(self, cfg):
        super().__init__(intents=discord.Intents.default())
        self.cfg = cfg
        self.tree = app_commands.CommandTree(self)
        self.rsvp = load_rsvp()

    async def setup_hook(self):
        # Registered BEFORE the gateway connects, so a click that arrives in the first
        # second is handled rather than dropped.
        self.add_view(RsvpView(self))
        await self.tree.sync()
        print("[bot] commands synced", flush=True)
        self.loop.create_task(watch_server(self))

    async def on_ready(self):
        print(f"[bot] online as {self.user}", flush=True)
        await self.change_presence(
            activity=discord.Activity(type=discord.ActivityType.watching, name="for matches"),
        )

    # ---- the game server -------------------------------------------------

    def address(self):
        """The game server as (host, port), from tsm_ad_connect."""
        raw = self.cfg.get("tsm_ad_connect", "").strip()
        if not raw:
            return None
        host, _, port = raw.partition(":")
        return (host, int(port or 27015))

    async def query(self):
        """
        A2S_INFO and A2S_PLAYER, or None if the server is not answering.

        Run in a thread: python-a2s is blocking, and blocking the event loop is how a
        bot stops responding to Discord while it waits on a dead game server.
        """
        addr = self.address()
        if not addr:
            return None
        try:
            info = await asyncio.to_thread(a2s.info, addr, 2.0)
            players = await asyncio.to_thread(a2s.players, addr, 2.0)
            return info, players
        except (OSError, asyncio.TimeoutError, Exception):   # noqa: BLE001
            return None


class RsvpView(discord.ui.View):
    """
    The buttons on an advert.

    timeout=None and fixed custom_ids make it PERSISTENT: Discord routes a click by
    custom_id to whatever view the bot registered at startup, so this handles buttons on
    messages it never posted -- which is every advert, since the plugin posts them.
    """

    def __init__(self, bot):
        super().__init__(timeout=None)
        self.bot = bot

    async def answer(self, interaction, coming):
        key = str(interaction.message.id)
        who = self.bot.rsvp.setdefault(key, {"in": [], "out": []})
        uid = str(interaction.user.id)

        for side in ("in", "out"):
            if uid in who[side]:
                who[side].remove(uid)
        who["in" if coming else "out"].append(uid)
        save_rsvp(self.bot.rsvp)

        # Edited onto the original embed rather than sent as a reply, so the channel
        # does not fill with one message per person answering.
        embed = interaction.message.embeds[0] if interaction.message.embeds else discord.Embed()
        names_in = ", ".join(f"<@{u}>" for u in who["in"]) or "nobody yet"
        field = f"**In ({len(who['in'])}):** {names_in}"

        fields = [f for f in embed.fields if f.name != "Coming"]
        embed.clear_fields()
        for f in fields:
            embed.add_field(name=f.name, value=f.value, inline=f.inline)
        embed.add_field(name="Coming", value=field, inline=False)

        await interaction.response.edit_message(embed=embed, view=self)

    @discord.ui.button(label="I'm in", style=discord.ButtonStyle.success,
                       custom_id="tsm_rsvp_in", emoji="\N{WHITE HEAVY CHECK MARK}")
    async def rsvp_in(self, interaction, button):
        await self.answer(interaction, True)

    @discord.ui.button(label="Can't make it", style=discord.ButtonStyle.secondary,
                       custom_id="tsm_rsvp_out")
    async def rsvp_out(self, interaction, button):
        await self.answer(interaction, False)


def build_embed(cfg, info, players, organiser=None):
    """The same embed the plugin builds, so an advert looks the same whoever posted it."""
    title = "Someone is looking for a match"
    if organiser:
        desc = f"{organiser} is organising a match"
    else:
        desc = "A match is being organised"

    embed = discord.Embed(title=title, description=desc, colour=PURPLE)
    if info is None:
        embed.add_field(name="Server", value="not answering right now", inline=False)
        return embed

    humans = [p for p in players if p.name]
    bots = max(0, info.bot_count)
    embed.add_field(name="Map", value=info.map_name, inline=True)
    embed.add_field(name="Players", value=f"{max(0, info.player_count - bots)} / {info.max_players}", inline=True)
    if bots:
        embed.add_field(name="Bots", value=str(bots), inline=True)
    if humans:
        embed.add_field(name="On now", value=", ".join(p.name for p in humans[:20]), inline=False)

    connect = cfg.get("tsm_ad_connect", "").strip()
    if connect:
        embed.add_field(name="Connect", value=f"`connect {connect}`", inline=False)
    return embed


def main():
    cfg = read_cfgs()
    token = cfg.get("tsm_ad_token", "").strip()
    channel_id = cfg.get("tsm_ad_channel", "").strip()
    if not token or token.startswith("PASTE"):
        sys.exit("tsm_ad_token is not set in ts_advertise.cfg")

    bot = Bot(cfg)

    @bot.tree.command(name="who", description="Who is on the game server right now")
    async def who(interaction: discord.Interaction):
        await interaction.response.defer(thinking=True)
        got = await bot.query()
        if got is None:
            await interaction.followup.send("The game server is not answering.")
            return
        info, players = got
        named = [p for p in players if p.name]
        if not named:
            await interaction.followup.send(f"Nobody on **{info.server_name}** ({info.map_name}).")
            return
        lines = "\n".join(f"  {p.name} -- {int(p.score)}" for p in sorted(named, key=lambda q: -q.score))
        await interaction.followup.send(f"**{info.server_name}** on `{info.map_name}`\n{lines}")

    @bot.tree.command(name="status", description="What the game server is doing")
    async def status(interaction: discord.Interaction):
        await interaction.response.defer(thinking=True)
        got = await bot.query()
        if got is None:
            await interaction.followup.send("The game server is not answering.")
            return
        info, players = got
        await interaction.followup.send(embed=build_embed(cfg, info, players))

    @bot.tree.command(name="advertise", description="Call for a match in this channel")
    async def advertise(interaction: discord.Interaction):
        await interaction.response.defer(thinking=True)
        got = await bot.query()
        info, players = got if got else (None, [])
        mention = ""
        role = cfg.get("tsm_ad_role", "").strip()
        if role:
            mention = f"<@&{role}>"
        embed = build_embed(cfg, info, players, organiser=interaction.user.display_name)
        await interaction.followup.send(
            content=mention, embed=embed, view=RsvpView(bot),
            allowed_mentions=discord.AllowedMentions(everyone=False, users=False,
                                                     roles=[discord.Object(id=int(role))] if role else False),
        )

    # The launcher reads this to know what to stop, and stop-bot.bat uses it too.
    # Written by the bot rather than captured by the launcher because a batch file
    # cannot get the pid of something it started with "start", and the ways round that
    # -- PowerShell line continuations inside a for/f, matching on window titles --
    # are exactly the kind of thing that breaks silently and takes the server with it.
    try:
        PIDFILE.write_text(str(os.getpid()), encoding="utf-8")
    except OSError as exc:                                  # noqa: BLE001
        print(f"[bot] could not write {PIDFILE}: {exc}", flush=True)

    print(f"[bot] starting, channel {channel_id}", flush=True)
    try:
        bot.run(token, log_handler=None)
    finally:
        try:
            PIDFILE.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()
