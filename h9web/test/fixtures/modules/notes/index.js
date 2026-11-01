// A module the tests load through the registry, the way the forum will be loaded: its own
// migration, routes under /api/notes and /notes, and the shared auth guards.

let refusedOutside = false;

export default {
  name: "notes",
  pages: true,
  migrations: [
    {
      version: 1,
      description: "notes table",
      up(db) {
        db.exec(`CREATE TABLE notes_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`);
      },
    },
  ],
  setup(ctx) {
    const insert = ctx.db.prepare("INSERT INTO notes_items (account_id, body, created_at) VALUES (?, ?, ?)");
    const list = ctx.db.prepare("SELECT n.id, n.body, a.username FROM notes_items n JOIN accounts a ON a.id = n.account_id ORDER BY n.id");
    const remove = ctx.db.prepare("DELETE FROM notes_items WHERE id = ?");
    const posts = new ctx.limits.RateLimiter({ max: 3, windowSeconds: 60, blockSeconds: 60, maxBlockSeconds: 60 });

    ctx.router.get("/api/notes", async (req, res, rc) => rc.json(200, { notes: list.all(), refusedOutside }));
    ctx.router.post("/api/notes", ctx.auth.requireSession(async (req, res, rc) => {
      const lim = posts.hit("a:" + rc.account.id);
      if (!lim.ok) throw new ctx.http.HttpError(429, "rate_limited", "Slow down.");
      const body = await rc.body();
      if (typeof body.body !== "string" || !body.body.trim()) throw new ctx.http.HttpError(400, "bad_request", "Write something.");
      insert.run(rc.account.id, body.body.slice(0, 500), Math.floor(Date.now() / 1000));
      rc.json(201, { ok: true, by: ctx.accounts.publicView(rc.account) });
    }));
    ctx.router.delete("/api/notes/:id", ctx.auth.requireRole("moderator", async (req, res, rc) => {
      remove.run(Number(rc.params.id));
      rc.json(200, { ok: true });
    }));
    ctx.router.get("/notes/*", async (req, res, rc) => {
      rc.send(200, "<!doctype html><title>notes</title><p>" + rc.params["*"].replace(/[^a-z0-9/-]/gi, "") + "</p>", "text/html; charset=utf-8");
    });
    try {
      ctx.router.get("/api/me", async () => {});
    } catch (e) {
      refusedOutside = true;
    }
  },
};
