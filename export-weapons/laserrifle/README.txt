LASER RIFLE (weapon 40) FOR THE SPECIALISTS / H9XASH

WHERE THIS FOLDER IS
  In the git repository: export-weapons\laserrifle (the finished files under ts\, the scripts under build\).
  In the working copy: D:\Downloads\TSM\laserrifle, which the scripts read and write (the paths are at the top of
  each script; temporary files go to D:\temp\lr).

THE WEAPON
  An energy weapon built on The Specialists' own M4A1 models (so the hands, the animations and the gunbash are the
  game's). Credits and the licence of the model it comes from: laserrifle_ATTRIBUTION.txt (also in the game, in
  ts\models\h9\, and listed in creds_attribution.txt). Its numbers: docs\WEAPON_DAMAGES.txt. What the game does
  with it: reTS\reference\DEVIATIONS.md ("Laser rifle").

THE FILES (drop-in: they go in the game's ts\ folder; the git repository keeps them in xash3d-h9-patches\overlay\ts
and H9XASH\ts as well)
  ts\models\h9\v_laserrifle.mdl, p_laserrifle.mdl, w_laserrifle.mdl, laserrifle_ATTRIBUTION.txt
  ts\sound\h9\laserrifle\fire.wav, hit1.wav, hit2.wav, hit3.wav, reload.wav
  ts\sprites\laserrifle_muzzle.spr, laserrifle_trail.spr, laserrifle_bolt.spr, laserrifle_hit.spr
  ts\sprites\laserscope.spr                  the scope overlay's mask and side bars, one flat blue (build\make_scope.py)
  ts\sprites\weapons\laserrifle.spr          the weapon's picture (the select bar and the buy menu both draw it)

WHAT THE GAME NEEDS BESIDES THE FILES (they are no use without it)
  reTS\dlls\ts_weapon_info.{h,cpp}   TSW_LASERRIFLE = 40 and its row (a copy of the M4A1's), caliber 15 "Plasma Cell"
  reTS\dlls\game.cpp                 the h9_laserrifle cvar, TS_util.cpp, ts_weapons.cpp (the precache: the muzzle flash
                                      is a temporary sprite and needs the server's model index), ts_gun.cpp (tables)
  reTS\cl_dll\ev_ts.cpp, ts_bullets.cpp, ts_scope.cpp, ts_buymenu.*, ts_weaponbar.cpp   the effects and the tables
  AMXMODX\modules\ts\tsx\            the TSX tables (weapon 40; kung fu's stats slot is 41 now) and tsconst.inc
  ts_matchmode.sma and its .cfg lines (tsm_class7: the Officer carries it)
  NOTE: build.bat copies the Steam install's ts\addons over H9XASH: a TSX built for this must be put in the Steam
  install too, or the next build puts the old one back (it then refuses weapon 40).

HOW TO MAKE THE FILES AGAIN (all in build\)
  1. The source model is a download ("Sci-Fi Marksman Rifle (Updated Textures)" by Jett Spaulding on Sketchfab, CC BY
     4.0; the address is in the attribution file) and is not kept in this repository: its licence and its size say
     so. Its FBX goes in laserrifle\source\RifleNewTextures.fbx and its pictures in laserrifle\textures\.
  2. The colour pictures, one a material, from the PBR maps (white paint, black underside, blue lens):
       py -3 v2_textures.py ..\textures D:\temp\lr\tex
  3. The rifle as triangles on one 512 x 512 picture (every part kept at a budget of its own; the optic's lenses made
     here; the magazine seated; the optic lowered onto the receiver; the barrel gathered on a grid):
       node v2-prep.mjs                       writes ..\out2\gun.json
  4. The three models, on the M4A1's (the lenses get a texture of their own with the fullbright flag, so that they
     glow whatever the map's light):
       node v2-models.mjs                     writes ..\out2\{v,p,w}_laserrifle.mdl and pictures to look at them by
  5. The sprites and the weapon's picture:
       node v2-icon-src.mjs
       py -3 make_sprites.py ..\out2\overlay ..\out2\icon_src.png
  6. The sounds (made from arithmetic: nothing to credit):
       py -3 make_sounds.py ..\out2\overlay\sound
  7. The scope mask: the stock quarterscope.spr with the colour of its last palette entry changed (an index-alpha
     sprite paints every pixel in that colour; the client draws the side bars from the same sprite's solid corner, so
     the whole frame is one flat blue):
       py -3 make_scope.py <ts\sprites\quarterscope.spr> ..\out2\overlay\sprites\laserscope.spr 8 28 92
  Pictures to look at a model by: node v2-view.mjs <model.mdl> <prefix>; node v2-optic-iso.mjs; node v2-crop.mjs.

THE PLASMA
  Only a shot of ammo caliber 15 (the laser rifle's plasma cells) is drawn as plasma, so no other weapon changes: a green
  bolt that runs from the muzzle to where it lands, its trail holding at full brightness a moment and then fading, a
  green muzzle flash and a faint green light where it was fired from and where it lands, no brass, no gun smoke, a
  scorch where it hits and the blaster's sound (cl_dll\ev_ts.cpp, ts_bullets.cpp). Every ribbon, head and flash is kept
  between a least and a most number of pixels across at its own distance, so a bolt a few thousand units out is still a
  line; a round the client bullet simulation flies (slow motion, or realbullet) is stepped every frame and its trail is
  carried to the impact. The scope overlay of the weapon's zoom is blue (cl_dll\ts_scope.cpp).

TURNING IT OFF
  h9_customweapons 0 (a server cvar, 1 by default; H9XASH\ts\server.cfg and listenserver.cfg set it) is TS 3.0's own
  roster: the laser rifle, the PPSh-41 and any weapon H9 adds later cannot be bought or picked up, the buy menu leaves
  them out (SrvSett id 4) and the match mode gives its classes the M4A1 and the UMP in their place.
