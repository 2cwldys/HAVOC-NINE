// The presence module's tables. Every one is named presence_..., and every row that belongs to an
// account points at accounts(id) with ON DELETE CASCADE, so deleting an account deletes its
// presence with it. Never edit a migration that has shipped; add the next one.
//
//   presence_settings   an account's privacy switches (show_game, show_where, show_web, show_site,
//                       show_playtime, show_last_seen): 1 show, 0 hide, NULL the default in
//                       moduleSettings.presence.privacy, so a changed default reaches everyone
//                       who never chose
//   presence_servers    per game server: what its last accepted report said (map, mode, detail),
//                       when it came (h9web's clock) and its own timestamp (the replay guard:
//                       a report must carry a later ts than the last accepted one)
//   presence_online     an account's open session on a server. since: when it started; last_at:
//                       when its time was last counted; plugin_at: the last report that listed it
//                       (NULL when the plugin does not); away_at: when the plugin stopped listing
//                       it (back within rejoinSeconds, the same session goes on); relay: 1 while
//                       the web client's relay says it is in game there; proven: 1 when the
//                       plugin's last sighting carried a valid proof of the player id; held: 1
//                       while the account is counted on another server at the same time;
//                       credited: 1 once any of its time has been counted; device and net: the
//                       hashes of the proven device and of the coarse network; seen_by: 1 the
//                       plugin, 2 the relay, 3 both; name: the in-game name; seconds: counted.
//                       In game now: plugin_at set or relay 1. Verified: proven or relay. Counted:
//                       in game, verified and not held
//   presence_sessions   finished sessions that counted time, kept sessionRetentionDays
//   presence_playtime   per account and server: seconds counted, first and last seen. An account
//                       with a row has been seen in game, verified (the badge)
//   presence_devices    the devices an account's proofs came from (hashes of the per-install
//                       device id): the first one binds ("bound"), an admin may allow more
//                       ("allowed"); a proof from any other device is refused and flagged
//   presence_flags      what admins should look at: a second device, a proof that does not check
//                       out or is too old, the account in game in two places. One open flag per
//                       account, kind and device or server, counting repeats
//   presence_nets       per account, the coarse networks (a keyed hash of an IPv4 /24 or an IPv6
//                       /48) its verified sightings came from, kept netRetentionDays, so a flag can
//                       say whether a network was the account's usual one

// v2 (enrollment and communities, H9_COMMUNITIES.txt):
//   presence_online.slot, presence_servers.name/humans/max   from the plugin's reports
//   presence_enrolled   per game server address: its public server_id; the live key's salt (the key
//                       is HMAC(<module data>/enroll-key, address + salt), never stored), whether an
//                       admin approved it, a pending enrollment (salt, a hash of its code, when), the
//                       last A2S_RULES probe, blocked, the last report
//   presence_server_flags   per server, for admins: re_enrolled, pending_approval
//   presence_nonces     the nonces of signed server calls other than reports, for 10 minutes
//   presence_communities, _community_staff, _community_servers   communities, their admins and
//                       their servers (each server in one community, with a chat tag)
//   presence_claims     one-time codes a server shows in its console, to link it to a community
//   presence_sanctions  bans and mutes per account: one community's, or H9-wide (community NULL)
//   presence_kicks      one-off kicks waiting for the account's server to report
//   presence_messages   community chat and announcements (H9-wide: community NULL), kept
//                       chatRetentionDays
//   presence_data, presence_data_log   the h9_community.inc store per community and account, and
//                       every change to it, kept dataLogRetentionDays, for rollback

// v3 (membership, H9_COMMUNITIES.txt section 3):
//   presence_communities.join_mode   open (anyone signed in joins), request (staff approve), invite
//   presence_communities.visibility  listed, unlisted (by link only), private (members only)
//   presence_communities.whitelist, whitelist_proof   members-only servers, and whether a member's
//                       game has to prove its player id to get in
//   presence_community_members    who belongs: the owner and every admin as well, added as they
//                       become one (and here for every community that had them before v3)
//   presence_community_requests   requests to join a request-mode community, until decided
//   presence_community_invites    invitations, until accepted, declined or withdrawn

