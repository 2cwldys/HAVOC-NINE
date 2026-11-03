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
    who owns a grenade or a thrown blade -- for its attacker for the rest of
    that life (SpawnInit forgets him), turns to him, wields its fists
    ("weapon_0", TS's weapon-select command for its hands) and fights with
    them, whatever it carries. Another bot, the world or itself is no
    attacker, so one fight starts no brawl. tsrp_roambots_defend 0: none.
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

tsm_bot_powerups belongs to ts_matchmode.sma (default 1; the TeamElimination and
Siege configs set 0), and it counts only while the plugin's match mode is on, as
its other tsm_ settings do: on a map TS plays as it ships (tsm_enabled 0) the bots
take powerups as nopowerup lets them. A cvar that does not exist holds no bot back,
so without the plugin this is CHANGE 2's nopowerup test alone.

A powerup the plugin itself grants -- the Officer's kung fu, what a mode hands
out -- is no pickup and needs no usepowerup, so this does not touch it. The
plugin also refuses a bot's touch of a ts_powerup under tsm_bot_powerups 0, for a
bot that walks over one on its way somewhere else.


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
    MSBuild dlls\HPB_bot.vcxproj /p:Configuration="MetaMod Release" /p:Platform=Win32

In this order. The eight together give, file for file, the source in src\;
without the third the tree does not compile. On a clone with core.autocrlf true, apply
with --index. The shipped rcbot_mm.dll (and rcbot_mm.dll.patch) is the build of
all eight.

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