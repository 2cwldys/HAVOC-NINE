# The Discord side of `.advertise`

Someone types `.advertise` in game chat and a call for a match appears in a Discord
channel, with the map, who is on and a connect line.

There are **two halves**, and the first thing to understand is that they are independent.

| | does what | needs what running |
|---|---|---|
| `ts_advertise.amxx` (the plugin) | posts the advert | nothing but the game server |
| `ts_bot.py` (this) | online presence, slash commands, RSVP buttons | its own python process |

**The plugin posts adverts on its own.** A bot token is a *credential*, not a connection:
the game server makes an HTTPS request to Discord carrying the token, and Discord
creates the message. No program of yours is involved. You can run the plugin with no
bot process at all and adverts will post perfectly.

What a running process adds is everything **inbound** -- the things Discord has to push
*to* you, which one-way HTTP cannot do:

* the bot showing as **online** (the green dot is a gateway connection and nothing else)
* **slash commands** typed in Discord
* the **RSVP buttons** on an advert

If the bot is not running, adverts still post, but the bot shows offline and clicking a
button says "This interaction failed".

## Where it goes

**In the Half-Life folder, beside `ts\` -- not inside it.**

```
Half-Life\
    hlds.exe
    ts.bat                      <- run this
    discord-bot\
        ts_bot.py
        requirements.txt
    ts\
        addons\amxmodx\configs\ts_advertise.cfg     <- settings AND the token
        addons\amxmodx\modules\easy_http_amxx.dll
        addons\amxmodx\data\amxx_easy_http_cacert.pem
```

That layout is not arbitrary: the bot finds the token by looking at
`..\ts\addons\amxmodx\configs`, so it has to sit one level above `ts\`. If you need it
somewhere else, set `TSM_CONFIGS` to the configs folder.

## Setting it up

**1. The AMXX module.** Download AmxxEasyHttp and put `easy_http_amxx.dll` in
`ts\addons\amxmodx\modules\` and `amxx_easy_http_cacert.pem` in `ts\addons\amxmodx\data\`.

Without the `.pem` **every request fails certificate validation and reports it as a
connection error**, not as a missing file. That one costs an afternoon.

**2. The bot application.** Discord Developer Portal -> New Application -> Bot ->
Reset Token, and copy it. The token is shown once.

Invite it with the **`bot` and `applications.commands`** scopes -- without the second
one the slash commands never appear -- and give it **View Channel, Send Messages** and
**Embed Links** in the channel you are posting to.

**3. The config.** One file, `tsddonsmxmodx\configs	s_advertise.cfg`, read by
both the plugin and the bot:

```
tsm_ad_token   "the bot token"
tsm_ad_channel "the channel id"
tsm_ad_connect "203.0.113.10:27015"
```

**Check those lines are not commented out.** `//` at the start of a line is a comment,
and a commented token reads as no token at all -- the plugin says Discord is not
configured and the bot exits with `tsm_ad_token is not set`, both while the value sits
right there in the file.

`tsm_ad_connect` matters more than it looks. It is the connect line in the advert, and
it is what the bot queries for `/who`. Left blank, the plugin falls back to
`net_address`, which is the address the server **bound** to -- behind NAT that is a LAN
address nobody outside can reach.

**Do not commit this file.** The token is the whole bot account: anyone holding it can
act as the bot in every guild it is in, until it is reset. The packaged `.gitignore`
already excludes it, and `build.bat` will not overwrite it once it exists -- so a
rebuild cannot wipe your token out of it.

If the token does land in a commit, Reset Token in the portal. Deleting the file
afterwards does not help; the history keeps it.

**4. Python.** 3.9 or newer. Run `discord-bot\install.bat` once -- it installs
`discord.py` and `python-a2s` and then checks they actually import.

It uses `python -m pip` rather than a bare `pip` on purpose: on a machine with more than
one python, bare `pip` installs into whichever is first on PATH, and the bot then fails
with `No module named a2s` while pip insists it is installed.

**5. Run `ts.bat`** from the Half-Life folder. It starts the bot, runs `hlds.exe`, and
kills the bot when hlds exits.

The bot is started by the launcher and **not by the plugin**, because a plugin cannot
start a program -- AMXX has no native for it, and `server_exec` only flushes queued
*console* commands. The launcher gets the same result: the bot comes up with the server
and goes down with it.

## Commands

In game:

```
.advertise   /  .ad      post a call for a match
```

One every thirty minutes **for the whole server**, not per player, and it survives a map
change. The clock only starts once Discord has **accepted** the post, so a failed advert
does not cost anyone the next half hour.

In Discord:

```
/who         who is on the game server right now
/status      map, players, bots, connect line
/advertise   post a call for a match from Discord
```

The bot answers these by **querying the game server directly over A2S**, the same UDP
protocol the server browser uses. It never talks to the plugin and the plugin never
talks to it; the only thing they share is the config file. That is deliberate -- the
plugin posts whether or not the bot is up, and `/who` works whether or not anybody has
advertised.

## When it does not work

| what you see | what it is |
|---|---|
| Chat: "Discord is not configured" | `tsm_ad_token` or `tsm_ad_channel` is blank |
| Chat: "Could not reach Discord" | the module or the `.pem` is missing |
| Log: `HTTP 401` | the token is wrong, or was reset in the portal |
| Log: `HTTP 403` | the bot is not in the guild, or lacks Send Messages / Embed Links there |
| Log: `HTTP 404` | the channel id is wrong |
| Advert posts, bot shows offline | normal -- `ts_bot.py` is not running. Adverts do not need it |
| Bot seems to start then is not there | it exited at once. `discord-botot.err` says why |
| `No module named a2s` | `install.bat` has not been run, or into a different python |
| `tsm_ad_token is not set` | the line is missing, empty, or commented out with `//` |
| Buttons say "This interaction failed" | the bot is not running, or was restarted mid-click |
| The role ping shows as grey text | the role is not mentionable and the bot lacks Mention Everyone |
| Slash commands never appear | invited without the `applications.commands` scope. Re-invite |
| `/who` says "not answering" | `tsm_ad_connect` is wrong, or the query port is firewalled |

The plugin logs failures with Discord's own status code and reason, in `addons/amxmodx/logs`.
It never logs the token, not even on failure.
