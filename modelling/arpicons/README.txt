APOLLO RP'S ITEM PICTURES: THE TOOLS AND THEIR SOURCES
======================================================

What they make
  sprites\h9_arpicons.spr   the sheet: one 32 x 32 frame for each item (a Half-Life sprite, version 2, type SPR_FWD_PARALLEL, SPR_ALPHTEST: palette
                            index 255 is transparent), at most 256 pictures
  sprites\h9_arpicons.txt   its list: one line for each name, "<item's name>|<frame>" (a name more than once, as an alias, has the same frame)
  sprites\h9_cuffed.spr     the handcuff symbol over a cuffed head (make_cuffed_sprite.py; ARP_JailMod, arp_h9_cuffsprite)
  Who reads them: the inventory window and the notice over a dropped item (reTS\cl_dll h9_arpinv*.cpp, vgui_H9Panel.cpp, at every VidInit) and
  the picture that floats over a dropped pack (ARP_Core.sma, arp_h9_itemicon, at map load). docs\ARP_INVENTORY_WINDOW.txt, 4, says how they are drawn.

The files here (everything is in the repository: nothing else is needed to make the sheet again but Python with Pillow)
  arpicons_art.py       the drawn pictures: a function of a Pen for each item with no world model (that is every item of Apollo RP but the guns),
                        the colours, and the tables ICONS (the first pictures) and LATER (the ones added since)
  make_arpicons.py      builds the sheet and its list from the drawings, baked\ and baked_h9\, and writes modelling\arpicons\out\;
                        --install copies the two files into sprites\, which the build ships with the game
  make_cuffed_sprite.py builds the handcuff symbol from the Cuffs drawing; --install copies it into sprites\
  bake_final.mjs        renders a weapon from its world model with SMAK (smak\ in the repository, found from this file's place), laid on the diagonal
  weapons_final.json    the 31 weapons of TS 3.0: {"name", "model", "flip", "roll", "lean"}; "model" is a file of TS's models folder (set
                        H9_TS_MODELS to that folder, else the Steam install's ts\models is used)
  weapons_h9.json       the two weapons of H9's own (PPSh-41, Laser Rifle), their models given from the repository's root ("@repo/H9XASH/..."), and the
                        other spellings of their names (aliases)
  baked\, baked_h9\     the renders of the weapons, kept so that the sheet can be made without TS's models
  h9_arpicons_atlas.png, preview.png   the sheet to look at (the atlas is what tools\render_arpinv.py draws the window's previews with)

The order of the frames: the weapons of weapons_final.json, then ICONS, then the weapons of weapons_h9.json, then LATER. The window finds a picture by the name,
so the order matters to nothing but the file: the sheet and its list are made together and go out together.

ADDING A PICTURE (for an item you have hooked up in a plugin)
  1. The name is the item's name as the plugin registers it, spelled exactly (the window compares the whole name, case and all).
  2. A drawn item: write its function in arpicons_art.py (the others are examples: a Pen, the grid's 0 to 32 across and down, the colours at the top) and
     add the name to LATER, at the end of it.
     A weapon with a world model: add an entry to weapons_h9.json (name, "model": "@repo/<path from the repository's root>", flip, roll, lean, aliases), then
         node modelling\arpicons\bake_final.mjs modelling\arpicons\weapons_h9.json modelling\arpicons\baked_h9 32
     and look at baked_h9\<its number>.png; flip puts the heavy end down, roll and lean turn it until the picture reads.
  3. python modelling\arpicons\make_arpicons.py            writes out\h9_arpicons.spr and .txt, preview.png and the atlas: look at preview.png
     python modelling\arpicons\make_arpicons.py --install  when it looks right
     Pass a tab separated list of item names (second column) after the options to have the names that have no picture listed.
  4. python reTS\cl_dll\tests\check_arpicons.py            the sheet as the engine reads it, and every item the plugins register against the list: it says
     which items have no picture (an item with none is a monogram in the window and has no icon in the world, which is fine until you draw one)
  5. Nothing is built. The client reads the sheet when the game starts a map, the server when a map loads (a map change or a restart for the picture over a
     pack); build.bat and export.bat carry sprites\ to H9XASH and the repository, and the web client and the packages take it at the next parity run.
     In the game: cl_h9_arpinv_state <the item's name> says the frame the client found, or why it found none; cl_h9_arpinv_test draws a window of tiles by the real code.

The handcuff symbol (make_cuffed_sprite.py) is not in the sheet: it is a world sprite of its own (type SPR_FACING_UPRIGHT) whose frame sits 98 pixels over its origin,
because a sprite that follows a player is drawn at the player's origin. Change the Cuffs drawing and run it again after make_arpicons.py.
