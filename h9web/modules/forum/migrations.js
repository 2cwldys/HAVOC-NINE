// The forum's tables. The registry runs each migration once, in a transaction, after copying
// the database (lib/db.js); a migration that has shipped is never edited, the next one is added.
//
//   forum_categories  the boards: slug (the address, fixed), name, description, order, and who may
//                     start threads (start_role) and reply (reply_role)
//   forum_threads     title, author, pinned, locked; post_count, last_post_* keep the lists cheap;
//                     deleted_* is a soft delete ('moderator', or 'empty' once no post is left)
//   forum_posts       the text as written (rendered when read); edited_* and deleted_* (soft:
//                     'author' or 'moderator'); no IP address is kept with a post
//   forum_reports     a report, with a copy of the post's text when it was reported
//   forum_avatars     each account's profile picture: its version (in its address), type, size
//                     and frame count; the file is <dataDir>/modules/forum/avatars/<id>-<version>.<ext>
//   v2: forum_categories.visible (0: only moderators and admins see the category), and
//   forum_restrictions: an account whose posting is turned off, until when (NULL: until lifted)
//                     and why; it can still sign in, read and play
//   v3: the "maps" category becomes "Modding" (address modding), for maps, models, sounds and
//                     plugins alike, unless an admin has already renamed it
//   v4: forum_votes: one like (+1) or dislike (-1) per account per post; a removed post keeps
//                     its votes, which are not shown while it is removed
// What moderators do goes into h9web's audit log (lib/audit.js), not into a table of the forum's.
// Every other reference to an account is ON DELETE SET NULL: deleting an account keeps its
// posts, shown as from a deleted account, and deletes its picture and the votes it cast.

const SEED = [
  ["announcements", "Announcements", "News from the HAVOC 9 team. Only moderators and admins start threads here.", "moderator"],
  ["general", "General", "Anything about HAVOC 9 that has no other place.", "user"],
  ["servers", "Servers and Match Mode", "The servers, Match Mode, its rules, and organising games.", "user"],
  ["roleplay", "Roleplay", "Roleplay servers, characters and stories.", "user"],
  ["maps", "Maps and Mapping", "Maps, mapping help and work in progress.", "user"],
  ["support", "Web Client and Support", "The web client, the H9XASH client, and getting the game to run.", "user"],
  ["off-topic", "Off-topic", "Everything else.", "user"],
];

export const MIGRATIONS = [
  {
    version: 1,
    description: "categories, threads, posts, reports and profile pictures",
    up(db) {
      db.exec(`
        CREATE TABLE forum_categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL,
          start_role TEXT NOT NULL DEFAULT 'user' CHECK (start_role IN ('user', 'moderator', 'admin')),
          reply_role TEXT NOT NULL DEFAULT 'user' CHECK (reply_role IN ('user', 'moderator', 'admin')),
          created_at INTEGER NOT NULL
        );
        CREATE TABLE forum_threads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id INTEGER NOT NULL REFERENCES forum_categories(id),
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          locked INTEGER NOT NULL DEFAULT 0,
          post_count INTEGER NOT NULL DEFAULT 0,
          last_post_id INTEGER,
          last_post_at INTEGER NOT NULL,
          last_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          deleted_at INTEGER,
          deleted_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          deleted_kind TEXT CHECK (deleted_kind IN ('moderator', 'empty'))
        );
        CREATE INDEX forum_threads_board ON forum_threads(category_id, pinned DESC, last_post_at DESC, id DESC) WHERE deleted_at IS NULL;
        CREATE INDEX forum_threads_latest ON forum_threads(category_id, last_post_at DESC, id DESC) WHERE deleted_at IS NULL;
        CREATE INDEX forum_threads_removed ON forum_threads(category_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
        CREATE INDEX forum_threads_author ON forum_threads(account_id);
        CREATE TABLE forum_posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          edited_at INTEGER,
          edited_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          deleted_at INTEGER,
          deleted_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          deleted_kind TEXT CHECK (deleted_kind IN ('author', 'moderator'))
        );
        CREATE INDEX forum_posts_thread ON forum_posts(thread_id, id);
        CREATE INDEX forum_posts_author ON forum_posts(account_id, deleted_at);
        CREATE TABLE forum_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          reason TEXT NOT NULL,
          snapshot TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          closed_at INTEGER,
          closed_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          outcome TEXT
        );
        CREATE INDEX forum_reports_queue ON forum_reports(closed_at, id);
        CREATE INDEX forum_reports_post ON forum_reports(post_id);
        CREATE UNIQUE INDEX forum_reports_once ON forum_reports(post_id, account_id) WHERE closed_at IS NULL;
        CREATE TABLE forum_avatars (
          account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
          bytes INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          frames INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const now = Math.floor(Date.now() / 1000);
      const insert = db.prepare("INSERT INTO forum_categories (slug, name, description, position, start_role, reply_role, created_at) VALUES (?, ?, ?, ?, ?, 'user', ?)");
      SEED.forEach(([slug, name, description, startRole], i) => insert.run(slug, name, description, i + 1, startRole, now));
    },
  },
  {
    version: 2,
    description: "hidden categories and posting restrictions",
    up(db) {
      db.exec(`
        ALTER TABLE forum_categories ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE forum_restrictions (
          account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          until INTEGER,
          reason TEXT NOT NULL,
          by_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    description: "Maps and Mapping becomes Modding",
    up(db) {
      db.prepare(
        "UPDATE forum_categories SET slug = 'modding', name = 'Modding', description = ? WHERE slug = 'maps' AND name = 'Maps and Mapping'",
      ).run("Maps, models, sounds, plugins and every other mod: help, releases and work in progress.");
    },
  },
  {
    version: 4,
    description: "likes and dislikes on posts",
    up(db) {
      db.exec(`
        CREATE TABLE forum_votes (
          post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          value INTEGER NOT NULL CHECK (value IN (1, -1)),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (post_id, account_id)
        );
        CREATE INDEX forum_votes_account ON forum_votes(account_id);
      `);
    },
  },
];
