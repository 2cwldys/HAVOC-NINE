-- Apollo RP on h9_tsrp_hive: the Ministry of Defense ranks and the civilian jobs. ARP_CONTENT.txt (docs) says what each is.
-- Loaded by an ARP admin on this map: console arp_config, entry 3 "Load Map SQL Data". Written against ARP's default
-- table names (arp_jobs); the loader swaps in this map's own jobs table, arp_jobs_h9_tsrp_hive.
-- Every row is INSERT OR IGNORE: loading the file twice changes nothing, and a row an admin edited stays as edited.
-- A line that starts with - ; or # is skipped by the loader. One statement to a line.
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
