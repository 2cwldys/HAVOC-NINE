"""
Release announcement for ts_bot.py -- posts an embed when a new version goes live.

Not wired into ts_bot.py yet. The four edits that do it are under "Where it goes" below.

How it fires
------------
The host writes one small file at the END of a successful install (see
receive-deploy-snippet.ps1). The bot watches that file and posts when the version in it
changes. That ordering matters: the announcement goes out when the build is actually live on
the host, not when an upload started and not when a local build finished. 1.68 is exactly the
case that argues for it -- the package built, uploaded, and was then refused by the host, and
nothing anywhere said so. A watcher on the host's own state cannot make that mistake, because
the file is only written after the install succeeds.

A file rather than a webhook call from the deploy script, for two reasons: the deploy script
never needs the bot token, and a post that fails (Discord down, bot restarting) is retried on
the next tick instead of being lost.

Where it goes in ts_bot.py
--------------------------
1. the two colours and RELEASE_STATE, next to PURPLE at line 54
2. release_embed() and release_loop(), next to watch_server() at line 126
3. one line in Bot.setup_hook() (line 163) to start the loop
4. one optional /release command, next to /status

Config, in ts_advertise.cfg beside the keys the bot already reads:

    tsm_ad_release_channel  "123456789012345678"   // optional; defaults to tsm_ad_channel
    tsm_ad_release_file     "C:/havoc9/data/release.json"
    tsm_ad_release_role     "123456789012345678"   // optional; pinged on a new release
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import discord
from discord.ext import tasks

# ---------------------------------------------------------------- 1. colours and state

# HAVOC 9. A Discord embed carries exactly one colour, so orange is the stripe -- it is the
# thing that moved, which is the same rule the rest of the H9 theme uses -- and the purple
# has to arrive as an image, because there is nowhere else in an embed to put a second colour.
# ORANGE is the release; PURPLE stays what the match embeds already use (ts_bot.py line 54).
H9_ORANGE = 0xFF7A18
H9_PURPLE = 0xA78BFA

# The last version this bot announced. Kept beside rsvp.json, same idea: losing it re-posts
# one release, which is better than the bot refusing to start.
RELEASE_STATE = Path(__file__).parent / "release-posted.json"

# Tiny gradient strip, orange into purple, shown under the fields. Optional: without it the
# embed is simply orange. Serve it from the site next to the other assets.
H9_STRIP_URL = "https://havoc9.org/assets/h9-strip.png"
H9_ICON_URL = "https://havoc9.org/assets/h9-mark.png"


def _load_posted():
    try:
        return json.loads(RELEASE_STATE.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}


def _save_posted(data):
    try:
        RELEASE_STATE.write_text(json.dumps(data), encoding="utf-8")
    except OSError:
        pass        # a release that cannot be recorded is re-announced once, not lost


# ---------------------------------------------------------------- 2. the embed

def release_embed(info, cfg):
    """
    info is the host's release.json, verbatim. Every field is optional except version: the
    host writes what it knows, and a key that is missing simply does not appear.
    """
    version = str(info.get("version", "")).strip() or "unknown"

    embed = discord.Embed(
        title=f"HAVOC 9  {version}",
        description=info.get("notes") or "A new build is live. The updater will pick it up.",
        colour=H9_ORANGE,
    )
    embed.set_author(name="New release", icon_url=H9_ICON_URL)

    changed = info.get("files")
    if changed:
        embed.add_field(name="Files changed", value=f"{int(changed):,}", inline=True)

    size = info.get("mb")
    if size:
        embed.add_field(name="Download", value=f"{float(size):,.1f} MB", inline=True)

    # What a player actually does about it. The updater is the answer for almost everyone,
    # so it goes above the raw links rather than below them.
    embed.add_field(
        name="Get it",
        value="Run **H9XASH-Updater.exe** -- it takes only what changed.",
        inline=False,
    )

    connect = cfg.get("tsm_ad_connect", "").strip()
    if connect:
        embed.add_field(name="Connect", value=f"`connect {connect}`", inline=False)

    # The strip is where the purple lives. If the asset is not there Discord drops the image
    # silently and the embed still reads correctly, so this is safe to ship before the art is.
    if H9_STRIP_URL:
        embed.set_image(url=H9_STRIP_URL)

    at = info.get("at")
    if at:
        try:
            embed.timestamp = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        except ValueError:
            pass
    else:
        embed.timestamp = datetime.now(timezone.utc)

    embed.set_footer(text="havoc9.org")
    return embed


# ---------------------------------------------------------------- 3. the watcher

@tasks.loop(seconds=30)
async def release_loop(bot):
    cfg = bot.cfg

    path = cfg.get("tsm_ad_release_file", "").strip() or r"C:\havoc9\data\release.json"
    if not os.path.exists(path):
        return

    try:
        info = json.loads(Path(path).read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return          # written half-way through; the next tick reads it whole

    version = str(info.get("version", "")).strip()
    if not version:
        return

    posted = _load_posted()
    if posted.get("version") == version:
        return          # already announced

    channel_id = (cfg.get("tsm_ad_release_channel", "").strip()
                  or cfg.get("tsm_ad_channel", "").strip())
    if not channel_id.isdigit():
        return

    channel = bot.get_channel(int(channel_id))
    if channel is None:
        return          # not in the cache yet; try again on the next tick

    role = cfg.get("tsm_ad_release_role", "").strip()
    content = f"<@&{role}>" if role.isdigit() else None

    try:
        await channel.send(content=content, embed=release_embed(info, cfg))
    except discord.HTTPException:
        return          # Discord said no; the version is not recorded, so this retries

    # Recorded only after the post succeeded, so a failure repeats rather than disappears.
    _save_posted({"version": version, "at": datetime.now(timezone.utc).isoformat()})
    print(f"[bot] announced release {version} in {channel_id}", flush=True)


@release_loop.before_loop
async def _before_release_loop():
    pass    # bot.wait_until_ready() is done by the caller in setup_hook


# ---------------------------------------------------------------- 4. wiring
#
# In Bot.setup_hook(), beside the other tasks:
#
#     release_loop.start(self)
#
# and an optional command beside /status, so the current build can be asked for:
#
#     @bot.tree.command(name="release", description="What build the server is on")
#     async def release(interaction: discord.Interaction):
#         path = cfg.get("tsm_ad_release_file", "").strip() or r"C:\havoc9\data\release.json"
#         try:
#             info = json.loads(Path(path).read_text(encoding="utf-8"))
#         except (ValueError, OSError):
#             await interaction.response.send_message("I cannot read the host's release file.",
#                                                     ephemeral=True)
#             return
#         await interaction.response.send_message(embed=release_embed(info, cfg))
