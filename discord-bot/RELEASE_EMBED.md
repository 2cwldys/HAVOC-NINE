# Discord release embed

Not wired into ts_bot.py yet. The four edits that do it are listed at the top of
`release_embed.py`, and the host side is in `receive-deploy-snippet.ps1`.

## What it does

Posts an embed to a Discord channel when a new build goes live, in the HAVOC 9 colours.

## Why it fires from the host, not from the deploy script

1.68 is the argument for this. The package built, every file uploaded, and then the host
refused the delivery on a free-space guard. From the sending side it looked finished. Nothing
said otherwise, and the server list bot sat on 1.66 until it was noticed by eye.

So the announcement is written at the end of `receive-deploy.ps1`, on the success path only --
after the install and after the start-up checks. That line is unreachable unless the build is
actually live, which means the embed cannot announce a release that did not happen.

The host writes `C:\havoc9\data\release.json`; the bot watches it and posts when the version
changes. A file rather than the deploy script calling Discord directly, because:

- the deploy script never needs the bot token
- a post that fails (Discord down, bot restarting) retries on the next tick instead of being
  lost -- the version is recorded only *after* the send succeeds

## The colours

A Discord embed carries exactly one `colour`. There is no second slot, so "orange and purple"
cannot both be chrome.

- **Orange `#FF7A18`** is the stripe. Same rule as the rest of the H9 theme: orange is the
  thing that moved, and a new release is the thing that moved.
- **Purple `#A78BFA`** arrives as an image -- a thin gradient strip set as the embed image.
  This is the bot's existing purple (`ts_bot.py:54`), not a new one.

If the strip asset is not on the site yet, Discord drops the image silently and the embed
still reads correctly. So this is safe to put in before the art exists.

## Files

| file | what it is |
|---|---|
| `release_embed.py` | the block for `ts_bot.py`: colours, embed builder, watcher loop |
| `receive-deploy-snippet.ps1` | the lines for the end of `receive-deploy.ps1` |

## Config

Three keys in `ts_advertise.cfg`, beside the ones the bot already reads. Same file on purpose:
the bot's author kept the token in one place so there is only ever one copy to rotate.

    tsm_ad_release_channel  "123456789012345678"   // optional, defaults to tsm_ad_channel
    tsm_ad_release_file     "C:/havoc9/data/release.json"
    tsm_ad_release_role     "123456789012345678"   // optional, pinged on a release

## Wiring

Four edits to `ts_bot.py`, all listed at the top of `release_embed.py`: the colours by `PURPLE`
(line 54), the two functions by `watch_server` (line 126), one `release_loop.start(self)` in
`setup_hook` (line 163), and an optional `/release` command.

## Not done

- Needs your channel ID. Everything else has a default.
- `receive-deploy.ps1` does not currently track `$filesInstalled` / `$bytesInstalled` under
  those names. Those two fields are cosmetic -- the embed omits a field it has no value for --
  so they can be wired up later or left at zero.
- The gradient strip (`assets/h9-strip.png`) is not drawn yet.
- Not run against a live Discord channel.
