"""
Announce the build the site is serving, by hand.

The bot does this by itself when downloads/.build changes (h9_serverlist.py, note_build). This is
the same announcement, sent on demand, for when that did not happen: the bot was down, the setting
was added after the release, or the release went out before any of this existed.

It reads the same settings the bot does, sends the same embed, pings the same role, and then
records the build in announced_build so the bot does NOT post it a second time.

    announce-release.cmd                 announce what the site serves now
    announce-release.cmd --dry-run       show what would be sent, send nothing
    announce-release.cmd --build 1.68    announce a particular build
    announce-release.cmd --force         send even if announced_build already names it

Nothing here needs the repo: it runs on the host, beside the bot.
"""

import argparse
import configparser
import io
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

HOME = os.environ.get("H9_SERVERLIST_HOME") or r"C:\havoc9\data\serverlist"
INI = os.path.join(HOME, "serverlist.ini")
CFG = os.path.join(HOME, "serverlist.cfg")
ANNOUNCED = os.path.join(HOME, "announced_build")

H9_ORANGE = 0xFF7A18
BUILD_RE = r"[0-9][A-Za-z0-9._-]{0,31}"


def die(msg):
    print("announce-release: " + msg)
    raise SystemExit(1)


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--build", default="", help="the build to announce; default is what the site serves")
    ap.add_argument("--dry-run", action="store_true", help="show the embed, send nothing")
    ap.add_argument("--force", action="store_true", help="send even if this build was announced already")
    args = ap.parse_args()

    if not os.path.exists(INI):
        die("no %s (set H9_SERVERLIST_HOME if the bot's data is elsewhere)" % INI)

    ini = configparser.ConfigParser()
    ini.read(INI, encoding="utf-8")
    channel = ini.get("discord", "release_channel", fallback="").strip()
    role = ini.get("discord", "release_role", fallback="").strip()
    image = ini.get("discord", "release_image", fallback="").strip()
    build_file = ini.get("discord", "build_file", fallback="").strip()

    if not channel.isdigit():
        die("release_channel is not set in %s -- there is nowhere to post" % INI)

    build = args.build.strip()
    if not build:
        if not build_file:
            die("no --build given and build_file is not set in %s" % INI)
        try:
            with io.open(build_file, encoding="ascii", errors="replace") as f:
                build = f.readline().strip()
        except OSError as e:
            die("cannot read %s (%s)" % (build_file, e))
    import re
    if not re.fullmatch(BUILD_RE, build or ""):
        die("%r does not look like a build number" % build)

    already = ""
    if os.path.exists(ANNOUNCED):
        try:
            with io.open(ANNOUNCED, encoding="ascii", errors="replace") as f:
                already = f.readline().strip()
        except OSError:
            already = ""

    print("build to announce : %s" % build)
    print("channel           : %s" % channel)
    print("role ping         : %s" % (role if role.isdigit() else "(none)"))
    print("already announced : %s" % (already or "(nothing yet)"))

    if already == build and not args.force and not args.dry_run:
        print()
        print("That build was announced already. Use --force to send it again.")
        return

    embed = {
        "title": "HAVOC 9  " + build,
        "description": "A new version is available.",
        "color": H9_ORANGE,
        "url": "https://havoc9.org/downloads/",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if image:
        embed["image"] = {"url": image}

    payload = {"embeds": [embed]}
    if role.isdigit():
        payload["content"] = "<@&%s>" % role
        # only this role may be mentioned, whatever the text happens to contain
        payload["allowed_mentions"] = {"parse": [], "roles": [role]}
    else:
        payload["allowed_mentions"] = {"parse": []}

    if args.dry_run:
        print()
        print("--dry-run, nothing sent. This is the message:")
        print(json.dumps(payload, indent=2))
        return

    if not os.path.exists(CFG):
        die("no %s to read the bot token from" % CFG)
    secrets = configparser.ConfigParser()
    secrets.read(CFG, encoding="utf-8")
    token = (secrets.get("secrets", "discord_token", fallback="") or "").strip()
    if not token:
        die("no discord_token in %s" % CFG)

    req = urllib.request.Request(
        "https://discord.com/api/v10/channels/%s/messages" % channel,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": "Bot " + token,
            "Content-Type": "application/json",
            "User-Agent": "DiscordBot (https://havoc9.org, 1.0)",
        },
    )

    print()
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
            print("sent: HTTP %s, message %s" % (r.status, data.get("id")))
    except urllib.error.HTTPError as e:
        # the request carries the token in a header, so only the response is shown
        die("Discord said HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:300]))
    except Exception as e:
        die("could not send: %s" % e)

    # Recorded only after it went, so a failure can simply be run again, and recorded at all so
    # the bot does not post the same build a second time when it next looks.
    try:
        tmp = ANNOUNCED + ".tmp"
        with io.open(tmp, "w", encoding="ascii") as f:
            f.write(build + "\n")
        os.replace(tmp, ANNOUNCED)
        print("recorded in %s, so the bot will not repeat it" % ANNOUNCED)
    except OSError as e:
        print("WARNING: sent, but could not write %s (%s)" % (ANNOUNCED, e))
        print("         the bot may announce %s again when it next looks" % build)


if __name__ == "__main__":
    main()
