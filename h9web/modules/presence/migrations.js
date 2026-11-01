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
];
