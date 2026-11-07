===============================================================================
 modelling\ -- making and changing The Specialists' player models
===============================================================================

 The working folder. SMAK itself is the kit in  ..\smak  ; this is where our own
 scripts, docs and output live, so the kit stays as it came.

   docs\        how to do it:
                  PLAYER-MODELS.md   the donor-skeleton workflow, and why a model
                                     cannot be built from scratch
                  FROM-REFERENCE.md  turning a reference image into a model
                  VARIANTS.md        the five recipes, safest first
   lib.mjs      what every script shares: where SMAK is, where the models are,
                the pose everything is measured in, and checked()
   inspect.mjs  read a model and print its facts
   example-recolour.mjs   a worked, runnable variant: new colour from the palette
   out\         everything written. GENERATED -- delete it freely.

 Node.js 18 or later and nothing else. The kit has no dependencies.


===============================================================================
 START HERE
===============================================================================

 Look at a model first. Always.

     node inspect.mjs XCCPsgts
     node inspect.mjs repuheavy

 Then make something, and look at the picture it writes:

     node example-recolour.mjs XCCPsgts desert
     node example-recolour.mjs XCCPsgts woodland

 To see any two side by side, turning, with any of their 171 animations playing:

     node ..\smak\bin\smak.mjs view out\recolour

 Ctrl+C stops it.


===============================================================================
 WHERE THE MODELS COME FROM
===============================================================================

 lib.mjs reads the game's own player models:

     D:\SteamLibrary\steamapps\common\Half-Life\ts\models\player

 1893 folders, one per model, each  <name>\<name>.mdl . Edit GAME_MODELS at the
 top of lib.mjs if the install moves, or set TS_MODELS to point elsewhere.

 NOTHING is ever written there. Output goes to out\ and is installed by hand.

 team-hands.mjs   the first-person hands, three sets by side (msr, insurgent, default
                  with no stripe at all) for every viewmodel in the game: models/v_*.mdl
                  and models/h9/v_*.mdl (the PPSh-41, the laser rifle). Its pictures are
                  hands\*.bmp (the default is the msr picture with the cuff taken out,
                  the blue stripe and the black line beside it);
                  it writes models/matchmode/<set>/ in the game folder and never the
                  game's own models. ts_matchmode.sma (h9_customhands) points the client
                  at the copy for the player's side. A weapon added to the game: run it
                  again and add the model's path to g_hand_files in ts_matchmode.sma.

 ..\test\ts-trial\originals\ holds thirteen of them copied out, with twenty
 variants made from them and the scripts that did it. That folder is an EXAMPLE
 and is left alone; read its scripts, do not work in it.


===============================================================================
 THE RULES THAT MATTER
===============================================================================

 Read  ..\smak\AGENTS.md . It is the contract and it is short. The three that
 catch people out:

 1. EVERY EDIT APPENDS. New data goes at the end of the file and the tables are
    pointed at it; the old bytes stay inside. So always build a variant FROM THE
    PRISTINE ORIGINAL, never from your last output. Stacking runs grows the file
    without bound, and anything involving paint() degrades the palette each pass.

 2. NEVER REORDER OR REMOVE animations, submodels, bones or attachments. Game
    code plays them by number. Everything in the kit adds at the end so numbers
    stay; do not work around that.

 3. A MODEL THAT PASSES check() CAN STILL BE WRONG. Inside out, tiny, facing
    backwards. Render it and look at the PNG, every time. Then put it in the
    game -- that is the only real test, and nothing made with this kit has been
    loaded by The Specialists yet.


===============================================================================
 INSTALLING ONE
===============================================================================

 Copy your variant over

     ts\models\player\<name>\<name>.mdl

 under the ORIGINAL'S name, keeping a copy of the original first. The folder and
 the file must share that name.

 Start with a recolour: it changes least, so if something is wrong it is more
 likely to be the install than the model.
