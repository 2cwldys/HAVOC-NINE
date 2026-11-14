-- Apollo RP on h9_tsrp_newbyzantium: the Ministry of Defense ranks and the civilian jobs, then the properties and doors. ARP_CONTENT.txt (docs) says what each is.
-- Run by ARP_Core itself at every start of this map (arp_mapsql_autoload 1 in arp.cfg), after the tables are made and before the
-- jobs, properties and doors are read, so the rows are there in the same map load. An ARP admin can also run it by hand: console arp_config, entry 3
-- "Load Map SQL Data". Written against ARP's default table names (arp_jobs, arp_property, arp_doors); the loader swaps in this map's own tables
-- (arp_jobs_h9_tsrp_newbyzantium, arp_property_h9_tsrp_newbyzantium, arp_doors_h9_tsrp_newbyzantium).
-- Every row is INSERT OR IGNORE: running the file again changes nothing, and a row an admin edited stays as edited.
-- To be run by itself every statement must be  INSERT OR IGNORE INTO arp_jobs (or arp_property, arp_doors) VALUES (...);  one to a line, the table name in
-- lower case, nothing after the ;  (docs\ARP_CONTENT.txt, section 2, has the whole rule). A line that starts with - ; or # is skipped.
-- Columns: name, salary paid every 60 seconds into the bank, access letters (a police, b medical, z ARP admin: the
-- Administrator job only; c d e f are the hiring tiers and g is the Lord Minister's own letter: see ARP_CONTENT.txt, section 4).
-- Unemployed pays 0, so that a character takes a job to be paid. pay.ini, in this folder, sets what a job is paid in place of what its row says, in a database that has the row
-- already too (docs\ARP_CONTENT.txt, section 3).

-- Civilians
INSERT OR IGNORE INTO arp_jobs VALUES ('Unemployed',0,'');
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

-- ==== Properties and doors (docs\ARP_CONTENT.txt, section 9): the precincts, checkpoints and the headquarters ====
-- A property is a building or a place the look-at plaque names; its doors are func_door entities of this map, one row each, by their targetname
-- (t|<targetname>), every one an entity of the compiled map. Property columns: internalname, externalname (what the plaque shows), ownername,
-- ownerauth, price, locked, access letters, profit. No owner and price 0 is state property; a price and no owner is for sale (say /buy).
-- locked 1 keeps a door as the map has it and leaves it to the owner, a key holder or the access letters (a Ministry of Defense, b Medical
-- Division, g the Lord Minister's own); locked 0 is open to anyone. The affiliation the plaque shows comes from the access letters.
-- Doors the map did not give a name cannot be bound here (docs\ARP_CONTENT.txt, section 9). The four wall panels of the jails (h9_jail) are made by
-- ARP_JailMod, not by this file.

-- North Precinct: the front desk, core door and cells of the north precinct
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_precinct_n','North Precinct','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_n_desk','h9_nb_precinct_n');
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_n_coredoor','h9_nb_precinct_n');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_n_0','h9_nb_precinct_n');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_n_1','h9_nb_precinct_n');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_n_2','h9_nb_precinct_n');
-- East Precinct: the front desk, core door and cells of the east precinct
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_precinct_e','East Precinct','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_e_desk','h9_nb_precinct_e');
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_e_coredoor','h9_nb_precinct_e');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_e_0','h9_nb_precinct_e');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_e_1','h9_nb_precinct_e');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_e_2','h9_nb_precinct_e');
-- South Precinct: the front desk, core door and cells of the south precinct
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_precinct_s','South Precinct','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_s_desk','h9_nb_precinct_s');
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_s_coredoor','h9_nb_precinct_s');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_s_0','h9_nb_precinct_s');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_s_1','h9_nb_precinct_s');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_s_2','h9_nb_precinct_s');
-- West Precinct: the front desk, core door and cells of the west precinct
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_precinct_w','West Precinct','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_w_desk','h9_nb_precinct_w');
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_w_coredoor','h9_nb_precinct_w');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_w_0','h9_nb_precinct_w');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_w_1','h9_nb_precinct_w');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_w_2','h9_nb_precinct_w');
-- North-East Precinct: the front desk, core door and cells of the north-east precinct
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_precinct_en','North-East Precinct','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_en_desk','h9_nb_precinct_en');
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_en_coredoor','h9_nb_precinct_en');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_en_0','h9_nb_precinct_en');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_en_1','h9_nb_precinct_en');
-- South-East Precinct: the front desk, core door and cells of the south-east precinct
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_precinct_es','South-East Precinct','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_es_desk','h9_nb_precinct_es');
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_es_coredoor','h9_nb_precinct_es');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_es_0','h9_nb_precinct_es');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_es_1','h9_nb_precinct_es');
-- South-West Precinct: the front desk, core door and cells of the south-west precinct
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_precinct_ws','South-West Precinct','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_ws_desk','h9_nb_precinct_ws');
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_ws_coredoor','h9_nb_precinct_ws');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_ws_0','h9_nb_precinct_ws');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_ws_1','h9_nb_precinct_ws');
-- North-West Precinct: the front desk, core door and cells of the north-west precinct
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_precinct_wn','North-West Precinct','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_wn_desk','h9_nb_precinct_wn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|precinct_wn_coredoor','h9_nb_precinct_wn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_wn_0','h9_nb_precinct_wn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_wn_1','h9_nb_precinct_wn');
-- North Sewer Checkpoint: the door and cell of the north sewer checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_sewer_n','North Sewer Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_sewer_n_door','h9_nb_sewer_n');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_sewer_n','h9_nb_sewer_n');
-- East Sewer Checkpoint: the door and cell of the east sewer checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_sewer_e','East Sewer Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_sewer_e_door','h9_nb_sewer_e');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_sewer_e','h9_nb_sewer_e');
-- South Sewer Checkpoint: the door and cell of the south sewer checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_sewer_s','South Sewer Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_sewer_s_door','h9_nb_sewer_s');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_sewer_s','h9_nb_sewer_s');
-- West Sewer Checkpoint: the door and cell of the west sewer checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_sewer_w','West Sewer Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_sewer_w_door','h9_nb_sewer_w');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_sewer_w','h9_nb_sewer_w');
-- North-East Sewer Checkpoint: the door and cell of the north-east sewer checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_sewer_en','North-East Sewer Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_sewer_en_door','h9_nb_sewer_en');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_sewer_en','h9_nb_sewer_en');
-- South-East Sewer Checkpoint: the door and cell of the south-east sewer checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_sewer_es','South-East Sewer Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_sewer_es_door','h9_nb_sewer_es');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_sewer_es','h9_nb_sewer_es');
-- South-West Sewer Checkpoint: the door and cell of the south-west sewer checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_sewer_ws','South-West Sewer Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_sewer_ws_door','h9_nb_sewer_ws');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_sewer_ws','h9_nb_sewer_ws');
-- North-West Sewer Checkpoint: the door and cell of the north-west sewer checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_sewer_wn','North-West Sewer Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_sewer_wn_door','h9_nb_sewer_wn');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_sewer_wn','h9_nb_sewer_wn');
-- North Ward Checkpoint: the doors and cell of the north ward checkpoint
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_ward_n','North Ward Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_ward_n_door','h9_nb_ward_n');
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_ward_n_wing','h9_nb_ward_n');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_ward_n','h9_nb_ward_n');
-- East Ward Checkpoint: the doors and cell of the east ward checkpoint
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_ward_e','East Ward Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_ward_e_door','h9_nb_ward_e');
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_ward_e_wing','h9_nb_ward_e');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_ward_e','h9_nb_ward_e');
-- South Ward Checkpoint: the doors and cell of the south ward checkpoint
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_ward_s','South Ward Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_ward_s_door','h9_nb_ward_s');
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_ward_s_wing','h9_nb_ward_s');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_ward_s','h9_nb_ward_s');
-- West Ward Checkpoint: the doors and cell of the west ward checkpoint
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_ward_w','West Ward Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_ward_w_door','h9_nb_ward_w');
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_ward_w_wing','h9_nb_ward_w');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_ward_w','h9_nb_ward_w');
-- North Mese Checkpoint: the door and cell of the north Mese checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_mese_n','North Mese Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_mese_n_door','h9_nb_mese_n');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_mese_n','h9_nb_mese_n');
-- East Mese Checkpoint: the door and cell of the east Mese checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_mese_e','East Mese Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_mese_e_door','h9_nb_mese_e');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_mese_e','h9_nb_mese_e');
-- South Mese Checkpoint: the door and cell of the south Mese checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_mese_s','South Mese Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_mese_s_door','h9_nb_mese_s');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_mese_s','h9_nb_mese_s');
-- West Mese Checkpoint: the door and cell of the west Mese checkpoint (the gate is left open)
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_mese_w','West Mese Checkpoint','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|checkpoint_mese_w_door','h9_nb_mese_w');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_mese_w','h9_nb_mese_w');
-- Ministry Headquarters: the lobby stair door and the front desk of the headquarters in the Nexus
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_hq','Ministry Headquarters','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|hq_stair_lobby','h9_nb_hq');
INSERT OR IGNORE INTO arp_doors VALUES ('t|hq_desk','h9_nb_hq');
-- Headquarters Armoury: the armoury door
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_hq_armoury','Headquarters Armoury','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|hq_armory_door','h9_nb_hq_armoury');
-- Interrogation Room: the interrogation room door
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_hq_interrogation','Interrogation Room','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|hq_interrogation_door','h9_nb_hq_interrogation');
-- Headquarters Garage: the garage shutter
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_hq_garage','Headquarters Garage','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|hq_garage_shutter','h9_nb_hq_garage');
-- Headquarters Jail: the jail door and its twelve cells
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_hq_jail','Headquarters Jail','','',0,1,'a',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|jail_hq_door','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_0','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_1','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_2','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_3','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_4','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_5','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_6','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_7','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_8','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_9','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_10','h9_nb_hq_jail');
INSERT OR IGNORE INTO arp_doors VALUES ('t|cell_hq_11','h9_nb_hq_jail');
-- Commander's Office: the commander's office, its stair and its tunnel door: the Lord Minister's own letter g
INSERT OR IGNORE INTO arp_property VALUES ('h9_nb_commander','Commander''s Office','','',0,1,'g',0);
INSERT OR IGNORE INTO arp_doors VALUES ('t|commander_office','h9_nb_commander');
INSERT OR IGNORE INTO arp_doors VALUES ('t|commander_stair','h9_nb_commander');
INSERT OR IGNORE INTO arp_doors VALUES ('t|commander_tunnel','h9_nb_commander');
