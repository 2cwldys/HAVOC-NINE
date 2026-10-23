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
which had never actually compiled standalone -- see rcbot_mm.dll.patch, shipped
beside every deployed rcbot_mm.dll, for exactly what that needed.


===============================================================================
REBUILDING
===============================================================================

    git clone https://github.com/APGRoboCop/rcbotold
    cd rcbotold
    git checkout v1.51b13
    git apply rcbot-ts-teams.patch
    git apply rcbot-tsweaps-crash.patch
    MSBuild dlls\HPB_bot.vcxproj /p:Configuration="MetaMod Release" /p:Platform=Win32

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