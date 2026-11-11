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

-- Optional, the Medical Division above the Ensign (the museum's list stops at M-Ensign). Remove the leading "-- " to use a line.
-- INSERT OR IGNORE INTO arp_jobs VALUES ('M-Sergeant 1',45,'bd');
-- INSERT OR IGNORE INTO arp_jobs VALUES ('M-Sergeant 2',50,'bd');
-- INSERT OR IGNORE INTO arp_jobs VALUES ('M-Lieutenant',60,'bd');

-- ==== Properties and doors (docs\ARP_CONTENT.txt, section 9): the Ministry's posts, clinics, shops, businesses and homes ====
-- A property is a building or a place the look-at plaque names; its doors are func_door entities of this map, one row each, by their targetname
-- (t|<targetname>), every one an entity of the compiled map. Property columns: internalname, externalname (what the plaque shows), ownername,
-- ownerauth, price, locked, access letters, profit. No owner and price 0 is state property; a price and no owner is for sale (say /buy).
-- locked 1 keeps a door as the map has it and leaves it to the owner, a key holder or the access letters (a Ministry of Defense, b Medical
-- Division, g the Lord Minister's own); locked 0 is open to anyone. The affiliation the plaque shows comes from the access letters.
-- A property may have several doors, but its lock is one: a shop whose front door starts open and whose back door is shut is two properties with one name.
-- Doors the map did not name cannot be bound here (docs\ARP_CONTENT.txt, section 9). The four wall panels of the jails (h9_jail) are made by
-- ARP_JailMod, not by this file.

-- Gear Guys: front door of the red wood shop (Gear Guys Arms Dealer, Gear Guys Ammunition Counter inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_gear_guys','Gear Guys','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_techromagna','h9_pc_gear_guys');
-- Uncle Pikkys Pizzeria: entrance doors of the pizzeria (Uncle Pikkys Pizzeria NPC inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_pikkys','Uncle Pikkys Pizzeria','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_unclepikkysentra','h9_pc_pikkys');
-- Cybernetics: the machine door of the Cybernetics lane's rear chamber (the Black Market NPC stands inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_cybernetics','Cybernetics','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_cybernetc','h9_pc_cybernetics');
-- Paradise Bank: the bank building's automatic glass doors (opened by their own trigger, so not locked)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_bank','Paradise Bank','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_bankdoor','h9_pc_bank');
-- Pawn Prawn Staff Room: the staff door behind the Pawn Prawn bar counter; also the hatch in the floor of the chamber behind the staff door, the hideout under it and its far door: the flood fill of the map's space joins the staff door, the chamber, the hatch and the hideout, and the doors are named pp
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_pawn_prawn','Pawn Prawn Staff Room','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_noodles1','h9_pc_pawn_prawn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_pphideout1','h9_pc_pawn_prawn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_pphideout','h9_pc_pawn_prawn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_pphideout3','h9_pc_pawn_prawn');
-- Romagna Clinic: the ward doors of the white waiting hall (Romagna Clinic Medical Officer outside them)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_romagna_clinic','Romagna Clinic','','',0,1,'b',0);
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
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_cafe_avalon','Paradise Cafe','','',12000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_cafe1door','h9_pc_cafe_avalon');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_cafe2door','h9_pc_cafe_avalon');
-- Paradise Flat 1: a residence door in the south west blocks
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res1','Paradise Flat 1','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident1','h9_pc_flat_res1');
-- Paradise Flat 2: a residence with a street door and a park door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res2','Paradise Flat 2','','',3000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident2','h9_pc_flat_res2');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident2park','h9_pc_flat_res2');
-- Paradise Flat 3: a residence with a street door and a park door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res3','Paradise Flat 3','','',3000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident3','h9_pc_flat_res3');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident3park','h9_pc_flat_res3');
-- Guns n Stuff: front door of the gun shop (Guns n Stuff Arms Dealer, Ammunition Counter inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_guns_n_stuff','Guns n Stuff','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gunshop','h9_xe_guns_n_stuff');
-- Green Dragon: front door of the restaurant (Green Dragon Cantina inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_green_dragon','Green Dragon','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_processedfood1','h9_xe_green_dragon');
-- Xenon City Gear: front door of the store (Xenon City Gear General Store inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_city_gear','Xenon City Gear','','',0,0,'',0);
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
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_clinic','Xenon Clinic','','',0,1,'b',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_clinic_off','h9_xe_clinic');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_clinic_op','h9_xe_clinic');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_clinic_rest','h9_xe_clinic');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_clinic_wing','h9_xe_clinic');
-- Sky Bar: the bar of the upper level (the gate starts open): a place to run; also the drawer of the bar's counter (xe_skyb_ prefix, inside the bar); locked whole: a bar for sale is sealed until bought (its gate starts open and stays open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_sky_bar','Sky Bar','','',9600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_skyb_gate','h9_xe_sky_bar');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_skyb_door1','h9_xe_sky_bar');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_skyb_door2','h9_xe_sky_bar');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_skyb_drawer','h9_xe_sky_bar');
-- Xenon Apartment 1: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt1','Xenon Apartment 1','','',4800,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door1a','h9_xe_apt1');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door1b','h9_xe_apt1');
-- Xenon Apartment 2: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt2','Xenon Apartment 2','','',4800,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door2a','h9_xe_apt2');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door2b','h9_xe_apt2');
-- Xenon Apartment 3: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt3','Xenon Apartment 3','','',4800,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door3a','h9_xe_apt3');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door3b','h9_xe_apt3');
-- Xenon Luxury Apartment A: luxury apartment, entrance and bath door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lux_a','Xenon Luxury Apartment A','','',9600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_a','h9_xe_lux_a');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_abath','h9_xe_lux_a');
-- Cafe Fortress (H&C Coffee): the two doors of the cafe on the main street (H&C Coffee Cantina inside)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_cafe_fortress','Cafe Fortress (H&C Coffee)','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_cafe.fortress','h9_al_cafe_fortress');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_cafefortress','h9_al_cafe_fortress');
-- K-Line Super Store: the south door of the supermarket (the open side is the park)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_kline','K-Line Super Store','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_klinedoor','h9_al_kline');
-- Midgar Lab: the lab gate (the console al_labentbutton opens it; Midgar Lab Medical Officer inside); also the console itself, al_labentbutton, a use-only door brush whose target is al_midgar.lab.gate.one
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_midgar_lab','Midgar Lab','','',0,1,'b',0);
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
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_steakhouse','Ed''s Steak House','','',12000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_edssteak','h9_al_steakhouse');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_steakexit','h9_al_steakhouse');
-- Golgotha Apartment 1: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha1','Golgotha Apartment 1','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoapartment1','h9_al_golgotha1');
-- Golgotha Apartment 2: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha2','Golgotha Apartment 2','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoapartment2','h9_al_golgotha2');
-- Golgotha Apartment 3: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha3','Golgotha Apartment 3','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgo.apt3.1','h9_al_golgotha3');