// v4 (the ID proof, H9_PRESENCE.txt section 8):
//   presence_proof_nonces   the nonces h9web gave each server for its challenges, and when; a proof
//                       counts only while its nonce is younger than proofMaxAgeSeconds

// v6 (open chat, the Discord relay, game pictures):
//   presence_communities.chat_open   1: the web chat is open to every signed-in account, not only
//                       to members (the owner's switch; a private community's stays members-only)
//   presence_communities.discord_channel, discord_by, discord_at, discord_last   the Discord
//                       channel an H9 site admin bridged the community's chat with, who did and
//                       when, and the last Discord message relayed from it (H9_COMMUNITIES.txt
//                       section 4a)
//   presence_messages   rebuilt as it was, with 'discord' among the sources
//   presence_game_pictures   per account, the 64 x 64 PNG its owner's browser made of a JPEG or WebP
//                       profile picture, for the scoreboard, and the picture version it was made
//                       from (H9_PRESENCE.txt section 4b)

// v12 (the official preset and the server browser's chain, preset.js, H9_PRESENCE.txt section 4c):
//   presence_preset      the allowlist: one row per file an authenticated server may run (kind amxx, module or
//                       meta; the file's name; the SHA-256 of its bytes); optional 1 for what an admin added beside
//                       the official build's files (a "replace" import keeps it); who added it and when
//   presence_servers.plugins, plugins_at   what the server's last plugin list said (JSON, or "!" for a list
//                       that could not be read) and when it came
//   presence_servers.opted_out   1 while the server's last report said authenticated: false (its operator set
//                       h9_authenticated 0): it asked not to be authenticated or rated

// v13 (the day's limits on experience and on H9 ladder points, compete.js, H9_COMPETITIVE.txt section 9a):
//   compete_deltas_account, compete_matches_started   indexes, so what an account has been given since a UTC
//                       day began is read from its own rows and the day's matches, not from every table's

// v7 (Create Game servers, H9_PRESENCE.txt section 8a):
//   presence_enrolled.listen, pend_listen, owner_id   a listen server enrolled by its own player's ID
//                       proof (no A2S_RULES probe, no admin approval): its reports count proven
//                       players only and its address is never shown; pend_listen marks such an
//                       enrollment while it waits for the proof; owner_id is the account that proved it

// v14 (chat and shared data for proven players, community.js, H9_COMMUNITIES.txt section 2):
//   presence_communities.chat_proof, data_proof   1 unless the community's owner switched it off: a line
//                       relayed from a game, and a value read or written for a player, need a game that
//                       proved the player id (an announced h9_clientid can be copied by any player on the
//                       server). The columns hold 0 or 1 and nothing else, so they cannot tell a community
//                       whose owner chose 0 from one that never chose; every community that exists when
//                       this runs gets 1, and an owner who wants the announced id accepted switches the
//                       setting off on the community's page again. A new community is made with 1 and 1
//                       (community.js); the columns' own DEFAULT stays 0, as SQLite changes a default
//                       only by rebuilding the table, and dropping a table that others point at ON DELETE CASCADE deletes their rows

// v15 (the official preset per game mode, preset.js, H9_PRESENCE.txt section 4d):
//   presence_preset.game_mode   '*' for an entry every game mode accepts (every row that exists when this
//                       runs), else the preset tag of one mode (Assault, Siege, TeamElimination), compared
//                       without regard to case. The key is kind, file, sha256 and game_mode
//   presence_servers.preset     the preset tag the server's last report named, NULL when it named none

