MECH ARMS: the Mech's minigun and rocket launcher as arm-mounted weapons (no hands anywhere)

WHAT IT MAKES (SMAK at D:\Downloads\TSM\smak, Node 18+; set TEMP and TMP to a folder with room, e.g. D:\temp\tmp)
  models\h9\v_mechminigun.mdl                  first person: a six-barrel rotary cannon built into an armoured forearm
  models\h9\v_mechrocket.mdl                   first person: a four-tube rocket pod on the same forearm
  models\h9\p_mechrocket.mdl, w_mechrocket.mdl another player's view of the pod on the Mech's arm, and the pod on the floor
  models\matchmode\{msr,insurgent,default}\h9\v_mechminigun.mdl, v_mechrocket.mdl
                                               the three side sets; models\h9\v_*.mdl is byte for byte the default set
  Same file names as before: nothing else has to be wired. The minigun has no p_ or w_ of its own (the stock M60's, as before).
  Each file is a new model (SMAK buildMdl): the stock M60's skeleton, animations, events and attachments, none of its meshes or
  pictures, one 8-bit picture "mecharm.bmp" (512 x 512 view models, 256 x 256 p_ and w_). No arms256.bmp, no glove, no skin.

REBUILD EVERYTHING (from this folder; <game> is a folder shaped like H9XASH\ts, created if need be)
  node build-minigun.mjs <game>          v_mechminigun.mdl and its three sets          (check printed for each: 0 errors, 0 warnings)
  node build-pod.mjs <game>              v_, p_, w_mechrocket.mdl and the v_ sets
  node verify-sets.mjs <game>\models\matchmode mechminigun      the sets differ only inside the band's zone, in the exact colours
  node verify-sets.mjs <game>\models\matchmode mechrocket
  node check-rotor.mjs <game>\models\h9\v_mechminigun.mdl      the rotor turns about the bore (the same for v_mechrocket.mdl)
  python make-preview.py <game> <out.png>                      the preview sheet (needs Pillow)
  node D:\Downloads\TSM\smak\bin\smak.mjs check <any of the models> [--engine xash]      PASS: fit for goldsrc / xash (all ten)
  The stock models are read from D:\Downloads\TSM\H9XASH\ts\models (v_m60, p_m60, w_m60, read only); MECH_STOCK or TSM_ROOT
  name another place. The scripts import SMAK by its absolute path.

THE DESIGN
  Everything is drawn in the view model's own space at the stock idle pose (+x forward from the eye, +y left, +z up; the eye
  at the origin, 90 degrees across), then bound to the M60's bones. The arm and weapon lie low and to the right, as the M60 does,
  with the nearest corner of the muzzle 65 to 77 pixels (of 640 across) from the crosshair; the first-person tiles of the preview mark it.
    minigun.mjs   cannon on axis y -4.8 z -4.6: the gauntlet (octagon tube, x -8.5 to 8.2, its rear end never in view), a wrist
                  step ring, the side band ring at x 5.6 to 6.6, two armour plates, a hydraulic piston on the shoulder into a bracket,
                  two hoses, the gearbox housing (x 9 to 13), the shroud, the feed throat with seven brass rounds hanging from it,
                  six barrels (ring 1.5, radius 0.55) and three clamps to the muzzle at x 19.8; the service hatch on the gauntlet's top.
    pod.mjs       the same gauntlet, wrist, band, plates, piston, hoses and hatch; a breech housing (x 9 to 11.8) with a loader port
                  and four lamps (a rocket each), a bulkhead ring, and a cage of four tubes (radius 1.15, each closed by a cap) held
                  by three plates, muzzle at x 17.6. p_ is the pod with a short gauntlet (kind "p"), w_ the pod alone on two feet (kind "w").
    kit.mjs       the shared shapes (gauntlet, piston, hose, plate) and the gauntlet's paint.   paint.mjs  the paint: gunmetal, hazard
                  stripes, brass, rivets, the side accent.   common.mjs  the stock's skeleton carried into a new model, placing, side textures.
    motion.mjs    the changes to the M60's animations (below).
  WHAT EACH BONE CARRIES, so the M60's timing is kept: m60 the arm and weapon (the shoot recoil, the reload's swing and drop, the draw's rise are
  the M60's own); cover the arm's hatch (the reload opens it as the M60's cover opened, the sounds at frames 25, 55 and 60 are the M60's);
  rotor (a bone added under m60 on the bore) the six barrels or the four-tube cage. The M60's hand, finger, trigger and belt bones carry
  nothing. Frame counts, rates, events, the sequence order and the attachments are the stock's; attachment 0 is moved to the muzzle.
  CHANGED MOTION (motion.mjs, and the rotor in the two build scripts)
    shoot, shoot2   minigun: the rotor turns about 17 degrees a frame at first (60 degrees in 3.6 frames, the M60's rate of fire), slowing to a
                    whole turn by the last frame (a sixth of a turn is the same picture, so each shot that restarts the animation leaves the barrels
                    where they began). Rocket: the cage turns a quarter in frames
                    3 to 13 and rests (four tubes in a square are the same after a quarter turn) and the arm kicks back 1.3 units on top of the M60's recoil.
    stock (melee)   the M60's flips the rifle over to strike with the butt, which on a gun built into an arm would turn the arm end over end;
                    here the arm keeps its attitude and takes the M60's path, shortened (45 percent ahead, 25 percent up and left): a punch.
  THE SIDE SETS differ only in the band's zone of the picture ("BAND", 24 x 160 pixels, painted by accent() in paint.mjs): msr (60,120,255),
  insurgent (80,200,90), default hazard yellow and black. sideTextures() (common.mjs) makes one palette from the default picture, keeps 16
  entries for the band's colours, and indexes every pixel outside the band the same in all three: verify-sets.mjs checks it.

THE HAND GENERATOR
  modelling\team-hands.mjs (the copy in this tree, to replace D:\Downloads\TSM\modelling\team-hands.mjs) is the project's generator with one
  change: it SKIPS every v_mech*.mdl (stated in its header), so a rerun cannot write a glove picture over these sets. Everything else
  in it is as it was. The sets of the other 40 view models come out the same.

SPARE WEAPONS: modelling\spare-weapons\ holds the previous human-held minigun and rocket launcher, with its own README.txt.

AFTER THE MERGE: copy newfiles\H9XASH\ts\models into H9XASH\ts\models (and the Steam ts\ folder where the laser rifle's files also live),
then node tools\webclient-sync.mjs, as for any model change.