-- More properties, by city. A lock belongs to a property, so a shop whose front door starts open and whose back, side or staff door is shut is two properties with one name:
-- the front one unlocked, the one of the shut doors locked. Homes and businesses for sale are locked whole, at the price of their kind (docs\ARP_CONTENT.txt, 9).

-- Paradise City
-- Uncle Pikkys Pizzeria: the east door and the oven door of the pizzeria (unclepikky prefix, the kitchen on its north side; both shut in the map)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_pikkys_back','Uncle Pikkys Pizzeria','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_unclepikkyse','h9_pc_pikkys_back');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_oven_door','h9_pc_pikkys_back');
-- Gear Guys (South West): front door of the second Gear Guys, south west (a GEARGUYS sign hangs over it; it starts open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_gear_guys_sw','Gear Guys (South West)','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_gearshop1','h9_pc_gear_guys_sw');
-- Gear Guys (South West): the shop's side door and pc_edenoffice2, an Eden office door of the same walled compound (the compound's other office door, pc_edenoffice1, wears the same name as the back office of the first Gear Guys and cannot be bound)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_gear_guys_sw_back','Gear Guys (South West)','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_gearshop2','h9_pc_gear_guys_sw_back');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_edenoffice2','h9_pc_gear_guys_sw_back');
-- Eden News: front door of the news office (a PCN sign hangs by it; a button works it, it starts open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_eden_news','Eden News','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_edennews','h9_pc_eden_news');
-- Eden News: the newsroom door behind it (the two doors bound one closed complex)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_eden_news_back','Eden News','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_newsroom1','h9_pc_eden_news_back');
-- Tartec: the automatic front doors (a trigger opens them) of the Tartec building, two halves of one name
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_tartec','Tartec','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_tartec_frt','h9_pc_tartec');
-- SkyTech: the SkyTech building: its gates, the two lab doors on the upper floor, the computer core hatch and the operating room (the flood fill joins them through skytechgate4); pc_skytechgate2 shares its name with a door elsewhere and is not bound
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_skytech','SkyTech','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_skytechgate','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_skytechgate1','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_skytechgate3','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_skytechgate4','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_labdoor1sky','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_labdoor2sky','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_computercore','h9_pc_skytech');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_operatingroom1','h9_pc_skytech');
-- Paradise Flat 4: a flat of the lower level (its door starts open and stays open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res4','Paradise Flat 4','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident4','h9_pc_flat_res4');
-- Paradise Flat 4A: named 4a, 1,100 units from pc_resident4 and a floor lower: a flat of its own, not a second door of flat 4
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res4a','Paradise Flat 4A','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident4a','h9_pc_flat_res4a');
-- Paradise Flat 5: a residence door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res5','Paradise Flat 5','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident5','h9_pc_flat_res5');
-- Paradise Flat 6: a residence door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res6','Paradise Flat 6','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident6','h9_pc_flat_res6');
-- Paradise Flat 7: a flat of the lower level
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res7','Paradise Flat 7','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident7','h9_pc_flat_res7');
-- Paradise Flat 8: a residence door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res8','Paradise Flat 8','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident8','h9_pc_flat_res8');
-- Paradise Flat 9: a residence door
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_res9','Paradise Flat 9','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_resident9','h9_pc_flat_res9');
-- Paradise Citizen Flat 1: a citizen's flat east of the Romagna hall
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit1','Paradise Citizen Flat 1','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen1','h9_pc_flat_cit1');
-- Paradise Citizen Flat 2: a citizen's flat east of the Romagna hall
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit2','Paradise Citizen Flat 2','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen2','h9_pc_flat_cit2');
-- Paradise Citizen Flat 3: a flat with a street door (starts open) and an upper door (the flood fill joins them)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit3','Paradise Citizen Flat 3','','',3000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen3','h9_pc_flat_cit3');
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen3a','h9_pc_flat_cit3');
-- Paradise Citizen Flat 4: a citizen's flat
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit4','Paradise Citizen Flat 4','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen4','h9_pc_flat_cit4');
-- Paradise Citizen Flat 5: a citizen's flat
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit5','Paradise Citizen Flat 5','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen5','h9_pc_flat_cit5');
-- Paradise Citizen Flat 6: a citizen's flat
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_flat_cit6','Paradise Citizen Flat 6','','',2400,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_citizen6','h9_pc_flat_cit6');
-- K Tower Suite: the suite door inside K Tower (luxury tier)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_ktower_suite','K Tower Suite','','',9600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_ktowersuite','h9_pc_ktower_suite');
-- Storage Unit 1: one of four equal unit doors in a row (137 apart) on the lower level; an hour's pay
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage1','Storage Unit 1','','',1200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storage1','h9_pc_storage1');
-- Storage Unit 2: a storage unit
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage2','Storage Unit 2','','',1200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storage2','h9_pc_storage2');
-- Storage Unit 3: a storage unit
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage3','Storage Unit 3','','',1200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storage3','h9_pc_storage3');
-- Storage Unit 4: a storage unit
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage4','Storage Unit 4','','',1200,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storage4','h9_pc_storage4');
-- Storage Gate: the gate of the storage corridor (state)
INSERT OR IGNORE INTO arp_property VALUES ('h9_pc_storage_gate','Storage Gate','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|pc_storagegate','h9_pc_storage_gate');

