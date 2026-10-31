# REPLACEMENTS

This `valve` folder is **not Half-Life's**. Nothing in it is Valve's. Every file here was made for HAVOC 9 or
comes from a source that allows its use. Each one takes the place of a Half-Life file with the same name,
so the engine can find what The Specialists and its maps borrow from Half-Life, with no copy of Half-Life
installed.

Half-Life, its files and its trademarks belong to Valve Corporation. HAVOC 9 is not made, endorsed or
supported by Valve. Where you own Half-Life, its own `valve` folder may be used in place of this one.

The replacements are made in `TSM\valve_replacements` (the tools named below). They have the same names,
sizes, submodel counts, frame counts and sequence names as the files they replace. None of their meshes,
pixels or audio is taken from Half-Life's: only those counts and sizes were read from the originals.

## What is here, and where it comes from

| File | What it is | Where it comes from |
| --- | --- | --- |
| `halflife.wad` | Tool textures (`clip`, `aaatrigger`, `sky`, `{invisible`), flat colours, and the 29 drawn textures TS's maps use | Painted from scratch for HAVOC 9 (`tools/make_textures.mjs`) |
| `gfx.wad` | The LOADING and PAUSED pictures, the H9 helmet, the console and credits fonts, the backdrop tile | Drawn for HAVOC 9 |
| `models/woodgibs.mdl`, `fleshgibs.mdl`, `glassgibs.mdl`, `metalgibs.mdl`, `metalplategibs.mdl`, `rockgibs.mdl`, `ceilinggibs.mdl`, `ventgibs.mdl`, `computergibs.mdl`, `cindergibs.mdl` | A breakable's debris | Built from scratch with SMAK (`tools/make_props.mjs`) |
| `models/can.mdl`, `models/w_medkit.mdl` | A soda can (six original labels), the first-aid kit | Built from scratch with SMAK (`tools/make_props.mjs`) |
| `models/shrapnel.mdl`, `models/shotgunshell.mdl` | An explosion's flying shards, a spent shotgun shell | Built from scratch with SMAK (`tools/make_props.mjs`) |
| `sprites/zerogxplode.spr`, `steam1.spr`, `bubble.spr`, `flare1.spr`, `glow04.spr`, `fire.spr`, `explode1.spr`, `wxplo1.spr`, `blood.spr`, `bloodspray.spr`, `flare3.spr`, `flare6.spr`, `lgtning.spr`, `voiceicon.spr`, `camera.spr`, `crosshairs.spr`, `tile.spr`, `iplayer.spr`, `iplayerblue.spr`, `iplayerred.spr`, `iplayerdead.spr` | Explosion, steam, bubble, glow, flame, underwater-explosion, blood, flare and lightning sprites, the voice and spectator-camera icons, the crosshairs sheet, the panel tile, and the overview map's player markers | Drawn from scratch (`tools/make_sprites.mjs`) |
| `resource/gameui_english.txt` | The main menu's words | Written for HAVOC 9 |
| `sound/common/launch_*.wav` (8 files) | The main menu's sounds: into and out of a menu, a button pressed, a switch toggled, refused, a key typed and rubbed out, and the pointer onto another item (`launch_move1`, which Half-Life has no file for) | Synthesized from scratch for HAVOC 9 (`tools/make_menu_sounds.mjs`) |
| `sound/...` (105 files) | Footsteps, doors, debris, ambience, pickups and the player | The Sonniss #GameAudioGDC bundles, cut and levelled (`tools/replace.mjs`); each is listed below |
| `extras.pk3` | The menu's small buttons and icons, fonts, gamepad mappings | Xash3D FWGS's own (`3rdparty/extras`), with the engine. Its fonts and logos carry their own licences inside it: Fira Sans under the SIL Open Font License 1.1; the Tahoma-metric font from the Wine project under the LGPL 2.1; the FWGS and Xash3D FWGS logos and the Neocat and Neofox icons under CC BY-NC-SA 4.0; Blobfox under Apache 2.0 |

## The sounds

Every sound is from the Sonniss #GameAudioGDC bundles. Their licence is royalty-free, and no attribution is
required. Each one is credited here anyway: the file it replaces, then the bundle, the library and the
original file it was cut from.

