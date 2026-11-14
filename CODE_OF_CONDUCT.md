# Master Server Code of Conduct

This applies to the **upstream master server only**: the H9 server list at `https://havoc9.org/serverlist` that the game's
Internet tab reads, and the Discord that goes with it ([how the list runs](serverlist-bot/README.md)). If you run your own copy
of the list, it is your list and your rules.

It is common-sense policy, not a rulebook to hunt people with. **Modding and making things is welcome.** A modified server, a
new map, a plugin, a strange game mode, a harder difficulty: none of that is a reason to act on anyone, and nobody will be
targeted for it. What we act on is **vitriol** and **blatant malicious misuse**. The list is free and run by volunteers, and we
want any new player to be able to click on any server in it and be fine.

## What we can and cannot govern

We cannot govern what players do on a server, and we do not try to. Whoever runs a server answers for that. What does matter is
how a server is **listed, demonstrated or advertised** through the master server: its name, map and mode, the player counts it
reports, and anything it uses the list to promote. That is what this page is about.

## If you run a server on the list

1. **Leave room for a real player.** Bots (RCBots) must never take every slot. A listed server keeps at least one slot open:
   its bots number at most one less than its player limit.
2. **Be what you say you are.** The name, map, mode and player counts on the list are what your server answers. Do not fake
   players or bots to climb the list, and do not name a server so that it looks like the official one (`HAVOC 9 -- Main`) or
   like someone else's.
3. **No false servers, and no adverts dressed as servers.** Do not list, or send heartbeats for, a server that is not real: no
   simulated servers, and no faked answers to the list's queries. Do not use made-up server information (names, maps, player
   counts) to advertise, or to send people to a website, a service or a product.
4. **Keep it safe to join.** No exploits aimed at players' games, no files or downloads that harm or spy on a player, and no
   collecting of players' addresses or accounts beyond what a game server needs to run.
5. **Keep the names decent.** A server's name and map name are public: they show in the Internet tab and on the website's JSON
   list. No hate, no harassment, no real people's private details, no spam.
6. **Keep it free.** This project is non-commercial ([NON_COMMERCIAL.MD](NON_COMMERCIAL.MD)). Do not sell a listing.
7. **Keep to the limits.** The list only takes a server that answers its query and runs the `ts` game folder. Keep your
   heartbeats under the limits (60 a minute per address, 8 servers per address, 100 open servers in all), do not send a
   heartbeat for an address that is not yours, and do not try to guess the heartbeat key.
8. **List your own servers.** Do not add someone else's server without asking them.

A server that shuts down leaves the list by itself after five minutes without an answer. Nothing else is needed.

## If you are a list moderator

- Add a server only after you have looked at it, or you have its operator's word.
- Take a server off when it breaks this page: `/removeserver address`. Mods and odd rules are not breaking it.
- Keep `heartbeat_key` and the Discord bot token to yourself. They are in `serverlist.cfg`, which is never committed or
  shared. If one leaks, change it at once and say so in the Discord.
- Say why a server was removed, and what would let it come back.

## For everyone

Be decent to each other in the Discord and in anything that touches the list. No harassment, threats, hate, doxxing or spam.
Disagree about maps, rules and modes as much as you like; keep it about the game.

## What happens when this is broken

A moderator can take a server off the list at any time. Misusing the master server against this page can lead to more than that:
the blacklisting of the IP addresses behind it (`blacklisted.ini`), which keeps the server off, the suspension of the havoc9.org
account of whoever is responsible, and removal from the Discord. A serious breach, or the same one again, is where this starts.
We will say what happened and hear you out, but the list's keepers decide. The list shows what servers answer. It does not host
them, and it cannot promise what is on one.

## Telling us

- A server or a person on the list: tell a list moderator in the [Discord](https://discord.gg/b76pqqVsNY), or open an issue
  here without private details.
- A security problem (the list, the bot, a leaked key): privately, as [SECURITY.md](SECURITY.md) says.