-- Xenon City
-- Guns n Stuff: the back door at the end of the back hall (shut in the map)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_guns_n_stuff_back','Guns n Stuff','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gunshop1','h9_xe_guns_n_stuff_back');
-- Green Dragon: the side door of the restaurant (shut in the map; a dragon sign hangs by it)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_green_dragon_side','Green Dragon','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_processedfood2','h9_xe_green_dragon_side');
-- Xenon City Gear: the back door of the store (shut in the map; the flood fill joins it to the shop)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_city_gear_back','Xenon City Gear','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_gearshop1','h9_xe_city_gear_back');
-- Xenon Clinic: the clinic's entrance gate (the XENON CLINIC sign hangs 56 units from it; the flood fill joins it to the clinic doors; it starts open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_clinic_gate','Xenon Clinic','','',0,0,'b',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_broth_gate','h9_xe_clinic_gate');
-- Uncle Elzos: front gate of the restaurant (an UNCLE ELZOS sign hangs by it; it starts open; the door is named enzos)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_elzos','Uncle Elzos','','',0,0,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_enzos_gate','h9_xe_elzos');
-- Uncle Elzos: the oven door and the uez entrance, where the other UNCLE ELZOS sign hangs (as Uncle Pikkys has its oven door)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_elzos_back','Uncle Elzos','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_oven_door','h9_xe_elzos_back');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_uez_entrance1','h9_xe_elzos_back');
-- Electronics Store: the store's door (the name is cut at gam); a business to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_electronics','Electronics Store','','',12000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_electronicsstoregam','h9_xe_electronics');
-- Xenon Apartment 4: upper level apartment, two doors (the flood fill joins them)
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt4','Xenon Apartment 4','','',4800,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door4a','h9_xe_apt4');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door4b','h9_xe_apt4');
-- Xenon Apartment 5: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt5','Xenon Apartment 5','','',4800,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door5a','h9_xe_apt5');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door5b','h9_xe_apt5');
-- Xenon Apartment 6: upper level apartment, two doors
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_apt6','Xenon Apartment 6','','',4800,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door6a','h9_xe_apt6');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_apartment_door6b','h9_xe_apt6');
-- Xenon Luxury Apartment B: luxury apartment, entrance and bath door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lux_b','Xenon Luxury Apartment B','','',9600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_b','h9_xe_lux_b');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_bbath','h9_xe_lux_b');
-- Xenon Luxury Apartment C: luxury apartment, entrance and bath door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lux_c','Xenon Luxury Apartment C','','',9600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_c','h9_xe_lux_c');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_cbath','h9_xe_lux_c');
-- Xenon Luxury Apartment D: luxury apartment, entrance and bath door
INSERT OR IGNORE INTO arp_property VALUES ('h9_xe_lux_d','Xenon Luxury Apartment D','','',9600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_d','h9_xe_lux_d');
INSERT OR IGNORE INTO arp_doors VALUES ('t|xe_lux_apt_dbath','h9_xe_lux_d');

-- Alexandria
-- Cafe Fortress (H&C Coffee): the door from the cafe hall to the room east of it (the flood fill joins it to the cafe; an H&C COFFEE sign hangs there; it is shut in the map)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_cafe_fortress_back','Cafe Fortress (H&C Coffee)','','',0,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgocafed1','h9_al_cafe_fortress_back');
-- Catacombs: the catacomb bar: its entrance (starts open) and the door to its back room (the flood fill joins them); a business to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_catacombs','Catacombs','','',12000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_catacombone','h9_al_catacombs');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_catacombstwo','h9_al_catacombs');
-- Xaelem Ribs: the ribs restaurant of the Xaelem street (a RIBS sign hangs 236 units from the door); a business to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_ribs','Xaelem Ribs','','',12000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_xaelemribs','h9_al_ribs');
-- Golgotha Club: the night club: gate (starts open), booth, cocktail bar and boss office, one hall (the flood fill puts gate, booth and bar on the same hall); a business to run
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha_club','Golgotha Club','','',12000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_clubgate','h9_al_golgotha_club');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoclubbooth','h9_al_golgotha_club');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoclubbar','h9_al_golgotha_club');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_clubboss','h9_al_golgotha_club');
-- Golgotha Apartment 4: an apartment of the Golgotha block, two doors (the flood fill joins them)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha4','Golgotha Apartment 4','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoaptfour','h9_al_golgotha4');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgofourdoor','h9_al_golgotha4');
-- Golgotha Apartment 5: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha5','Golgotha Apartment 5','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgoaptfive','h9_al_golgotha5');
-- Golgotha Apartment 6: an apartment of the Golgotha block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_golgotha6','Golgotha Apartment 6','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_golgapartment6','h9_al_golgotha6');
-- Xaelem Apartment 2: a flat of the Xaelem block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem2','Xaelem Apartment 2','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_xaelemapttwo','h9_al_xaelem2');
-- Xaelem Apartment 4: a flat of the Xaelem block
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem4','Xaelem Apartment 4','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_xaelemaptfour','h9_al_xaelem4');
-- Xaelem Apartment 5: a flat of the Xaelem block (the door is named apt five xae)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem5','Xaelem Apartment 5','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_aptfivexae','h9_al_xaelem5');
-- Xaelem Apartment 6: a flat of the Xaelem block (the door is named apt six xael)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_xaelem6','Xaelem Apartment 6','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_aptsixxael','h9_al_xaelem6');
-- Cosmos Apartment: a flat (cosmosapt)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_cosmos','Cosmos Apartment','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_cosmosapt','h9_al_cosmos');
-- Eskimo Home: a home (eskimohome)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_eskimo','Eskimo Home','','',6000,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_eskimohome','h9_al_eskimo');
-- Midgar House One: a house of Midgar: its entrance and two inner doors (one closed complex)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_midgar_house1','Midgar House One','','',9600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgarhouseone','h9_al_midgar_house1');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgarhone2','h9_al_midgar_house1');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgarhone3','h9_al_midgar_house1');
-- Midgar House Two: a house of Midgar: its entrance and its bedroom door (one closed complex)
INSERT OR IGNORE INTO arp_property VALUES ('h9_al_midgar_house2','Midgar House Two','','',9600,1,'',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgahousetwo','h9_al_midgar_house2');
INSERT OR IGNORE INTO arp_doors VALUES ('t|al_midgahousetwobed','h9_al_midgar_house2');
