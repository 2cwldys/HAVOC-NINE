-- Apollo RP on h9_tsrp_hive: the Ministry of Defense ranks and the civilian jobs, then the properties and doors. ARP_CONTENT.txt (docs) says what each is.
-- Run by ARP_Core itself at every start of this map (arp_mapsql_autoload 1 in arp.cfg), after the tables are made and before the
-- jobs, properties and doors are read, so the rows are there in the same map load. An ARP admin can also run it by hand: console arp_config, entry 3
-- "Load Map SQL Data". Written against ARP's default table names (arp_jobs, arp_property, arp_doors); the loader swaps in this map's own tables
-- (arp_jobs_h9_tsrp_hive, arp_property_h9_tsrp_hive, arp_doors_h9_tsrp_hive).
-- Every row is INSERT OR IGNORE: running the file again changes nothing, and a row an admin edited stays as edited.
-- To be run by itself every statement must be  INSERT OR IGNORE INTO arp_jobs (or arp_property, arp_doors) VALUES (...);  one to a line, the table name in
-- lower case, nothing after the ;  (docs\ARP_CONTENT.txt, section 2, has the whole rule). A line that starts with - ; or # is skipped.
-- Columns: name, salary paid every 60 seconds into the bank, access letters (a police, b medical, z ARP admin: the
-- Administrator job only; c d e f are the hiring tiers and g is the Lord Minister's own letter: see ARP_CONTENT.txt, section 4).

-- Civilians
INSERT OR IGNORE INTO arp_jobs VALUES ('Unemployed',5,'');
INSERT OR IGNORE INTO arp_jobs VALUES ('Citizen',10,'');
INSERT OR IGNORE INTO arp_jobs VALUES ('Laborer',12,'');
INSERT OR IGNORE INTO arp_jobs VALUES ('Courier',15,'');
INSERT OR IGNORE INTO arp_jobs VALUES ('Technician',18,'');
INSERT OR IGNORE INTO arp_jobs VALUES ('Merchant',20,'');
-- Ministry of Defense: cadets, enforcers and ensigns (M- is the Medical Division)
INSERT OR IGNORE INTO arp_jobs VALUES ('Cadet',20,'ac');
INSERT OR IGNORE INTO arp_jobs VALUES ('M-Cadet',20,'bc');
INSERT OR IGNORE INTO arp_jobs VALUES ('Enforcer 1',25,'ac');
INSERT OR IGNORE INTO arp_jobs VALUES ('M-Enforcer 1',25,'bc');
INSERT OR IGNORE INTO arp_jobs VALUES ('Enforcer 2',30,'ac');
INSERT OR IGNORE INTO arp_jobs VALUES ('M-Enforcer 2',30,'bc');
INSERT OR IGNORE INTO arp_jobs VALUES ('Enforcer 3',35,'ac');
INSERT OR IGNORE INTO arp_jobs VALUES ('M-Enforcer 3',35,'bc');
INSERT OR IGNORE INTO arp_jobs VALUES ('Ensign',40,'ac');
INSERT OR IGNORE INTO arp_jobs VALUES ('M-Ensign',40,'bc');
-- Ministry of Defense: sergeants and lieutenants
INSERT OR IGNORE INTO arp_jobs VALUES ('Sergeant 1',45,'ad');
INSERT OR IGNORE INTO arp_jobs VALUES ('Sergeant 2',50,'ad');
INSERT OR IGNORE INTO arp_jobs VALUES ('Lieutenant',60,'ad');
-- Ministry of Defense: officers
INSERT OR IGNORE INTO arp_jobs VALUES ('Captain',70,'abe');
INSERT OR IGNORE INTO arp_jobs VALUES ('Major',80,'abe');
-- Ministry of Defense: high command
INSERT OR IGNORE INTO arp_jobs VALUES ('Guardian',90,'abf');
INSERT OR IGNORE INTO arp_jobs VALUES ('Legate',100,'abf');
INSERT OR IGNORE INTO arp_jobs VALUES ('Lord Commander',120,'abf');
-- Ministry of Defense: the head. No job right holds g, so only an admin can offer this job
INSERT OR IGNORE INTO arp_jobs VALUES ('Lord Minister',150,'abg');
-- ARP administration: the one job with z. An admin gives it with arp_setjob; nobody's job right holds z, so no one can offer it
INSERT OR IGNORE INTO arp_jobs VALUES ('Administrator',0,'z');
-- The Insurrection: the junior ranks, the NCOs, the officers, the high command and the head, lowest rank first, after the jobs above. Every job holds i (arp_h9_insurgent_access: the
-- Insurrection team of ARP's team play, the Insurgency on the plaque) and one tier letter of its own: j the junior ranks, k the NCOs, l the officers, m the high command, n the head. No
-- job right holds i or n, so only an admin can offer the Liberator; a right of j, jk, jkl or jklm (arp_setjobright) offers and takes the ranks below it as the Ministry's c, cd, cde and cdef do,
-- and none of them shares a letter with a Ministry job. See docs\ARP_CONTENT.txt, sections 3 and 4.
-- Insurrection: recruits, rebels and partisans
INSERT OR IGNORE INTO arp_jobs VALUES ('Recruit',15,'ij');
INSERT OR IGNORE INTO arp_jobs VALUES ('Rebel 1',20,'ij');
INSERT OR IGNORE INTO arp_jobs VALUES ('Rebel 2',25,'ij');
INSERT OR IGNORE INTO arp_jobs VALUES ('Rebel 3',30,'ij');
INSERT OR IGNORE INTO arp_jobs VALUES ('Partisan',35,'ij');
-- Insurrection: squad, cell and section leaders
INSERT OR IGNORE INTO arp_jobs VALUES ('Squad Leader',40,'ik');
INSERT OR IGNORE INTO arp_jobs VALUES ('Cell Leader',45,'ik');
INSERT OR IGNORE INTO arp_jobs VALUES ('Section Leader',50,'ik');
-- Insurrection: officers
INSERT OR IGNORE INTO arp_jobs VALUES ('Colonel',60,'il');
INSERT OR IGNORE INTO arp_jobs VALUES ('Marshal',70,'il');
-- Insurrection: high command
INSERT OR IGNORE INTO arp_jobs VALUES ('Tribune',80,'im');
INSERT OR IGNORE INTO arp_jobs VALUES ('Strategist',90,'im');
INSERT OR IGNORE INTO arp_jobs VALUES ('Hetman',100,'im');
-- Insurrection: the head. No job right holds n, so only an admin can offer this job
INSERT OR IGNORE INTO arp_jobs VALUES ('Liberator',130,'in');

-- Optional, the Medical Division above the Ensign (the museum's list stops at M-Ensign). Remove the leading "-- " to use a line.
-- INSERT OR IGNORE INTO arp_jobs VALUES ('M-Sergeant 1',45,'bd');
-- INSERT OR IGNORE INTO arp_jobs VALUES ('M-Sergeant 2',50,'bd');
-- INSERT OR IGNORE INTO arp_jobs VALUES ('M-Lieutenant',60,'bd');

-- ==== Properties and doors (docs\ARP_CONTENT.txt, section 9): the Ministry's posts, clinics, shops, businesses and homes ====
-- A property is a building or a place the look-at plaque names; its doors are func_door entities of this map, one row each, by their targetname
-- (t|<targetname>), every one an entity of the compiled map. Property columns: internalname, externalname (what the plaque shows), ownername,
-- ownerauth, price, locked, access letters, profit. No owner and price 0 is state property; a price and no owner is for sale (say /buy). Every property of this map has a price but the state properties (price 0): the guard posts, the throne room, the Ministry of Defense's own buildings and the MSR gate, sealed to their letter, and the ways through that a whole city uses (docs\ARP_CONTENT.txt, 9 lists them), which stand open to everyone; each of the others is for sale until somebody has it.
-- locked 1 keeps a door as the map has it and leaves it to the owner, a key holder or the access letters (a Ministry of Defense, b Medical
-- Division, g the Lord Minister's own); locked 0 is open to anyone. The affiliation the plaque shows comes from the access letters.
-- A property may have several doors, but its lock is one: a shop whose front door starts open and whose back door is shut is two properties with one name.
-- Doors the map did not name cannot be bound here (docs\ARP_CONTENT.txt, section 9). The four wall panels of the jails (h9_jail) are made by
-- ARP_JailMod, not by this file.

-- Gear Guys: front door of the red wood shop (Gear Guys Arms Dealer, Gear Guys Ammunition Counter inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_gear_guys','Gear Guys','','',29000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_techromagna','h9_pc_gear_guys');
-- Uncle Pikkys Pizzeria: entrance doors of the pizzeria (Uncle Pikkys Pizzeria NPC inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_pikkys','Uncle Pikkys Pizzeria','','',29000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_unclepikkysentra','h9_pc_pikkys');
-- Cybernetics: the machine door of the Cybernetics lane's rear chamber (the Black Market NPC stands inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_cybernetics','Cybernetics','','',29000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_cybernetc','h9_pc_cybernetics');
-- Paradise Bank: the bank building's automatic glass doors (opened by their own trigger, so not locked)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_bank','Paradise Bank','','',29000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_bankdoor','h9_pc_bank');
-- Pawn Prawn Staff Room: the staff door behind the Pawn Prawn bar counter; also the hatch in the floor of the chamber behind the staff door, the hideout under it and its far door: the flood fill of the map's space joins the staff door, the chamber, the hatch and the hideout, and the doors are named pp
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_pawn_prawn','Pawn Prawn Staff Room','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_noodles1','h9_pc_pawn_prawn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_pphideout1','h9_pc_pawn_prawn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_pphideout','h9_pc_pawn_prawn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_pphideout3','h9_pc_pawn_prawn');
-- Romagna Clinic: the ward doors of the white waiting hall (Romagna Clinic Medical Officer outside them)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_romagna_clinic','Romagna Clinic','','',29000,1,'b',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_lwrromgoff2','h9_pc_romagna_clinic');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_lwrromgoff3','h9_pc_romagna_clinic');
-- Ministry of Defense Facility: the gate and the office door of the Ministry of Defense facility (south west); also the facility's elevator screen (the md prefix, inside the same closed complex as the gate, the office and the armoury)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_md_facility','Ministry of Defense Facility','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_mdfacgate','h9_pc_md_facility');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_msrmdoffice1','h9_pc_md_facility');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_mdelescreen1','h9_pc_md_facility');
-- Ministry of Defense Armoury: the facility's armoury door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_md_armoury','Ministry of Defense Armoury','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_mdarmorydoor','h9_pc_md_armoury');
-- Ministry of Defense Detention: the four cells in the facility's basement
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_md_cells','Ministry of Defense Detention','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_mdcell1','h9_pc_md_cells');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_mdcell2','h9_pc_md_cells');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_mdcell3','h9_pc_md_cells');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_mdcell4','h9_pc_md_cells');
-- Paradise Cafe: the cafe on the plaza (no NPC): a business to run; cafe1door is the entrance and cafe2door an inner door of one closed complex, and the only AVALON sign hangs 740 units east, not here
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_cafe_avalon','Paradise Cafe','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_cafe1door','h9_pc_cafe_avalon');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_cafe2door','h9_pc_cafe_avalon');
-- Paradise Flat 1: a residence door in the south west blocks
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res1','Paradise Flat 1','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident1','h9_pc_flat_res1');
-- Paradise Flat 2: a residence with a street door and a park door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res2','Paradise Flat 2','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident2','h9_pc_flat_res2');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident2park','h9_pc_flat_res2');
-- Paradise Flat 3: a residence with a street door and a park door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res3','Paradise Flat 3','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident3','h9_pc_flat_res3');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident3park','h9_pc_flat_res3');
-- Guns n Stuff: front door of the gun shop (Guns n Stuff Arms Dealer, Ammunition Counter inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_guns_n_stuff','Guns n Stuff','','',14000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gunshop','h9_xe_guns_n_stuff');
-- Green Dragon: front door of the restaurant (Green Dragon Cantina inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_green_dragon','Green Dragon','','',14000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_processedfood1','h9_xe_green_dragon');
-- Xenon City Gear: front door of the store (Xenon City Gear General Store inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_city_gear','Xenon City Gear','','',14000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gearshop','h9_xe_city_gear');
-- Xenon City Civil Protection: the CP gate at the north end of the concourse and the shield behind it; also the two help alcoves on the concourse's west wall (xe_cp_ prefix: Civil Protection's)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_cp_post','Xenon City Civil Protection','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_xenoncpgate','h9_xe_cp_post');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_pdshield','h9_xe_cp_post');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_help','h9_xe_cp_post');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_help1','h9_xe_cp_post');
-- XCCP Armoury: the armoury's two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_cp_armoury','XCCP Armoury','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_armory','h9_xe_cp_armoury');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_armory1','h9_xe_cp_armoury');
-- XCCP Barracks: the barracks door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_cp_barracks','XCCP Barracks','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_barracks','h9_xe_cp_barracks');
-- XCCP Control Room: the control room door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_cp_control','XCCP Control Room','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_control','h9_xe_cp_control');
-- XCCP Detention: the six prison cells
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_cp_cells','XCCP Detention','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_prison1','h9_xe_cp_cells');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_prison2','h9_xe_cp_cells');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_prison3','h9_xe_cp_cells');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_prison4','h9_xe_cp_cells');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_prison5','h9_xe_cp_cells');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cp_prison6','h9_xe_cp_cells');
-- Xenon Clinic: the clinic's office, operating room, rest room and wing (upper level, the XENON CLINIC sign)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_clinic','Xenon Clinic','','',57000,1,'b',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_clinic_off','h9_xe_clinic');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_clinic_op','h9_xe_clinic');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_clinic_rest','h9_xe_clinic');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_clinic_wing','h9_xe_clinic');
-- Sky Bar: the bar of the upper level (the gate starts open): a place to run; also the drawer of the bar's counter (xe_skyb_ prefix, inside the bar); locked whole: a bar for sale is sealed until bought (its gate starts open and stays open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_sky_bar','Sky Bar','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_skyb_gate','h9_xe_sky_bar');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_skyb_door1','h9_xe_sky_bar');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_skyb_door2','h9_xe_sky_bar');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_skyb_drawer','h9_xe_sky_bar');
-- Xenon Apartment 1: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt1','Xenon Apartment 1','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door1a','h9_xe_apt1');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door1b','h9_xe_apt1');
-- Xenon Apartment 2: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt2','Xenon Apartment 2','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door2a','h9_xe_apt2');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door2b','h9_xe_apt2');
-- Xenon Apartment 3: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt3','Xenon Apartment 3','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door3a','h9_xe_apt3');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door3b','h9_xe_apt3');
-- Xenon Luxury Apartment A: luxury apartment, entrance and bath door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lux_a','Xenon Luxury Apartment A','','',110000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_a','h9_xe_lux_a');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_abath','h9_xe_lux_a');
-- Cafe Fortress (H&C Coffee): the two doors of the cafe on the main street (H&C Coffee Cantina inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_cafe_fortress','Cafe Fortress (H&C Coffee)','','',110000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_cafe.fortress','h9_al_cafe_fortress');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_cafefortress','h9_al_cafe_fortress');
-- K-Line Super Store: the south door of the supermarket (the open side is the park)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_kline','K-Line Super Store','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_klinedoor','h9_al_kline');
-- Midgar Lab: the lab gate (the console al_labentbutton opens it; Midgar Lab Medical Officer inside); also the console itself, al_labentbutton, a use-only door brush whose target is al_midgar.lab.gate.one
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_midgar_lab','Midgar Lab','','',7200,1,'b',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgar.lab.gate.one','h9_al_midgar_lab');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_labentbutton','h9_al_midgar_lab');
-- Ministry Detention Facility: the prison gate and the armoury gate of the detention block (the cells' wall panels are h9_jail)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_detention','Ministry Detention Facility','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_prisongate','h9_al_detention');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_armorygate','h9_al_detention');
-- Throne Room: the throne room: the Lord Minister's own letter g
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_throne_room','Throne Room','','',0,1,'g',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_throneroom','h9_al_throne_room');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_thronegate','h9_al_throne_room');
-- Ed's Steak House: the steak house of the lower level, entrance and exit: a place to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_steakhouse','Ed''s Steak House','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_edssteak','h9_al_steakhouse');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_steakexit','h9_al_steakhouse');
-- Golgotha Apartment 1: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha1','Golgotha Apartment 1','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoapartment1','h9_al_golgotha1');
-- Golgotha Apartment 2: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha2','Golgotha Apartment 2','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoapartment2','h9_al_golgotha2');
-- Golgotha Apartment 3: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha3','Golgotha Apartment 3','','',57000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgo.apt3.1','h9_al_golgotha3');

