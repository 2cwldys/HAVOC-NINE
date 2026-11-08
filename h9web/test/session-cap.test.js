import { test } from "node:test";
import assert from "node:assert/strict";
import { startApp, signup, request } from "./helpers.js";

test("an account keeps at most session.maxPerAccount sessions: a new sign-in ends the oldest", async () => {
  const t = await startApp({
    session: { days: 30, idleDays: 14, maxPerAccount: 3 },
    limits: { signupPerIp: { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 }, loginPerIp: { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 }, loginPerUser: { max: 100000, windowSeconds: 60, blockSeconds: 1, maxBlockSeconds: 1 } },
  });
  try {
    const first = await signup(t.base, "Cap");
    const count = () => t.app.db.prepare("SELECT count(*) AS n FROM sessions").get().n;
    assert.equal(count(), 1);
    const cookies = [first];
    for (let i = 0; i < 4; i++) {
      const r = await request(t.base, "POST", "/api/login", { body: { username: "Cap", password: "correct horse battery staple" } });
      assert.equal(r.status, 200);
      cookies.push(r.cookie);
    }
    assert.equal(count(), 3, "five sign-ins, three sessions kept");
    const oldest = await request(t.base, "GET", "/api/me", { cookie: cookies[0] });
    assert.equal(oldest.json.signedIn, false, "the oldest session is gone");
    const newest = await request(t.base, "GET", "/api/me", { cookie: cookies[cookies.length - 1] });
    assert.equal(newest.json.signedIn, true, "the newest still works");
  } finally {
    await t.close();
  }
});
