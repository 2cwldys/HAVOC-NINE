// The forum's data: every query the routes make, and the writes that keep a thread's counters
// (its post count, its last post, its place in the lists) in step with its posts. The routes
// call the writes inside a transaction.
//
// A thread is listed while it is not removed; a hidden one (hidden_at) only for staff (the
// staff arguments below).
//
// A thread is listed while it is not removed. refreshThread recounts a thread after any post
// is added, removed or restored: a thread whose last remaining post goes is removed with the
// kind 'empty', and comes back by itself when one of its posts is restored; a thread a
// moderator removed ('moderator') comes back only when a moderator restores it.

// author_dev and last_dev: whether the thread's author and its last poster have the DEVELOPER flag
const THREAD_ROW = `SELECT t.id, t.category_id, t.title, t.pinned, t.locked, t.created_at, t.post_count, t.last_post_id,
    t.last_post_at, t.deleted_at, t.deleted_kind, t.hidden_at, a.username AS author_name, a.role AS author_role, l.username AS last_name,
    EXISTS (SELECT 1 FROM forum_developers d WHERE d.account_id = t.account_id) AS author_dev, EXISTS (SELECT 1 FROM forum_developers d WHERE d.account_id = t.last_account_id) AS last_dev
  FROM forum_threads t
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN accounts l ON l.id = t.last_account_id`;

// The author columns a post is shown with (a = the author's account, av = their picture): one list
// for a page of posts, one post, and an account alone, so a preview shows its author exactly as a
// posted post does. author_dev: the DEVELOPER flag.
export const AUTHOR_COLUMNS = `a.username AS author_name, a.role AS author_role, a.created_at AS author_created,
    EXISTS (SELECT 1 FROM forum_developers d WHERE d.account_id = a.id) AS author_dev,
    av.version AS pic_version, av.bytes AS pic_bytes, av.frames AS pic_frames, av.type AS pic_type`;
const POST_ROW = `SELECT p.*, ${AUTHOR_COLUMNS}
  FROM forum_posts p
  LEFT JOIN accounts a ON a.id = p.account_id
  LEFT JOIN forum_avatars av ON av.account_id = p.account_id`;

const REPORT_ROW = `SELECT r.id, r.post_id, r.reason, r.snapshot, r.created_at, r.closed_at, r.outcome,
    ra.username AS reporter, ca.username AS closer, p.thread_id, p.deleted_kind AS post_removed,
    pa.username AS post_author, t.title AS thread_title, t.deleted_kind AS thread_removed
  FROM forum_reports r
  JOIN forum_posts p ON p.id = r.post_id
  JOIN forum_threads t ON t.id = p.thread_id
  LEFT JOIN accounts ra ON ra.id = r.account_id
  LEFT JOIN accounts ca ON ca.id = r.closed_by
  LEFT JOIN accounts pa ON pa.id = p.account_id`;