-- More properties, by city. A lock belongs to a property, so a shop whose front door starts open and whose back, side or staff door is shut is two properties with one name:
-- the front one unlocked, the one of the shut doors locked. Homes and businesses for sale are locked whole, at the price of their tier (docs\ARP_CONTENT.txt, 9 has the scale and the price of every property).

-- Paradise City
-- Uncle Pikkys Pizzeria: the east door and the oven door of the pizzeria (unclepikky prefix, the kitchen on its north side; both shut in the map)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_pikkys_back','Uncle Pikkys Pizzeria','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_unclepikkyse','h9_pc_pikkys_back');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_oven_door','h9_pc_pikkys_back');
-- Gear Guys (South West): front door of the second Gear Guys, south west (a GEARGUYS sign hangs over it; it starts open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_gear_guys_sw','Gear Guys (South West)','','',110000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_gearshop1','h9_pc_gear_guys_sw');
-- Gear Guys (South West): the shop's side door and pc_edenoffice2, an Eden office door of the same walled compound (the compound's other office door, pc_edenoffice1, wears the same name as the back office of the first Gear Guys and cannot be bound)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_gear_guys_sw_back','Gear Guys (South West)','','',57000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_gearshop2','h9_pc_gear_guys_sw_back');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_edenoffice2','h9_pc_gear_guys_sw_back');
-- Eden News: front door of the news office (a PCN sign hangs by it; a button works it, it starts open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_eden_news','Eden News','','',29000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_edennews','h9_pc_eden_news');
-- Eden News: the newsroom door behind it (the two doors bound one closed complex)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_eden_news_back','Eden News','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_newsroom1','h9_pc_eden_news_back');
-- Tartec: the automatic front doors (a trigger opens them) of the Tartec building, two halves of one name, the lobby of the lift up to the park level; open state property that nobody can buy
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_tartec','Tartec','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_tartec_frt','h9_pc_tartec');
-- SkyTech: the SkyTech building: its gates, the two lab doors on the upper floor, the computer core hatch and the operating room (the flood fill joins them through skytechgate4); pc_skytechgate2 shares its name with a door elsewhere and is not bound
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_skytech','SkyTech','','',110000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_skytechgate','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_skytechgate1','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_skytechgate3','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_skytechgate4','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_labdoor1sky','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_labdoor2sky','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_computercore','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_operatingroom1','h9_pc_skytech');
-- Paradise Bar: a bar of the lower level, south west (its door starts open and stays open, as a bar's front does, and is the only pc_resident door that does; no sign hangs near it, so the heading is the town's own); locked whole: a bar for sale is sealed until bought
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_bar_paradise','Paradise Bar','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident4','h9_pc_bar_paradise');
-- Paradise Flat 4: named 4a in the map, 1,100 units from the bar's door pc_resident4 and a floor lower: a flat of its own, numbered 4 so that the flats run 1 to 9 without a gap
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res4','Paradise Flat 4','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident4a','h9_pc_flat_res4');
-- Paradise Flat 5: a residence door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res5','Paradise Flat 5','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident5','h9_pc_flat_res5');
-- Paradise Flat 6: a residence door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res6','Paradise Flat 6','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident6','h9_pc_flat_res6');
-- Paradise Flat 7: a flat of the lower level
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res7','Paradise Flat 7','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident7','h9_pc_flat_res7');
-- Paradise Flat 8: a residence door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res8','Paradise Flat 8','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident8','h9_pc_flat_res8');
-- Paradise Flat 9: a residence door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res9','Paradise Flat 9','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident9','h9_pc_flat_res9');
-- Paradise Citizen Flat 1: a citizen's flat east of the Romagna hall
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit1','Paradise Citizen Flat 1','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen1','h9_pc_flat_cit1');
-- Paradise Citizen Flat 2: a citizen's flat east of the Romagna hall
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit2','Paradise Citizen Flat 2','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen2','h9_pc_flat_cit2');
-- Paradise Citizen Flat 3: a flat with a street door (starts open) and an upper door (the flood fill joins them)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit3','Paradise Citizen Flat 3','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen3','h9_pc_flat_cit3');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen3a','h9_pc_flat_cit3');
-- Paradise Citizen Flat 4: a citizen's flat
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit4','Paradise Citizen Flat 4','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen4','h9_pc_flat_cit4');
-- Paradise Citizen Flat 5: a citizen's flat
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit5','Paradise Citizen Flat 5','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen5','h9_pc_flat_cit5');
-- Paradise Citizen Flat 6: a citizen's flat
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit6','Paradise Citizen Flat 6','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen6','h9_pc_flat_cit6');
-- K Tower Suite: the suite door inside K Tower (luxury tier)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_ktower_suite','K Tower Suite','','',110000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_ktowersuite','h9_pc_ktower_suite');
-- Storage Unit 1: one of four equal unit doors in a row (137 apart) on the lower level; an hour's pay
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage1','Storage Unit 1','','',3600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storage1','h9_pc_storage1');
-- Storage Unit 2: a storage unit
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage2','Storage Unit 2','','',3600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storage2','h9_pc_storage2');
-- Storage Unit 3: a storage unit
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage3','Storage Unit 3','','',3600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storage3','h9_pc_storage3');
-- Storage Unit 4: a storage unit
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage4','Storage Unit 4','','',3600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storage4','h9_pc_storage4');
-- Storage Gate: the gate of the storage corridor (for sale)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage_gate','Storage Gate','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storagegate','h9_pc_storage_gate');
-- Org Headquarters: the Org's headquarters, one building on two levels: the street door on the ground floor (pc_orghqroma1) and the two office doors upstairs (pc_orghqroma2 and pc_orghqroma3, about 520 units up, reached by the headquarters' own lift, whose screen door pc_1orghq1elescreen1 is not bound); three doors, closed rooms of about 198k square units in all; an office for sale, sealed until bought
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_org_hq','Org Headquarters','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_orghqroma1','h9_pc_org_hq');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_orghqroma2','h9_pc_org_hq');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_orghqroma3','h9_pc_org_hq');
-- MSR Gate: the gate of the MSR yard east of the plaza, two halves of one gate (pc_MSRGATEUP rises, pc_MSRGATEDOWN sinks) in front of a closed yard of about 267k square units; state property sealed to the Ministry of Defense (nothing in the map fires the manager that moves the halves: its only two triggers are key panels that nothing can use, so only the use key of a job with the letter a opens the gate)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_msr_gate','MSR Gate','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_MSRGATEUP','h9_pc_msr_gate');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_MSRGATEDOWN','h9_pc_msr_gate');

