// havoc9.org's rank figures (assets/presence.js), run in a stand-in page: the ELO figure beside the
// career badge, in thousands ("1.2K ELO": one decimal under 10K, a ".0" dropped), beside a name
// that asks for it (data-h9-level-elo, as the forum's post authors and profiles do) and in the RANK
// block; a name that does not ask gets the badge alone. docs\H9_COMPETITIVE.txt section 8a. And the
// admin panel's account page (admin/admin.js), whose RANK box has to get in beside the others.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, "..", "..", "havoc9.org");

class Text {
  constructor(s) {
    this.s = s;
  }
  get textContent() {
    return this.s;
  }
}

// Enough of an element for presence.js to build and fill a page.
function stand() {
  const all = [];
  class E {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.attrs = {};
      this.className = "";
      this.text = "";
      this.connected = false;
      all.push(this);
    }
    append(...c) {
      for (const x of c) this.children.push(typeof x === "string" ? new Text(x) : x);
    }
    appendChild(c) {
      this.children.push(c);
      return c;
    }
    replaceChildren(...c) {
      this.children = [];
      this.append(...c);
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    }
    hasAttribute(k) {
      return k in this.attrs;
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    addEventListener() {}
    matches() {
      return false;
    }
    querySelector() {
      return null;
    }
    querySelectorAll(sel) {
      const keys = [...sel.matchAll(/\[([a-z0-9-]+)\]/g)].map((m) => m[1]);
      return all.filter((n) => n.connected && keys.some((k) => k in n.attrs));
    }
    get isConnected() {
      return this.connected;
    }
    set textContent(v) {
      this.text = String(v);
      this.children = [];
    }
    get textContent() {
      return this.text + this.children.map((c) => c.textContent).join("");
    }
  }
  const doc = {
    currentScript: { src: "https://havoc9.org/assets/presence.js" }, readyState: "loading", head: new E("head"), body: new E("body"),
    createElement: (tag) => new E(tag), querySelectorAll: (sel) => E.prototype.querySelectorAll.call({}, sel), querySelector: () => null,
    addEventListener() {}, getElementById: () => null,
  };
  return { E, doc };
}

describe("havoc9.org: the ELO figure beside the career badge", () => {
  let P;
  let E;
  let doc;
  before(() => {
    ({ E, doc } = stand());
    const views = {
      neo: { username: "Neo", level: 37, elo: 1234 },
      zed: { username: "Zed", level: 0, elo: null },
    };
    const ctx = {
      document: doc, window: {}, location: { href: "https://havoc9.org/forum/" }, Element: E,
      URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: async (url) => {
        const accounts = {};
        for (const name of (new URL(url).searchParams.get("u") || "").split(",")) accounts[name] = views[name.toLowerCase()] || null;
        return { ok: true, status: 200, json: async () => ({ accounts }) };
      },
      matchMedia: () => ({ matches: false, addEventListener() {} }), MutationObserver: class { observe() {} disconnect() {} },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "presence.js"), "utf8"), ctx, { filename: "presence.js" });
    P = ctx.H9Presence;
  });

  test("a rating in thousands: one decimal under 10K, a .0 dropped, whole thousands from 10K", () => {
    const cases = [
      [1234, "1.2K"], [1000, "1K"], [1050, "1.1K"], [850, "0.9K"], [999, "1K"], [5000, "5K"], [5049, "5K"],
      [9949, "9.9K"], [9950, "10K"], [9960, "10K"], [10000, "10K"], [12345, "12K"], [100000, "100K"],
    ];
    for (const [rating, want] of cases) assert.equal(P.compactElo(rating), want, String(rating));
    for (const nothing of [null, undefined, "1200", NaN, Infinity]) assert.equal(P.compactElo(nothing), "", String(nothing));
  });

  test("beside a name that asks for it: the badge and the figure; otherwise the badge alone; no rating, no figure", async () => {
    const mark = (name, asks) => {
      const n = new E("span");
      n.attrs["data-h9-level"] = name;
      if (asks) n.attrs["data-h9-level-elo"] = "1";
      n.connected = true;
      return n;
    };
    const plain = mark("Neo", false);
    const asking = mark("Neo", true);
    const unrated = mark("Zed", true);
    await P.decorate(doc);
    assert.deepEqual(plain.children.map((c) => c.tag), ["img"], "the badge alone");
    assert.deepEqual(asking.children.map((c) => c.tag), ["img", "span"], "the badge, then the figure");
    assert.equal(asking.children[0].attrs.src.endsWith("/assets/levels/lv-37-24.png"), true);
    assert.equal(asking.children[1].textContent, "1.2K ELO");
    assert.equal(asking.children[1].className, "h9-elo");
    assert.equal(asking.children[1].attrs.title, "H9 ladder rating 1234");
    assert.deepEqual(unrated.children.map((c) => c.tag), ["img"], "Lv 0 with no rating: the badge, no figure");
  });

  test("the RANK block: the figure beside the level, the H9 ladder's rating and place, the career's experience", () => {
    const rank = {
      season: { number: 2, started: "2026-11-03T05:00:00Z", ended: null }, level: 16, rule: "career", xp: 3200,
      h9: { elo: 1102, place: 1, matches: 3, wins: 2, losses: 1, kills: 9, deaths: 4, headshots: 2, assists: null, kd: 2.25 },
    };
    const text = P.renderRank(rank, { name: "Neo" }).textContent;
    for (const want of ["LV 16", "1.1K ELO", "SEASON 2", "H9 LADDER", "1102", "#1", "2 WON", "1 LOST", "9 / 4", "CAREER XP", "3200"]) {
      assert.ok(text.includes(want), want + " in " + text);
    }
    const none = P.renderRank({ season: { number: 1, started: null }, level: 0, rule: "career", xp: 0, h9: null }).textContent;
    assert.ok(none.includes("LV 0") && none.includes("CAREER XP"), none);
    assert.ok(!none.includes("ELO") && !none.includes("H9 LADDER"), "no rating yet, no figure: " + none);
  });
});

describe("havoc9.org: the admin panel's account page", () => {
  test("every box (DISCORD, LINKED GAMES, RANK, DEVELOPER) goes in before the audit trail's own heading", () => {
    // panel.querySelector(".forum-section") finds the heading of the box that went in before, which
    // is not the panel's child: insertBefore throws, and the boxes after it never show
    const js = fs.readFileSync(path.join(SITE, "admin", "admin.js"), "utf8");
    const from = js.indexOf("async function showAccount(");
    assert.ok(from > 0, "showAccount");
    const body = js.slice(from, js.indexOf("\n  }\n", from));
    const inserts = body.match(/panel\.insertBefore\([^;]*\);/g) || [];
    assert.equal(inserts.length, 4, inserts.join(" "));
    for (const s of inserts) assert.ok(s.endsWith(", trailHead);"), s);
    assert.match(body, /const trailHead = el\("h3", \{ class: "forum-section", text: "ITS AUDIT TRAIL" \}\);/);
    assert.match(body, /panel\.append\(trailHead, /);
  });
});
