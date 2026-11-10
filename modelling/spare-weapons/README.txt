SPARE WEAPONS: the human-held minigun and rocket launcher, kept for later

WHAT THEY ARE
  The first versions of the Mech's two weapons (issues 8 and 9), as they were before the Mech got arm-mounted view models of
  its own. They are ordinary hand-held weapons built on the stock M60 view model: its human forearms and black fingerless
  gloves hold a six-barrel minigun (rotor bone turned by the shoot animations) and a shoulder-fired rocket launcher. The
  files are copies of what stood in H9XASH\ts\models when the Mech's own models replaced them; only the model's name inside
  its header was changed to the new file name. Nothing else differs. SMAK check: PASS (0 errors) on all ten.

FILES (same folder layout as H9XASH\ts, so they can be dropped in as they are)
  models\h9\v_minigun_handheld.mdl              749188   first person, minigun
  models\h9\v_rocketlauncher_handheld.mdl       425788   first person, rocket launcher
  models\h9\p_rocketlauncher_handheld.mdl       104920   in another player's hands (the M60's p_ bones)
  models\h9\w_rocketlauncher_handheld.mdl       101844   on the floor
  models\matchmode\{msr,insurgent,default}\h9\v_minigun_handheld.mdl, v_rocketlauncher_handheld.mdl
                                                the three custom hand sets (msr: blue cuff, insurgent: green cuff, default: no cuff),
                                                as modelling\team-hands.mjs makes them
  The minigun never had a p_ or w_ model of its own: another player saw the stock M60 (p_m60, w_m60). A hand-held minigun
  would use those until one is made.
  Animations (all of them the M60's, same numbers and timing): idle, draw, shoot, shoot2, reload (events at 25, 55, 60: the
  M60's open, belt and close sounds), stock. Muzzle: attachment 0 at the barrels' end.

HOW THEY COULD BE WIRED IN AS ORDINARY WEAPONS
  1. The game library (reTS) must register each as a weapon, the way it registers the PPSh-41 (39), the laser rifle (40) and the
     Mech's rocket launcher (41): a weapon id, its damage and ammo, and the model names above, behind h9_customweapons like
     every H9 weapon. The Mech's own models use the names v_mechminigun / v_mechrocket / p_mechrocket / w_mechrocket; these
     spares have different names on purpose, so both can exist at once.
  2. Hands: put v_minigun_handheld.mdl and v_rocketlauncher_handheld.mdl in H9XASH\ts\models\h9 and run
         node modelling\team-hands.mjs
     (the generator takes every v_*.mdl of models\ and models\h9\ except the Mech's v_mech*.mdl, so it writes the three sets
     itself; the copies shipped here are what it would write). Then add "h9/v_minigun_handheld.mdl" and
     "h9/v_rocketlauncher_handheld.mdl" to g_hand_files in ts_matchmode.sma (and raise TSM_HANDS), as the PPSh-41 is listed.
  3. Effects that still exist for the Mech and could be reused: sprites\h9_minigun_flash.spr (the large muzzle flash),
     sprites\h9_rocket_flash.spr, h9_rocket_smoke.spr, h9_rocket_boom.spr and the rocket in flight, models\h9\mechrocket.mdl.
  4. After copying into the game folder: node tools\webclient-sync.mjs, so that the web client carries the files.
