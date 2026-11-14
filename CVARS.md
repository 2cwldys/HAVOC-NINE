# Cvar index

Every cvar HAVOC 9 adds, in three parts: the **engine**, the **module** (the mod's own game and client libraries) and the
**plugins** (the game modes and everything around them, and the Apollo RP roleplay scripts). TS's and Half-Life's own cvars
are not listed. This file is written by [tools/gen_cvar_index.py](tools/gen_cvar_index.py) from the sources, so it is as
current as the last time that was run.

> [!IMPORTANT]
> **Normal The Specialists 3.0 stays fully playable.** Everything below has a stock "off" or a default that leaves the game as
> TS plays it: for example `h9_customweapons 0` gives TS 3.0's own weapons and `h9_customhands 0` gives its own hands. The game
> modes run only on maps named for them, and any other map plays as TS plays it.

**Where a cvar is set.** A plugin's cvars have their defaults in the plugin's own config file in `ts\addons\amxmodx\configs\`
(`ts_matchmode.cfg`, `ts_assault.cfg`, ...), which also explains each one at length. A map can set them for itself in
`ts\mapconfigs\<map>.cfg`, which runs after the map has loaded and wins for that map (see the README's presets and map configs).
A preset swaps whole config files. The console and `rcon` set a cvar until the next map. Client cvars (`cl_h9_*`) are the
player's own and are kept in their `config.cfg`.

- [Part 1: the engine](#part-1-the-engine)
- [Part 2: the module](#part-2-the-module-the-mods-own-libraries)
- [Part 3: the plugins](#part-3-the-plugins)

## Part 1: the engine

The Xash3D FWGS engine of H9XASH, with the H9 patch chain in `xash3d-h9-patches/`. Its description is the one its code gives it.

| Cvar | Default | What it does | Patch |
|---|---|---|---|
| `cl_h9_avatars` | `1` | H9: show players' havoc9.org pictures on the scoreboard (cl_avatar.c) | `engine-h9-avatars.patch` |
| `cl_h9_cloakfix` | `1` | H9: show a server-side cloak on your own model instead of the client dll's own third person transparency | `engine-h9-cloak.patch` |
| `cl_h9_joinscreen` | `1` | H9: the menu's join screen while a server is joined (0: the console, as upstream) | `engine-h9-joinscreen.patch` |
| `cl_h9_motd` | `1` | H9: show a server's splash MOTD (a picture or a web page) in place of its text MOTD: 1 = on, 0 = the text MOTD | `engine-h9-motd.patch` |
| `cl_h9_motd_wine` | `0` | H9: under Wine or Proton, show a server's web page inside the game with Edge WebView2, without Chromium's sandbox: 0 = no, its picture or text and OPEN PAGE; 1 = yes; 2 = yes, with the GPU off | `engine-h9-motd.patch` |
| `cl_h9_servers` | `1` | H9: ask havoc9.org which servers are authenticated, for the server browser's chain (cl_h9auth.c) | `engine-h9-serverauth.patch` |
| `cl_h9_site` | (empty) | H9: for testing only, http://127.0.0.1:&lt;port&gt; or http://localhost:&lt;port&gt; in place of https://havoc9.org for the scoreboard's pictures | `engine-h9-avatars.patch` |
| `cl_h9_travel` | `1` | H9: a server may offer to send you to another server (community portals): 1 = ask me, 0 = ignore its offers | `engine-h9-travel.patch` |
| `cl_h9_userid` | (empty) | H9: this install's regenerable client id -- see docs/CUSTOM_XASH_USERID.txt | `engine-h9-userid.patch` |
| `con_shownotify` | `0` | draw console notify lines over the game | `engine-h9-consoleoverlay.patch` |
| `h9_autoconfig` | `1` | H9: exec mapconfigs/&lt;mapname&gt;.cfg once the map and its plugins are up | `engine-h9-autoconfig.patch` |
| `h9_upscale` | `1` | upscale the scene rendered with r_scene_scale with AMD FSR 1, EASU then RCAS (0 off, 1 on) | `engine-h9-upscale.patch` |
| `h9_upscale_sharp` | `0.84` | how strongly h9_upscale sharpens (RCAS): 0 none, 1 the most, 0.84 is AMD's recommended 0.25 stops | `engine-h9-upscale.patch` |
| `ts_intro` | `1` | play the intro video before the main menu | `engine-h9-intro.patch` |
| `ts_intro_vol` | `1` | how loud the intro video is: 0 silent, 1 full | `engine-h9-intro.patch` |
| `ts_richpresence` | `1` | show your game on Discord (Rich Presence): 1 = on, 0 = off | `engine-h9-presence.patch` |

**Set by the engine itself.** These carry state between the engine and the menu or the plugins. Read them, do not set them.

| Cvar | Default | What it holds | Patch |
|---|---|---|---|
| `_h9_drop` | (empty) | H9: why the last join or game ended (set by the engine) | `engine-h9-joinscreen.patch` |
| `_h9idl` | `0` | H9: 1 in a game that answers its own listen server's h9_idlisten (set by the engine, cl_h9listen.c) | `engine-h9-listen.patch` |
| `_h9idv` | `0` | H9: 1 while this game can answer the presence ID proof (set by the engine, cl_idproof.c) | `engine-h9-idproof.patch` |
| `_h9join` | `0` | H9: 1 while the join screen is up (set by the engine) | `engine-h9-joinscreen.patch` |
| `_h9join_file` | (empty) | H9: the file the join screen downloads (set by the engine) | `engine-h9-joinscreen.patch` |
| `_h9join_fileprog` | `0` | H9: that file's progress, 0 to 100 (set by the engine) | `engine-h9-joinscreen.patch` |
| `_h9join_server` | (empty) | H9: the server the join screen joins (set by the engine) | `engine-h9-joinscreen.patch` |
| `_h9join_stage` | (empty) | H9: the join screen's stage (set by the engine) | `engine-h9-joinscreen.patch` |
| `_h9join_total` | (empty) | H9: the downloads together, for the join screen (set by the engine) | `engine-h9-joinscreen.patch` |
| `_h9link_account` | (empty) | H9: the havoc9.org account this game is linked to (set by the engine) | `engine-h9-link.patch` |
| `_h9link_code` | (empty) | H9: the code h9_link shows (set by the engine) | `engine-h9-link.patch` |
| `_h9link_flow` | `0` | H9: h9_link's code: 0 none, 1 asking, 2 waiting for its approval, 3 linked, 4 failed (set by the engine) | `engine-h9-link.patch` |
| `_h9link_site` | `havoc9.org` | H9: the site h9_link's code comes from, as the player reads it (set by the engine) | `engine-h9-link.patch` |
| `_h9link_text` | (empty) | H9: where h9_link stands, in words (set by the engine) | `engine-h9-link.patch` |
| `_h9lnk` | `0` | H9: 1 while this game is linked to a havoc9.org account (set by the engine, cl_h9link.c) | `engine-h9-link.patch` |
| `_h9rel` | (empty) | H9: the release of this game, sent to every server (h9_release.txt) | `engine-h9-presence.patch` |
| `_h9srv` | (empty) | H9: the servers havoc9.org names, each with its verdict (set by the engine, cl_h9auth.c) | `engine-h9-serverauth.patch` |
| `_h9srv_gen` | `0` | H9: 0 until the list of servers was read, then counts its changes (set by the engine, cl_h9auth.c) | `engine-h9-serverauth.patch` |

## Part 2: the module (the mod's own libraries)

reTS is the mod's game library (`mp.dll`) and client library (`client.dll`), rebuilt from the Half-Life SDK. These are the cvars H9 adds to them.

| Cvar | Default | What it does | In |
|---|---|---|---|
| `_h9arpvgui` | `1` | the userinfo key through which the server learns whether this game draws Apollo RP's menus as panels (set from cl_h9_arpvgui) | client library |
| `cl_h9_aimplaque` | `1` | the teammate under the crosshair as a plaque (his name, class, health and armour over a bar), with TS's own green name left out, on a server that sends it (tsm_hover_plaque; 1); 0 | client library |
| `cl_h9_arphud` | `1` | Apollo RP's HUD as panels (1); 0: the server's text HUD instead, all of it, and the panels' other switches do nothing. | client library |
| `cl_h9_arphud_icon` | `1` | the picture of an item lying on the floor, above the notice that names it; 0 leaves the notice as text alone | client library |
| `cl_h9_arphud_needs` | `1` | the needs (1): the second panel, with hunger as a bar, and the line under it when starving; 0 hides the panel, not as text either. | client library |
| `cl_h9_arphud_plaque` | `1` | what you look at -- a property door, an NPC, a player -- as a plaque (1): a plate of one width in the notice's place, its heading and fields in upper case, the affiliation and the status | client library |
| `cl_h9_arphud_shrink` | `1` | the first panel in a smaller size while TS's weapon select (the five columns at the top left) is open (1), its own size again when the select shuts; 0 leaves it as it is all the | client library |
| `cl_h9_arpinv` | `1` | Apollo RP's inventory, the exchange of goods and the search of a handcuffed player as windows you click and drag (1); 0 keeps the text inventory, and the game tells servers so | client library |
| `cl_h9_arpvgui` | `1` | Apollo RP's menus as panels (1); 0: its text menus, the other panels as they are. | client library |
| `cl_h9_buyauto` | `1` | the equipment menu comes up by itself when the server opens a buy window (1), in the freeze of a round under tsm_loadoutrework 1; 0: only the buy key (bind one to "buy") | client library |
| `cl_h9_ctxmenu` | `1` | the menu of the use key (E) on a player (1): a list of what you can do to him, with a cursor, in place of the exchange offer; greyed rows say why they cannot be chosen. | client library |
| `cl_h9_linkicons` | `1` | the scoreboard's link icons (1): a green chain on a proven havoc9.org account, a red broken one on anyone else, H9's grey helmet on a bot; 0 leaves them out. | client library |
| `cl_h9_marks` | `1` | the marks a server shows through the walls (1): Assault's capture points, Capture the Uplink's zones and uplink, Capture the Flag's flags and pads, drawn on the screen | client library |
| `cl_h9_marks_strip` | `1` | the row of those marks under the top notices (1) | client library |
| `cl_h9_scoreboard_scroll` | `1` | a scoreboard column too long for the board even at its shortest rows scrolls (1): the mouse wheel, or PgUp/PgDn, while the board is held open -- the column under the pointer, | client library |
| `cl_h9_show_reinforce` | `1` | the line that counts down this side's next respawn wave (1); 0 hides it, whatever the server's tsm_show_reinforce says | client library |
| `cl_h9_tts` | `1` | spoken chat (1): when a server has h9_texttospeech 1, what players near you say is read out by your own voices (Windows SAPI; the browser's in the web client). | client library |
| `cl_h9_tts_engine` | `system` | which voices speak (saved) | client library |
| `cl_h9_tts_individual` | `1` | 1 gives a speaker who asked for no voice of his own one from his slot: another voice of his kind and a small step off its pitch (1), so a room of players does not sound alike. | client library |
| `cl_h9_tts_maxvoices` | `4` | the most voices that speak at once | client library |
| `cl_h9_tts_muffle` | `1.0` | how strongly a gas mask muffles the voices you hear (1); 0 not at all, 2 heavy. | client library |
| `cl_h9_tts_mydepth` | `0` | how deep (below 0) or high (above 0) others hear you (0). | client library |
| `cl_h9_tts_myvoice` | `0` | the voice others hear from you: the n-th voice of your kind on THEIR machine, wrapping round (0: each listener's game chooses; a new player is given one at random, once). | client library |
| `cl_h9_tts_pan` | `1` | 1 puts each voice in the ear it comes from (1; Windows, in stereo), 0 plays them all in the middle. | client library |
| `cl_h9_tts_robot` | `1` | a Mech's and a bot's voice through a robot filter (1); Windows only, the browser has no audio to filter. | client library |
| `cl_h9_tts_threads` | `0` | the threads the Kokoro helper synthesises with, 0 leaving it to the game | client library |
| `cl_h9_tts_voice_bot` | `0` | which of the voices in cl_h9_tts_voices a bot's voice is; 0 leaves it to the game | client library |
| `cl_h9_tts_voice_man` | `0` | which of the voices in cl_h9_tts_voices a man's voice is; 0 leaves it to the game | client library |
| `cl_h9_tts_voice_mech` | `0` | which of the voices in cl_h9_tts_voices a Mech's voice is; 0 leaves it to the game | client library |
| `cl_h9_tts_voice_set` | `0` | 1 once this player has a voice of their own, chosen or given at random the first time | client library |
| `cl_h9_tts_voice_woman` | `0` | which of the voices in cl_h9_tts_voices a woman's voice is; 0 leaves it to the game | client library |
| `cl_h9_tts_volume` | `1.0` | how loud the voices are, up to the ceiling the game sets | client library |
| `cl_h9_vgui` | `1` | a server's panels (1): the side and class menus and Apollo RP's menus on H9's purple art, in the game's fonts, their number keys as ever; ESC closes one. | client library |
| `cl_h9_vgui_b` | `196` | the blue part (0 to 255) of the colour of H9's panels | client library |
| `cl_h9_vgui_g` | `66` | the green part (0 to 255) of the colour of H9's panels | client library |
| `cl_h9_vgui_r` | `138` | the red part (0 to 255) of the colour of H9's panels; 138 66 196 is the default purple | client library |
| `cl_h9_vgui_scale` | `1` | the panels' size (1; the panels are a quarter smaller than they were before 2026-11-05, and 1.33 is that size again) | client library |
| `cl_h9_vgui_top` | `0` | how far down panels may start, from the top of the screen: 0 for 1.5% of the height (16 px at 1080); TS's own notices stand beneath the panels at the top (0) | client library |
| `h9_customweapons` | `1` | 1: the weapons H9 adds to TS (the PPSh-41, the laser rifle, the Mech's rocket launcher, and any it adds later) are in play. | server library |
| `h9_laserrifle` | `1` | the same for the laser rifle (weapon 40) | server library |
| `h9_mechrocket` | `1` | present and 1 when the game library has the Mech rocket launcher (weapon 41), so a plugin can give a library without it another gun. | server library |
| `h9_mechrocket_clip` | `4` | rockets in a clip (1 to 30): one salvo | server library |
| `h9_mechrocket_damage` | `200` | damage at the middle of one rocket's blast (full out to a quarter of the radius, then falling to nothing at the radius; armour takes none of it). | server library |
| `h9_mechrocket_lift` | `250` | how much it throws them up, in units a second, with the same falloff | server library |
| `h9_mechrocket_nodrop` | `1` | 1: a Mech's launcher is deleted where a drop would have made a gun on the floor (death, the drop key, a disarm); anyone else drops it like any gun. | server library |
| `h9_mechrocket_push` | `400` | how hard a blast pushes the players it leaves alive, in units a second along the ground, away from the middle; it falls off like the damage. | server library |
| `h9_mechrocket_radius` | `260` | radius of the blast, in units | server library |
| `h9_mechrocket_rate` | `1.5` | seconds from the last rocket of a salvo to the next pull (never under 0.1). | server library |
| `h9_mechrocket_reload` | `3.0` | seconds a reload takes (0.5 to 30): the length of the launcher's reload animation | server library |
| `h9_mechrocket_salvo` | `4` | rockets one trigger pull launches in burst mode (1 to 8); a clip with fewer launches what it holds. | server library |
| `h9_mechrocket_selfdamage` | `0` | 1: a rocket's blast hurts the player who fired it, and pushes him | server library |
| `h9_mechrocket_speed` | `1100` | speed of the rocket, in units a second | server library |
| `h9_mechrocket_spread` | `2.5` | degrees the rockets after the first may stray from the aim (0 to 15); the first goes straight, so a salvo of one is exact | server library |
| `h9_mechrocket_stagger` | `0.12` | seconds between two rockets of a salvo (0.03 to 1). | server library |
| `h9_ppsh41` | `1` | present and 1 when the game library has the PPSh-41 (weapon 39), so a plugin can give a library without it another gun. | server library |

## Part 3: the plugins

AMX Mod X plugins. Each section is one plugin, with the config file that carries its defaults and comments.

### H9 plugins

#### h9_community

`src/h9_community.sma`. Config: `h9_community.cfg`. 5 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_community_chat` | `1` | the community's chat shows here and players may relay; 0: neither (announcements still show) |
| `h9_community_find` | `1` | /find and /where (and .find, .where) |
| `h9_community_portal_wait` | `10` | seconds before a player may travel through a portal again |
| `h9_community_prefix` | `.relay` | what a player types before a line for the whole community |
| `h9_community_travel` | `0` | 1: a portal's Go sends h9_travel to every client, also to those without _h9travel "1" (H9XASH and the web client get it anyway); leave it 0 |

#### h9_compete

`src/h9_compete.sma`. Config: `h9_compete.cfg`. 3 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_compete` | `0` | 1: this server's matches go to havoc9.org and are rated (needs h9_presence with a live key); shown in the server's rules |
| `h9_compete_ladder` | `auto` | auto: a ts_matchmode match on h9_ and tsm_ maps, deathmatch (kills only) on h9_dm_, h9_tdm_, h9_ctb_ and ctb_ maps, off on Wave Survival, roleplay and stock |
| `h9_compete_notice` | `1` | the join lines: that the server is rated, and the player's rating to everyone when they show it |

#### h9_link

`src/h9_link.sma`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_link_command` | `1` | .link starts linking a player's game to their havoc9.org account; 0 leaves .link alone |
| `h9_link_hint` | `0` | 1: a player whose H9XASH can link and is not linked is told about .link once, a while after joining (once per player on this server, the vault h9_link_hints) |

#### h9_motd

`src/h9_motd.sma`. Config: `h9_motd.cfg`. 5 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_motd` | `text` | text: TS's own text MOTD (the splash off); image: a picture; page: a web page |
| `h9_motd_image` | (empty) | page only: the picture shown when the page itself cannot be |
| `h9_motd_link` | (empty) | image only: the page OPEN PAGE offers |
| `h9_motd_show` | `connect` | connect: once a connection; map: at every map |
| `h9_motd_url` | (empty) | https address of the picture or the page |

#### h9_msgstats

`src/h9_msgstats.sma`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_msgstats_on` | `1` | 1: count the messages the game sends, a few cheap forwards; 0: stop. |

#### h9_p2p

`src/h9_p2p.sma`. 10 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_p2p` | `0` | 1: this game may open a path through a relay for friends (h9_p2p_invite). |
| `h9_p2p_direct` | `1` | 1: an invite may let a friend's game and this one find each other directly (each learns the other's network address) when the command says "direct". |
| `h9_p2p_direct_public` | `0` | 1: a guest from the public list may use a direct path too (needs h9_p2p_direct 1). |
| `h9_p2p_name` | (empty) | the name on the public list; empty: the server's hostname |
| `h9_p2p_public` | `0` | 1: the game is on the relay's public list (name, map, players, password yes or no) and anybody may ask the relay for a one-use invite to join without yours. |
| `h9_p2p_relay` | `1` | 0: the relay never carries this game's packets, so friends can only connect directly. |
| `h9_p2p_require_account` | `0` | 1: every invite, and every guest from the public list, needs a havoc9.org account; the console shows which one joined |
| `h9_p2p_service` | (empty) | the relay's base URL (https:// on the internet) for a helper whose p2p.ini has no service= line; a service= in p2p.ini wins, because the token is for that relay. |
| `h9_p2p_ttl` | `600` | seconds an invite lives (60 to 900) |
| `h9_p2p_uses` | `1` | times one invite can be used (1 to 8) |

#### h9_presence

`src/h9_presence.sma`. Config: `h9_presence.cfg`. 13 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_authenticated` | `1` | 0: this server asks not to be authenticated or rated: havoc9.org lists it as not authenticated (the red chain in the server browser) and |
| `h9_presence_autoenroll` | `1` | a dedicated server with no hand-made key enrolls with havoc9.org by itself; a listen server (Create Game) does once its own player is in game, by that player's |
| `h9_presence_challenge` | `1` | 1: each H9XASH client proves its player id (the default); 0 proves no one, and an announced id can then be copied |
| `h9_presence_enroll` | (empty) | set by the plugin, not by hand: the code havoc9.org looks for while enrolling |
| `h9_presence_interval` | `60` | seconds between reports, 30 to 600 |
| `h9_presence_key` | (empty) | a hand-made key; never shown |
| `h9_presence_names` | `0` | 1: havoc9.org names on H9 maps (needs h9_presence_challenge 1) |
| `h9_presence_server` | (empty) | a hand-made key's server: its public IPv4:port, as havoc9.org lists it |
| `h9_presence_url` | `https://havoc9.org/api/presence/report` | Where reports go; without its /report, also where the server enrolls and where h9_community's calls go. |
| `h9_preset` | (empty) | the game-mode preset this server runs (Assault, Siege, TeamElimination): havoc9.org judges its files against that mode's list and the shared one. |
| `h9_require_account` | `0` | 1: havoc9.org accounts only. |
| `h9_require_account_grace` | `45` | seconds a game has to prove its account (10 to 300) |
| `h9_require_release` | `1` | 0: any game may join. |

#### h9_rank

`src/h9_rank.sma`. Config: `h9_rank.cfg`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_rank_command` | `1` | .rank answers; 0 leaves .rank alone |
| `h9_rank_cooldown` | `5` | seconds between two .rank from one player (1 to 60) |

#### h9_staticprops

`src/h9_staticprops.sma`. Config: `h9_staticprops.cfg`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_staticprops` | `0` | 0: off; 1: on roleplay maps (rp_, tsrp_ in the name); 2: on every map. |

#### h9_tts

`src/h9_tts.sma`. Config: `h9_tts.cfg`. 6 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_texttospeech` | `0` | 1: what a player says in chat is spoken to the players near him, by their own game (Windows SAPI; the browser's speech in the web client). |
| `h9_tts_gap` | `1.5` | seconds a speaker waits between two spoken lines; what he says in between is only written |
| `h9_tts_global` | `0` | 1: a line is heard by every player with text to speech, wherever he is, alive or not, at full volume and from no direction (say_team: the speaker's team); never by |
| `h9_tts_maxchars` | `96` | the most characters of a line that are spoken (8 to 150); a longer one is cut |
| `h9_tts_range` | `800` | units from the speaker out to which a line is heard: full volume within a quarter of it, fading to nothing at the range. |
| `h9_tts_self` | `1` | 1: the speaker hears his own line too (one player alone can tell it works); 0: only the others do |

#### ts_advertise

`src/ts_advertise.sma`. Config: `ts_advertise.cfg`. 7 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `tsm_ad_channel` | (empty) | the channel the advert goes to |
| `tsm_ad_connect` | (empty) | the address in the advert's connect line |
| `tsm_ad_cooldown` | `1800` | seconds between adverts, for the whole server |
| `tsm_ad_flag` | (empty) | an admin flag needed to advertise; empty, anyone |
| `tsm_ad_minplayers` | `1` | players needed on before an advert goes |
| `tsm_ad_role` | `1559132404424380436` | The Discord role to ping, by id. |
| `tsm_ad_token` | (empty) | the Discord bot's token; never shown |

#### ts_assault

`src/ts_assault.sma`. Config: `ts_assault.cfg`. 11 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_assault_rounds` | `0` | 0: Assault has no rounds, the first round that ends is the whole match (its winner wins and is rated, a draw is a drawn match). |
| `tsm_as_capture_reinforcements` | `5` | added to a side's pool when it takes a point (0: none) |
| `tsm_as_capture_wave` | `1` | 1: the taker's fallen come back in a wave at once |
| `tsm_as_maxcap` | `6` | players who count toward that, at most |
| `tsm_as_radius` | `384` | a point's radius, unless given |
| `tsm_as_spawn_under_attack` | `0` | 0: a point's respawn set is shut while an enemy is taking it, open again when they are gone or beaten; 1: it stays open |
| `tsm_as_speedup` | `0.5` | how much faster each further player of the side taking it makes it |
| `tsm_as_time` | `20` | seconds for one player to take a point from neutral (and again to wear down the other side's hold) |
| `tsm_as_wave` | `30` | seconds between both sides' respawn waves on an assault map |
| `tsm_assault_mode` | `1` | the mode on, on every map with capture points |
| `tsm_gamedesc_assault` | `Assault` | the browser's game name while it runs |

#### ts_ctf

`src/ts_ctf.sma`. Config: `ts_ctf.cfg`. 10 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `h9_ctf_rounds` | `0` | 0: Capture the Flag has no rounds, the first round that ends is the whole match (its winner wins and is rated). |
| `tsm_cf_bots` | `0` | 1: a bot takes and returns flags even with tsm_bot_objectives 0 (one that walks over a flag); 0: only while tsm_bot_objectives is 1 |
| `tsm_cf_caps` | `3` | captures that win the round |
| `tsm_cf_capture_wave` | `1` | 1: the capturing side's fallen come back in a wave at once |
| `tsm_cf_needhome` | `1` | 1: a carrier scores only while his own flag is at its pad; 0: whatever has become of it |
| `tsm_cf_pad_radius` | `72` | how near its pad a carrier must be, units |
| `tsm_cf_return` | `20` | seconds before a dropped flag flies home (0: it stays where it lies) |
| `tsm_cf_wave` | `20` | seconds between both sides' respawn waves on a flag map |
| `tsm_ctf_mode` | `1` | the mode on, on every map with both pads |
| `tsm_gamedesc_ctf` | `Capture the Flag` | What the server browser, the server-list bot, the adverts and the Discord card call the game while the mode runs. |

#### ts_floatchat

`src/ts_floatchat.sma`. Config: `game.cfg`. 18 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `fc_blue` | `255` | (no description yet) |
| `fc_enabled` | `1` | float chat on: typing bubbles and words over heads; 0 off for everyone |
| `fc_green` | `215` | (no description yet) |
| `fc_hold` | `5.0` | seconds a line stays over a head, and 0.04 more for each character of it |
| `fc_range` | `1100` | how far away a talker's words still show: a line is hidden past it, whatever is left of its hold |
| `fc_red` | `150` | (no description yet) |
| `fc_rise` | `24.0` | how far above the eyes the bubble sits (it follows a duck, prone or a dive) |
| `fc_scale` | `0.20` | (no description yet) |
| `fc_self` | `0` | (no description yet) |
| `fc_y_tweak` | `1.0` | the hudmessage words' height on a screen that is not 4:3 |
| `h9_floatchat_bubble` | `1` | 1: a client that draws the words itself (cl_h9_chatbubble 1) is sent each line once, as H9Say, in place of the hudmessage; 0: every client gets the hudmessage |
| `h9_floatchat_bubble_hold` | `0` | seconds a line stays for those clients (1 to 30); 0: fc_hold and 0.04 more for each character, as the hudmessage |
| `h9_floatchat_bubble_maxchars` | `96` | the most characters of a line sent to them (12 to 150); a longer one ends in "..."; the client breaks it into lines itself |
| `h9_floatchat_bubble_team` | `1` | 1: a say_team line goes to the speaker's team only; 0: to everyone, as say goes (the hudmessage has no team test) |
| `h9_floatchat_hud` | `1` | 0: a client that cannot draw the words itself is sent none |
| `h9_floatchat_maxchars` | `48` | the most characters of a line shown over a head by the hudmessage (12 to 100); a longer one is cut and ends in "...". |
| `h9_floatchat_typing` | `1` | 0: the typing bubble sprite is never shown |
| `h9_floatchat_words` | `1` | 0: no words over heads for any client (the typing bubble has its own switch) On a roleplay map Apollo RP's /me &lt;action&gt; is drawn over the speaker's head in RED, as |

#### ts_matchmode

`src/ts_matchmode.sma`. Config: `ts_matchmode.cfg`. 286 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `amx_tsm_forcedoor` | `0` | 1 lets an admin's tsm_opendoor work |
| `arp_h9_hidenames` | `1` | on a roleplay map (Apollo RP in use) an H9 game draws none of the names TS puts over the player the crosshair is on (red for anyone there, there being no sides); 0: TS's names as before. |
| `h9_customhands` | `1` | custom first-person hands and kicking legs: 1 a black glove and sleeve, by side in a match (MSR a blue cuff, the Insurgents green) and with no stripe in normal TS and |
| `h9_fog_b` | `0` | (no description yet) |
| `h9_fog_density` | `0` | (no description yet) |
| `h9_fog_g` | `0` | (no description yet) |
| `h9_fog_r` | `0` | (no description yet) |
| `sv_visiblemaxplayers` | `-1` | a stand-in made on Xash only, for AMXX's adminslots plugin |
| `tsm_addtime` | `150` | the most one fall puts back, in seconds |
| `tsm_alarm` | `1` | the siren from the first attack on |
| `tsm_alarm_every` | `20` | an H9 game's warning line pops up under the round timer and fades away; seconds between pops, 0 keeps it up |
| `tsm_alarm_msg` | `BREACH IN PROGRESS` | The warning line itself; a pipe "/" is a row break, same as the round banners above. |
| `tsm_alarm_msg_attack` | `YOUR TEAM IS CURRENTLY SIEGING THE MAP` | The attacking side's line, in the same place, the same way. |
| `tsm_alarm_vol` | `0.3` | its volume, 0.0 to 1.0 |
| `tsm_ammo_mags` | `2` | spare magazines of every ammo type [cfg 6] |
| `tsm_arm_delay` | `2.5` | seconds between writing a loadout and the respawn that applies it |
| `tsm_arm_order` | `0` | 1 issues the class line back to front, so the first weapon is in hand [cfg 1] |
| `tsm_autofill` | `1` | fill a short side at a round's start: 0 never, 1 from late joiners, 2 spectators too |
| `tsm_balance_gap` | `1` | the largest allowed difference in side sizes |
| `tsm_balance_mode` | `block` | off, warn, block (hold ready-up), or shuffle |
| `tsm_block_buy` | `1` | refuse TS's buy-menu commands |
| `tsm_block_spectator` | `0` | put a player the mod drifts to spectator back on their side |
| `tsm_block_teamvgui` | `1` | refuse changeteam, which opens TS's own team panel |
| `tsm_bot_blind_ff` | `1` | teammates hidden from bots' sight, so they never target one |
| `tsm_bot_class` | `0` | 0 tsm_default_class, spread, or a class number [cfg 1] |
| `tsm_bot_flow_interval` | `0` | seconds between those steps; 0: 0.35 up to 32 player slots, 0.6 above |
| `tsm_bot_flow_step` | `1` | bots put on their sides, named and classed each step of the bot flow |
| `tsm_bot_loadout` | `0` | arm bots from their class |
| `tsm_bot_name1` | `Enforcer` | side 1's bot name prefix |
| `tsm_bot_name2` | `Insurgent` | (no description yet) |
| `tsm_bot_names` | `1` | rename bots after their side |
| `tsm_bot_powerups` | `0` | 0: no bot walks to, uses or is handed a powerup, wins a kill award (slow motion, the Specialist's kung fu) or leaves a slow-motion kill bubble, while the match |
| `tsm_bot_ready` | `1` | count bots as ready |
| `tsm_bot_reload` | `5.0` | seconds between forcing a bot to reload |
| `tsm_bot_resupply` | `20.0` | seconds between topping a bot up with ammo |
| `tsm_bot_return` | `6.0` | seconds bots sit out after a match |
| `tsm_bot_stockobjectives` | `1` | 1: on a ctb_ or ctf_ map the bots play TS's own capture game -- fetch the other side's briefcase, carry it to their own base, bring their own back, escort the carrier, guard the |
| `tsm_bot_teams` | `both` | which sides bots go on: both, 1 or 2 |
| `tsm_bots` | `0` | how many bots; 0 kicks them all [cfg 10]. Set to 0 by the plugin on maps that are not H9's, but a ctb_ or ctf_ map gets tsm_briefcase_bots |
| `tsm_breach_entities` | `func_door,func_door_rotating,func_wall_toggle,func_button` | What a Breacher can force open with +USE. |
| `tsm_breach_range` | `96` | how far that reaches |
| `tsm_briefcase_bots` | `0` | how many bots a ctb_ or ctf_ map gets (the match mode stays out there); 0 none [cfg 0] |
| `tsm_class1` | `Assault;5:3,22:2;13:3,22:2;repuheavy|XCCPSoldier-wartorn,XCCPmutant;100;0;0` | Class 3's model side for the insurgents is left BLANK on purpose: a blank side falls back to that side's Assault model, so insurgent marksmen are dressed as assaults rather than as nothing. |
| `tsm_class2` | `Combat Engineer;23:3,22:2;39:3,22:2;scda_Spy02|XCCPsgts;100;0;1` | Class 3's model side for the insurgents is left BLANK on purpose: a blank side falls back to that side's Assault model, so insurgent marksmen are dressed as assaults rather than as nothing. |
| `tsm_class3` | `Marksman;18:2,22:2;18:2,22:2;;85;0;0` | Class 3's model side for the insurgents is left BLANK on purpose: a blank side falls back to that side's Assault model, so insurgent marksmen are dressed as assaults rather than as nothing. |
| `tsm_class4` | `Heavy;32:2,22:2;32:2,22:2;repuheavyw|XCCPsgg;125;50;0;0.75` | Class 3's model side for the insurgents is left BLANK on purpose: a blank side falls back to that side's Assault model, so insurgent marksmen are dressed as assaults rather than as nothing. |
| `tsm_class5` | `Breacher;4:4,22:2;4:4,22:2;;110;0;2` | Class 3's model side for the insurgents is left BLANK on purpose: a blank side falls back to that side's Assault model, so insurgent marksmen are dressed as assaults rather than as nothing. |
| `tsm_class6` | `Medic;22:4;22:4;repuheavym|ins_medic_belt;100;0;3` | Class 3's model side for the insurgents is left BLANK on purpose: a blank side falls back to that side's Assault model, so insurgent marksmen are dressed as assaults rather than as nothing. |
| `tsm_class7` | `Officer;40:3,1:4,34:0;40:3,1:4,34:0;reputengu|;100;0;4` | Class 3's model side for the insurgents is left BLANK on purpose: a blank side falls back to that side's Assault model, so insurgent marksmen are dressed as assaults rather than as nothing. |
| `tsm_class8` | `Recon;12:2,15:2,34:0;12:2,15:2,34:0;repuheavy_recon|;75;0;0;1.20` | Class 3's model side for the insurgents is left BLANK on purpose: a blank side falls back to that side's Assault model, so insurgent marksmen are dressed as assaults rather than as nothing. |
| `tsm_class9` | `Mech;32:2;32:2;repuheavy_recon|;300;0;0;0.60` | Class 9 carries perk 7, the Mech: the .rocket ability, no stim/heal, the hp watch, the nodraw and the whole mech sound suite. |
| `tsm_class_cost` | `1,1,1,1,1,1,2,1,3` | what a death of each class draws from its side's reinforcements, in class order |
| `tsm_class_icons` | `1` | a sprite above each head showing their class, visible ONLY to that player's own side |
| `tsm_class_limits` | (empty) | how many may take each class, a side [cfg 0,4,2,2,4,2,1,4,1] |
| `tsm_class_lives` | (empty) | lives for each class [cfg 2,1,1,1,1,1,1,1,1] |
| `tsm_class_retry` | `1.0` | seconds between re-offering the class menu |
| `tsm_class_scale` | `1` | apply each class's height (drawn only) |
| `tsm_classchange` | `1` | a player may ask for another class with .class at any time and has it from his next respawn (a wave's revive, else the next round's start); in the freeze countdown it |
| `tsm_classes` | `1` | the class system on |
| `tsm_clean_drops` | `0` | strip weapons dropped on death before the next round |
| `tsm_clip_bonus` | `2` | spare magazines added to every weapon [cfg 6] |
| `tsm_clip_max` | `6` | most spare magazines for one weapon [cfg 14] |
| `tsm_clip_sparepct` | `100` | how much of those magazines is held, percent |
| `tsm_cloak_cooldown` | `30.0` | seconds after a cloak ends before the next |
| `tsm_cloak_duration` | `30.0` | seconds a cloak lasts by itself |
| `tsm_cloak_enabled` | `1` | .cloak and .uncloak on |
| `tsm_cloak_opacity` | `12.0` | how solid a cloaked Recon looks, 0-255 [cfg 10.0] |
| `tsm_competitive` | `1` | the scoreboard's class column (the class icon beside each name, H9's client.dll): 1 a player sees only his own side's classes, 0 both sides' |
| `tsm_death_delay` | `10.0` | ceiling on how long a dying player is left before becoming a spectator [cfg 4] |
| `tsm_death_grace` | `2.5` | seconds an eliminated player is left alone before being taken out of play |
| `tsm_death_linger` | `3.0` | seconds a dying player is left untouched [cfg 10.5] |
| `tsm_debug_log` | `1` | 0 off, 1 logs/tsm_debug.log, 2 also the console, 3 verbose, 4 verbose to the console [cfg 0] |
| `tsm_default_class` | `1` | the class of someone who never picks |
| `tsm_default_spectator` | `1` | put a new arrival with no side on the spectator team, with the side menu |
| `tsm_disarm` | `2` | how an eliminated player is stopped: 1 buttons, 2 buttons and speed, 3 neither |
| `tsm_enabled` | `1` | the match mode on. |
| `tsm_end_watchdog` | `20` | seconds a round's or match's end may stand with nothing scheduled to leave it before everyone is put back in warmup; also ends a no-clock run (Wave Survival) that cannot end |
| `tsm_eng_clips` | `3` | magazines handed over per resupply |
| `tsm_eng_cooldown` | `30.0` | seconds between resupplies |
| `tsm_eng_door_class` | `Combat Engineer` | A map marks a door for this by giving it the targetname "tsm_eng_door" and the spawnflag 256, which is SF_DOOR_USE_ONLY in the Half-Life SDK: the door stops opening when somebody walks into it and answers +USE alone. |
| `tsm_eng_door_team` | `0` | which side's: 0 either, 1 or 2 that side's |
| `tsm_eng_entities` | (empty) | entity classnames the engineer may +USE |
| `tsm_eng_glow` | `1.5` | seconds of the yellow glow on whoever got it |
| `tsm_eng_range` | `96` | how far its +USE reaches |
| `tsm_eng_shell` | `16` | that glow's thickness |
| `tsm_eng_sound` | `items/9mmclip1.wav` | the resupply's sound |
| `tsm_force_maxspeed` | `1` | restore a released player's maxspeed when TS leaves it at 0 |
| `tsm_force_spawn` | `1` | respawn anyone still dead as a round starts |
| `tsm_force_teamlist` | `1` | set mp_teamlist again once the map is up |
| `tsm_force_teammodels` | (empty) | set mp_teammodels too, when not empty |
| `tsm_freeze_method` | `2` | how a hold freezes: 2 clamps maxspeed (the one that works), 1 FL_FROZEN |
| `tsm_freezetime` | `10` | seconds frozen at the start of each round (the match's first freeze lasts at least tsm_lr_freeze with tsm_loadoutrework 1) [cfg 6] |
| `tsm_friendlyfire` | `0` | teammates can hurt each other |
| `tsm_gamedesc` | `Match Mode` | The "Game" column in the server browser. |
| `tsm_gamedesc_siege` | `Siege` | the game name on a siege map |
| `tsm_halt_bypass` | `0` | 1 never halts, while leaving the rest of the balance settings doing their job. |
| `tsm_halt_delay` | `3.0` | seconds after a leave before the sides are counted |
| `tsm_halt_humans` | `1` | a halt counts people, not bots |
| `tsm_halt_on_leave` | `1` | stop a round whose sides went uneven, replay it, keep the score |
| `tsm_handoff` | `1` | 1: a player's use key on a bot of his own side that carries the uplink, a flag or TS's briefcase makes it let go (a bot cannot type dropflag); 0: a bot lets go only by dying [cfg: line commented out] |
| `tsm_handoff_secs` | `8` | seconds that bot keeps its hands off what it let go of, so that the player can take it (1 and up) [cfg: line commented out] |
| `tsm_hold_height` | `900` | how far above their death spot a dead player is parked with nobody to watch |
| `tsm_hover_info` | `1` | aim at a teammate to see their class and health |
| `tsm_hover_plaque` | `1` | on an H9 game the readout is a plaque (a notice over a bar of his health, in the colour of how well he is) and TS's own green name over the teammate is left out; 0: the green text as |
| `tsm_hover_range` | `640` | how far that reaches |
| `tsm_icon_height` | `52.0` | units above the player's origin |
| `tsm_icon_scale` | `0.25` | sprite scale; the sheet is 64x64 per frame |
| `tsm_latejoin` | `1` | a person arriving after the match began (or leaving the spectators) may pick a side and is let in at his side's next respawn: the next respawn wave, else the start of the |
| `tsm_linear_obj` | `1` | numbered order, the default: a charge or a gunshot counts on an objective only when every lower number has fallen ("Objective 2 has to fall first.") |
| `tsm_listen_guard` | `1` | a game with maxplayers 1 is single-player, where the fire click of "Press Fire To Play" restarts the map in a loop: 1 refuses the click there and says why in chat; no |
| `tsm_live_gate` | `1` | 1 the match starts when everyone types .ready; 0 no ready-up: it starts by itself when each side has tsm_live_minplayers players or tsm_live_wait seconds have run since both |
| `tsm_live_minplayers` | (empty) | gate off: players needed on EACH side to start at once; empty or 0 = not used |
| `tsm_live_wait` | (empty) | gate off: seconds to wait; with this and tsm_live_minplayers both empty it waits 45 |
| `tsm_loadout` | `9:3,25:0` | what a player spawns holding without a class (id:clips pairs) |
| `tsm_loadoutrework` | `0` | (no description yet) |
| `tsm_lock_teams` | `1` | refuse side changes once a match is under way |
| `tsm_logging` | `0` | the plugin's own log lines on |
| `tsm_lr_buy_seconds` | `20` | tsm_lr_lock 0 only: seconds after a respawn wave that the menu stays open, for one change (the freeze is open throughout) |
| `tsm_lr_cash` | `8500` | cash each such class has to spend: a rifle, a pistol, a knife and kevlar (1900); a class weapon of its own (the Barrett) comes on top |
| `tsm_lr_clips` | `3` | spare magazines with each bought gun |
| `tsm_lr_deny` | `32,18` | weapon ids that only a class whose own kit carries them may buy (the Barrett: the Marksman; the M60E3: nobody the rework covers); the word kevlar refuses |
| `tsm_lr_freeze` | `30` | seconds of the FIRST freeze of a match (the one the live gate opens) while the rework is on: the class pick and the last buy; later rounds are tsm_freezetime long |
| `tsm_lr_kitfallback` | `0` | 0: a player who bought nothing holds his fists. |
| `tsm_lr_lock` | `1` | 1: a player's loadout is final from the first time a round goes live for him: later freezes and respawn waves sell him nothing. |
| `tsm_lr_slotcap` | `81` | the most slots a covered class's loadout may weigh: 81 is TS's own limit, and the hand-over does not raise the room. |
| `tsm_mech_ammo_mult` | `2.0` | the Mech's spare rounds as a multiple of what it is armed with (the M60's 120, TS's cap for its caliber): the rest waits in an ammo bay and loads into the reserve as it is used up; |
| `tsm_mech_flash` | `1` | a large muzzle flash at the Mech's barrels on every shot |
| `tsm_mech_flash_scale` | `0.3` | its size, as a sprite scale (0.3 is about 40 units across) |
| `tsm_mech_laser_mult` | `1.15` | what the laser rifle's damage to a Mech is multiplied by, before the Mech's armour; 1.0 off |
| `tsm_mech_nodrop` | `1` | on it lets a Mech go of no weapon (no disarm, no drop, no death scatter), and while tsm_loadoutrework is on |
| `tsm_mech_nopickup` | `1` | 1: a Mech takes no weapon from the floor, neither one another player dropped nor one lying on the map: the use key does nothing while one is within reach (he is told) and |
| `tsm_mech_rocket_boom` | `1` | (no description yet) |
| `tsm_mech_rocket_flash` | `1` | the launcher's muzzle flash (a sprite and a light at the muzzle): 0 off, 1 the size the sprite was made for, more or less to scale it |
| `tsm_mech_rocket_smoke` | `1` | the smoke trail behind his rocket in flight: 0 off, 1 as made, more or less to scale its width |
| `tsm_mech_trail_max` | `6` | bullets of one Mech in the air at once (1 to 16) |
| `tsm_mech_trails` | `1` | a bullet and its trail flown from the barrels to where the shot lands |
| `tsm_medic_cooldown` | `15.0` | seconds between heals |
| `tsm_medic_glow` | `1.5` | seconds of the red glow on the healed |
| `tsm_medic_heal` | `50` | Hit points per heal. |
| `tsm_medic_range` | `96` | how far the heal reaches |
| `tsm_medic_shell` | `16` | that glow's thickness |
| `tsm_medic_sound` | `items/medshot4.wav` | The sounds the two perks play, heard by anyone nearby rather than only by the two players involved. |
| `tsm_menu_delay` | `3` | seconds after joining before the side menu is offered |
| `tsm_min_per_team` | `1` | players each side needs before ready-up can start the match |
| `tsm_model_fallback_class` | `1` | the class a blank model field borrows from |
| `tsm_model_mode` | `teamonly` | force (class models, re-asserted) or teamonly (TS's own) [cfg force] |
| `tsm_model_post` | `1` | write the class model from a POST hook, after TS |
| `tsm_model_verify` | `0` | seconds between re-checking a player's model; 0 never |
| `tsm_music_rp` | `1` | the ambient music on a roleplay map too, where the match mode is off; 0 only where the match mode plays. |
| `tsm_music_volume` | `0.5` | the background music's volume [cfg 0.6] |
| `tsm_no_powerups` | `1` | take TS's powerups out of match play |
| `tsm_no_weapons` | `0` | 1 sweeps every weapon off the map, once a second (set per map in its mapconfig) |
| `tsm_nocash` | `1` | economy on, wallet held at 0: no buying |
| `tsm_obj_class` | `Breacher` | the class that plants; empty, any class |
| `tsm_obj_fuse` | `5.0` | seconds a planted charge burns |
| `tsm_obj_markers` | `1` | a marker over each objective, each side its own colour, and each objective's glow: blue to defend, red to attack, white for no side (H9XASH draws it); 0 off |
| `tsm_obj_msg_1` | (empty) | side 1's round-start banner |
| `tsm_obj_msg_2` | (empty) | What each side reads in BIG LETTERS, upper-middle of the screen, one second after a round starts and for five seconds after. |
| `tsm_obj_range` | `96` | how far a planter can reach |
| `tsm_obj_slay` | `1` | the last objective's fall kills everyone left |
| `tsm_obj_team` | `2` | the side that attacks the objectives |
| `tsm_obj_time` | `10.0` | seconds to hold +USE to plant |
| `tsm_officerslain_sound` | `1` | both sides hear it when an Officer falls (not in Capture the Flag or Assault: a death there is a wait for a wave) |
| `tsm_officerspawn` | `0` | 1 brings a respawn wave back beside the side's living Officer instead of its spawn points |
| `tsm_pool_base` | `16` | a side's reinforcements as the round goes live: this, and |
| `tsm_pool_perplayer` | `4` | this for every player on the side, bots included |
| `tsm_pres_alive1` | (empty) | (no description yet) |
| `tsm_pres_alive2` | (empty) | (no description yet) |
| `tsm_pres_attack` | (empty) | (no description yet) |
| `tsm_pres_mode` | (empty) | the claimed mode's key, for the Discord card |
| `tsm_pres_prog` | (empty) | the claimed mode's progress, as it last said it |
| `tsm_pres_side1` | (empty) | (no description yet) |
| `tsm_pres_side2` | (empty) | (no description yet) |
| `tsm_pres_siege` | (empty) | (no description yet) |
| `tsm_regen_amount` | `10` | health back each tick |
| `tsm_regen_interval` | `15.0` | seconds between ticks |
| `tsm_regen_pause` | `15.0` | seconds unhurt before it starts again |
| `tsm_reinforce_cooldown` | `120.0` | seconds between an Officer's .reinforce calls [cfg 120] |
| `tsm_report_hp` | `1` | with the killer's health and armour left |
| `tsm_report_kills` | `1` | team-scoped elimination messages |
| `tsm_reset_delay` | `1.0` | accepted and ignored |
| `tsm_reset_loadout` | `0` | removed; accepted and ignored |
| `tsm_respawn_seconds` | `5.0` | seconds dead before a wave can take someone [cfg 5] |
| `tsm_respawn_sudden` | `0` | 1 runs waves in sudden death too |
| `tsm_respawn_wave` | `60.0` | seconds between a side's waves [cfg 60] |
| `tsm_respawns` | `1` | classes with lives come back in waves; 0 makes every elimination final |
| `tsm_roundend_delay` | `4.0` | seconds from the last enemy dying to the round ending |
| `tsm_rounds` | `9` | best of: 9 is first to 5 |
| `tsm_roundtime` | `300` | the round's time limit, in seconds |
| `tsm_rp_hands` | `1` | (no description yet) |
| `tsm_rp_hands_droid` | `1` | 1 a droid wears the metal arms of its type (insdroid_bot the insurgent droid's, any other droid the msr droid's); 0 every droid the msr droid's, and 21 MB less to |
| `tsm_rp_hands_ins` | `xccp,ins_` | the same for the insurgent hands |
| `tsm_rp_hands_msr` | `repu,rh_` | words (commas, any case) of a player model name that give the msr hands on a roleplay map; read at once |
| `tsm_rp_hands_prole` | `proletarian` | words (commas, any case) of a player model name that give the bare mottled brown hand of proletarian (proletarian_dirty too); read at once, and a list left empty keeps |
| `tsm_rp_hands_prolefem` | `prole_` | the same for the dark glove of prole_fem and prole_bfem |
| `tsm_rp_hands_prolehealthy` | `proletarian_healthy` | the same for the pale hand of proletarian_healthy; asked before the other two. |
| `tsm_rp_sound_range` | `1200` | how far those sounds are heard on a roleplay map, in units: quieter with the distance, gone at the range (100 at least) |
| `tsm_rp_sounds` | `1` | on a roleplay map the death sounds (a voice by model, a machine's burst) and a machine's clang when hit; 0 none. |
| `tsm_rtv_menu_wait` | `90` | seconds the side menu waits for ts_rtv's map vote at most; 0 waits as long as it runs |
| `tsm_scale_limits` | `1` | added to every class limit, per tier: one number or a list in class order |
| `tsm_scale_lives` | `0` | a class's extra lives at a tier, times tsm_scale_lives_tiers (tsm_respawns 1): one number or a list in class order; 0 leaves a class out [cfg 1,1,1,1,1,1,1,1,0; 0 in the |
| `tsm_scale_lives_tiers` | (empty) | each tier's number for those extra lives, in tier order, the last for any tier past the list; empty: the tier itself [cfg 1,1,2] |
| `tsm_scale_players` | (empty) | player counts that start each tier of a bigger match; empty is off [cfg 24,40,56] |
| `tsm_scale_tier` | `0` | set by the plugin: the tier this round started in |
| `tsm_scan_cooldown` | `30.0` | seconds between scans |
| `tsm_scan_radius` | `1024` | how far .scan reaches |
| `tsm_scan_sound` | (empty) | the scan's sound; empty is silent [cfg scan.wav] |
| `tsm_scan_time` | `10.0` | seconds a scanned enemy stays exposed |
| `tsm_score` | `1` | a match's points are the frags, each side's its header total; 0 leaves TS's own frags |
| `tsm_score_assist` | `1` | an assist (the scoreboard's A) |
| `tsm_score_capture` | `10` | a flag carried home and captured (Capture the Flag) |
| `tsm_score_carry` | `1` | every tsm_score_carry_secs (15) seconds carrying the uplink |
| `tsm_score_carry_secs` | `15` | seconds of carrying for tsm_score_carry |
| `tsm_score_heal` | `1` | The points, each for one thing a player does in a round; a negative number takes points away. |
| `tsm_score_kill` | `2` | an enemy eliminated |
| `tsm_score_objective` | `5` | a siege objective destroyed |
| `tsm_score_plant` | `2` | the siege satchel set |
| `tsm_score_resupply` | `1` | an engineer's resupply that gave rounds |
| `tsm_score_return` | `3` | a dropped flag taken back to its pad |
| `tsm_score_teamkill` | `-3` | a teammate eliminated |
| `tsm_score_wave` | `3` | a survival wave cleared while still in play |
| `tsm_score_zone` | `5` | an uplink zone taken (Capture the Uplink) |
| `tsm_show_reinforce` | `1` | every living player, and every teammate waiting for the wave, sees his side's next respawn wave, what is left and the list of who is waiting, as the Officer always does; |
| `tsm_show_timer` | `1` | the round clock on screen |
| `tsm_siege_extratime` | `1` | the clock runs back toward a full tsm_roundtime, by at most tsm_addtime seconds (150, 2:30) a fall, never past the round time. |
| `tsm_siege_rewardlives` | `1` | everyone's lives SET to their class's count again -- never added to, so a full count stays as it is -- and everyone eliminated, out of lives or already waiting, comes back with their |
| `tsm_spawn_health` | `100` | health given at the start of each round |
| `tsm_spawn_mode` | `auto` | auto (the map's spawn cfg, else its entities), config, or entity |
| `tsm_spawn_prune` | `1` | keep the map's own spawn points out of the custom set |
| `tsm_spawn_prune_dist` | `64` | how near a map spawn must be to count as one |
| `tsm_spawnprotect` | `1` | a player who goes live (a round's start, a respawn wave) is unhurt, a little translucent and lit with a white glow for tsm_spawnprotect_dur seconds |
| `tsm_spawnprotect_dur` | `3` | the seconds of that protection |
| `tsm_spectate_index` | `3` | that team's place in mp_teamlist |
| `tsm_spectator_model` | `Invisible` | the model a spectator wears |
| `tsm_spectator_team` | `spectator` | the real third TS team for people not playing |
| `tsm_spectator_team_h9` | `Spectator` | the same on H9XASH |
| `tsm_squad_dist` | `280` | how close a squad bot keeps; inside it, rcbot steers [cfg 160] |
| `tsm_squad_leash` | `50` | how far out counts as lost: 3 seconds out there and the bot is brought back |
| `tsm_squad_speed` | `240` | how fast squad bots are steered |
| `tsm_squad_steer` | `1` | (no description yet) |
| `tsm_squad_warp` | `1200` | beyond this a bot is warped to the Officer at once |
| `tsm_startsound` | `1` | each side's own stinger one second into a round |
| `tsm_stim` | `1` | (no description yet) |
| `tsm_stim_glow` | `1.5` | seconds of its red glow |
| `tsm_stim_max` | `50` | (no description yet) |
| `tsm_stim_min` | `25` | least health it gives |
| `tsm_stim_shell` | `16` | that glow's thickness |
| `tsm_sudden_death` | `60` | the last N seconds of a round go "sudden"; 0 is off |
| `tsm_sudden_fog_b` | `45` | While sudden death is on, the round goes louder and greener on the H9XASH engine: 1. |
| `tsm_sudden_fog_density` | `90` | its strength, 0-255 |
| `tsm_sudden_fog_g` | `140` | While sudden death is on, the round goes louder and greener on the H9XASH engine: 1. |
| `tsm_sudden_fog_r` | `40` | the fog's red, 0-255 |
| `tsm_sudden_sound` | `xom_laugh.wav` | played to everyone as it starts |
| `tsm_sudden_xray` | `1` | enemies through walls on H9XASH |
| `tsm_sweep_drops` | `1` | remove what players dropped, at each round's start |
| `tsm_team1_label` | `the Middle Sea Republic` | Long names shown in the "Pick a side" menu. |
| `tsm_team1_name` | (empty) | side 1's TS team name on the GoldSrc package, 15 characters at most [cfg msr] |
| `tsm_team1_name_h9` | `Middle Sea Republic` | (no description yet) |
| `tsm_team1_short` | (empty) | side 1's short name on the score line [cfg MSR] |
| `tsm_team2_label` | `the Insurrectionists` | Long names shown in the "Pick a side" menu. |
| `tsm_team2_name` | (empty) | side 2's [cfg insurgents] |
| `tsm_team2_name_h9` | `Insurrectionists` | side 2's on H9XASH Each pair matches its platform's mp_teamlist in ts\game.cfg: "msr;insurgents;spectator" on the GoldSrc package, "Middle Sea Republic; |
| `tsm_team2_short` | (empty) | side 2's [cfg INS] |
| `tsm_team_mode` | `auto` | how the two sides are learned: auto, name, or number |
| `tsm_test_solo` | `0` | 1 lets a match run with one side filled, to test alone |
| `tsm_transporter` | `1` | the Combat Engineer's transporter pads (.transporter) |
| `tsm_transporter_cooldown` | `3.0` | seconds before a player rides a pad again |
| `tsm_transporter_hp` | `200` | a pad's health: the other side's fire destroys it |
| `tsm_transporter_per_engineer` | `2` | pads an engineer may set up a round |
| `tsm_transporter_resist` | `0.5` | the share of each hit its armour turns aside |
| `tsm_turret` | `1` | .turret (or turret in the console) stands one on the floor in front of a Combat Engineer in a live round. |
| `tsm_turret_damage` | `16` | Damage a round, rounds a second, and its spread in degrees. |
| `tsm_turret_hp` | `400` | Its health, the share of every hit its armour turns aside (0.5: it takes half), and how far it sees and shoots, in units. |
| `tsm_turret_per_team` | `2` | standing at once per side |
| `tsm_turret_range` | `1000` | how far it sees and shoots |
| `tsm_turret_rate` | `8.0` | Damage a round, rounds a second, and its spread in degrees. |
| `tsm_turret_repair` | `100` | health one +USE repair puts back |
| `tsm_turret_repair_cooldown` | `30` | seconds between repairs of one turret |
| `tsm_turret_resist` | `0.5` | share of each hit its armour turns aside |
| `tsm_turret_spread` | `1.5` | Damage a round, rounds a second, and its spread in degrees. |
| `tsm_verbosity` | `0` | 0: no "[MATCH]" chat line at all; the centre texts stay (CHAT AND CENTRE TEXTS) |
| `tsm_warmup_hide` | `1` | hide players in warmup as well as freezing, and from a match's end until warmup |
| `tsm_warmup_hold` | `1` | hold everyone, frozen and unhurt, through warmup and ready-up, and from a match's end until warmup |
| `tsm_weapon_mode` | `2` | 2 hands out the class weapons; 0 none |
| `tsm_welcome_sound` | `welcome.wav` | played to a player who has just joined |
| `tsm_wpn_extra` | `0` | attachments on every class weapon (bitmask: 1 silencer, 2 laser, 4 light, 8 scope) |

#### ts_mechwarrior

`src/ts_mechwarrior.sma`. Config: `ts_mechwarrior.cfg`. 7 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `tsm_gamedesc_mechwarrior` | `Mech Warrior` | What the server browser, the server-list bot, the adverts and the Discord card call the game while the mode runs. |
| `tsm_mechwarrior_mode` | `1` | the mode on, on every h9_mw_ map |
| `tsm_mw_engineer` | `1` | the Combat Engineer is played too, at his class's limit and lives; 0 not |
| `tsm_mw_mech_lives` | `3` | Mechs a side (0: no limit), and the lives each one has. |
| `tsm_mw_mechs` | `0` | Mechs a side; 0 no limit |
| `tsm_mw_officer_lives` | `2` | each Officer's lives |
| `tsm_mw_officers` | `1` | Officers a side; 0 no Officer |

#### ts_rtv

`src/ts_rtv.sma`. Config: `ts_rtv.cfg`. 5 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `tsm_rtv_auto` | `1` | a vote 10 seconds after a match is played to its end; a vote nobody answers then picks a map |
| `tsm_rtv_in_match` | `0` | 1 lets .rtv start a vote while a match is in progress |
| `tsm_rtv_maps` | `6` | maps on a vote, 2 to 8 |
| `tsm_rtv_nominations` | `4` | nominations a vote takes, at most tsm_rtv_maps; 0 turns .nominate off |
| `tsm_rtv_roleplay` | `0` | 1 lets a roleplay map be voted away from; 0: no .rtv, .nominate or vote on one |

#### ts_survival

`src/ts_survival.sma`. Config: `ts_survival.cfg`. 16 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `tsm_gamedesc_survival` | `Wave Survival` | What the server browser, the server-list bot, the adverts and the Discord card call the game while the mode runs. |
| `tsm_mutants_mode` | `1` | the mode on, on every h9_ws_ map |
| `tsm_ws_class` | `1` | the class every mutant plays |
| `tsm_ws_gun_odds` | `1:40,16:60,25:100` | the chance of a gun, by wave |
| `tsm_ws_guns` | `13:3,3:3,7:3,20:3` | the guns, one at random |
| `tsm_ws_hp_per_wave` | `5` | percent more health each wave |
| `tsm_ws_human_side` | `1` | the side the people play, 1 or 2; the mutants are the bots of the other (read when the map is claimed); the map's spawn areas follow the roles, not the number |
| `tsm_ws_kungfu_after` | `30` | the kung fu powerup after this wave |
| `tsm_ws_mech_after` | `25` | from this wave on, a mutant may play the Mech class |
| `tsm_ws_mech_per_wave` | `1` | percent chance of that, times (wave - after + 1), 100 at most. |
| `tsm_ws_melee` | `25,34,35,0` | the blades, one at random |
| `tsm_ws_overtime` | `225` | seconds a wave may run before overtime; the mutants then lose health until it is cleared. |
| `tsm_ws_overtime_fog` | `1` | 1: the sudden-death fog while overtime lasts |
| `tsm_ws_overtime_hp` | `2` | health each living mutant loses a second in overtime |
| `tsm_ws_stall` | `120` | seconds with three or fewer mutants left and none falling before the wave is cleared |
| `tsm_ws_wave` | `30` | the breather between waves, in seconds |

#### ts_uplink

`src/ts_uplink.sma`. Config: `ts_uplink.cfg`. 7 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `tsm_cap_radius` | `128` | a zone's radius, unless given |
| `tsm_cap_time` | `15` | seconds the carrier must hold a zone |
| `tsm_gamedesc_uplink` | `Capture the Uplink` | What the server browser, the server-list bot, the adverts and the Discord card call the game while the mode runs. |
| `tsm_uplink_mode` | `1` | the mode on, on every map with control zones |
| `tsm_uplink_return` | `20` | seconds a dropped uplink lies before going home |
| `tsm_uplink_rewardlives` | `1` | what a taken zone gives back: 1 the taking side's lives and fallen at once, 2 both sides', 0 nothing |
| `tsm_uplink_wave` | `30` | seconds between both sides' respawn waves on an uplink map |

#### tsrp_roambots

`src/tsrp_roambots.sma`. Config: `tsrp_roambots.cfg`. 25 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `tsrp_rb_forget_cmd` | `0` | 0: nothing beyond RCBot's own rules; 1: "rcbot roamforget &lt;player&gt;" when a hostility ends (needs a build that has it); 2: the citizens that were hostile |
| `tsrp_rb_forgive_seconds` | `0` | 0: tsrp_roambots_defend_time is left as it is; N: it is set to N (seconds after his last blow, RCBot lets him go) |
| `tsrp_roambots` | `0` | 1: citizens on this roleplay map [h9_tsrp_newbyzantium and h9_tsrp_hive 1] |
| `tsrp_roambots_active` | `0` | set by the plugin, not by hand: 1 while citizens run (RCBot reads it) |
| `tsrp_roambots_admin_flag` | `h` | the admin flags .insurgency and .civilians need; empty: anyone |
| `tsrp_roambots_commands` | `1` | 0: .insurgency and .civilians do nothing on this map (for a mapconfig) |
| `tsrp_roambots_count` | `12` | how many at most; fewer when real players need the slots [h9_tsrp_newbyzantium and h9_tsrp_hive 32] |
| `tsrp_roambots_debug` | `0` | 1: log placements, refused pickups and dropped weapons |
| `tsrp_roambots_defend` | `1` | 1: a citizen someone hurts fights that one back, with its hands, until he dies or leaves (RCBot reads it) |
| `tsrp_roambots_defend_time` | `30` | seconds it goes on without being hurt again before it lets him be (RCBot reads it) |
| `tsrp_roambots_god` | `0` | 1: citizens cannot be hurt |
| `tsrp_roambots_insurgency` | `0` | 1: the citizens are insurgents; set by .insurgency and .civilians, or by a mapconfig (RCBot reads it) |
| `tsrp_roambots_insurgent_drop` | `1` | what a dying insurgent leaves on the ground: 1 the gun in its hands, 0 nothing |
| `tsrp_roambots_insurgent_team` | `0` | 0: insurgents are set on every player who is not a bot; with team play on every player and every bot that is not on their own team; a team number: only |
| `tsrp_roambots_names` | (empty) | names for a face with no gender; empty: the plugin's own 16 |
| `tsrp_roambots_names_f` | (empty) | women's names, ";" between; empty: the plugin's own 40 |
| `tsrp_roambots_names_m` | (empty) | men's names; empty: the plugin's own 40 |
| `tsrp_roambots_pause` | `40` | percent chance of a pause before each walk (RCBot reads it) |
| `tsrp_roambots_reserve` | `2` | slots always kept free for real players (at least 1) |
| `tsrp_roambots_speed` | `120` | the walk, units a second (RCBot reads it) |
| `tsrp_roambots_talk` | `40` | percent chance that two citizens who meet stop to talk; 0: never |
| `tsrp_roambots_talk_range` | `150` | how close two citizens are when they stop to talk (units) |
| `tsrp_roambots_use` | `1` | 1: +use (E) on a citizen gets a murmur from it, and it faces you a moment |
| `tsrp_roambots_use_cooldown` | `8` | seconds before that citizen, or that player, has another |
| `tsrp_roambots_weapons` | `0` | 0: unarmed, and nothing picked up; 1: armed by RCBot as usual; it fights only with its hands [h9_tsrp_newbyzantium 0] |

### Apollo RP

#### ARP_Config

`apollo-rp/base/addons/amxmodx/scripting/ARP_Config.sma`. Config: `arp.cfg`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_sql_backup_db` | `backup` | Database to use for backups |

#### ARP_Core

`apollo-rp/base/addons/amxmodx/scripting/ARP_Core.sma`. Config: `arp.cfg`. 39 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_account_wait` | `30` | 30 live, at each join |
| `arp_auxhud_b` | `0` | (no description yet) |
| `arp_auxhud_g` | `0` | (no description yet) |
| `arp_auxhud_r` | `255` | (no description yet) |
| `arp_auxhud_type` | `2` | (no description yet) |
| `arp_auxhud_x` | `0.4` | (no description yet) |
| `arp_auxhud_y` | `0.7` | (no description yet) |
| `arp_character_sheet` | `1` | (no description yet) |
| `arp_falldamage` | `1` | Whether or not to enable fall damage |
| `arp_gamename` | (empty) | (no description yet) |
| `arp_goddoors` | `1` | (no description yet) |
| `arp_godwindows` | `0` | God windows: 1 makes EVERY func_breakable unbreakable (manhole covers, vents, glass, crates); doors are protected by arp_goddoors |
| `arp_h9_itemglow` | `1` | 0 no pulse is sent and the beat stops at its next turn. |
| `arp_h9_itemglow_color` | `180 60 255` | (no description yet) |
| `arp_h9_itemglow_radius` | `200` | (no description yet) |
| `arp_h9_itemglow_time` | `12` | (no description yet) |
| `arp_h9_itemhover` | `1` | 1: a dropped item that a player looks toward says what it is and how many (Soda x3), and how to pick it up from close by; 0: stock ARP, which says nothing of it |
| `arp_h9_itemicon` | `1` | 1 0 live; 1 needs a map change |
| `arp_h9_itemicon_max` | `64` | 64 live, for the next pack |
| `arp_h9_itemicon_scale` | `0.6` | 0.6 live, for the next pack |
| `arp_h9_plaque` | `1` | (no description yet) |
| `arp_h9_toast` | `1` | (no description yet) |
| `arp_hover_message` | `1` | (no description yet) |
| `arp_hud4_type` | `1` | Auxilary HUD This HUD is used for messages such as telling a user they have loaded up on ammo, they can't target something, etc. |
| `arp_hud_panel` | `1` | (no description yet) |
| `arp_hud_refresh` | `10` | (no description yet) |
| `arp_items_per_page` | `30` | (no description yet) |
| `arp_lights` | `q` | Lighting - a is darkest, z is lowest, q is normal |
| `arp_log` | `1` | Where to log to 0 - disable logging 1 - log to AMXX files 2 - log to logs/arp/mm-dd-YY.log 3 - log to logs/arp/pluginname.log |
| `arp_mapsql_autoload` | `1` | Whether a map's own SQL file, configs/arp/maps/&lt;map&gt;/&lt;map&gt;.sql, is run by itself when the map loads (1) or only when an ARP admin runs it by hand (0: console arp_config, entry 3, Load Map SQL Data). |
| `arp_performance` | `100` | Performance level: leave at 100 unless you have problems with the core even when it is running on its own (i.e. with no other ARP plugins) |
| `arp_save_interval` | `30` | How often all data is saved in seconds - use 0 to disable saving (not recommended, it will not lag the server due to the way it is done) |
| `arp_startmoney` | `500` | How much money you start with if you have never joined the server before |
| `arp_teamplay` | `0` | 1 map change, from the files only |
| `arp_teamplay_on` | `0` | (no description yet) |
| `arp_wallet_death` | `1` | Whether or not when you die you lose the money in your wallet |
| `arp_welcome_msg1` | `This server is running Apollo RP (http://ApolloRP.org).` | Welcome messages Each line is broken up into a separate cvar Use "" to disable |
| `arp_welcome_msg2` | `Type ^` | Welcome messages Each line is broken up into a separate cvar Use "" to disable |
| `arp_welcome_msg3` | (empty) | Welcome messages Each line is broken up into a separate cvar Use "" to disable |

#### ARP_CS

`apollo-rp/base/addons/amxmodx/scripting/ARP_CS.sma`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_respawn_time` | `2` | (no description yet) |

#### ARP_H9Ctx

`apollo-rp/base/addons/amxmodx/scripting/ARP_H9Ctx.sma`. Config: `arp.cfg`. 7 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_ctx_cuff` | `1` | The entries that no other switch is behind: Cuff (and Free), Fine and Give money. |
| `arp_h9_ctx_fine` | `1` | The entries that no other switch is behind: Cuff (and Free), Fine and Give money. |
| `arp_h9_ctx_fine_amounts` | `50 100 250 500 1000` | "50 100 250 500 1000" live |
| `arp_h9_ctx_give` | `1` | The entries that no other switch is behind: Cuff (and Free), Fine and Give money. |
| `arp_h9_ctx_give_amounts` | `10 50 100 500 1000` | "10 50 100 500 1000" live |
| `arp_h9_ctx_range` | `150` | The distance, in units, beyond which the menu closes by itself. |
| `arp_h9_ctxmenu` | `0` | The context menu of the use key on a player (ARP_H9Ctx; docs\ARP_INVENTORY.txt, 10). |

#### ARP_HUD

`apollo-rp/base/addons/amxmodx/scripting/ARP_HUD.sma`. Config: `arp.cfg`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_hud_title` | `? #hostname# ?` | HUD display title, use #hostname# to insert the server's hostname in that spot Use "\n" to indicate a line break |

#### ARP_HungerMod

`apollo-rp/base/addons/amxmodx/scripting/ARP_HungerMod.sma`. Config: `arp.cfg`. 3 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_thirst_keep` | `1` | 1 live, at each load and save |
| `arp_hunger_enabled` | `1` | Whether or not hunger is enabled |
| `arp_thirst_enabled` | `1` | Whether or not thirst is enabled: a second need beside hunger, quenched only by drinks (Soda and Milk) |

#### ARP_Inventory

`apollo-rp/base/addons/amxmodx/scripting/ARP_Inventory.sma`. Config: `arp.cfg`. 10 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_credits` | `1` | What the money is called in the inventory and exchange windows and in the messages ARP_Inventory prints: 1 is credits (1,250 credits), 0 is cash ($1,250). |
| `arp_h9_inv_persist` | `1` | (no description yet) |
| `arp_h9_inv_slots` | `32` | 32 live, once a second |
| `arp_h9_inv_stack` | `20` | 20 live, once a second |
| `arp_h9_inv_window` | `1` | 1 gives a player whose game has the inventory window that window for /items and /inventory in place of the text menu (it needs arp_h9_vgui 1). |
| `arp_h9_search` | `1` | A player who presses the use key on a player who is handcuffed or in jail searches him: a window opens with the other player's cells beside his own and what he takes moves from the one's inventory to the other's. |
| `arp_h9_search_money` | `1` | (no description yet) |
| `arp_h9_search_range` | `150` | A player who presses the use key on a player who is handcuffed or in jail searches him: a window opens with the other player's cells beside his own and what he takes moves from the one's inventory to the other's. |
| `arp_h9_trade_range` | `250` | The exchange of goods between two players (the use key pressed on another player; ARP_Inventory): the distance, in units, at which an open exchange is cancelled. |
| `arp_h9_trade_timeout` | `120` | The seconds without a change to an offer after which an open exchange is cancelled. |

#### ARP_Items

`apollo-rp/base/addons/amxmodx/scripting/ARP_Items.sma`. Config: `arp.cfg`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_restraints` | `1` | Restraints: 1 makes Cuffs, Tape and Rope items (the shops' sell lines for them then work). |
| `arp_h9_rope_length` | `150` | The slack of a rope, in units: a tied player is pulled toward the one who holds the rope when he is further than this, and the rope snaps at four times it. |

#### ARP_JailMod

`apollo-rp/base/addons/amxmodx/scripting/ARP_JailMod.sma`. Config: `arp.cfg`. 7 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_cuffsprite` | `1` | 1 0 live; 1 needs a map change |
| `arp_h9_restraints` | `1` | Restraints: 1 makes Cuffs, Tape and Rope items (the shops' sell lines for them then work). |
| `arp_jail_death` | `1` | This is whether or not dying lets you out (1 = keep in, 0 = let out) |
| `arp_jail_distance` | `90.0` | This is how far you must be within to be kept in jail This only takes effect if arp_jail_mode is "1" |
| `arp_jail_mode` | `1` | This is the mode it works in Use 0 to disable it entirely Use 1 to use Harbu style, where if you leave the cell, you are free Use 2 for new style, where a cop has to "Free Target Player" in order for them to be able to leave |
| `arp_jail_reconnect` | `1` | This is whether or not reconnecting lets you out (1 = keep in, 0 = let out) |
| `arp_jailmod_table` | `arp_jailusers` | (no description yet) |

#### ARP_NPCs

`apollo-rp/base/addons/amxmodx/scripting/ARP_NPCs.sma`. Config: `arp.cfg`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_ammofill_cost` | `50` | How much it costs to refill ammo at the gun shop |
| `arp_profit_fraction` | `0.25` | How much money of an item sold goes to profit |

#### ARP_PayScale

`apollo-rp/base/addons/amxmodx/scripting/ARP_PayScale.sma`. Config: `arp.cfg`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_pay_percent` | `100` | Pay (ARP_PayScale; docs\APOLLO_RP.txt, section 8). |

#### ARP_PropClip

`apollo-rp/base/addons/amxmodx/scripting/ARP_PropClip.sma`. Config: `arp.cfg`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_propclip` | `0` | 1 live, once a second |

#### ARP_PropertyTax

`apollo-rp/base/addons/amxmodx/scripting/ARP_PropertyTax.sma`. Config: `arp.cfg`. 9 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_tax` | `1` | 1 live, at each toll |
| `arp_h9_tax_evict` | `0` | 1 live, at each toll |
| `arp_h9_tax_evict_debt` | `0` | 0 live, at each toll |
| `arp_h9_tax_evict_tolls` | `96` | 288 live, at each toll |
| `arp_h9_tax_flat` | `0` | 0 live, at each toll |
| `arp_h9_tax_manual` | `0` | 1 live, at each toll |
| `arp_h9_tax_minutes` | `15` | 15 live, at each toll |
| `arp_h9_tax_percent` | `1.0` | 0.10 live, at each toll |
| `arp_h9_tax_treasury` | `0` | 1 live, at each eviction |

#### ARP_TalkArea

`apollo-rp/base/addons/amxmodx/scripting/ARP_TalkArea.sma`. Config: `arp.cfg`. 13 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_advert` | `60` | The interval between advertisements (0 to disable) |
| `arp_capscom` | `1` | Whether COM APPEARS IN CAPS IN CHAT or if it retains how the person typed it out |
| `arp_chat_color` | `0` | (no description yet) |
| `arp_cnn` | `120` | The interval between CNN messages (0 to disable) |
| `arp_message_log` | `0` | Whether or not to log chats |
| `arp_message_lol` | `0` | Whether or not to replace "lol", "rofl" and other chat with "haha" This only works when arp_printmode is set to 2 |
| `arp_message_range` | `1.0` | Message range as a factor Increasing this multiplies the default range by the amount you choose You can also pick values below 1.0 to shrink the range This affects all chat commands except for main OOC |
| `arp_ooc` | `2` | Whether or not OOC (i.e. (( talking like this to everyone )) ) is allowed 1 - Normal OOC (shows in chat section) 2 - HUD OOC (uses HUD 3 to separate OOC and normal chat): the box on the right of the screen, with the ... |
| `arp_ooc_hudtitle` | `[ARP OOC]` | OOC HUD title, appears above all OOC chats if arp_ooc is set to 2 |
| `arp_ooc_refresh` | `3.0` | How often the OOC HUD should refresh in seconds A refresh removes a single line of text |
| `arp_printconsole` | `1` | Whether or not messages should be printed to the console (OOC and IC) |
| `arp_printmode` | `1` | Print mode 0 - no standard chat 1 - normal print mode, i.e. 'Hawk: this is a sample message' 2 - extra print mode, i.e. 'Hawk says, "This is a sample message."' |
| `arp_voice` | `1` | Voice talkarea Limits voice chat to the same range as normal speech |

#### ARP_Zones

`apollo-rp/base/addons/amxmodx/scripting/ARP_Zones.sma`. Config: `arp.cfg`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_h9_zonefix` | `1` | 1 zones: map change; touch: live |

### Apollo RP extras

#### ARP_AdvancedArmor

`apollo-rp/extra/ARP_AdvancedArmor/addons/amxmodx/scripting/ARP_AdvancedArmor.sma`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_kevlar_penetration` | `0.5` | (no description yet) |
| `arp_power_penetration` | `0.1` | (no description yet) |

#### ARP_Blueprints

`apollo-rp/extra/ARP_Blueprints/addons/amxmodx/scripting/ARP_Blueprints.sma`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_blueprint_copy_factor` | `5.0` | (no description yet) |
| `arp_blueprint_invent_factor` | `20.0` | (no description yet) |

#### ARP_Combat

`apollo-rp/extra/ARP_Combat/addons/amxmodx/scripting/ARP_Combat.sma`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_regen_time` | `2` | (no description yet) |

#### ARP_DeathFix

`apollo-rp/extra/ARP_DeathFix/addons/amxmodx/scripting/ARP_DeathFix.sma`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_respawn_time` | `10.0` | (no description yet) |

#### ARP_DMGuard

`apollo-rp/extra/ARP_DMGuard/addons/amxmodx/scripting/ARP_DMGuard.sma`. 4 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_dm_bantime` | `0` | (no description yet) |
| `arp_dm_increase` | `34` | (no description yet) |
| `arp_dm_lower` | `10` | (no description yet) |
| `arp_dm_lower_interval` | `5` | (no description yet) |

#### ARP_HawksList

`apollo-rp/extra/ARP_HawksList/addons/amxmodx/scripting/ARP_HawksList.sma`. Config: `arp.cfg`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_hawkslist_keep` | `172800` | (no description yet) |
| `arp_save_interval` | `30` | How often all data is saved in seconds - use 0 to disable saving (not recommended, it will not lag the server due to the way it is done) |

#### ARP_HoverBoots

`apollo-rp/extra/ARP_HoverBoots/addons/amxmodx/scripting/ARP_HoverBoots.sma`. 5 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_hover_flymode` | `1` | (no description yet) |
| `arp_hover_flyspeed` | `500` | (no description yet) |
| `arp_hover_flytrailbrightness` | `255` | (no description yet) |
| `arp_hover_flytrails` | `1` | (no description yet) |
| `arp_hover_grav` | `0.001` | (no description yet) |

#### ARP_RestrictModels

`apollo-rp/extra/ARP_RestrictModels/addons/amxmodx/scripting/ARP_RestrictModels.sma`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_model_punish` | `60` | (no description yet) |

#### ARP_Spy

`apollo-rp/extra/ARP_Spy/addons/amxmodx/scripting/ARP_Spy.sma`. Config: `arp.cfg`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_lights` | `m` | Lighting - a is darkest, z is lowest, q is normal |
| `arp_message_range` | `1.0` | Message range as a factor Increasing this multiplies the default range by the amount you choose You can also pick values below 1.0 to shrink the range This affects all chat commands except for main OOC |

#### ARP_StockMod

`apollo-rp/extra/ARP_StockMod/addons/amxmodx/scripting/ARP_StockMod.sma`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_stock_updatetime` | `300` | (no description yet) |

#### ARP_Casino

`apollo-rp/extra/ARP_Casino/scripting/ARP_Casino.sma`. 3 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_casino_npc_angle` | `0` | (no description yet) |
| `arp_casino_npc_model` | `models/mecklenburg/chef.mdl` | (no description yet) |
| `arp_casino_npc_origin` | `0 0 0` | (no description yet) |

#### ARP_InGameApp

`apollo-rp/extra/ARP_InGameApp/scripting/ARP_InGameApp.sma`. 1 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_application_interval` | `180` | (no description yet) |

#### ARP_MedicalTools

`apollo-rp/extra/ARP_MedicalTools/scripting/ARP_MedicalTools.sma`. 6 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_medical_bleeddamage` | `10` | (no description yet) |
| `arp_medical_bleedout` | `0` | (no description yet) |
| `arp_medical_breakdamage` | `25` | (no description yet) |
| `arp_medical_hitspeed` | `220` | (no description yet) |
| `arp_medical_maxpain` | `200` | (no description yet) |
| `arp_medical_painheal` | `50` | (no description yet) |

#### ARP_MultiCharacter

`apollo-rp/extra/ARP_MultiCharacter/scripting/ARP_MultiCharacter.sma`. 2 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_character_enforcename` | `0` | (no description yet) |
| `arp_character_max` | `5` | (no description yet) |

#### ARP_MurderMod

`apollo-rp/extra/ARP_MurderMod/scripting/ARP_MurderMod.sma`. 3 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_murder_deathmsg` | `1` | (no description yet) |
| `arp_murder_showattacker` | `1` | (no description yet) |
| `arp_murder_time` | `60.0` | (no description yet) |

#### ARP_RadioMod

`apollo-rp/extra/ARP_RadioMod/scripting/ARP_RadioMod.sma`. Config: `arp.cfg`. 4 cvars.

| Cvar | Default | What it does |
|---|---|---|
| `arp_capscom` | `1` | Whether COM APPEARS IN CAPS IN CHAT or if it retains how the person typed it out |
| `arp_message_lol` | `0` | Whether or not to replace "lol", "rofl" and other chat with "haha" This only works when arp_printmode is set to 2 |
| `arp_printmode` | `1` | Print mode 0 - no standard chat 1 - normal print mode, i.e. 'Hawk: this is a sample message' 2 - extra print mode, i.e. 'Hawk says, "This is a sample message."' |
| `arp_radio_channels` | `10` | (no description yet) |