-- Xenon City
-- Guns n Stuff: the back door at the end of the back hall (shut in the map)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_guns_n_stuff_back','Guns n Stuff','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gunshop1','h9_xe_guns_n_stuff_back');
-- Green Dragon: the side door of the restaurant (shut in the map; a dragon sign hangs by it)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_green_dragon_side','Green Dragon','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_processedfood2','h9_xe_green_dragon_side');
-- Xenon City Gear: the back door of the store (shut in the map; the flood fill joins it to the shop)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_city_gear_back','Xenon City Gear','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gearshop1','h9_xe_city_gear_back');
-- Xenon Clinic: the clinic's entrance gate (the XENON CLINIC sign hangs 56 units from it; the flood fill joins it to the clinic doors; it starts open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_clinic_gate','Xenon Clinic','','',14000,0,'b',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_broth_gate','h9_xe_clinic_gate');
-- Uncle Elzos: front gate of the restaurant (an UNCLE ELZOS sign hangs by it; it starts open; the door is named enzos)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_elzos','Uncle Elzos','','',29000,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_enzos_gate','h9_xe_elzos');
-- Uncle Elzos: the oven door and the uez entrance, where the other UNCLE ELZOS sign hangs (as Uncle Pikkys has its oven door)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_elzos_back','Uncle Elzos','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_oven_door','h9_xe_elzos_back');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_uez_entrance1','h9_xe_elzos_back');
-- Electronics Store: the store's door (the name is cut at gam); a business to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_electronics','Electronics Store','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_electronicsstoregam','h9_xe_electronics');
-- Xenon Apartment 4: upper level apartment, two doors (the flood fill joins them)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt4','Xenon Apartment 4','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door4a','h9_xe_apt4');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door4b','h9_xe_apt4');
-- Xenon Apartment 5: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt5','Xenon Apartment 5','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door5a','h9_xe_apt5');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door5b','h9_xe_apt5');
-- Xenon Apartment 6: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt6','Xenon Apartment 6','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door6a','h9_xe_apt6');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door6b','h9_xe_apt6');
-- Xenon Luxury Apartment B: luxury apartment, entrance and bath door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lux_b','Xenon Luxury Apartment B','','',110000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_b','h9_xe_lux_b');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_bbath','h9_xe_lux_b');
-- Xenon Luxury Apartment C: luxury apartment, entrance and bath door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lux_c','Xenon Luxury Apartment C','','',110000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_c','h9_xe_lux_c');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_cbath','h9_xe_lux_c');
-- Xenon Luxury Apartment D: luxury apartment, entrance and bath door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lux_d','Xenon Luxury Apartment D','','',110000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_d','h9_xe_lux_d');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_dbath','h9_xe_lux_d');