- `sound/ambience/boomer.wav`: Sonniss GDC 2015, Soundopolis - Natures Fury_Thunder, Thunder_Boom_Fienup_005.wav
- `sound/ambience/computalk2.wav`: Sonniss GDC 2017, Zero-G - Alien Skies - Cinematic Ambiences 2, Electronic Pass 005.wav
- `sound/ambience/cricket.wav`: Sonniss GDC 2016, The Sound Pack Tree - The BIG Pack, 0457 - amazon jungle night.wav
- `sound/ambience/drips.wav`: Sonniss GDC 2017, West Wolf - WATER, W 04 Water_05_Cave, Ambience, Water Drops, River_T05.wav
- `sound/ambience/hammer.wav`: Sonniss GDC 2016, Hzandbits - Construction Ambiances, Amb.Construction,Ext,Engines,Impacts,Clanging,Diffuse.wav
- `sound/ambience/industrial2.wav`: Sonniss GDC 2016, Game Audio Factory - GAFSFX07 - Yellowstone Geysers, G4F SFX07-YNP-MUDPOT-Norris 2.wav
- `sound/ambience/industrial4.wav`: Sonniss GDC 2017, The Soundcatcher - Antique Mills, ANTIQUE_MILL_TANNERY_HAMMER_DROP_IMPACT_RHYTHM_08.wav
- `sound/ambience/steamjet1.wav`: Sonniss GDC 2016, SoundMorph - INTERVENTION, Gear - movements_running_10.wav
- `sound/ambience/truck2.wav`: Sonniss GDC 2020, Pole Position - Yamaha MT-09 2015, Yamaha_MT09_t7_Ext_Start_Idle_Blips_Off_Holophone.wav
- `sound/ambience/wind2.wav`: Sonniss GDC 2020, SmartSoundFX - Mavic Travel Filmmaker, AMBIENCE Birds Forest Quiet Wind Loop 02.wav
- `sound/buttons/latchlocked1.wav`: Sonniss GDC 2020, SculpTunes - HHDoors - Household Doors and furnitures, HHDoors  Armored Door - Metal and wood Fron door - Unlock and Lock by the Key.wav
- `sound/buttons/lever1.wav`: Sonniss GDC 2017, Eiravaein Sound - Latchlocker, Latchlocker,cable,steel,wood,room,channel,slide,catch,alt2.wav
- `sound/buttons/lightswitch2.wav`: Sonniss GDC 2020, SculpTunes - HHDoors - Household Doors and furnitures, HHDoors  Armored Door - Metal and wood Fron door - Unlock and Lock by the Key.wav
- `sound/buttons/spark5.wav`: Sonniss GDC 2026, InMotionAudio - Arc, ELECBuzz_Buzz27_InMotionAudio_Arc.wav
- `sound/buttons/spark6.wav`: Sonniss GDC 2017, The Soundcatcher - Electric Cash Register, Cash Register_SANYO ECR 335_Bon_Exchange_Paper_Movement_1_3.wav
- `sound/common/bodysplat.wav`: Sonniss GDC 2026, Epic Stock Media - Halloween Game - Haunted House and Horror Audio Scare Kit, GORESplt_Gore Designed Transient Heavy Impact Smash 01_ESM_HALG.wav
- `sound/debris/bustceiling.wav`: Sonniss GDC 2017, Double Trouble Audio - Junk and Debris, Styrofoam - Pile of Styrofoam, Handling, Drop, Long Tail 07.wav
- `sound/debris/bustconcrete1.wav`: Sonniss GDC 2016, Mattia Cellotto - Rocks Momentum, Collapsed Stone House - Rock Single Large Impacts - 1 Meter. Rock,Large,Impact,Single,Land,Various_04.wav
- `sound/debris/bustconcrete2.wav`: Sonniss GDC 2016, Mattia Cellotto - Rocks Momentum, Glacial Lake - Large Size Rock Splashes - 5 Meters. Water,Splash,Large,Rock,Impact,Various_06.wav
- `sound/debris/bustflesh1.wav`: Sonniss GDC 2026, 344 Audio - Dinosaurs Vol. 2, ANMLRept_Dinosaur Eating Meat 01_344 Audio_Dinosaurs Vol 2.wav
- `sound/debris/bustflesh2.wav`: Sonniss GDC 2015, Soundopolis - Gore Toolkit HD, Slice_Crunchy_Fienup_002.wav
- `sound/debris/bustmetal1.wav`: Sonniss GDC 2026, 344 Audio - Historical Weapons Vol. 2, WEAPSwrd_Sword Slide Cuts, Metallic, Impact CM4 2_344 Audio_Medieval Weapons Vol 2.wav
- `sound/debris/bustmetal2.wav`: Sonniss GDC 2026, David Dumais Audio - Melee Weapons Sound Effects Pack 2, METLImpt_METAL SWING HIT Weapon Swing To Metallic Body Impact And Resonant Tail 01_DDUMAIS_MWP2.wav
- `sound/debris/concrete1.wav`: Sonniss GDC 2016, Levan Nadashvili - Soldier Footsteps, FS Concrete Soldier Crouch N02.wav
- `sound/debris/concrete2.wav`: Sonniss GDC 2016, Mattia Cellotto - Rocks Momentum, Glacial Lake - Large Size Rock Splashes - 5 Meters. Water,Splash,Large,Rock,Impact,Various_06.wav
- `sound/debris/concrete3.wav`: Sonniss GDC 2017, Double Trouble Audio - Wood Impacts and Debris, Drop Soft - Single Plank, Drop 02.wav
- `sound/debris/flesh1.wav`: Sonniss GDC 2015, Soundopolis - Gore Toolkit HD, Bloody_Squish_Fienup_CLASSIC_006.wav
- `sound/debris/flesh2.wav`: Sonniss GDC 2015, Soundopolis - Gore Toolkit HD, Bloody_Squish_Fienup_CLASSIC_006.wav
- `sound/debris/flesh3.wav`: Sonniss GDC 2026, 344 Audio - Dinosaurs Vol. 2, ANMLRept_Dinosaur Eating Meat 01_344 Audio_Dinosaurs Vol 2.wav
- `sound/debris/flesh5.wav`: Sonniss GDC 2026, Epic Stock Media - Synthesized Nature Loops and Sounds, ANMLAmph_Animal Frog Echo Short Squished Frequency Formant 03_ESM_SNLS.wav
- `sound/debris/flesh6.wav`: Sonniss GDC 2026, InMotionAudio - Sinister Textures 5, GOREMisc_Concrete_MetalPipe02_InMotionAudio_SinisterTextures5.wav
- `sound/debris/flesh7.wav`: Sonniss GDC 2026, 344 Audio - Dinosaurs Vol. 2, ANMLRept_Dinosaur Eating Meat 01_344 Audio_Dinosaurs Vol 2.wav
- `sound/debris/metal6.wav`: Sonniss GDC 2017, SoundBits - The Blacksmith, Metal_Chain_Hit_10.wav
- `sound/debris/pushbox1.wav`: Sonniss GDC 2017, SoundBits - Drag & Slide, Body_Drag_on_FarmLane_02_06.wav
- `sound/debris/pushbox2.wav`: Sonniss GDC 2017, SoundBits - Drag & Slide, LargeWoodenObject_Sliding_01_04.wav
- `sound/debris/pushbox3.wav`: Sonniss GDC 2017, SoundBits - Drag & Slide, Body_Drag_on_FarmLane_02_06.wav
- `sound/debris/wood4.wav`: Sonniss GDC 2016, Mattia Cellotto - Rocks Momentum, Woodshed - Rock and Wood Large Impacts - 1 Meter. Rock,Wood,Large,Impact,Roll,Various_02.wav
- `sound/doors/doormove10.wav`: Sonniss GDC 2020, SculpTunes - HHDoors - Household Doors and furnitures, HHDoors - Window Wooden Shutter Open and close - Close Perspective XY.wav
- `sound/doors/doormove2.wav`: Sonniss GDC 2017, SoundHolder -  Renault Master II 2.8dTi, Renault Master 28dTi Foley Passenger Doors Open Mono.wav
- `sound/doors/doormove6.wav`: Sonniss GDC 2020, SculpTunes - HHDoors - Household Doors and furnitures, HHDoors -  80s wooden door - 80s city apartment door - Opening and closing - close perspective XY.wav
- `sound/doors/doormove8.wav`: Sonniss GDC 2017, SoundMorph - Portals, Door - Medieval Open 16.wav
- `sound/doors/doormove9.wav`: Sonniss GDC 2020, SculpTunes - HHDoors - Household Doors and furnitures, HHDoors - Window Wooden Shutter Open and close - Close Perspective XY.wav
- `sound/doors/doorstop1.wav`: Sonniss GDC 2017, The Sound Keeper - Normal Doors, door-industrial open close office 03.wav
- `sound/doors/doorstop2.wav`: Sonniss GDC 2017, The Sound Keeper - Normal Doors, door-household open close sliding 02.wav
- `sound/doors/doorstop4.wav`: Sonniss GDC 2020, SculpTunes - HHDoors - Household Doors and furnitures, HHDoors -  80s wooden door - 80s city apartment door - Opening and closing - close perspective XY.wav
- `sound/doors/doorstop5.wav`: Sonniss GDC 2026, SoundBits - Cars - Mad Mustang Mercury, VEHDoor_Car Foley Car Door Open and Close Exterior 04 Perspective A_SNDBTS_CRS-MMM.wav
- `sound/doors/doorstop7.wav`: Sonniss GDC 2017, The Sound Keeper - Normal Doors, door-household open close sliding 02.wav
- `sound/items/9mmclip1.wav`: Sonniss GDC 2020, SculpTunes – Cartridges & Casings Shell, 9 mm x 21  - Casings Shell & Cartdridges - Roll on Concrete Floor - Outdoor.wav
- `sound/items/gunpickup2.wav`: Sonniss GDC 2017, SoundMorph - MECHANISM, Mechanism - AssaultRifle_PickUp_004.wav
- `sound/items/smallmedkit1.wav`: Sonniss GDC 2026, 344 Audio - East Coast America Vol. 1, AMBSubn_Electricity Hum, Lightbulb,  Coil Pickup 01_344 Audio_East Coast America.wav
- `sound/items/suitchargeok1.wav`: Sonniss GDC 2026, Epic Stock Media - Public Spaces - Basic Transportation Sounds, AMBTraf_Downtown Construction Traffic Light Walla 03 Distant Beep_ESM_CPS.wav
- `sound/items/weapondrop1.wav`: Sonniss GDC 2017, SoundMorph - MECHANISM, Mechanism - Source - Metallic Auto Gun.wav
- `sound/plats/bigmove2.wav`: Sonniss GDC 2020, Rzpost - The Gondola Lift, Multiple,Gondolas, Medium,Size,Passing,By,Mountain,Ski,Station,Mechanism.wav
- `sound/plats/bigstop2.wav`: Sonniss GDC 2017, The Sound Pack Tree - The Sound Pack Tree, 5366 - Space Lift Door 02.wav
- `sound/plats/elevmove1.wav`: Sonniss GDC 2020, Rzpost - The Gondola Lift, Gondola,Snowboard,Ski,Lyft,Style,Small,Size,Mechanism,Pulley,Passing,By_V2.wav
- `sound/plats/railstop1.wav`: Sonniss GDC 2017, Tone Manufacture - Cassette Tone, TM_CASSETTE TONE_Motor only, pause, counter perspective.wav
- `sound/player/breathe2.wav`: Sonniss GDC 2026, Epic Stock Media - AAA Game Character British Female Detective, VOXReac_British Detective Pain Vocal Female Dying High Grunt Breath_ESM_AAAGCBFD.wav
- `sound/player/pl_dirt1.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 169_Foley_Footsteps_Grass_Sneaker_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_dirt2.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 289_Foley_Footsteps_Rocks_Sneaker_Jump_Land_On_Two_Feet_Close.wav
- `sound/player/pl_dirt3.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 289_Foley_Footsteps_Rocks_Sneaker_Jump_Land_On_Two_Feet_Close.wav
- `sound/player/pl_dirt4.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 169_Foley_Footsteps_Grass_Sneaker_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_duct1.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_duct2.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_duct3.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_duct4.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_fallpain3.wav`: Sonniss GDC 2026, Epic Stock Media - Public Spaces - Crowds Walla and Everyday Ambiences, AMBWar_Paintball Match Firefight Shots Walla Nearfield Full 05_ESM_CPS.wav
- `sound/player/pl_grate1.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_grate2.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_grate3.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_grate4.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_ladder1.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_ladder2.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_ladder3.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_ladder4.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_metal1.wav`: Sonniss GDC 2016, Levan Nadashvili - Soldier Footsteps, FS Metal Soldier Walk N01.wav
- `sound/player/pl_metal2.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_metal3.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 237_Foley_Footsteps_Metal_Boot_Walk_Normal_Close.wav
- `sound/player/pl_metal4.wav`: Sonniss GDC 2016, Levan Nadashvili - Soldier Footsteps, FS Metal Soldier Walk N05.wav
- `sound/player/pl_shell1.wav`: Sonniss GDC 2020, SculpTunes – Cartridges & Casings Shell, 7 62 x 39 PPU  - Casings Shell & Cartdridges  - Impact and Roll on Tile Floor - Inside.wav
- `sound/player/pl_shell2.wav`: Sonniss GDC 2016, Stuart Duffield - Bullet SFX, Bullet_Drop_Wood_04.wav
- `sound/player/pl_shell3.wav`: Sonniss GDC 2020, SculpTunes – Cartridges & Casings Shell, 7 62 x 39 PPU  - Casings Shell & Cartdridges  - Impact and Roll on Tile Floor - Inside.wav
- `sound/player/pl_slosh1.wav`: Sonniss GDC 2016, Game Audio Factory - GAFSFX04 - Liquids Materials, GAF SFX04 - LIQUIDS - Ocean Water Movement Close.wav
- `sound/player/pl_slosh2.wav`: Sonniss GDC 2026, Just Sound Effects - Highlands of Norway, WATRLap_Small Waves sloshing onto Rock Slabs at huge Glacial Lake _JSE_HoN_Quad.wav
- `sound/player/pl_slosh3.wav`: Sonniss GDC 2016, Game Audio Factory - GAFSFX07 - Yellowstone Geysers, G4F SFX07-YNP-WATER SPLASH-Sawmill Geyser Errupt.wav
- `sound/player/pl_slosh4.wav`: Sonniss GDC 2016, Mattia Cellotto - Rocks Momentum, Glacial Lake - Large Size Rock Splashes - 5 Meters. Water,Splash,Large,Rock,Impact,Various_06.wav
- `sound/player/pl_step1.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 015_Foley_Footsteps_Asphalt_Boot_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_step2.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 015_Foley_Footsteps_Asphalt_Boot_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_step3.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 015_Foley_Footsteps_Asphalt_Boot_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_step4.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 015_Foley_Footsteps_Asphalt_Boot_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_swim1.wav`: Sonniss GDC 2026, Sonic Bat - Swimming Pool Ambience, SBspa_Water Polo Feminine League Match Presentation 001.wav
- `sound/player/pl_swim2.wav`: Sonniss GDC 2016, Game Audio Factory - GAFSFX07 - Yellowstone Geysers, G4F SFX07-YNP-WATER SPLASH-Red Spouter Geyser.wav
- `sound/player/pl_swim3.wav`: Sonniss GDC 2017, West Wolf - WATER, W 04 Water_19_Splashing, Sailing, Ship_T03.wav
- `sound/player/pl_swim4.wav`: Sonniss GDC 2026, Sonic Bat - Swimming Pool Ambience, SBspa_Water Polo Masculine League Break 001.wav
- `sound/player/pl_tile1.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 015_Foley_Footsteps_Asphalt_Boot_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_tile2.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 015_Foley_Footsteps_Asphalt_Boot_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_tile3.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 015_Foley_Footsteps_Asphalt_Boot_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_tile4.wav`: Sonniss GDC 2017, Tovusound - Edward – Foleyart Collection Add-On Extended Footsteps, 015_Foley_Footsteps_Asphalt_Boot_Walk_Fast_Run_Jog_Close.wav
- `sound/player/pl_wade1.wav`: Sonniss GDC 2026, Just Sound Effects - Highlands of Norway, WATRLap_Small Waves sloshing onto Rock Slabs at huge Glacial Lake _JSE_HoN_Quad.wav
- `sound/player/pl_wade2.wav`: Sonniss GDC 2026, Just Sound Effects - Highlands of Norway, WATRLap_Small Waves sloshing onto Rock Slabs at huge Glacial Lake _JSE_HoN_Quad.wav
- `sound/player/pl_wade3.wav`: Sonniss GDC 2026, Just Sound Effects - Highlands of Norway, WATRLap_Small Waves sloshing onto Rock Slabs at huge Glacial Lake _JSE_HoN_Quad.wav
- `sound/player/pl_wade4.wav`: Sonniss GDC 2017, Double Trouble Audio - Flowing Water, FLWA 74 - Dam, water, flowing, splashing, waves, clucking, movement.wav
- `sound/player/sprayer.wav`: Sonniss GDC 2016, Kevin Durr - Essential Bathroom Sounds, hairspray 2.wav
- `sound/weapons/explode3.wav`: Sonniss GDC 2026, Epic Stock Media - Public Spaces - Storms Lakes Parks and Rural Nature Exteriors, STORM_Texas Rain Thunder Initial Crash Boom Storm 01 Clap Lightning_ESM_CPS.wav
- `sound/weapons/explode4.wav`: Sonniss GDC 2016, SoundMorph - INTERVENTION, Explosives - Sweetners_07.wav
- `sound/weapons/explode5.wav`: Sonniss GDC 2026, Epic Stock Media - Anime Game, EXPLDsgn_Explosion Small Blast Enemy Death Crunchy Boom Cartoon Noisy Crash Impact Delay 03_ESM_AG.wav
