===============================================================================
 PATCHED RCBOT  --  The Specialists team support
===============================================================================

 Built from APGRoboCop/rcbotold at tag v1.51b13 -- the SAME version that shipped
 with this install -- with ONE additive change.
 Win32, MetaMod Release, MSVC v145.

 Drop over  <Half-Life>\rcbot\dlls\rcbot_mm.dll .
 The stock build is kept beside it as rcbot_mm.dll.stock, so one copy reverts.


===============================================================================
 THE BUG
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


===============================================================================
 THE CHANGE
===============================================================================

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
 WHAT THIS DELIBERATELY DOES NOT DO
===============================================================================

 An earlier version of this patch also:

   - changed UTIL_GetTeam to return pev->team for TS, and
   - fixed globals.cpp, where m_bTeamPlay was COMPARED against mp_teamplay
     rather than assigned from it, so the flag never tracked the cvar.

 Both are genuine bugs. Both were reverted.

 Fixing the second one switches on a large amount of team code that this mod has
 never run -- team joining, team balancing, squad handling -- and the server
 crashed when bots spawned. One line of team comparison needs none of it.

 That earlier build was also made from master (1.51b14) instead of the installed
 1.51b13, which changed far more than was intended. This one is built from the
 tag, so the only difference from the DLL that worked is the block above.


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