-- Xenon City, the dead doors given a property: the underground's blast doors, the elevator, the level doors, the pods and hideouts of the lower level, the offices and plants of the top level
-- Underground Public Gate: two of the four blast doors of the underground (216 x 177, they rise into the lintel); the public pair, open state property that nobody can buy, so the door opens to a touch or the use key
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_ug_public','Underground Public Gate','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_ug_pub_1','h9_xe_ug_public');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_ug_pub_2','h9_xe_ug_public');
-- Underground Commercial Gate: the other two blast doors of the underground, the commercial pair; open state property that nobody can buy
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_ug_commercial','Underground Commercial Gate','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_ug_com_1','h9_xe_ug_commercial');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_ug_com_2','h9_xe_ug_commercial');
-- Xenon Elevator: the shaft gates of the main elevator at its three stops (the concourse, the fourth level, the fifth level); nothing in the map opened them, so the car was reachable by nobody; open state property that nobody can buy
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_elevator','Xenon Elevator','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_third_gate','h9_xe_elevator');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_fourth_gate','h9_xe_elevator');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_fifth_gate','h9_xe_elevator');
-- Xenon Level Doors: the four level doors of the top hall (LEVEL I, II, III signs, one closed set of rooms behind them); open state property that nobody can buy
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_level_doors','Xenon Level Doors','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_secondfloor','h9_xe_level_doors');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_thirdfloor','h9_xe_level_doors');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_fourthfloor','h9_xe_level_doors');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_fifthfloor','h9_xe_level_doors');
-- Underground Data Room: the data room of the underground: one rotating door into a closed room of about 90k square units; a workroom for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_ug_data_room','Underground Data Room','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_ug_data','h9_xe_ug_data_room');
-- Underground Distillery: the distillery of the underground: one rotating door into a closed room of about 70k square units; a business for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_ug_distillery','Underground Distillery','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_ug_distil','h9_xe_ug_distillery');
-- Underground Hideout: a hideout of the underground: one rotating door into a closed room of about 94k square units; for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_ug_hideout','Underground Hideout','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_ug_hideout','h9_xe_ug_hideout');
-- Gang Hideout: the gang's hideout of the lower level: its gate (a closed room of about 32k square units) and the grate hatch named for it (room not measured); for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_gang_hideout','Gang Hideout','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gang_hideout','h9_xe_gang_hideout');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gang_hideout1','h9_xe_gang_hideout');
-- Hex Pod 1: a hex pod of the lower level, one door into a room of about 11k square units
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_hex_pod1','Hex Pod 1','','',3600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_hex_1','h9_xe_hex_pod1');
-- Hex Pod 2: a hex pod of the lower level, one door into a room of about 5k square units
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_hex_pod2','Hex Pod 2','','',3600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_hex_2','h9_xe_hex_pod2');
-- Hex Pod 3: a hex pod of the lower level, one door into a room of about 29k square units
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_hex_pod3','Hex Pod 3','','',3600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_hex_3','h9_xe_hex_pod3');
-- Rectangular Pod 1: a rectangular pod of the lower level, one door into a room of about 29k square units
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_rect_pod1','Rectangular Pod 1','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_rect_1','h9_xe_rect_pod1');
-- Rectangular Pod 2: a rectangular pod of the lower level, one door into a room of about 33k square units
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_rect_pod2','Rectangular Pod 2','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_rect_2','h9_xe_rect_pod2');
-- Rectangular Pod 3: a rectangular pod of the lower level, one door into a room of about 33k square units
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_rect_pod3','Rectangular Pod 3','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_rect_3','h9_xe_rect_pod3');
-- Rectangular Pod 4: a rectangular pod of the south row of the lower level (room not measured); a pod is one small room
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_rect_pod4','Rectangular Pod 4','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_rect_4','h9_xe_rect_pod4');
-- Rectangular Pod 5: a rectangular pod of the south row of the lower level (room not measured); a pod is one small room
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_rect_pod5','Rectangular Pod 5','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_rect_5','h9_xe_rect_pod5');
-- Rectangular Pod 6: a rectangular pod of the south row of the lower level (room not measured); a pod is one small room
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_rect_pod6','Rectangular Pod 6','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_rect_6','h9_xe_rect_pod6');
-- Xenon City Office: the office of the top level: its blast gate and the pair of glass doors behind it (room not measured); an office for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_city_office','Xenon City Office','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cityoffice_gate','h9_xe_city_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_city_office_door1','h9_xe_city_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_city_office_door2','h9_xe_city_office');
-- Xenon Office: the second office of the top level: its blast gate and the pair of glass doors behind it (a closed room of about 38k square units); an office for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_office','Xenon Office','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_office_gate','h9_xe_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_office_door1','h9_xe_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_office_door2','h9_xe_office');
-- Cyber Lab: the cyber lab of the top level: gate and inner door; state property sealed to the Ministry of Defense
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_cyber_lab','Cyber Lab','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cyblab_gate','h9_xe_cyber_lab');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_cyblab_door','h9_xe_cyber_lab');
-- Data Center: the data center of the top level: gate and two inner doors; state property sealed to the Ministry of Defense
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_data_centre','Data Center','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_datacom_gate','h9_xe_data_centre');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_datacom_door1','h9_xe_data_centre');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_datacom_door2','h9_xe_data_centre');
-- Generator Station 5: the fifth generator station of the top level: gate and inner door; state property sealed to the Ministry of Defense
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_generator','Generator Station 5','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gen5_gate','h9_xe_generator');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gen5_door','h9_xe_generator');
-- Lab Control: the lab control room of the top level: gate and inner door; state property sealed to the Ministry of Defense
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lab_control','Lab Control','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lcon_gate','h9_xe_lab_control');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lcon_door','h9_xe_lab_control');