export const MIGRATIONS = [
  {
    version: 1,
    description: "presence: switch, servers, sessions, playtime, devices, flags, networks",
    up(db) {
      db.exec(`
        CREATE TABLE presence_settings (
          account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          show_game INTEGER CHECK (show_game IN (0, 1)),
          show_where INTEGER CHECK (show_where IN (0, 1)),
          show_web INTEGER CHECK (show_web IN (0, 1)),
          show_site INTEGER CHECK (show_site IN (0, 1)),
          show_playtime INTEGER CHECK (show_playtime IN (0, 1)),
          show_last_seen INTEGER CHECK (show_last_seen IN (0, 1)),
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE presence_servers (
          server TEXT PRIMARY KEY,
          map TEXT,
          mode TEXT,
          detail TEXT,
          last_report INTEGER NOT NULL,
          last_ts INTEGER NOT NULL
        );
        CREATE TABLE presence_online (
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          server TEXT NOT NULL,
          since INTEGER NOT NULL,
          last_at INTEGER NOT NULL,
          plugin_at INTEGER,
          away_at INTEGER,
          relay INTEGER NOT NULL DEFAULT 0 CHECK (relay IN (0, 1)),
          proven INTEGER NOT NULL DEFAULT 0 CHECK (proven IN (0, 1)),
          held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
          credited INTEGER NOT NULL DEFAULT 0 CHECK (credited IN (0, 1)),
          device TEXT,
          net TEXT,
          seen_by INTEGER NOT NULL DEFAULT 0,
          name TEXT,
          seconds INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (account_id, server)
        );
        CREATE INDEX presence_online_server ON presence_online(server);
        CREATE TABLE presence_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          server TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER NOT NULL,
          seconds INTEGER NOT NULL,
          seen_by INTEGER NOT NULL,
          name TEXT
        );
        CREATE INDEX presence_sessions_account ON presence_sessions(account_id, ended_at);
        CREATE INDEX presence_sessions_ended ON presence_sessions(ended_at);
        CREATE TABLE presence_playtime (
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          server TEXT NOT NULL,
          seconds INTEGER NOT NULL DEFAULT 0,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (account_id, server)
        );
        CREATE TABLE presence_devices (
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          device TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('bound', 'allowed')),
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          set_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          PRIMARY KEY (account_id, device)
        );
        CREATE TABLE presence_flags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('second_device', 'bad_proof', 'stale_proof', 'concurrent')),
          about TEXT NOT NULL,
          server TEXT,
          other_server TEXT,
          device TEXT,
          net_known INTEGER,
          detail TEXT,
          first_at INTEGER NOT NULL,
          last_at INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
          resolved_at INTEGER,
          resolved_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          note TEXT
        );
        CREATE UNIQUE INDEX presence_flags_one_open ON presence_flags(account_id, kind, about) WHERE status = 'open';
        CREATE INDEX presence_flags_list ON presence_flags(status, last_at);
        CREATE TABLE presence_nets (
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          net TEXT NOT NULL,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (account_id, net)
        );
        CREATE INDEX presence_nets_seen ON presence_nets(last_seen);
      `);
    },
  },
  {
    version: 2,
    description: "presence: enrollment, communities, sanctions, messages, shared data",
    up(db) {
      db.exec(`
        ALTER TABLE presence_online ADD COLUMN slot INTEGER;
        ALTER TABLE presence_servers ADD COLUMN name TEXT;
        ALTER TABLE presence_servers ADD COLUMN humans INTEGER;
        ALTER TABLE presence_servers ADD COLUMN max INTEGER;
        CREATE TABLE presence_enrolled (
          server TEXT PRIMARY KEY,
          server_id TEXT NOT NULL UNIQUE,
          live_salt TEXT,
          live_since INTEGER,
          approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0, 1)),
          approved_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          pend_salt TEXT,
          pend_code TEXT,
          pend_at INTEGER,
          probe_at INTEGER,
          blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
          created_at INTEGER NOT NULL,
          last_report INTEGER
        );
        CREATE TABLE presence_server_flags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('re_enrolled', 'pending_approval')),
          detail TEXT,
          first_at INTEGER NOT NULL,
          last_at INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
          resolved_at INTEGER,
          resolved_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX presence_server_flags_one_open ON presence_server_flags(server, kind) WHERE status = 'open';
        CREATE TABLE presence_nonces (
          server TEXT NOT NULL,
          nonce TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (server, nonce)
        );
        CREATE INDEX presence_nonces_at ON presence_nonces(at);
        CREATE TABLE presence_communities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          owner_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          chat INTEGER NOT NULL DEFAULT 1 CHECK (chat IN (0, 1)),
          chat_proof INTEGER NOT NULL DEFAULT 0 CHECK (chat_proof IN (0, 1)),
          data_proof INTEGER NOT NULL DEFAULT 0 CHECK (data_proof IN (0, 1)),
          created_at INTEGER NOT NULL
        );
        CREATE TABLE presence_community_staff (
          community_id INTEGER NOT NULL REFERENCES presence_communities(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          added_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (community_id, account_id)
        );
        CREATE TABLE presence_community_servers (
          server TEXT PRIMARY KEY,
          community_id INTEGER NOT NULL REFERENCES presence_communities(id) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
          linked_at INTEGER NOT NULL,
          linked_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL
        );
        CREATE INDEX presence_community_servers_c ON presence_community_servers(community_id);
        CREATE TABLE presence_claims (
          code_hash TEXT PRIMARY KEY,
          server TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE presence_sanctions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          community_id INTEGER REFERENCES presence_communities(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('ban', 'mute')),
          reason TEXT,
          created_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          until INTEGER,
          revoked_at INTEGER,
          revoked_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL
        );
        CREATE INDEX presence_sanctions_account ON presence_sanctions(account_id, kind);
        CREATE TABLE presence_kicks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          community_id INTEGER REFERENCES presence_communities(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          reason TEXT,
          created_at INTEGER NOT NULL,
          done_at INTEGER
        );
        CREATE TABLE presence_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          community_id INTEGER REFERENCES presence_communities(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('chat', 'announce')),
          source TEXT NOT NULL CHECK (source IN ('game', 'web', 'admin')),
          server TEXT,
          tag TEXT NOT NULL,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          deleted_at INTEGER,
          deleted_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL
        );
        CREATE INDEX presence_messages_c ON presence_messages(community_id, id);
        CREATE TABLE presence_data (
          community_id INTEGER NOT NULL REFERENCES presence_communities(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          updated_by TEXT NOT NULL,
          PRIMARY KEY (community_id, account_id, key)
        );
        CREATE TABLE presence_data_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          community_id INTEGER NOT NULL REFERENCES presence_communities(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          old_value TEXT,
          new_value TEXT,
          old_version INTEGER NOT NULL,
          new_version INTEGER NOT NULL,
          server TEXT NOT NULL,
          at INTEGER NOT NULL
        );
        CREATE INDEX presence_data_log_c ON presence_data_log(community_id, at);
      `);
    },
  },
  {
    version: 3,
    description: "presence: community membership, visibility, members-only servers",
    up(db) {
      db.exec(`
        ALTER TABLE presence_communities ADD COLUMN join_mode TEXT NOT NULL DEFAULT 'open' CHECK (join_mode IN ('open', 'request', 'invite'));
        ALTER TABLE presence_communities ADD COLUMN visibility TEXT NOT NULL DEFAULT 'listed' CHECK (visibility IN ('listed', 'unlisted', 'private'));
        ALTER TABLE presence_communities ADD COLUMN whitelist INTEGER NOT NULL DEFAULT 0 CHECK (whitelist IN (0, 1));
        ALTER TABLE presence_communities ADD COLUMN whitelist_proof INTEGER NOT NULL DEFAULT 0 CHECK (whitelist_proof IN (0, 1));
        CREATE TABLE presence_community_members (
          community_id INTEGER NOT NULL REFERENCES presence_communities(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          joined_at INTEGER NOT NULL,
          added_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          PRIMARY KEY (community_id, account_id)
        );
        CREATE INDEX presence_community_members_a ON presence_community_members(account_id);
        CREATE TABLE presence_community_requests (
          community_id INTEGER NOT NULL REFERENCES presence_communities(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (community_id, account_id)
        );
        CREATE TABLE presence_community_invites (
          community_id INTEGER NOT NULL REFERENCES presence_communities(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          invited_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (community_id, account_id)
        );
        CREATE INDEX presence_community_invites_a ON presence_community_invites(account_id);
        INSERT OR IGNORE INTO presence_community_members (community_id, account_id, joined_at, added_by)
          SELECT id, owner_id, created_at, NULL FROM presence_communities WHERE owner_id IS NOT NULL;
        INSERT OR IGNORE INTO presence_community_members (community_id, account_id, joined_at, added_by)
          SELECT community_id, account_id, added_at, added_by FROM presence_community_staff;
      `);
    },
  },
  {
    version: 4,
    description: "presence: the ID proof's nonces, issued by h9web",
    up(db) {
      db.exec(`
        CREATE TABLE presence_proof_nonces (
          nonce TEXT PRIMARY KEY,
          server TEXT NOT NULL,
          issued_at INTEGER NOT NULL
        );
        CREATE INDEX presence_proof_nonces_at ON presence_proof_nonces(issued_at);
      `);
    },
  },
  {
    version: 5,
    description: "presence: rated play (compete.js): flags, matches, players, ratings, deltas",
    up(db) {
      // compete_servers      a rated server's flags: network (NETWORK LADDER, an H9 site admin's)
      //                      and ladder_community (COUNTS FOR THE LADDER: the community it counts
      //                      for, while it is linked there); last_match, when its last one began
      // compete_communities  ladder: the community's staff turned its ladder on
      // compete_matches      one per match: scopes is the space-separated scopes it counts in
      //                      ("s:<address>", "c:<community id>", "n"), fixed at its start and
      //                      emptied by a void; seq, the last batch of kills taken; kills and
      //                      unrated_kills, how many moved ratings and how many could not; rated,
      //                      whether its result did; why, why not
      // compete_players      a proven account's part in a match (nobody else gets a row); NULL
      //                      account_id once the account is deleted ("a deleted player")
      // compete_ratings      per scope, ladder and account; decayed_at, the day (unix days) the
      //                      last decay was taken up to, NULL while the player is active
      // compete_deltas       what each match gave and took per scope and account, for a void
      // compete_pairs        kills one account scored on another per day, for pairKillsPerDay
      // compete_disputes     a player's DISPUTE of a match, until an H9 admin resolves it
      db.exec(`
        CREATE TABLE compete_servers (
          server TEXT PRIMARY KEY,
          network INTEGER NOT NULL DEFAULT 0 CHECK (network IN (0, 1)),
          network_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          network_at INTEGER,
          ladder_community INTEGER REFERENCES presence_communities(id) ON DELETE SET NULL,
          last_match INTEGER
        );
        CREATE TABLE compete_communities (
          community_id INTEGER PRIMARY KEY REFERENCES presence_communities(id) ON DELETE CASCADE,
          ladder INTEGER NOT NULL DEFAULT 0 CHECK (ladder IN (0, 1)),
          set_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          set_at INTEGER
        );
        CREATE TABLE compete_matches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server TEXT NOT NULL,
          community_id INTEGER REFERENCES presence_communities(id) ON DELETE SET NULL,
          scopes TEXT NOT NULL,
          ladder TEXT NOT NULL CHECK (ladder IN ('match', 'dm')),
          map TEXT,
          mode TEXT,
          started_at INTEGER NOT NULL,
          last_at INTEGER NOT NULL,
          ended_at INTEGER,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'over', 'voided')),
          how TEXT CHECK (how IN ('finished', 'forfeit', 'cancelled', 'abandoned')),
          winner INTEGER,
          score1 INTEGER,
          score2 INTEGER,
          rounds INTEGER,
          rated INTEGER NOT NULL DEFAULT 0 CHECK (rated IN (0, 1)),
          why TEXT,
          seq INTEGER NOT NULL DEFAULT 0,
          kills INTEGER NOT NULL DEFAULT 0,
          unrated_kills INTEGER NOT NULL DEFAULT 0,
          humans INTEGER,
          bots INTEGER,
          voided_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          voided_at INTEGER,
          void_note TEXT
        );
        CREATE INDEX compete_matches_server ON compete_matches(server, started_at);
        CREATE INDEX compete_matches_open ON compete_matches(status, last_at);
        CREATE TABLE compete_players (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id INTEGER NOT NULL REFERENCES compete_matches(id) ON DELETE CASCADE,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          side INTEGER NOT NULL DEFAULT 0,
          kills INTEGER NOT NULL DEFAULT 0,
          deaths INTEGER NOT NULL DEFAULT 0,
          headshots INTEGER NOT NULL DEFAULT 0,
          teamkills INTEGER NOT NULL DEFAULT 0,
          rounds INTEGER NOT NULL DEFAULT 0,
          seconds INTEGER NOT NULL DEFAULT 0,
          left_early INTEGER NOT NULL DEFAULT 0 CHECK (left_early IN (0, 1)),
          result TEXT CHECK (result IN ('win', 'loss', 'left')),
          place INTEGER
        );
        CREATE UNIQUE INDEX compete_players_one ON compete_players(match_id, account_id);
        CREATE INDEX compete_players_account ON compete_players(account_id, match_id);
        CREATE TABLE compete_ratings (
          scope TEXT NOT NULL,
          ladder TEXT NOT NULL CHECK (ladder IN ('match', 'dm')),
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          elo INTEGER NOT NULL,
          kills INTEGER NOT NULL DEFAULT 0,
          deaths INTEGER NOT NULL DEFAULT 0,
          headshots INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,
          matches INTEGER NOT NULL DEFAULT 0,
          last_at INTEGER NOT NULL,
          decayed_at INTEGER,
          PRIMARY KEY (scope, ladder, account_id)
        );
        CREATE INDEX compete_ratings_board ON compete_ratings(scope, ladder, elo);
        CREATE INDEX compete_ratings_account ON compete_ratings(account_id);
        CREATE TABLE compete_deltas (
          match_id INTEGER NOT NULL REFERENCES compete_matches(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          delta INTEGER NOT NULL DEFAULT 0,
          kills INTEGER NOT NULL DEFAULT 0,
          deaths INTEGER NOT NULL DEFAULT 0,
          headshots INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,
          matches INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (match_id, scope, account_id)
        );
        CREATE TABLE compete_pairs (
          day INTEGER NOT NULL,
          killer INTEGER NOT NULL,
          victim INTEGER NOT NULL,
          n INTEGER NOT NULL,
          PRIMARY KEY (day, killer, victim)
        );
        CREATE TABLE compete_disputes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          match_id INTEGER NOT NULL REFERENCES compete_matches(id) ON DELETE CASCADE,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          reason TEXT,
          at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
          resolved_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          resolved_at INTEGER,
          note TEXT
        );
      `);
    },
  },
  {
    version: 6,
    description: "presence: open community chat, the Discord relay, game copies of JPEG and WebP pictures",
    up(db) {
      // presence_messages takes a fourth source; SQLite changes a CHECK only by a new table. The
      // ids and the AUTOINCREMENT counter go across, so no server's "since" ever sees an id twice.
      db.exec(`
        ALTER TABLE presence_communities ADD COLUMN chat_open INTEGER NOT NULL DEFAULT 0 CHECK (chat_open IN (0, 1));
        ALTER TABLE presence_communities ADD COLUMN discord_channel TEXT;
        ALTER TABLE presence_communities ADD COLUMN discord_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
        ALTER TABLE presence_communities ADD COLUMN discord_at INTEGER;
        ALTER TABLE presence_communities ADD COLUMN discord_last TEXT;
        CREATE TABLE presence_messages_v6 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          community_id INTEGER REFERENCES presence_communities(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('chat', 'announce')),
          source TEXT NOT NULL CHECK (source IN ('game', 'web', 'admin', 'discord')),
          server TEXT,
          tag TEXT NOT NULL,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          deleted_at INTEGER,
          deleted_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL
        );
        INSERT INTO presence_messages_v6 (id, community_id, kind, source, server, tag, account_id, name, text, created_at, deleted_at, deleted_by)
          SELECT id, community_id, kind, source, server, tag, account_id, name, text, created_at, deleted_at, deleted_by FROM presence_messages;
        DELETE FROM sqlite_sequence WHERE name = 'presence_messages_v6';
        INSERT INTO sqlite_sequence (name, seq) SELECT 'presence_messages_v6', seq FROM sqlite_sequence WHERE name = 'presence_messages';
        DROP TABLE presence_messages;
        ALTER TABLE presence_messages_v6 RENAME TO presence_messages;
        CREATE INDEX presence_messages_c ON presence_messages(community_id, id);
        CREATE TABLE presence_game_pictures (
          account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          png BLOB NOT NULL,
          made_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 7,
    description: "presence: Create Game servers enrolled by their own player's ID proof",
    up(db) {
      db.exec(`
        ALTER TABLE presence_enrolled ADD COLUMN listen INTEGER NOT NULL DEFAULT 0 CHECK (listen IN (0, 1));
        ALTER TABLE presence_enrolled ADD COLUMN pend_listen INTEGER NOT NULL DEFAULT 0 CHECK (pend_listen IN (0, 1));
        ALTER TABLE presence_enrolled ADD COLUMN owner_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
      `);
    },
  },
  {
    version: 8,
    description: "presence: account levels Lv 0-99 from the H9 ladder (compete.js)",
    up(db) {
      // compete_config   the site admins' settings for levels: key and value as text (the rule,
      //                  "elo" or "career", and each rule's tuning); a key not there takes its default
      // compete_xp       a career's experience: what each match counted on the H9 ladder gave each
      //                  player, so a void takes back exactly that match's
      // compete_levels   each account's level, worked out again whenever its H9 ladder rating, its
      //                  experience or the settings change: what the report answer and the site show
      db.exec(`
        CREATE TABLE compete_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          set_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          set_at INTEGER
        );
        CREATE TABLE compete_xp (
          match_id INTEGER NOT NULL REFERENCES compete_matches(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          xp INTEGER NOT NULL,
          PRIMARY KEY (match_id, account_id)
        );
        CREATE INDEX compete_xp_account ON compete_xp(account_id);
        CREATE TABLE compete_levels (
          account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          level INTEGER NOT NULL,
          xp INTEGER NOT NULL DEFAULT 0,
          rule TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 9,
    description: "presence: competitive seasons (compete.js): the season under way and the ones archived",
    up(db) {
      // compete_seasons            one row a season, numbered from 1; ended_at and ended_by once a
      //                            site admin reset it, backup: the database copy made right before
      // compete_season_standings   a season's final standings, per scope and ladder, as the reset
      //                            found them; account_id NULL once the account is deleted
      // compete_matches.season     the season a match was played in
      db.exec(`
        CREATE TABLE compete_seasons (
          id INTEGER PRIMARY KEY,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          ended_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          backup TEXT
        );
        INSERT INTO compete_seasons (id, started_at)
          VALUES (1, COALESCE((SELECT MIN(started_at) FROM compete_matches), CAST(strftime('%s', 'now') AS INTEGER)));
        CREATE TABLE compete_season_standings (
          season_id INTEGER NOT NULL REFERENCES compete_seasons(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          ladder TEXT NOT NULL,
          rank INTEGER NOT NULL,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          elo INTEGER NOT NULL,
          kills INTEGER NOT NULL DEFAULT 0,
          deaths INTEGER NOT NULL DEFAULT 0,
          headshots INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,
          matches INTEGER NOT NULL DEFAULT 0,
          level INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (season_id, scope, ladder, rank)
        );
        ALTER TABLE compete_matches ADD COLUMN season INTEGER NOT NULL DEFAULT 1;
      `);
    },
  },
  {
    version: 10,
    description: "presence: assists in rated play (compete.js): each player's in a match, each table's sum, a match's share for a void",
    up(db) {
      // compete_players.assists           the player's assists in the match, as the server's end
      //                                   report counts them (ts_matchmode's); NULL when it counts none
      // compete_ratings.assists           the table's sum over its matches; NULL until a match brings one
      // compete_deltas.assists            what a match added to the table, so a void takes it back
      // compete_season_standings.assists  the archived sum
      db.exec(`
        ALTER TABLE compete_players ADD COLUMN assists INTEGER;
        ALTER TABLE compete_ratings ADD COLUMN assists INTEGER;
        ALTER TABLE compete_deltas ADD COLUMN assists INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE compete_season_standings ADD COLUMN assists INTEGER;
      `);
    },
  },
  {
    version: 11,
    description: "presence: ranked play on every server (compete.js): UNRANKED servers, and admins' rank adjustments",
    up(db) {
      // compete_servers.unranked   1: an H9 site admin marked the server UNRANKED, and it feeds no
      //                            table from then on; every other enrolled server counts, for the
      //                            H9 ladder too (network, the old NETWORK LADDER flag, is not read)
      // compete_adjustments        an admin's change to an account's rank: a table's rating set or
      //                            moved (field elo, with its scope and ladder), or the career
      //                            experience (field xp, which adds after - before to the career's
      //                            sum); the note, who and when
      db.exec(`
        ALTER TABLE compete_servers ADD COLUMN unranked INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE compete_servers ADD COLUMN unranked_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
        ALTER TABLE compete_servers ADD COLUMN unranked_at INTEGER;
        CREATE TABLE compete_adjustments (
          id INTEGER PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          field TEXT NOT NULL,
          scope TEXT,
          ladder TEXT,
          before INTEGER NOT NULL,
          after INTEGER NOT NULL,
          note TEXT NOT NULL,
          by_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          at INTEGER NOT NULL,
          season INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX compete_adjustments_account ON compete_adjustments(account_id, at);
      `);
    },
  },
  {
    version: 12,
    description: "presence: the official preset (preset.js): the allowlist, and the plugin list each server reports",
    up(db) {
      db.exec(`
        CREATE TABLE presence_preset (
          kind TEXT NOT NULL CHECK (kind IN ('amxx', 'module', 'meta')),
          file TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          version TEXT,
          optional INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0, 1)),
          note TEXT,
          added_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (kind, file, sha256)
        );
        ALTER TABLE presence_servers ADD COLUMN plugins TEXT;
        ALTER TABLE presence_servers ADD COLUMN plugins_at INTEGER;
        ALTER TABLE presence_servers ADD COLUMN opted_out INTEGER NOT NULL DEFAULT 0 CHECK (opted_out IN (0, 1));
      `);
    },
  },
  {
    version: 13,
    description: "compete: indexes for the day's limits on experience and on H9 ladder points (compete.js)",
    up(db) {
      db.exec(`
        CREATE INDEX compete_deltas_account ON compete_deltas(account_id, scope);
        CREATE INDEX compete_matches_started ON compete_matches(started_at);
      `);
    },
  },
  {
    version: 14,
    description: "presence: community chat and shared data need proven players unless the owner switches that off (community.js)",
    up(db) {
      db.exec("UPDATE presence_communities SET chat_proof = 1, data_proof = 1");
    },
  },
  {
    version: 15,
    description: "presence: the official preset per game mode (preset.js)",
    up(db) {
      // presence_preset's key gains a column, which SQLite does by a new table; nothing points at this one
      db.exec(`
        CREATE TABLE presence_preset_v15 (
          kind TEXT NOT NULL CHECK (kind IN ('amxx', 'module', 'meta')),
          file TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          game_mode TEXT NOT NULL DEFAULT '*' COLLATE NOCASE,
          version TEXT,
          optional INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0, 1)),
          note TEXT,
          added_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (kind, file, sha256, game_mode)
        );
        INSERT INTO presence_preset_v15 (kind, file, sha256, game_mode, version, optional, note, added_by, added_at)
          SELECT kind, file, sha256, '*', version, optional, note, added_by, added_at FROM presence_preset;
        DROP TABLE presence_preset;
        ALTER TABLE presence_preset_v15 RENAME TO presence_preset;
        ALTER TABLE presence_servers ADD COLUMN preset TEXT;
      `);
    },
  },
];
