MECH ARMS: the Mech's minigun and rocket launcher as arm-mounted weapons (no hands anywhere)

WHAT IT MAKES (SMAK at D:\Downloads\TSM\smak, Node 18+; set TEMP and TMP to a folder with room, e.g. D:\temp\tmp)
  models\h9\v_mechminigun.mdl                  first person: a six-barrel rotary cannon built into an armoured forearm; its ammunition belt hangs
                                               on the left and feeds into the gun at every shot
  models\h9\w_mechminigun.mdl                  the cannon on its own, as it lies on the floor (three times the view's size, three pads, its belt on the floor)
  models\h9\v_mechrocket.mdl                   first person: a four-tube rocket pod on the same forearm
  models\h9\p_mechrocket.mdl, w_mechrocket.mdl another player's view of the pod on the Mech's arm, and the pod on the floor
  models\matchmode\{msr,insurgent,default}\h9\v_mechminigun.mdl, v_mechrocket.mdl
                                               the three side sets; models\h9\v_*.mdl is byte for byte the default set
  The view models keep the file names they always had: nothing has to be wired for them. w_mechminigun.mdl is put on the floor by the plugin
  (ts_matchmode.sma, mech_gun_world) and only when the file exists. The minigun has no p_ model: another player sees of a Mech the arm built into
  the Mech's player model (the plugin takes the weapon model off a Mech every frame), so no other player ever has it in his hands.
  Each file is a new model (SMAK buildMdl): the stock M60's skeleton, animations, events and attachments, none of its meshes or
  pictures, one 8-bit picture "mecharm.bmp" (512 x 512 view models, 256 x 256 p_ and w_). No arms256.bmp, no glove, no skin.

REBUILD EVERYTHING (from this folder; <game> is a folder shaped like H9XASH\ts, created if need be)
  node build-minigun.mjs <game>          v_mechminigun.mdl and its three sets, w_mechminigun.mdl          (check printed for each: 0 errors, 0 warnings)
                                         and the checks below (about a minute and a half); --quick leaves the two long ones out
  node build-pod.mjs <game>              v_, p_, w_mechrocket.mdl and the v_ sets
  node verify-sets.mjs <game>\models\matchmode mechminigun      the sets differ only inside the band's zone, in the exact colours
  node verify-sets.mjs <game>\models\matchmode mechrocket
  node check-rotor.mjs <game>\models\h9\v_mechminigun.mdl      the rotor turns about the bore (the same for v_mechrocket.mdl)
  node check-solid.mjs <model.mdl> [--world] [--full]            no hole in a model (see THE CHECKS); --world for a model not seen from the eye
  node check-belt.mjs <v_mechminigun.mdl> [<other sets>]         the belt's feed, length and sets (see THE CHECKS)
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
                  two hoses, the gearbox housing (x 9 to 13), the shroud, the feed throat with its belt of brass rounds, six barrels
                  (ring 1.5, radius 0.55) and three clamps to the muzzle at x 19.8; the service hatch on the gauntlet's top.
                  build(side, { kind: "v" | "w" }): "w" is the cannon alone (no arm, hatch, hoses or band), its wrist ring a hazard-striped
                  flange, on three pads, the belt lying on the floor, on a 256 picture; WORLD places it in the world model.
    belt.mjs      the ammunition belt (35 rounds on a line leaving the throat's mouth down and outwards, a pitch of 0.563 between them) and
                  the throat box it slides into; addFloorBelt is the belt of the world model.
    pod.mjs       the same gauntlet, wrist, band, plates, piston, hoses and hatch; a breech housing (x 9 to 11.8) with a loader port
                  and four lamps (a rocket each), a bulkhead ring, and a cage of four tubes (radius 1.15, each closed by a cap) held
                  by three plates, muzzle at x 17.6. p_ is the pod with a short gauntlet (kind "p"), w_ the pod alone on two feet (kind "w").
    kit.mjs       the shared shapes (gauntlet, piston, hose, plate) and the gauntlet's paint.   paint.mjs  the paint: gunmetal, hazard
                  stripes, brass, rivets, the side accent.   common.mjs  the stock's skeleton carried into a new model, placing, side textures.
    motion.mjs    the changes to the M60's animations (below).
  WHAT EACH BONE CARRIES, so the M60's timing is kept: m60 the arm and weapon (the shoot recoil, the reload's swing and drop, the draw's rise are
  the M60's own); cover the arm's hatch (the reload opens it as the M60's cover opened, the sounds at frames 25, 55 and 60 are the M60's);
  rotor (a bone added under m60 on the bore) the six barrels or the four-tube cage; belt (a bone added under m60 at the throat's mouth, minigun
  only) the whole belt. The M60's hand, finger, trigger and round bones carry nothing. Frame counts, rates, events, the sequence order and the
  attachments are the stock's; attachment 0 is moved to the muzzle.
  CHANGED MOTION (motion.mjs, and the rotor in the two build scripts)
    shoot, shoot2   minigun: the rotor turns about 17 degrees a frame at first (60 degrees in 3.6 frames, the M60's rate of fire), slowing to a
                    whole turn by the last frame (a sixth of a turn is the same picture, so each shot that restarts the animation leaves the barrels
                    where they began). Rocket: the cage turns a quarter in frames
                    3 to 13 and rests (four tubes in a square are the same after a quarter turn) and the arm kicks back 1.3 units on top of the M60's recoil.
    shoot, shoot2   minigun, the belt: the belt bone slides one pitch (0.563 units) along the belt toward the throat in the first three frames
                    (smooth at both ends) and rests there. The M60 fires every 0.109 s, 3.6 frames at 33 a second, and each shot starts the
                    animation again, so the belt is fed one round a shot. Every round is the same as the next, so the picture after the slide
                    is the picture before it and the restart shows no jump; the round that went into the throat is hidden by its walls. In idle,
                    draw, reload and stock (melee) the belt does not move.
    stock (melee)   the M60's flips the rifle over to strike with the butt, which on a gun built into an arm would turn the arm end over end;
                    here the arm keeps its attitude and takes the M60's path, shortened (45 percent ahead, 25 percent up and left): a punch.
  THE SIDE SETS differ only in the band's zone of the picture ("BAND", 24 x 160 pixels, painted by accent() in paint.mjs): msr (60,120,255),
  insurgent (80,200,90), default hazard yellow and black. sideTextures() (common.mjs) makes one palette from the default picture, keeps 16
  entries for the band's colours, and indexes every pixel outside the band the same in all three: verify-sets.mjs checks it.

THE BELT (belt.mjs; the feed is motion.mjs slide() called by build-minigun.mjs)
  35 rounds hang from the feed throat, a pitch of 0.563 units apart on a line that leaves the throat's mouth down and outwards (12 degrees off
  the vertical): a brass case, a copper tip and a link tab each, every one a closed surface. They are one bodypart "belt" of 1890 points
  (a GoldSrc submodel holds 2048, which is 37 rounds at most) on the bone belt. The throat is a closed box on the housing's left; its lower
  face is the mouth. At rest one round stands in the mouth, mostly inside the box; a shot slides the belt a pitch in, so that round goes up
  inside the box and the one below it takes its place. The feed is exactly one pitch (a round at site k takes site k - 1), which is what makes
  the picture after the slide the picture before it. The belt is long so that its far end is never in the picture: with the engine's field of
  view (a 4:3 or 5:4 picture takes the fov as set, a wider one keeps the vertical field of view that 4:3 has, so 5:4 shows the most below the
  gun) it is out of the picture by a pitch or more up to fov 120 on 4:3, 5:4, 16:10 and 16:9 in every frame of every animation (at fov 90,
  18 pitches or more). The melee thrust, which brings the gun and so the belt nearest, shows the end from about fov 128 (5:4) or 130 (4:3);
  the fire animation shows it from about fov 138, and the idle, draw and reload poses not before about fov 138 either. The view model is
  4792 triangles, 3360 of them the belt.

THE WORLD MODEL (build-minigun.mjs makeWorld; minigun.mjs build kind "w", WORLD)
  w_mechminigun.mdl has the stock w_m60's skeleton (one bone, joint1) and one bodypart. The cannon is drawn in the view model's space with
  the arm, hatch, hoses and band left out, its wrist ring painted as the hazard-striped band (a flange at its rear), three pads under the
  housing and the middle clamp, and a belt of 10 rounds that hangs from the throat for three rounds and lies on the floor beyond (addFloorBelt).
  Placing it (WORLD): three times the view's size (35 units long, about as long as the stock M60's 38), its length along +y with the muzzle
  forward and its middle on x 0, its left (the belt side) on -x, the bottom of its pads on z 0. A dropped gun's origin is on the floor and
  its angles are zeroed once it lands, so z is up and the model stands on its pads. The model's bounds and its one hit box are the cannon's own
  (the game gives a dropped gun its own grab box whatever the model's). 1944 triangles, a 256 square picture (mecharm.bmp, default set).
  Where it is seen: the game library gives every thrown M60 models/w_m60.mdl, and the plugin gives one a Mech threw (the thrower is the entity's
  owner until it lands) this model. A Mech does not drop his M60 with tsm_mech_nodrop 1 (the default: the T key and the weapon bar's drop are
  refused and a death throw is removed in the frame it was made) and a disarm still throws it; with tsm_loadoutrework 1 that gun is removed
  within a quarter second and handed back. So the cannon is seen on the floor when tsm_mech_nodrop is 0 (after a drop or a death), or after a
  disarm with the loadout rework off, and for a moment in the air after a disarm with it on. There is no p_ model: see WHAT IT MAKES.

THE CHECKS (each exits 1 when it finds anything; build-minigun.mjs runs the studio kit's, check-solid.mjs, the sets' same-shape test
(sameGeometry in check-solid.mjs) and check-belt.mjs; verify-sets.mjs and check-rotor.mjs are run by hand)
  the studio kit (K.check): every model, the limits of the engine's studio format (bones, points per submodel, triangles, picture).
  check-solid.mjs: no hole. The engine draws a triangle only from its front, so a missing, open or inside-out surface shows what is behind
    it. It reads the file and checks the picture's flags (masked, additive), every edge in two triangles run in opposite directions (so
    every part is closed and wound alike), every connected piece wound outward and on one bone, the stored normals against the winding, and
    then renders item buffers: from the game's first-person camera (fov 90, 110, 120) at every frame of every animation and from a sphere of
    cameras round the model at the idle pose and, coarser, at the other frames, counting the pixels whose nearest surface is a back face (a
    view into the model). --world leaves the first-person camera out (a model not seen from the eye); --full is the thorough one (about a minute).
    It cannot see a slit between two separate closed parts (it is a view through empty space), a hole smaller than a pixel of its cameras,
    or what the engine clips or lights. Every part added to a model has to be closed (a tube or turn gets caps at both ends).
  check-belt.mjs: the belt of v_mechminigun.mdl, measured in the file. A bone and a bodypart belt carrying only that bone; the rounds a pitch
    apart on a line; the belt bone's travel in shoot and shoot2 (one pitch toward the gun, reached in three frames, then at rest) and none in
    idle, draw, reload and stock; the picture of the whole model at the end of the slide equal to the picture of frame 0 (fov 90 to 120, and
    the depth from 12 directions); the far end out of the picture by a pitch or more at fov 90, 100, 110 and 120 on 4:3, 5:4, 16:10 and 16:9
    in every frame of every animation; no round showing above the throat's mouth (through its walls or roof) at 21 places of the slide from 60
    directions and the first-person camera; and, with more files, that the bones, every animation value and every triangle of the sets are equal.
    It cannot see the game's view bob, the engine's interpolation between stored frames (which is linear, as the slide is), or a field of view
    wider than the ones it names.
  verify-sets.mjs and check-rotor.mjs: the side sets differ only in the band's zone; the rotor turns about the bore.
  All of it is measured in SMAK's reading of the files and its renderer: none of it has been seen in the game.

THE HAND GENERATOR
  modelling\team-hands.mjs (the copy in this tree, to replace D:\Downloads\TSM\modelling\team-hands.mjs) is the project's generator with one
  change: it SKIPS every v_mech*.mdl (stated in its header), so a rerun cannot write a glove picture over these sets. Everything else
  in it is as it was. The sets of the other 40 view models come out the same.

SPARE WEAPONS: modelling\spare-weapons\ holds the previous human-held minigun and rocket launcher, with its own README.txt.

AFTER THE MERGE: copy newfiles\H9XASH\ts\models into H9XASH\ts\models (and the Steam ts\ folder where the laser rifle's files also live),
then node tools\webclient-sync.mjs, as for any model change.