-- Alexandria
-- Cafe Fortress (H&C Coffee): the door from the cafe hall to the room east of it (the flood fill joins it to the cafe; an H&C COFFEE sign hangs there; it is shut in the map)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_cafe_fortress_back','Cafe Fortress (H&C Coffee)','','',57000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgocafed1','h9_al_cafe_fortress_back');
-- Catacombs: the catacomb bar: its entrance (starts open) and the door to its back room (the flood fill joins them); a business to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_catacombs','Catacombs','','',110000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_catacombone','h9_al_catacombs');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_catacombstwo','h9_al_catacombs');
-- Xaelem Ribs: the ribs restaurant of the Xaelem street (a RIBS sign hangs 236 units from the door); a business to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_ribs','Xaelem Ribs','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_xaelemribs','h9_al_ribs');
-- Golgotha Club: the night club: gate (starts open), booth, cocktail bar and boss office, one hall (the flood fill puts gate, booth and bar on the same hall); a business to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha_club','Golgotha Club','','',57000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_clubgate','h9_al_golgotha_club');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoclubbooth','h9_al_golgotha_club');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoclubbar','h9_al_golgotha_club');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_clubboss','h9_al_golgotha_club');
-- Golgotha Apartment 4: an apartment of the Golgotha block, two doors (the flood fill joins them)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha4','Golgotha Apartment 4','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoaptfour','h9_al_golgotha4');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgofourdoor','h9_al_golgotha4');
-- Golgotha Apartment 5: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha5','Golgotha Apartment 5','','',57000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoaptfive','h9_al_golgotha5');
-- Golgotha Apartment 6: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha6','Golgotha Apartment 6','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgapartment6','h9_al_golgotha6');
-- Xaelem Apartment 2: a flat of the Xaelem block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem2','Xaelem Apartment 2','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_xaelemapttwo','h9_al_xaelem2');
-- Xaelem Apartment 4: a flat of the Xaelem block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem4','Xaelem Apartment 4','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_xaelemaptfour','h9_al_xaelem4');
-- Xaelem Apartment 5: a flat of the Xaelem block (the door is named apt five xae)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem5','Xaelem Apartment 5','','',57000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_aptfivexae','h9_al_xaelem5');
-- Xaelem Apartment 6: a flat of the Xaelem block (the door is named apt six xael)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem6','Xaelem Apartment 6','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_aptsixxael','h9_al_xaelem6');
-- Cosmos Apartment: a flat (cosmosapt)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_cosmos','Cosmos Apartment','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_cosmosapt','h9_al_cosmos');
-- Eskimo Home: a home (eskimohome)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_eskimo','Eskimo Home','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_eskimohome','h9_al_eskimo');
-- Midgar House One: a house of Midgar: its entrance and two inner doors (one closed complex)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_midgar_house1','Midgar House One','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgarhouseone','h9_al_midgar_house1');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgarhone2','h9_al_midgar_house1');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgarhone3','h9_al_midgar_house1');
-- Midgar House Two: a house of Midgar: its entrance and its bedroom door (one closed complex)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_midgar_house2','Midgar House Two','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgahousetwo','h9_al_midgar_house2');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgahousetwobed','h9_al_midgar_house2');

