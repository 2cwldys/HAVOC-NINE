===============================================================================
PATCHED RCBOT  --  The Specialists team support + follow command
===============================================================================

Built from APGRoboCop/rcbotold at tag v1.51b13 -- the SAME version that shipped
with this install -- with additive changes:
  1. Team fix: compare pev->team instead of model strings
  2. Follow command: "rcbot follow <bot_index> <player_index>" makes bots follow
     a player using the native squad system (attacks enemies while following)

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
CHANGE 2: FOLLOW COMMAND
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
REBUILDING
===============================================================================

    git clone https://github.com/APGRoboCop/rcbotold
    cd rcbotold
    git checkout v1.51b13
    git apply rcbot-ts-teams.patch
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