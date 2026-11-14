===============================================================================
PATCHED RCBOT  --  The Specialists team support + follow command
===============================================================================

Built from APGRoboCop/rcbotold at tag v1.51b13 -- the SAME version that shipped
with this install -- with additive changes:
  1. Team fix: compare pev->team instead of model strings
  2. Follow command: "rcbot follow <bot_index> <player_index>" makes bots follow
     a player using the native squad system (attacks enemies while following)
  3. TS weapon-learning crash fix: a save/load size mismatch left empty weapon-
     choice individuals in the population; a bot picking one crashed the server
     (see CHANGE 5)
  4. Waypoints and doors: 4096 waypoints a map, a visibility file that does not
     depend on that number, and TS breakable doors shot down when they stand in
     a bot's way (see CHANGE 6)
  5. Sentry turrets: the other side's .turret is an enemy, one's own never is
     (see CHANGE 7)
  6. Roaming citizens: while tsrp_roambots.sma runs a roleplay map's citizens,
     every bot walks between random waypoints, pauses now and then, fights only
     whoever hurt it (and, in an insurgency, the players), and is moved on when
     it gets nowhere; and waypoints reach +/-16384 across the map (see CHANGE 8)
  7. Player slots: every bot and client table covers 128 slots, so a server past
     32 players runs bots in every slot (see CHANGE 9)
  8. Powerups: while ts_matchmode's match mode is on, tsm_bot_powerups 0 keeps
     every bot off TS's powerups, whatever nopowerup says (see CHANGE 10)
  9. Objective play: while ts_matchmode's tsm_bot_objectives is 1 on a map that ts_assault,
     ts_uplink or ts_ctf runs, the bots go to the capture points, fetch and carry the uplink
     and the flags, escort their side's carrier and hunt the other side's (see CHANGE 11)
 10. Stock capture game: on a ctb_ or ctf_ map (TS's own briefcase game) where no match mode runs, and
     tsm_bot_stockobjectives is not 0, the bots fetch the other side's briefcase, carry it to their own
     base, bring their own back, escort the carrier, guard their base and hunt the other side's carrier,
     and know their own side from the other (see CHANGE 12)
 11. Mech weapons: a bot that carries the M60 and the Mech rocket launcher (weapon 41) alternates between
     them in a fight -- the launcher for a far target in clear sight of a rocket, or a group, the M60 for
     a near one and for an emptied launcher -- and aims and fires the launcher itself: one press, at the
     target's feet, led. Weapons 37 to 63, H9's 39 to 41 among them, have a place in the weapon tables
     (stock rcbot writes a bot's weapon 41 past the end of its table; see CHANGE 13)
 12. Teams in an insurgency: with the teams in use an insurgent roamer's enemies are every player and
     every bot that is not on its own team, and never one that is; a client with no team yet is nobody's
     (RoamIsEnemy compares team fields: tsrp_roambots puts every citizen on the Insurrection team, 2,
     while an insurgency lasts, and Apollo RP's ARP_TS puts a player on the team of his job); its
     attacker stays an enemy whatever team he is on (see CHANGE 14)

Win32, MetaMod Release, MSVC v145.

Drop over  <Half-Life>\rcbot\dlls\rcbot_mm.dll .
The stock build is kept beside it as rcbot_mm.dll.stock, so one copy reverts.


===============================================================================
CHANGE 1: TEAM FIX
===============================================================================

    CBot::IsEnemy, bot.cpp, case MOD_TS

        return std::strcmp(model1, model2) != 0;

For The Specialists, rcbot decides whether two players are on the same side by
comparing their PLAYER MODEL STRINGS. They count as teammates only if they are
wearing the identical model.

mp_teammodels takes a LIST of models per team, so more than one model on a side
is the normal case -- and every pair of teammates in different models therefore
reads as an enemy. A class system that gives each class its own model makes it
total.

No cvar, waypoint or server-plugin workaround can reach this. It is a decision
made inside the bot.

One block, inserted in IsEnemy ahead of the existing model comparison:

    if (pev->team > 0 && pEntity->v.team > 0)
        return pev->team != pEntity->v.team;

pev->team is the engine's own team field. Stock TS leaves it at 0 for everyone,
so on a stock server this is skipped and behaviour is unchanged. The
ts_matchmode plugin sets it, so here it is simply correct.

It logs its first 20 decisions to the server log:

    [RCBOT TS] team check: me=1 him=1 -> TEAMMATE

so it can be confirmed working -- or its absence confirmed -- without guessing.


===============================================================================
CHANGE 2: RESPECT nopowerup, DROP A COMPLETELY DRY WEAPON
===============================================================================

Already present in the patch and in every built rcbot_mm.dll shipped alongside this
README -- documented here now because it had never been written up.

    CBot::EnemyFound, bot.cpp, case MOD_TS
    CBot::CanPickup, bot.cpp

Bots called "usepowerup" on sighting an enemy, and treated every ts_powerup pickup
as fair game, regardless of the server's own nopowerup cvar. A server that had
turned powerups off still had its bots using and collecting them -- nothing on the
server side can stop that, because a fake client sends no client commands for a
plugin to intercept. Both paths now check CVAR_GET_FLOAT("nopowerup") first.
CHANGE 10 puts both behind one test, BotPowerupsAllowed(), which reads
ts_matchmode's tsm_bot_powerups as well.

    CBot::Think, bot.cpp

CanReload() for TS is !m_iClip && *m_iAmmo1 > 0, so a weapon with an empty clip AND
an empty reserve is OutOfAmmo() and cannot be reloaded. Stock rcbot had no answer
for that state: it kept the empty weapon selected and kept pulling the trigger,
which is why a bot would stand in place doing nothing with a dry gun raised.
Think() now drops a weapon in exactly that state (rate-limited per bot, 3 seconds),
so the game hands the bot its next weapon -- bare hands, worst case, which is still
a weapon.


===============================================================================
CHANGE 3: FOLLOW COMMAND
===============================================================================

New function: CBot::SetFollowTarget(edict_t* pTarget)
- Called by plugin or console command to make a bot follow a specific player
- Uses existing BOT_TASK_FOLLOW_LEADER task and squad system
- Bot attacks enemies while staying in formation with leader
- pTarget = nullptr clears follow target, bot returns to normal patrol

New console command: rcbot follow <bot_index> <player_index>
- bot_index: entity index of the bot (must be a fake client)
- player_index: entity index of player to follow (0 = unfollow)
- Plugin calls this via FakeClientCommand when officer types .follow/.unfollow

When following: bot stays with leader, attacks enemies in range, uses squad
formation. When unfollowing: bot leaves squad, clears follow task, returns to
normal patrol/waypoint behavior.


===============================================================================
CHANGE 4: CLOAK AWARENESS
===============================================================================

    CBot::IsEnemy, bot.cpp, case MOD_TS

        if (pEntity->v.rendercolor == Vector(40, 120, 255))
            return false;

Recon's .cloak (ts_matchmode.sma, set_cloak()) is a shimmer, not a vanish -- the
player stays drawn at very low opacity rather than going EF_NODRAW, so the generic
"can't see it" check already in IsEnemy() never catches a cloaked player, and bots
engaged them exactly as if they were standing in the open.

rendercolor is the signature: it is the one render field that plugin sets to this
exact blue only while cloaked, and to nothing else -- not shared with spectating,
warmup-hold, or any of the glow effects (medic heal, stim, engineer ammo), which
use red, white and yellow respectively and never touch rendercolor otherwise.
rendermode/renderamt were deliberately not used for this check: both are shared
with other hidden states in the same plugin and would misfire on those too.

Checked as the FIRST thing inside the FL_CLIENT block, ahead of the team
comparison just below it. Order matters: for an enemy-team cloaked player, the
team check alone would already return true before a later-placed cloak check
could ever run, so this has to come first to work in both the enemy-team and
same-team case.

While an Officer's .scan exposes a cloaked player, ts_matchmode writes his
rendercolor black instead, so for those seconds this check lets bots engage him.

Like Change 1, this is a plain pev-field read with no AMXX-module callback and no
dependency on any plugin cvar or array -- the plugin was already writing this
field for its own cosmetic purposes; this just reads it.

IsEnemy() is called from FindEnemy() (new-target acquisition) and roughly fifteen
other sites across the file, including the per-think target-revalidation inside
an active attack task -- so a bot that is mid-fight when its target cloaks drops
the attack on the very next think, the same as it would for a target that died or
disconnected. No other call site needs separate handling.


===============================================================================
CHANGE 5: TSWEAPS LEARNED-DATA CRASH (CBotGAValues::get on an empty vector)
===============================================================================

Crash: access violation, code C0000005, reported by the engine's own crash box as
"CBaseEntity::SUB_CallUseToggle" (rcbot_mm.dll) -- that symbol has nothing to do
with it. The crash box only has exported symbols to work from, and the real crash
site has none nearby; mapped against the DLL's own load base, the four frames are
actually: the bots' frame loop -> CBot::Think -> the TS weapon choice
(m_pTSWeaponSelect->get(i)) -> CBotGAValues::get indexing an EMPTY vector. Not
caused by any map or its waypoints -- it can happen on any map, some rounds into
whichever map is the second one played or later.

Root cause: a save/load size mismatch in the TS weapon-learning data.
SeedTSWeaponSelectValues saves each bot's learned weapon choice with 8 values
(header t-3-s-8), but CBotGlobals::loadLearnedData loads expecting 16
(m_TSWeaponChoices.load(bfp, 16)) -- every individual fails its header check and
comes back empty, CPopulation::load still adds the empty ones to the population
instead of dropping them, and once the population (16) is full of them, the next
bot that picks its guns from an empty individual reads index 0 of an empty vector.
Deleting rcbot/tsweaps.rld does not fix it -- the next map saves a fresh one with
8 values and the map after that loads it empty again.

Three changes, rcbot-tsweaps-crash.patch:
  - globals.cpp: loadLearnedData loads with size 8, the size they are saved with.
  - ga.cpp: CPopulation::load drops an individual that came back with no values,
    instead of adding it to the population.
  - bot.cpp: CBot::Think re-seeds a picked weapon choice that has fewer than 8
    values (covers any tsweaps.rld already on disk from before this fix, which
    still loads empty under the corrected size check).

Workaround without rebuilding: make rcbot/tsweaps.rld an empty, read-only file.
RCBot then loads nothing from it and cannot save to it, so weapon learning only
lives in memory for that server run.

Rebuilt successfully (MSBuild, 0 errors) against pinned upstream v1.51b13.
Getting there also required fixing the existing follow-command patch (CHANGE 3),
which had never actually compiled standalone. Those fixes are
rcbot-build-fixes.patch (third in the REBUILDING chain): the follow command's
prototypes in bot.h, CBotGlobals::GetBot, the CBotSquads::createSquad stub,
RemoveSimilarTask, the weapon choice re-seeded in place, returnVector()->size().


===============================================================================
CHANGE 6: WAYPOINTS AND DOORS (rcbot-waypoints-doors.patch)
===============================================================================

    MAX_WAYPOINTS, bot_const.h                  1024 -> 4096
    WaypointLoad, waypoint.cpp                  a file over MAX_WAYPOINTS is refused

h9_tsrp_hive is three cities stacked in one map, joined by teleport portals. One
waypoint set over all three needs far more than 1024 waypoints: SMAK's walker,
which makes them, cannot fit even one big city under 1024 without spacing them
1000 units apart. WaypointLoad read a file's count of records into the array
unchecked, so a longer file wrote past its end; it is refused now instead.

    CWaypointVisibilityTable::SaveToFile/ReadFromFile, waypoint.cpp

The table in memory is MAX_WAYPOINTS bits wide per row. The .rcv file held its
first num*num bits -- every row past num*num/MAX_WAYPOINTS was lost -- and any
other MAX_WAYPOINTS would misread every .rcv already on disk. The file is now
visibility/<mod>/<map>.rcv2, the table packed num x num, row by row: it does not
depend on MAX_WAYPOINTS, and an old .rcv is never read. Each map works its table
out once more on its first load. The load also cleared 4 bytes of the table
(sizeof an int) instead of all of it; it clears the table.

    CWaypointVisibilityTable::WorkOutVisibilityTable, waypoint.cpp

Pairs of waypoints farther apart than BOT_VIEW_DISTANCE (2048) are not traced:
a bot sees nothing past that, and the cities of a big map are thousands of units
apart, so most pairs cost nothing on the first load.

    the see-waypoint check in CBot::Think, CBot::FindEnemy, CBot::IsEnemy,
    EntityIsAlive -- bot.cpp; m_pBlockingDoor/m_fBlockingDoorTime, bot.h

A TS func_door with a "maxdamage" key takes damage (TS gives it DAMAGE_YES) and
shatters; in the TSRP cities most doors are named and nothing ever opens them.
rcbot walked into a door on its path waiting for it to open. Now, in TS, a door
that takes damage and that the line to the bot's next waypoint meets within
BLOCKING_DOOR_REACH (96) is remembered for BLOCKING_DOOR_MEMORY (2 s); IsEnemy
takes it as a target while it stands, and FindEnemy gives it a func_breakable's
priority (5) and falls back to it when the visibles scan lists nothing better.
The bot shoots it down and walks on. EntityIsAlive counts such a door standing
until TS shatters it (DEAD_DEAD, DAMAGE_NO): a door's damage is never in health.


===============================================================================
CHANGE 7: SENTRY TURRETS (rcbot-ts-turrets.patch)
===============================================================================

    CBot::IsEnemy, bot.cpp, case MOD_TS, the branch for what is not a player

ts_matchmode.sma's Combat Engineer stands a sentry turret with .turret: a
func_breakable the plugin makes, renamed to the classname "turret" (TS names a
kill by its inflictor's classname) and stamped with its side in pev->team, as
the plugin stamps every player.

Stock rcbot knew no turret. While it was still called func_breakable, the
breakable rule took it -- shoot one whenever any player stands within 200 units
of it, whichever side -- so a bot shot its own side's turret and passed the
other side's by. Renamed, nothing took it at all.

One block, ahead of the breakable rule:

    if (std::strcmp(szClassname, "turret") == 0)
        return pev->team > 0 && pEntity->v.team > 0 && pev->team != pEntity->v.team;

The checks at the top of IsEnemy still come first: a turret the plugin has
destroyed (DAMAGE_NO) or that is not drawn is no target. FindEnemy gives it the
default priority, 10, the same as a player, and picks the nearer of the two.


===============================================================================
CHANGE 8: ROAMING CITIZENS AND BIG-WORLD WAYPOINTS (rcbot-ts-roam.patch)
===============================================================================

    the waypoint location table, waypoint.h and waypoint.cpp

RCBot finds the waypoints near a point through a table of 256-unit buckets. Stock,
it covered -4096..+4096 on each axis, and WaypointLoad deleted any waypoint with
an x, y or z over +4096 (one under -4096 landed in a mirrored bucket by accident).
H9's big-world maps reach past that (engine-h9-bigworld): h9_tsrp_newbyzantium's
streets run to about +/-5000. The table now covers +/-WPT_LOC_REACH_XY (16384)
across the map and keeps +/-4096 up and down (WPT_LOC_REACH_Z), 128 x 128 x 32
buckets (2 MB); CWaypointLocations::bucketOf keeps every index inside it, and a
waypoint past either reach is not loaded. Inside +/-4096 the buckets are the same
ones as before, so no other map's waypoints behave differently.

    roam mode, bot.cpp (ROAMING CITIZENS, over CBot::IsRoamer) and bot.h

tsrp_roambots.sma puts citizens on a roleplay map: bots that walk the public
streets at a walk, fight only when they have to, and look like people. While it
runs them it holds the server cvar tsrp_roambots_active at 1 -- 0 at any other
time, and on every other map -- and then every bot is a roamer. Read once a
second, with:

    tsrp_roambots_speed    the walk in units a second; 120 is the TS client's walk
                           key (cl_movespeedkey 0.3 x cl_forwardspeed 400, from
                           cl_dlls\client.dll; the client sends no extra button)
    tsrp_roambots_weapons  0: no weapons are made for a roamer; 1: armed as usual
    tsrp_roambots_pause    percent chance of a pause before each walk
    tsrp_roambots_defend   1: a roamer someone hurts fights that one back
    tsrp_roambots_defend_time     seconds it goes on without being hurt again
                                  before it lets him be (30 without the cvar)
    tsrp_roambots_insurgency      1: the citizens are insurgents, set on players
    tsrp_roambots_insurgent_team  0: every player who is not a bot; a team
                                  number: only the players of that team

A cvar that does not exist reads 0, so without the plugin there are no roamers
and nothing here changes how any bot plays.

A roamer:
  - LookForNewTasks: does nothing else at all. RoamLookForNewTasks gives it, now
    and then (tsrp_roambots_pause), a BOT_TASK_WAIT_AND_FACE_VECTOR of 3 to 10
    seconds looking one way at eye height, then a BOT_TASK_FIND_PATH to
    RoamGoal(): a random waypoint 512 to 3072 units away (any distance when 64
    tries find none), never a ladder, lift, jump, crouch, teleport or other
    special waypoint, never one it failed to reach. No pickups, objectives,
    buttons or chargers. Where it may walk is the map's waypoints: a roleplay
    map's roam waypoints are laid only in its public streets and halls
    (export-map\h9_tsrp_newbyzantium\roamwaypoints.mjs).
  - IsEnemy (RoamIsEnemy) is true only for its attacker -- and, in an
    insurgency, for the players tsrp_roambots_insurgent_team names -- and
    WantToFindEnemy only while it has one of those, so a TS breakable door in
    its way is never shot (CHANGE 6 takes a door through IsEnemy).
  - Its attacker. TS sends no Damage message (reTS player.cpp, UpdateClientData),
    so RCBot's hurt event never names anyone; TS's TakeDamage leaves what hurt a
    player in pev->dmg_inflictor (reTS combat.cpp). A roamer hurt since the last
    frame (RoamThink) takes the player behind it -- the entity, or the player
    who owns a grenade or a thrown blade -- for its attacker, turns to him,
    wields its fists ("weapon_0", TS's weapon-select command for its hands)
    and fights with them, whatever it carries. It forgets him once he is
    dead (the life he comes back to did nothing to it), once he has left,
    and once he has not hurt it for tsrp_roambots_defend_time seconds; its
    own next life starts with no attacker (SpawnInit). Another bot, the
    world or itself is no attacker, so one fight starts no brawl.
    tsrp_roambots_defend 0: none.
  - Getting anywhere (RoamCheckProgress). Progress is distance, not speed: 64
    units from where it last got to. A pause, a wait, a fight or the plugin's
    hold is no lack of it. After 5 seconds without progress it gives its goal
    up (30 seconds among its failed goals) and the way it was walking; after 12
    it asks tsrp_roambots.sma to move it with the server command
    "tsrp_roambots_unstick <entity index>", again every 2 seconds until it has
    got somewhere. A move of more than 256 units in one frame (a portal, the
    plugin's placement) forgets the way it was walking. CheckStuck never kills
    a roamer for standing still.
  - The plugin's hold: with FL_FROZEN (two citizens stopped to talk) a roamer
    stands, presses nothing, and Think goes no further that frame, so its
    view stays as the plugin set it.
  - RunPlayerMove: the next frame's move is worked out from the walk, and this
    one's forward and side moves together are held to it, whatever set them (the
    unstuck code strafes at full speed); a roamer that fights runs. While alive
    it never jumps, ducks, stunts or uses, fires only while it fights and
    reloads only as an insurgent. The stuck check compares its speed with the
    walk, so walking is not taken for being stuck.
  - Buys nothing on death; is made weapons at spawn only with
    tsrp_roambots_weapons 1; and its life is kept out of the TS weapon learning
    (tsweaps.rld), which its weapons have no part in.
  - Respawns as TS respawns it ("respawn", the attack presses while dead): the
    plugin moves it after it is back on its feet, never while it is dying.


===============================================================================
CHANGE 9: PLAYER SLOTS (rcbot-ts-slots.patch)
===============================================================================

    MAX_PLAYERS, bot_const.h

Every client and bot table is sized by it (bot.h: CBotGlobals::m_Clients,
m_Bots, m_iJoiningClients), and every look-up by edict index is bounded by it
(GetBot, GetClientByIndex, ClientConnected), so a bot or player in a slot past it
is only half known to RCBot. It is 128, the slot count H9's game DLLs, Metamod and
AMX Mod X are built for.

    CBotGlobals' addbot, bot_commands.cpp

addbot tests the free bot slot against MAX_PLAYERS; upstream's literal 32 there
refuses the 33rd bot whatever the tables hold.

    the dry-weapon drop, bot.cpp (CHANGE 2)

Its per-bot clock, a table by edict index, holds MAX_PLAYERS + 1 entries.

The bot quota is the server's: "rcbot config max_bots" in rcbot\bot_config.ini.
On a server of 32 slots or fewer nothing here changes how any bot plays.


===============================================================================
CHANGE 10: POWERUPS (rcbot-ts-powerups.patch)
===============================================================================

    BotPowerupsAllowed, bot.cpp (beside the roam settings, over CBot)
    CBot::EnemyFound and CBot::CanPickup, bot.cpp, case MOD_TS

A TS bot uses powerups two ways: it walks to a ts_powerup it can see
(CanPickup), and it sends "usepowerup" on sighting an enemy (EnemyFound), which
sets off a powerup it carries. CHANGE 2 held both to the server's nopowerup. A
server that gives powerups to its players -- nopowerup 0 -- could not keep them
from its bots, and no plugin can: a fake client sends no client commands, and the
walk to a pickup is the bot's own decision.

Both now ask BotPowerupsAllowed(), read once a second:

    nopowerup <= 0, and not (tsm_enabled > 0 and tsm_bot_powerups <= 0)

tsm_bot_powerups belongs to ts_matchmode.sma (default 0, so the bots are off
powerups unless a server sets 1), and it counts only while the plugin's match
mode is on, as its other tsm_ settings do: on a map TS plays as it ships
(tsm_enabled 0) the bots take powerups as nopowerup lets them. A cvar that
does not exist holds no bot back, so without the plugin this is CHANGE 2's
nopowerup test alone.

A powerup the plugin itself grants -- the Officer's kung fu, what a mode hands
out -- is no pickup and needs no usepowerup, so nothing here touches it: the
plugin holds those back itself, and grants a bot none under tsm_bot_powerups 0.
It also refuses a bot's touch of a ts_powerup under tsm_bot_powerups 0, for a
bot that walks over one on its way somewhere else.


===============================================================================
CHANGE 11: OBJECTIVE PLAY (rcbot-ts-objectives.patch)
===============================================================================

    BOT OBJECTIVES, bot.cpp (over CBot::ObjPlay); dlls\bot_objective.h; BOT_TASK_TS_OBJECTIVE, bot_const.h

H9's mode plugins publish their objectives on their own entities (include\tsm_botobj.inc,
docs\BOT_OBJECTIVES.txt): ts_assault the rings of its capture points, ts_uplink the rings of its
zones and the uplink, ts_ctf its flags. rcbot reads them straight from the entities once a second
and gives its bots something to do with them. All of it is MOD_TS, and a cvar or a plugin that does
not exist leaves every bot as it was.

    tsm_enabled          0: nothing here
    tsm_bot_objectives   1: the bots play the objectives (plugin-owned, default 1). Absent, as with a
                         plugin that does not publish: 0
    tsm_pres_mode        "assault", "uplink" or "ctf": which mode the entities named tsm_cap belong to
    tsm_cf_pad_radius    how near its pad a flag carrier must be (72)

What is read (the plugins write it; nothing is written on a player):
    tsm_cap      team (holder), fuser1 (radius), iuser1 (number), iuser2 (state: 0 quiet, 1 being
                 taken, 2 contested, 3 not in play), iuser3 (the side taking it), fuser2 (progress),
                 fuser3 (reach above and below), vuser1 (x, y: players of side 1 and 2 inside)
    tsm_uplink   aiment (carrier), iuser2 (1 post, 2 carried, 3 dropped), fuser2 (seconds before it
                 flies home, -1 none)
    tsm_flag     team (whose), iuser1 (0 pad, 1 carried, 2 dropped), aiment (carrier), iuser2 (its
                 carrier would score now), fuser2 (seconds before it flies home), vuser1 (its pad)

The posts (dlls\bot_objective.h, namespace objplan, a pure function with its own tests in
rcbot-patch\test\test_bot_objective.cpp): per side, a carrier carries; a bot with an enemy keeps what
it has; a quarter of the side (25 percent, none for fewer than 4) is left to fight and roam as
before; the rest are given the cheapest post that asks for someone, the walk less a priority, with a
bonus for the post a bot has and at most 4 bots of a side changing post in a second (all of them
in the first plan of a round).
    Assault   TAKE a point not held (2 bots, 3 if the other side holds it, one more with an enemy
              inside; the players already in it count; none more when it is a quarter from taken
              with nobody against), RETAKE one of the side's own that the other side wears down
              (priority up to 3 as it nears lost), HOLD the quiet one nearest the front
    Uplink    FETCH the uplink at its post or dropped (2 bots a side, not when it flies home in
              under 3 s); the carrier CARRYs it to the cheapest zone the side does not hold (the
              walk, 1500 for each enemy inside, 400 while the plugin says it is denied there, kept
              unless another is 400 better); 3 ESCORT it, a person's as well; 1 CLEARs the zone it
              heads for; the other side's 3 HUNT the carrier
    Flag      FETCH the enemy flag (2), CARRY it to the side's pad, 2 ESCORT the carrier, 2 GUARD
              the side's own flag at its pad, RETURN it when dropped (1, the nearest), 3 HUNT the
              other side's carrier of it

The task. A bot with a post is given BOT_TASK_TS_OBJECTIVE (CBot::ObjLookForNewTasks, in
LookForNewTasks's TS case after the weapon pickup, ahead of the stock objective code). ObjRunTask
keeps no phase: every think it takes the plan's post for the bot and works out from where the bot
stands. It asks for a FIND_PATH to a waypoint of the objective (the ring's waypoints within 0.6 of
its radius, spread over the bots; the nearest one in sight otherwise, the last stretch walked
straight), walks straight to its mark within 160 units or at its goal waypoint, stands at the mark
(a ring, a pad: it looks around and walks to another waypoint of the ring every 8 to 14 s), follows
a carrier (an escort stays within 250, a hunter closes to 64). A fight pre-empts it (the stock
NORMAL_ATTACK goes in front) and it resumes. A bot walking one of the stock paths and given a post
leaves the path for it (ObjUpkeep, once a second). A bot that gets nowhere in 5 s walking straight,
or whose path fails, gives the objective up for 25 s. A carrier on its way looks for no fight and
follows no enemy (WantToFindEnemy, WantToFollowEnemy) until it is hurt (1.5 s) or arrives.
    Not touched: the stock TS objective code and m_TSObjectives (siege maps), CHANGE 3's squads (a
    bot of a squad plays no objective), CHANGE 8's citizens, the fight, the path finder.
    Log: "[RCBOT OBJ] objective play is on/off" and the first 60 posts.

Not covered here: TS's own capture game (the ctf_ and ctb_ maps, the briefcase). No H9 plugin runs there
(tsm_enabled 0) and nothing is published: see CHANGE 12.


===============================================================================
CHANGE 12: TS'S OWN CAPTURE GAME (rcbot-ts-briefcase.patch)
===============================================================================

    STOCK CAPTURE GAME, bot.cpp (over CBot::ObjSide); dlls\bot_briefcase.h; BotClient_TS_Flag and BotClient_TS_ScoreInfo,
    bot_client.cpp; CBotGlobals::KeyValue and MapInit, globals.cpp; ClientConnect and ClientDisconnect, dll.cpp;
    Bot::canTake and Obj::padReach, dlls\bot_objective.h

TS plays a capture game of its own on a map named ctb_ or ctf_ (ctb_deadheat): two ts_briefcase bases, one for each of two
teams, and a flag, the briefcase, that a team takes from the other's base and carries to its own. The match mode stays out of
those maps (tsm_enabled 0), so no plugin publishes anything, and the game DLL keeps a flag's state in its own private members.
What reaches a bot, and what rcbot reads:

    ts_briefcase   a base, an invisible brush: its box, and its team from the map's key ownerteam, which rcbot takes from
                   the map as it loads (CBotGlobals::KeyValue: nothing of it reaches an entity afterwards)
    ts_flag        a flag that lies loose, at its base or dropped: rendercolor is its team's glow (125 165 210, the first
                   team; 200 90 70, the second). A flag that is carried is no entity
    TSFlag         the user message: 0 a base seeded its flag, 1 it was taken, 2 it was dropped; the flag's id; its team
                   number; the carrier's edict index. A capture and a return send none of their own: the base seeds the
                   flag again, and that says 0 (BotClient_TS_Flag, on the MSG_ALL list that DelObj is on)
    ScoreInfo      the user message that gives each player's team number, to everyone (BotClient_TS_ScoreInfo): the
                   index of his team in the map's team list, plus one, which is also what ownerteam and TSFlag count

For a map of two teams the team numbers are 1 and 2, and they are the sides objplan::plan takes. Nothing stamps pev->team in this
game (the game never writes it), so a bot's side is the number ScoreInfo gave it (ObjSideOf), forgotten when its slot is
connected or disconnected (ClientConnect, ClientDisconnect) and when the map changes (MapInit).

The game is played (BriefRefresh, once a second, in front of CHANGE 11's own reading) when all of these hold:

    tsm_enabled              0, or the cvar does not exist: no match mode runs the map. Above 0 the plugins' entities are
                             read as CHANGE 11 reads them, and a ts_briefcase is left alone
    tsm_bot_stockobjectives  not 0. Default 1: ts_matchmode registers it with 1 (beside tsm_bot_powerups), rcbot reads it
                             and nothing else does, and a server without the plugin has none, which plays. 0: the bots
                             are stock rcbot again, in everything below
    tsrp_roambots_active     0: roleplay citizens walk, whatever else is on the map
    the map                  has exactly two ts_briefcase entities, one with ownerteam 1 and one with ownerteam 2. A neutral
                             base, two for a team or a third team is not played, and the server log says why once
                             ("[RCBOT BRIEF] 3 briefcase(s), owners 1 2 0: only one base for each of two teams is played")

Then every bot of the two sides has the posts of H9's flags (CHANGE 11, "Flag"), with CHANGE 11's restraint: a quarter of a
side (none of fewer than 4) is left to fight and roam, a bot with an enemy keeps what it has, a bot of a squad, a roamer or a
frozen one has none, at most 4 bots of a side change post in a second (all of them in the first plan of a map), and a post
that gets nowhere in 5 seconds is given up for 25. The posts:

    FETCH   the two nearest bots of a side walk onto the other team's flag where it lies at its base or dropped (not when it
            goes home in under 3 seconds: a dropped flag lies 20 seconds, counted from its TSFlag message)
    CARRY   the bot that has taken it walks onto the middle of its own side's base and stands there. The brush scores by
            touch, and only while the carrier's own flag lies at its base (CTSBriefcase::CaptureTouch); with it away the
            carrier waits at the base, as a person does, and the RETURN and HUNT posts below get it back
    ESCORT  two bots stay with their side's carrier, a person as well as a bot
    GUARD   two bots stand near their own flag at its base
    RETURN  the nearest bot walks onto its own flag when dropped; touching one's own dropped flag sends it home, and gives
            the returner 5 frags
    HUNT    three bots go after the carrier of their own flag

A bot is sent to take a flag only if it can: TS lets a player take one only with 20 free inventory slots
(CBasePlayer::TakeFlag), and sets his speed by the slots he has left, 210 + 120 * free / 81 cut to a whole number, so a bot
whose maxspeed is between 200 and 238 is too heavy and is never given a FETCH (brief::canTakeFlag; Bot::canTake in the
planner). It may still return its own flag, escort and guard. A bot cannot drop what it carries: a fake client sends no client
command, so a flag is let go only by dying.

A side to play for is also a side to shoot at: where the game stamps no pev->team, stock rcbot takes every player for an enemy
(it tells teammates by their model, and only on a map it knows to be teamplay), so on a ctb_ map a bot hunted its own team. While
the game is played, IsEnemy asks BriefEnemies first: two players are enemies when their team numbers differ, and the stock rule
decides where either is not known.

Files and functions:

    dlls\bot_briefcase.h   (new, no engine) the state the messages add up to (brief::Tracker: flags by team, team numbers by
                           slot, the ownerteam keys of the map), and the rules: layoutSupported, teamOfColor, padReach,
                           atBase, canTakeFlag, flagNow. Tested by rcbot-patch\test\test_bot_briefcase.cpp
    dlls\bot_objective.h   Obj::padReach (how near its pad counts as at it, 0 for tsm_cf_pad_radius's), Bot::canTake, the
                           FETCH of a flag skips a bot that cannot take it, padFor (see below)
    bot.cpp                ObjFindBases (the bases, once a map, again every 10 s while the map shows none), ObjAddBriefFlag
                           (a team's flag as a row), BriefRefresh, BriefEnemies, ObjSideOf and CBot::ObjSide (the four
                           places CHANGE 11 compared pev->team with a side), ObjItemEdict (ts_flag for a stock row)
    bot_client.cpp/.h      the TSFlag and ScoreInfo handlers (MSG_ALL, MOD_TS)
    globals.cpp, dll.cpp   the ownerteam key, the reset at MapInit, the slot forgotten at connect and disconnect

Log: "[RCBOT BRIEF] capture game: base of team 1 at x y z, of team 2 at ..." (z is the floor under the middle of the brush),
"[RCBOT OBJ] objective play is on: TS's capture game, 2 flag(s) read", and, on a map with briefcases, the first 40 messages
("[RCBOT BRIEF] TSFlag: action 1, flag 3, team 2, carrier 5" and "[RCBOT BRIEF] ScoreInfo: player 5 is on team 1"), and once a map
for a side of which half the bots are too heavy to take a flag ("[RCBOT BRIEF] side 1: 3 of 4 bots carry too much to take a flag ...").

Fixed in CHANGE 11: the carrier of a flag walked to the pad of the flag it carried, which is the pad the flag came from, the
other side's. A flag's published pad is its own (tsm_flag vuser1, ts_ctf.sma flag_publish), and the carrier of side f's flag is
of side 3 - f and scores at pad 3 - f (carried_tick). objplan::padFor takes the pad of the flag that the carrier's side owns, and
CARRY uses it for both games.

Not touched: CHANGE 11's reading of tsm_cap, tsm_uplink and tsm_flag, its task and its walk, the stock TS objective code, the
squads, the citizens, the fight. A map with no ts_briefcase, or with tsm_bot_stockobjectives 0, or running the match mode, is
exactly CHANGE 11.

Needs a waypoint file for the map: rcbot paths by waypoint (ctb_deadheat.rcw has flag-position waypoints at both bases), and
ts_matchmode.amxx's tsm_briefcase_bots, or a tsm_bots line in the map's mapconfig, to put bots on the map at all.


===============================================================================
CHANGE 13: THE MECH'S TWO WEAPONS (rcbot-ts-mech.patch)
===============================================================================

    MECH WEAPONS, bot.cpp (over CBot::MechPlay); dlls\bot_mech.h; BotClient_TS_WStatus, BotClient_TS_WeaponInfo and
    BotClient_TS_ResetHUD, bot_client.cpp; GetAimVector and PrimaryAttack, bot.cpp; MAX_WEAPONS, cdll_dll.h; CBotWeapons,
    bot_weapons.h and .cpp; BOT_DEBUG_MECH_LEVEL, bot_const.h; the "mech" level of rcbot debug, bot_commands.cpp and .h

A Mech (class 9 of ts_matchmode; every bot of Mech Warrior plays one) carries two weapons: the M60 (TS weapon 32, which a Mech
sees as a minigun) and the Mech rocket launcher (H9's weapon 41, reTS ts_mechrocket.cpp): one press of the trigger launches a
salvo of rockets (h9_mechrocket_salvo of them, 4, h9_mechrocket_stagger, 0.12 s, apart; the clip holds 4), and the launcher then
waits h9_mechrocket_rate (1.5 s) from the salvo's last rocket. Stock rcbot chooses no weapon in a TS fight. Its attack code
presses the trigger on whatever the game put in the bot's hand, which for a Mech is the M60, and it never takes the launcher out.
A bot that holds both now alternates between them, and fires the launcher itself.

What the bot knows. Only what the game's own user messages tell it, so no plugin is needed:

    WStatus     (type, owned, clip)         whenever the player starts or stops owning a weapon type
    WeaponInfo  (type, clip, reserve, ...)  when the wielded type, or its caliber's reserve, changes
    ResetHUD                                at every respawn; the weapons of the new life are announced again right after it

ClipInfo is registered by the game library and never sent, so the launcher's clip is worked out from what the bot did (a pull
takes a salvo out of it) and corrected by every WeaponInfo while the launcher is in hand. A bot is a Mech when it owns weapons 32
and 41 (mech::State, dlls\bot_mech.h). pev->fuser4, which the plugin sets on a Mech, is not used. SpawnInit and ResetHUD forget
all of it, and a new map's clock starts it again (State::fixClocks).

Changing weapon. TS wields a weapon on the client command "weapon_<type>" (TSSelectWeaponType; a type the player owns); the
usercmd weaponselect that RCBot's SwitchWeapon sends is ignored by the game library. The bot sends "weapon_32" or "weapon_41"
with FakeClientCommand, as CHANGE 8 sends "weapon_0", and waits for the WeaponInfo of that type. A command the game never answers
in 1.5 seconds was refused: the launcher is then left alone for 20 seconds, and an M60 that cannot be selected is no longer
counted as owned. The game reloads a dry clip only while that weapon is in hand, and a switch throws a reload away
(CTSGun::HolsterWeapon); that shapes the rule below.

The rule. mech::decide, ten times a second while the bot lives and is a Mech (tested by rcbot-patch\test\test_bot_mech.cpp, which
also plays the bot against a model of the game's launcher). "Pull line" is tsm_bot_mech_near (400 units), raised to 1.4 times the
blast radius when h9_mechrocket_selfdamage is 1, and lowered to 0.7 of it (not under 256) for a group: the target and another enemy
within a blast of him. "Far" is 1.35 pull lines.

    in hand       situation                                                              answer
    -----------   --------------------------------------------------------------------   ----------------------------------
    -             the bot holds only one of the two, or is a roaming citizen, or         stock play, nothing here runs
                  tsm_bot_mech_rocket 0 or h9_mechrocket 0                               (a launcher that is out goes away)
    either        a select command is in flight                                          keep
    launcher      a salvo is leaving (the gaps of the salvo, h9_mechrocket_stagger       keep
                  apiece, and 0.35 s: 0.71 s for four rockets 0.12 s apart)
    M60           target far, a player or a turret, a rocket flies the line to him,      launcher
                  and it has been so for 0.5 s; launcher loaded (or clip not known)     (after the dwell)
                  and not refused
    M60           anything else, the launcher empty, spent or refused included           keep the M60
    launcher      refused; spent (no clip, no spare rounds); target is a door            M60 at once
    launcher      target nearer than 0.75 pull lines                                     M60 at once
    launcher      emptied by a pull, target within 1500 units                            M60 at once
    launcher      empty after a pull, target beyond 1500 units, or empty because it      keep and reload, as long as a reload
                  came out to reload and the target is not inside the pull line          takes and a second more (9.2 s with the
                                                                                         shipped numbers), then M60
    launcher      loaded, target inside the pull line / no clear line / beyond 1800      M60 (after the dwell)
    launcher      loaded, target in the range and in clear sight                         keep (it is pulled, once: see below)
    launcher      no target for 1 s, loaded or spent                                     M60
    launcher      no target, empty with spare rounds                                     keep (it reloads in hand)
    M60           no target for 2 s, launcher empty with spare rounds                    launcher (to reload it)
    something     a target in sight (bare hands, any other weapon)                       M60
    else

The dwell is tsm_bot_mech_dwell (3 seconds) and up to half as much again, drawn anew at each switch, and twice as long after a
switch the situation forced (the launcher refused, spent or empty, a target at the bot's feet), so that a target at the edge of
the range does not send the bot back and forth. Two commands are never less than 0.6 seconds apart. A dead launcher with no
spare rounds is looked at again after 90 seconds, in case a resupply has filled it. The waits that follow the launcher come from
its cvars, read once a second: a salvo takes (h9_mechrocket_salvo - 1) times h9_mechrocket_stagger to leave; the game reloads a dry
launcher in hand 2 seconds after its last rocket (3 seconds after it was drawn) and the reload takes h9_mechrocket_reload; the bot
waits for that and a second more before it gives the launcher up, and counts an empty one in hand as loaded 1.5 seconds after
the reload should be over (8.2 s from the pull with the shipped numbers; the next pull tells).

With the shipped numbers (salvo 4, stagger 0.12, rate 1.5, clip 4, reload 3.0) a volley goes like this, from the pull:

    0.00 s   the pull: the first rocket leaves (the clip reads 3)
    0.12 s, 0.24 s, 0.36 s   the other three leave. A switch of weapon would end the salvo, so the rule makes none until 0.71 s
    0.71 s   the rule may choose again. The clip is empty and a target is within 1500 units: the M60 comes back, and the dwell
             (twice 3 s, and up to half again) keeps the launcher in the pack. A launcher kept in hand instead (a target too far
             for the M60) is reloaded by the game 2.36 s after the pull and is full at 5.36 s; the bot hears it by WeaponInfo
    quiet    a launcher put away empty is not reloaded by the game. The bot takes it out when no target has been in sight for 2 s:
             drawn (0.5 s), idle for 3 s, reloaded for 3 s, put away a second after WeaponInfo says it is loaded
    next pull   the launcher takes a pull again 1.5 s after the salvo's last rocket (1.86 s after the pull); with a clip of one
             salvo that is the reload, with h9_mechrocket_clip 8 it is a second salvo

Shooting (MechFire). With the launcher in hand the stock "press attack 9 times in 10" is not used, and CBot::PrimaryAttack refuses
for a Mech with the launcher in hand, so no other task can pull it: the trigger is MechFire's alone. The launcher is pulled once
when it is out for a second, loaded, past its own delay, and aimed: the line ahead of the bot, along its view, meets the target
or ends within 0.4 of the blast radius of the aim point; no wall is nearer than 96 units in front of the bot (1.4 blast radii
when h9_mechrocket_selfdamage is 1); no teammate or teammate's turret is in the line; and, when friendly fire is on (the
plugin's tsm_friendlyfire while the match mode is on, the game's mp_friendlyfire otherwise), no teammate is within a blast of
the burst. The press is one frame, never held: the salvo leaves by itself (CTSGun::MechRocketSalvoStep sends the rest, each along
the aim the bot has then), and the launcher is semi automatic, so a held button would fire nothing more. Then the launcher is left
alone until the game takes a pull again: the gaps of the salvo, then h9_mechrocket_rate from its last rocket (the game refuses a
pull while a salvo leaves, and inside the delay), plus 0.2 s. The bot looks for the rocket entity (h9_mechrocket, owned by the
shooter) in the next 0.6 seconds: a pull that launched none is counted, and two in a row leave the launcher alone for 20 seconds.

Aiming (GetAimVector, MechRocketAim). With the launcher in hand the bot aims at the target's feet when he stands on the floor and
the line to them is open, and leads him by his walk over the rocket's flight time at h9_mechrocket_speed (at most 1.5 seconds).
Its usual aim error is cut to 0.35: the blast covers the rest.

Settings, read once a second. A cvar that does not exist reads as its default, so the bots play as the defaults say until
ts_matchmode.sma registers the first three (three register_cvar lines beside tsm_bot_stockobjectives: "tsm_bot_mech_rocket" "1",
"tsm_bot_mech_dwell" "3.0", "tsm_bot_mech_near" "400"), which the console needs to set them. The h9_ ones are the game library's,
and a library that lacks the salvo ones fires one rocket a pull. The numbers the bot uses are the game's own after its clamps.
Turning tsm_bot_mech_rocket to 0 while a bot has the launcher out sends that bot back to the M60 (once; nothing else runs).

    tsm_bot_mech_rocket   1     0: a Mech bot plays its two weapons as any bot does
    tsm_bot_mech_dwell    3     seconds a Mech bot keeps the weapon it chose before it chooses the other (0.5 to 30)
    tsm_bot_mech_near     400   the pull line, in units (128 to 1500)
    h9_mechrocket         1     0: no launcher in the game library, nothing here runs
    h9_mechrocket_speed, _radius, _rate, _reload, _clip, _salvo, _stagger, _selfdamage

Debugging. "rcbot debug mech 1" on the server console (0 puts it off) logs every change of the rule's answer, every switch and
every pull, with the reason, to the server log:

    [RCBOT MECH] Mech-bot: m60 -> launcher: far target, clear line (target yes, 912 units, line clear, group 1, launcher 4/3)
    [RCBOT MECH] Mech-bot: pulls the launcher at 874 units (clip 4, spare 3, salvo 4, next pull in 2.1 s)
    [RCBOT MECH] Mech-bot: launcher -> m60: launcher empty (target yes, 861 units, line clear, group 1, launcher 0/3)

Without it the first 40 lines of a map are logged anyway. "launcher 4/3" is the clip and the spare rounds as the bot knows them,
-1 for not known. The wording after "launcher -> m60:" is the rule's reason (mech::whyName).

The weapon tables. TS 3.0 numbers its weapons 1 to 37 and H9 adds 39 (PPSh-41), 40 (laser rifle) and 41 (the launcher). Stock
rcbot's weapon tables hold MAX_WEAPONS = 37 entries, and BotClient_TS_WeaponInfo adds the weapon it is told about to the bot's
table without looking at the id. CBotWeapons::AddWeapon(41) therefore writes a CBotWeapon (32 bytes) just past the end of the
table: over the bot's m_pCurrentWeapon, its whole A* open list and the first of the path nodes that follow them in CBot, every
time a bot takes the launcher in hand or its spare rounds change. Ids 37 to 40 write over the table's ammo array. The global
table (CWeapons::AddWeapon) turns such an id down, so a Mech's launcher, a PPSh-41 and a laser rifle also have no weapon entry,
and IsMelee() reads true for them in the places that ask: no avoiding of entities, and no squad following while attacking.
MAX_WEAPONS is now 64, so ids 37 to 63 are registered like any other TS weapon (not melee, any range, no preset needed);
CBotWeapons::AddWeapon, UpdateWeapon and RemoveWeapon ignore an id past the table; TSWeapon names the three H9 weapons; and the
stunt decision, which divides the weapon id by the table size, divides by 37 as it always did. Left alone: weapon 36, which
RCBot takes for bare hands (WeaponInfo id 0 is mapped to it), so a Contender is played as kung fu.

Not touched: the stock attack code of any other weapon (a Mech with the M60 in hand is exactly the stock bot), the fight, the
path finder, CHANGE 3's squads, CHANGE 8's citizens, CHANGE 11 and 12's objectives, SwitchWeapon and the weapon-learning data.
Needs a game library with weapon 41 (reTS ts_mechrocket.cpp); the salvo cvars are optional. The tests are rcbot-patch\test\test_bot_mech.cpp
(cl /std:c++17 /EHsc /I<the rcbot dlls folder> test_bot_mech.cpp; it needs no HL SDK): the state a bot builds from the game's messages,
the rule, and the bot played against a model of the launcher as ts_gun.cpp runs it, which fails on a press the game would refuse, a click
on an empty launcher, a pull that launches nothing, and a salvo or a reload cut by a switch of weapon.


===============================================================================
CHANGE 14: ROAMING CITIZENS AND TEAMS (rcbot-ts-roam-teams.patch)
===============================================================================

    CBot::RoamIsEnemy, bot.cpp (CHANGE 8's test of an enemy)

A roamer's enemies are its attacker and, in an insurgency (tsrp_roambots_insurgency), the players
tsrp_roambots_insurgent_team names (0: every player who is not a bot). With Apollo RP's team play
(arp_teamplay 1) a roleplay map has three teams -- 1 Middle Sea Republic, 2 Insurrection, 3 Proletarians --
and every player and every bot has one in pev->team: ARP_TS puts a player on the team of his job,
tsrp_roambots puts a citizen on 3 and, while an insurgency lasts, on 2, all of them at once. After the
attacker is answered and the insurgency's settings are read, the test is:

        if (pev->team > 0)
        {
            if (pEntity->v.team <= 0 || pEntity->v.team == pev->team)
                return false;
        }
        else if (pEntity->v.flags & FL_FAKECLIENT)
            return false;

so with the teams in use an insurgent roamer's enemies are every player AND every bot that is not on its
own team, and never one that is, whatever tsrp_roambots_insurgent_team says: an insurgent citizen (team 2)
is set on the Proletarians and on the Middle Sea Republic's players and on a bot of the Republic's team (the
guards a later job adds), and leaves the Insurrection's players and the other insurgents alone. A client
no team is set on yet (pev->team 0: a player ARP has not placed) is nobody's enemy until it has one. The
cvar still narrows the hunt, in the line that ends the function as before: 0 does not, a team number
leaves only that team's players and bots. Every citizen is on team 2 from the moment an insurgency
starts (the plugin sets the team fields at once; TS's own move, a quarter-second step each, comes after),
so no insurgent is ever set on a citizen that has not moved yet. With no teams in use (arp_teamplay 0)
the roamer's team reads 0, a bot is nobody's enemy and nothing changes: only a player is an enemy, as in
CHANGE 8. The test comes after the attacker's, so a citizen that a player hurts fights him back whatever
team he is on: with friendly fire on (team play sets mp_friendlyfire 1) a Proletarian player's blow lands on
a citizen of his own team and it answers it, with its hands, as before. (A bot is never an attacker: RoamNoteAttacker
takes players only, so a guard's blow makes no attacker, and one fight starts no brawl.)

This is the insurgents' rule, and every roamer is a citizen so far. A roamer of another kind -- a guard,
on the Middle Sea Republic's team, which fights the insurgents -- must not run it: it takes its own
rule in RoamIsEnemy ahead of this one, told by its team field, and needs the insurgents' team number
for it (a cvar the plugin sets, or a constant).

Every other way a roamer picks a target goes through IsEnemy, and so through RoamIsEnemy: the scan of
what it sees, the attack task (which asks again as it runs, and drops a target that is no enemy) and the
events of a death seen (which can set a priority attack on a dead player's entity, only for the task to
drop it at once). A roamer of a team that needs another rule adds its test to RoamIsEnemy, before the
test above: it is the only test of an enemy that a roamer makes.

Not touched: the stock attack code, CHANGE 8's attacker (RoamNoteAttacker, RoamAttacker), the cvars.


===============================================================================
REBUILDING
===============================================================================

    git clone https://github.com/APGRoboCop/rcbotold
    cd rcbotold
    git checkout v1.51b13
    git apply rcbot-ts-teams.patch
    git apply rcbot-tsweaps-crash.patch
    git apply rcbot-build-fixes.patch
    git apply rcbot-waypoints-doors.patch
    git apply rcbot-ts-turrets.patch
    git apply rcbot-ts-roam.patch
    git apply rcbot-ts-slots.patch
    git apply rcbot-ts-powerups.patch
    git apply rcbot-ts-objectives.patch
    git apply rcbot-ts-briefcase.patch
    git apply rcbot-ts-mech.patch
    git apply rcbot-ts-roam-teams.patch
    MSBuild dlls\HPB_bot.vcxproj /p:Configuration="MetaMod Release" /p:Platform=Win32

In this order. The twelve together give, file for file, the source in src\;
without the third the tree does not compile. On a clone with core.autocrlf true, apply
with --index. The shipped rcbot_mm.dll (and rcbot_mm.dll.patch) is the build of
all twelve, CHANGE 14 and CHANGE 13 included.

Output lands at
    dlls\HPB_bot___Win32_MetaMod_Release\HPB_bot.dll
and is renamed to rcbot_mm.dll.

Worth sending upstream -- the model-string team test is broken for every TS
server, not just this one.


===============================================================================
INTEGRATION NOTE
===============================================================================

The "rcbot follow" console command must be registered in the MetaMod plugin
entry point (typically dlls/metamod.cpp or similar). Add a command handler
that parses "follow" subcommand and calls CBot::ConsoleCommandFollow().

Example registration (pseudo-code):
  REGISTER_COMMAND("rcbot", RCBot_Command);
  
  void RCBot_Command() {
    const char* cmd = CMD_ARGV(1);
    if (FStrEq(cmd, "follow")) {
      const char* args = CMD_ARGS();
      CBot::ConsoleCommandFollow(args);
    }
    // ... existing rcbot commands
  }

The ts_matchmode plugin will call this via FakeClientCommand when an officer
types .follow (to set follow target) or .unfollow (player_index = 0).