-- Alexandria, the dead doors given a property: the Aurora labs, the Midgar and Golgotha workrooms, the hideout, the stash, the vaults and the core controls
-- Aurora Laboratories: the three labs of the Aurora and the lab entrance, one closed set of rooms of about 270k square units at the foot of the city; state property sealed to the Ministry of Defense
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_aurora_labs','Aurora Laboratories','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_auroraslabone','h9_al_aurora_labs');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_auroraslabtwo','h9_al_aurora_labs');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_auroraslabthree','h9_al_aurora_labs');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_labentrance','h9_al_aurora_labs');
-- Aurora Map Room: the map room of the Aurora: one door into a closed room of about 29k square units; state property sealed to the Ministry of Defense
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_aurora_maps','Aurora Map Room','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_auroramaps','h9_al_aurora_maps');
-- Aurora Annex: a vault door of the Aurora into a closed room of about 69k square units; state property sealed to the Ministry of Defense
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_aurora_annex','Aurora Annex','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_auroranever','h9_al_aurora_annex');
-- Cult Gate: the gate of a hall of about 47k square units in the lower Golgotha lanes; for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_cult_gate','Cult Gate','','',15000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_cultgate','h9_al_cult_gate');
-- Stash of Ash: a stash room of about 12k square units; a stall for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_stash','Stash of Ash','','',3600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_stashofash','h9_al_stash');
-- Golgotha Hideout: the hideout under the Golgotha block, one door into a closed room of about 197k square units; for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha_hideout','Golgotha Hideout','','',29000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgohideout','h9_al_golgotha_hideout');
-- Golgotha Armoury: the armour room off the Golgotha hall, a closed room of about 28k square units; sealed to the Ministry of Defense
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha_armoury','Golgotha Armoury','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgomen1armr','h9_al_golgotha_armoury');
-- Xaelem Industrial Unit: the industrial unit of the Xaelem block, a closed room of about 138k square units; for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem_industrial','Xaelem Industrial Unit','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_industrialinxae','h9_al_xaelem_industrial');
-- K-Line Safe: the vault door of the K-Line's safe, a closed room of about 38k square units; sealed, like the store
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_klines_safe','K-Line Safe','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_klinesafe','h9_al_klines_safe');
-- Midgar Office: the office of Midgar and everything under it, one property: the office's two doors, the kiosk window, the two doors of the car that runs down to the Shores (al_clabshores and al_shoresclab, use-only doors that the game opens to any use key, so the lock does not hold them; the car's platform al_lift and the offices' elevator al_midgar.elev.offices are not bound) and the two cell doors of the Shores corridor below, which has no detention building of its own; closed rooms of about 800k square units in all, seven doors; an office for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_midgar_office','Midgar Office','','',110000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgaroffice','h9_al_midgar_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_theofficedoormid','h9_al_midgar_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgarkiosk','h9_al_midgar_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_clabshores','h9_al_midgar_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_shoresclab','h9_al_midgar_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_shorescell','h9_al_midgar_office');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_shorestwoc','h9_al_midgar_office');
-- Midgar Fabrication Shop: the fabricating room of Midgar, a rotating door of the east block (room not measured); a workroom for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_fabrication','Midgar Fabrication Shop','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_fabricatdoor','h9_al_fabrication');
-- Midgar Routing Office: the routing office of Midgar, a closed room of about 49k square units; for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_routing_office','Midgar Routing Office','','',7200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgarrouting','h9_al_routing_office');
-- Routing Depot: the routing door of the lower east block of Midgar (room not measured); a workroom for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_routing_depot','Routing Depot','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_routingdoor','h9_al_routing_depot');
-- Tech Vault: the vault gate east of the park (a rotating grate door, 154 wide, at 1720 1711 -2308); room not measured; a vault for sale
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_tech_vault','Tech Vault','','',14000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_techvaultgate','h9_al_tech_vault');
-- Maintenance Core Controls: the core kill switch console, a door that moves nowhere and fires the maintenance core's first gate; open state property that nobody can buy, so the use key works it
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_core_controls','Maintenance Core Controls','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_corekillswitch','h9_al_core_controls');