export function createStore(db) {
  const q = {
    categories: db.prepare("SELECT * FROM forum_categories ORDER BY position, id"),
    category: db.prepare("SELECT * FROM forum_categories WHERE id = ?"),
    categoryBySlug: db.prepare("SELECT * FROM forum_categories WHERE slug = ?"),
    categoryStats: db.prepare("SELECT count(*) AS threads, coalesce(sum(post_count), 0) AS posts FROM forum_threads WHERE category_id = ? AND deleted_at IS NULL AND (hidden_at IS NULL OR ? = 1)"),
    categoryLatest: db.prepare(`SELECT t.id, t.title, t.last_post_id, t.last_post_at, a.username AS last_name,
        EXISTS (SELECT 1 FROM forum_developers d WHERE d.account_id = t.last_account_id) AS last_dev
      FROM forum_threads t LEFT JOIN accounts a ON a.id = t.last_account_id
      WHERE t.category_id = ? AND t.deleted_at IS NULL AND (t.hidden_at IS NULL OR ? = 1) ORDER BY t.last_post_at DESC, t.id DESC LIMIT 1`),
    categoryHolds: db.prepare("SELECT count(*) AS threads, coalesce(sum(deleted_at IS NOT NULL), 0) AS removed FROM forum_threads WHERE category_id = ?"),
    categoryInsert: db.prepare(`INSERT INTO forum_categories (slug, name, description, position, start_role, reply_role, visible, created_at)
      VALUES (?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM forum_categories), ?, ?, ?, ?)`),
    categoryUpdate: db.prepare("UPDATE forum_categories SET name = ?, description = ?, start_role = ?, reply_role = ?, visible = ? WHERE id = ?"),
    categoryPosition: db.prepare("UPDATE forum_categories SET position = ? WHERE id = ?"),
    categoryDelete: db.prepare("DELETE FROM forum_categories WHERE id = ?"),
    categoryMoveAll: db.prepare("UPDATE forum_threads SET category_id = ? WHERE category_id = ?"),

    threadCount: db.prepare("SELECT count(*) AS n FROM forum_threads WHERE category_id = ? AND deleted_at IS NULL AND (hidden_at IS NULL OR ? = 1)"),
    threadPage: db.prepare(`${THREAD_ROW} WHERE t.category_id = ? AND t.deleted_at IS NULL AND (t.hidden_at IS NULL OR ? = 1)
      ORDER BY t.pinned DESC, t.last_post_at DESC, t.id DESC LIMIT ? OFFSET ?`),
    removedCount: db.prepare("SELECT count(*) AS n FROM forum_threads WHERE deleted_at IS NOT NULL"),
    removedPage: db.prepare(`${THREAD_ROW} WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC, t.id DESC LIMIT ? OFFSET ?`),
    thread: db.prepare(`SELECT t.*, a.username AS author_name, a.role AS author_role, EXISTS (SELECT 1 FROM forum_developers d WHERE d.account_id = t.account_id) AS author_dev
      FROM forum_threads t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`),
    threadInsert: db.prepare("INSERT INTO forum_threads (category_id, account_id, title, created_at, last_post_at) VALUES (?, ?, ?, ?, ?)"),
    threadTitle: db.prepare("UPDATE forum_threads SET title = ? WHERE id = ?"),
    threadFlags: db.prepare("UPDATE forum_threads SET pinned = ?, locked = ? WHERE id = ?"),
    threadHidden: db.prepare("UPDATE forum_threads SET hidden_at = ?, hidden_by = ? WHERE id = ?"),
    threadMove: db.prepare("UPDATE forum_threads SET category_id = ? WHERE id = ?"),
    threadRemove: db.prepare("UPDATE forum_threads SET deleted_at = ?, deleted_by = ?, deleted_kind = 'moderator' WHERE id = ?"),
    threadRestore: db.prepare("UPDATE forum_threads SET deleted_at = NULL, deleted_by = NULL, deleted_kind = NULL WHERE id = ?"),
    threadVisible: db.prepare("SELECT count(*) AS n, max(id) AS last FROM forum_posts WHERE thread_id = ? AND deleted_at IS NULL"),
    // SET reads the row as it was, so the CASEs see the old deleted_at
    threadEmpty: db.prepare(`UPDATE forum_threads SET post_count = 0,
      deleted_by = CASE WHEN deleted_at IS NULL THEN ? ELSE deleted_by END,
      deleted_kind = CASE WHEN deleted_at IS NULL THEN 'empty' ELSE deleted_kind END,
      deleted_at = coalesce(deleted_at, ?) WHERE id = ?`),
    threadCounters: db.prepare(`UPDATE forum_threads SET post_count = ?, last_post_id = ?, last_post_at = ?, last_account_id = ?,
      deleted_at = CASE WHEN deleted_kind = 'empty' THEN NULL ELSE deleted_at END,
      deleted_by = CASE WHEN deleted_kind = 'empty' THEN NULL ELSE deleted_by END,
      deleted_kind = CASE WHEN deleted_kind = 'empty' THEN NULL ELSE deleted_kind END
      WHERE id = ?`),
    threadsBy: db.prepare("SELECT count(*) AS n FROM forum_threads WHERE account_id = ? AND deleted_at IS NULL"),

    post: db.prepare("SELECT * FROM forum_posts WHERE id = ?"),
    postCount: db.prepare("SELECT count(*) AS n FROM forum_posts WHERE thread_id = ?"),
    postsBefore: db.prepare("SELECT count(*) AS n FROM forum_posts WHERE thread_id = ? AND id < ?"),
    postPage: db.prepare(`${POST_ROW} WHERE p.thread_id = ? ORDER BY p.id LIMIT ? OFFSET ?`),
    postRow: db.prepare(`${POST_ROW} WHERE p.id = ?`),
    // an account as the author of a post not written yet (a preview)
    authorRow: db.prepare(`SELECT a.id AS account_id, ${AUTHOR_COLUMNS}
      FROM accounts a LEFT JOIN forum_avatars av ON av.account_id = a.id WHERE a.id = ?`),
    postInsert: db.prepare("INSERT INTO forum_posts (thread_id, account_id, body, created_at) VALUES (?, ?, ?, ?)"),
    postEdit: db.prepare("UPDATE forum_posts SET body = ?, edited_at = ?, edited_by = ? WHERE id = ?"),
    postRemove: db.prepare("UPDATE forum_posts SET deleted_at = ?, deleted_by = ?, deleted_kind = ? WHERE id = ?"),
    postRestore: db.prepare("UPDATE forum_posts SET deleted_at = NULL, deleted_by = NULL, deleted_kind = NULL WHERE id = ?"),
    // what a member's post count shows: posts not removed, in threads not removed
    authorCounts: db.prepare(`SELECT p.account_id AS id, count(*) AS n
      FROM forum_posts p JOIN forum_threads t ON t.id = p.thread_id
      WHERE p.account_id IN (SELECT value FROM json_each(?)) AND p.deleted_at IS NULL AND t.deleted_at IS NULL
      GROUP BY p.account_id`),
    // ? = 1 counts the hidden categories in too (for moderators)
    recentPosts: db.prepare(`SELECT p.id, p.created_at, t.id AS thread_id, t.title
      FROM forum_posts p JOIN forum_threads t ON t.id = p.thread_id JOIN forum_categories c ON c.id = t.category_id
      WHERE p.account_id = ? AND p.deleted_at IS NULL AND t.deleted_at IS NULL AND ((c.visible = 1 AND t.hidden_at IS NULL) OR ? = 1)
      ORDER BY p.id DESC LIMIT ?`),

    restriction: db.prepare(`SELECT r.*, b.username AS by_name FROM forum_restrictions r LEFT JOIN accounts b ON b.id = r.by_id
      WHERE r.account_id = ?`),
    restrictionSet: db.prepare(`INSERT INTO forum_restrictions (account_id, until, reason, by_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, by_id = excluded.by_id,
        created_at = excluded.created_at`),
    restrictionLift: db.prepare("DELETE FROM forum_restrictions WHERE account_id = ?"),
    restrictionsCount: db.prepare("SELECT count(*) AS n FROM forum_restrictions WHERE until IS NULL OR until > ?"),
    restrictionsPage: db.prepare(`SELECT r.*, a.username, a.role, b.username AS by_name
      FROM forum_restrictions r JOIN accounts a ON a.id = r.account_id LEFT JOIN accounts b ON b.id = r.by_id
      WHERE r.until IS NULL OR r.until > ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?`),
    restrictionsExpired: db.prepare("DELETE FROM forum_restrictions WHERE until IS NOT NULL AND until <= ?"),

    reportInsert: db.prepare("INSERT INTO forum_reports (post_id, account_id, reason, snapshot, created_at) VALUES (?, ?, ?, ?, ?)"),
    reportOpenBy: db.prepare("SELECT id FROM forum_reports WHERE post_id = ? AND account_id = ? AND closed_at IS NULL"),
    report: db.prepare("SELECT * FROM forum_reports WHERE id = ?"),
    reportClose: db.prepare("UPDATE forum_reports SET closed_at = ?, closed_by = ?, outcome = ? WHERE id = ? AND closed_at IS NULL"),
    reportsClosePost: db.prepare("UPDATE forum_reports SET closed_at = ?, closed_by = ?, outcome = ? WHERE post_id = ? AND closed_at IS NULL"),
    reportsCloseThread: db.prepare(`UPDATE forum_reports SET closed_at = ?, closed_by = ?, outcome = ?
      WHERE closed_at IS NULL AND post_id IN (SELECT id FROM forum_posts WHERE thread_id = ?)`),
    reportsOpenCount: db.prepare("SELECT count(*) AS n FROM forum_reports WHERE closed_at IS NULL"),
    reportsClosedCount: db.prepare("SELECT count(*) AS n FROM forum_reports WHERE closed_at IS NOT NULL"),
    reportsOpen: db.prepare(`${REPORT_ROW} WHERE r.closed_at IS NULL ORDER BY r.id LIMIT ? OFFSET ?`),
    reportsClosed: db.prepare(`${REPORT_ROW} WHERE r.closed_at IS NOT NULL ORDER BY r.closed_at DESC, r.id DESC LIMIT ? OFFSET ?`),

    // votes: each list is one grouped query over the posts of a page (or the authors on it)
    voteCounts: db.prepare(`SELECT post_id, coalesce(sum(value = 1), 0) AS likes, coalesce(sum(value = -1), 0) AS dislikes
      FROM forum_votes WHERE post_id IN (SELECT value FROM json_each(?)) GROUP BY post_id`),
    votesBy: db.prepare("SELECT post_id, value FROM forum_votes WHERE account_id = ? AND post_id IN (SELECT value FROM json_each(?))"),
    // likes an author has had: on their posts that are not removed, in threads not removed
    likesReceived: db.prepare(`SELECT p.account_id AS id, count(*) AS n
      FROM forum_posts p JOIN forum_threads t ON t.id = p.thread_id JOIN forum_votes v ON v.post_id = p.id AND v.value = 1
      WHERE p.account_id IN (SELECT value FROM json_each(?)) AND p.deleted_at IS NULL AND t.deleted_at IS NULL
      GROUP BY p.account_id`),
    voteSet: db.prepare(`INSERT INTO forum_votes (post_id, account_id, value, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (post_id, account_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`),
    voteClear: db.prepare("DELETE FROM forum_votes WHERE post_id = ? AND account_id = ?"),

    picture: db.prepare("SELECT * FROM forum_avatars WHERE account_id = ?"),
    pictureSet: db.prepare(`INSERT INTO forum_avatars (account_id, version, type, bytes, width, height, frames, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET version = excluded.version, type = excluded.type, bytes = excluded.bytes,
        width = excluded.width, height = excluded.height, frames = excluded.frames, updated_at = excluded.updated_at`),
    pictureRemove: db.prepare("DELETE FROM forum_avatars WHERE account_id = ?"),
    pictureBytes: db.prepare("SELECT coalesce(sum(bytes), 0) AS n FROM forum_avatars"),
    pictureVersions: db.prepare("SELECT account_id, version FROM forum_avatars"),

    developer: db.prepare("SELECT 1 AS yes FROM forum_developers WHERE account_id = ?"),
    developerAdd: db.prepare("INSERT INTO forum_developers (account_id, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT (account_id) DO NOTHING"),
    developerRemove: db.prepare("DELETE FROM forum_developers WHERE account_id = ?"),
  };

  function refreshThread(threadId, actorId, now) {
    const v = q.threadVisible.get(threadId);
    if (!v.n) {
      q.threadEmpty.run(actorId, now, threadId);
      return { empty: true };
    }
    const last = q.post.get(v.last);
    q.threadCounters.run(v.n, last.id, last.created_at, last.account_id, threadId);
    return { empty: false };
  }

  // Title search: every word somewhere in the title (LIKE, no case for a-z), threads not removed,
  // in visible categories unless staff is true. One statement per number of words, made once.
  const searches = new Map();
  function searchStatements(words) {
    let st = searches.get(words);
    if (!st) {
      const where = "t.deleted_at IS NULL AND ((c.visible = 1 AND t.hidden_at IS NULL) OR ? = 1)" + " AND t.title LIKE ? ESCAPE '\\'".repeat(words);
      st = {
        count: db.prepare(`SELECT count(*) AS n FROM forum_threads t JOIN forum_categories c ON c.id = t.category_id WHERE ${where}`),
        page: db.prepare(`${THREAD_ROW} JOIN forum_categories c ON c.id = t.category_id WHERE ${where}
          ORDER BY t.last_post_at DESC, t.id DESC LIMIT ? OFFSET ?`),
      };
      searches.set(words, st);
    }
    return st;
  }
  const likeWord = (w) => "%" + w.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

  function moveCategory(id, direction) {
    const list = q.categories.all();
    const i = list.findIndex((c) => c.id === id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((c, k) => q.categoryPosition.run(k + 1, c.id));
    return true;
  }

  return {
    categories: () => q.categories.all(),
    category: (id) => q.category.get(id) || null,
    categoryBySlug: (slug) => q.categoryBySlug.get(slug) || null,
    categoryStats: (id, staff) => q.categoryStats.get(id, staff ? 1 : 0),
    categoryLatest: (id, staff) => q.categoryLatest.get(id, staff ? 1 : 0) || null,
    categoryHolds: (id) => q.categoryHolds.get(id),
    addCategory: (slug, f, now) => q.categoryInsert.run(slug, f.name, f.description, f.startRole, f.replyRole, f.visible ? 1 : 0, now),
    updateCategory: (id, f) => q.categoryUpdate.run(f.name, f.description, f.startRole, f.replyRole, f.visible ? 1 : 0, id),
    moveCategory,
    deleteCategory: (id) => q.categoryDelete.run(id),
    moveAllThreads: (fromId, toId) => Number(q.categoryMoveAll.run(toId, fromId).changes),

    threadCount: (categoryId, staff) => q.threadCount.get(categoryId, staff ? 1 : 0).n,
    threadPage: (categoryId, limit, offset, staff) => q.threadPage.all(categoryId, staff ? 1 : 0, limit, offset),
    removedCount: () => q.removedCount.get().n,
    removedPage: (limit, offset) => q.removedPage.all(limit, offset),
    thread: (id) => q.thread.get(id) || null,
    visiblePosts: (threadId) => q.threadVisible.get(threadId).n,
    threadsBy: (accountId) => q.threadsBy.get(accountId).n,
    createThread(categoryId, accountId, title, body, now) {
      const threadId = Number(q.threadInsert.run(categoryId, accountId, title, now, now).lastInsertRowid);
      const postId = Number(q.postInsert.run(threadId, accountId, body, now).lastInsertRowid);
      refreshThread(threadId, accountId, now);
      return { threadId, postId };
    },
    setTitle: (id, title) => q.threadTitle.run(title, id),
    setFlags: (id, pinned, locked) => q.threadFlags.run(pinned ? 1 : 0, locked ? 1 : 0, id),
    setHidden: (id, hidden, byId, now) => q.threadHidden.run(hidden ? now : null, hidden ? byId : null, id),
    moveThread: (id, categoryId) => q.threadMove.run(categoryId, id),
    removeThread: (id, now, actorId) => q.threadRemove.run(now, actorId, id),
    restoreThread: (id) => q.threadRestore.run(id),
    refreshThread,

    post: (id) => q.post.get(id) || null,
    postCount: (threadId) => q.postCount.get(threadId).n,
    postsBefore: (threadId, postId) => q.postsBefore.get(threadId, postId).n,
    postPage: (threadId, limit, offset) => q.postPage.all(threadId, limit, offset),
    postRow: (id) => q.postRow.get(id) || null,
    authorRow: (accountId) => q.authorRow.get(accountId) || null,
    addPost(threadId, accountId, body, now) {
      const postId = Number(q.postInsert.run(threadId, accountId, body, now).lastInsertRowid);
      refreshThread(threadId, accountId, now);
      return postId;
    },
    editPost: (id, body, now, actorId) => q.postEdit.run(body, now, actorId, id),
    removePost: (id, now, actorId, kind) => q.postRemove.run(now, actorId, kind, id),
    restorePost: (id) => q.postRestore.run(id),
    authorCounts(ids) {
      const list = [...new Set(ids.filter((x) => x !== null && x !== undefined))];
      const counts = new Map();
      if (list.length) for (const r of q.authorCounts.all(JSON.stringify(list))) counts.set(r.id, r.n);
      return counts;
    },
    recentPosts: (accountId, limit, staff) => q.recentPosts.all(accountId, staff ? 1 : 0, limit),
    search(words, staff, limit, offset) {
      const st = searchStatements(words.length);
      const args = [staff ? 1 : 0, ...words.map(likeWord)];
      return { total: st.count.get(...args).n, rows: st.page.all(...args, limit, offset) };
    },

    restriction: (accountId) => q.restriction.get(accountId) || null,
    restrict: (accountId, until, reason, byId, now) => q.restrictionSet.run(accountId, until, reason, byId, now),
    lift: (accountId) => Number(q.restrictionLift.run(accountId).changes),
    restrictions(now, limit, offset) {
      q.restrictionsExpired.run(now);
      return { total: q.restrictionsCount.get(now).n, rows: q.restrictionsPage.all(now, limit, offset) };
    },

    addReport: (postId, accountId, reason, snapshot, now) => q.reportInsert.run(postId, accountId, reason, snapshot, now),
    openReportBy: (postId, accountId) => q.reportOpenBy.get(postId, accountId) || null,
    report: (id) => q.report.get(id) || null,
    closeReport: (id, now, actorId, outcome) => q.reportClose.run(now, actorId, outcome, id),
    closeReportsForPost: (postId, now, actorId, outcome) => q.reportsClosePost.run(now, actorId, outcome, postId),
    closeReportsForThread: (threadId, now, actorId, outcome) => q.reportsCloseThread.run(now, actorId, outcome, threadId),
    openReportCount: () => q.reportsOpenCount.get().n,
    closedReportCount: () => q.reportsClosedCount.get().n,
    openReports: (limit, offset) => q.reportsOpen.all(limit, offset),
    closedReports: (limit, offset) => q.reportsClosed.all(limit, offset),

    // Map post id -> { likes, dislikes } (posts with no vote are left out)
    voteCounts(postIds) {
      const out = new Map();
      if (postIds.length) for (const r of q.voteCounts.all(JSON.stringify(postIds))) out.set(r.post_id, { likes: r.likes, dislikes: r.dislikes });
      return out;
    },
    // Map post id -> 1 or -1: the account's own votes among those posts
    votesBy(accountId, postIds) {
      const out = new Map();
      if (accountId && postIds.length) for (const r of q.votesBy.all(accountId, JSON.stringify(postIds))) out.set(r.post_id, r.value);
      return out;
    },
    // Map account id -> likes received
    likesReceived(ids) {
      const list = [...new Set(ids.filter((x) => x !== null && x !== undefined))];
      const out = new Map();
      if (list.length) for (const r of q.likesReceived.all(JSON.stringify(list))) out.set(r.id, r.n);
      return out;
    },
    vote(postId, accountId, value, now) {
      if (value === 0) q.voteClear.run(postId, accountId);
      else q.voteSet.run(postId, accountId, value, now);
    },

    picture: (accountId) => q.picture.get(accountId) || null,
    setPicture: (accountId, p, now) => q.pictureSet.run(accountId, p.version, p.type, p.bytes, p.width, p.height, p.frames, now),
    removePicture: (accountId) => q.pictureRemove.run(accountId),
    pictureBytes: () => q.pictureBytes.get().n,
    pictureVersions: () => q.pictureVersions.all(),

    // the DEVELOPER flag (migration 9)
    isDeveloper: (accountId) => !!(accountId && q.developer.get(accountId)),
    addDeveloper: (accountId, byId, now) => Number(q.developerAdd.run(accountId, byId, now).changes) > 0,
    removeDeveloper: (accountId) => Number(q.developerRemove.run(accountId).changes) > 0,
  };
}
