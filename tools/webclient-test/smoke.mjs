// The web client's smoke test: the page, the engine and the pieces the engine hands to the page, in a headless browser.
//
//   node smoke.mjs [--stage <dir>] [--site <dir>] [--browser edge|opera] [--json <file>]
//
// It serves the stage and havoc9.org's folder with stubbed API routes (server.mjs: no database, no account), plays to the
// engine's main menu, and checks:
//   engine     the page offers PLAY and the engine comes up to its menu
//   bridges    the page hands the engine every Module.* object the engine calls into (net, video, motd, travel, avatar)
//   chain      the page set _h9srv and _h9srv_gen from /api/presence/servers/auth, as the menu reads them
//   commands   the commands the page runs in the engine exist (h9_avatar_page)
//   picture    the page fetches a picture the engine names and writes it where the engine reads it
//   stable     the engine did not stop, abort or throw while it ran
// and records the menu's frame times as information.
// Exit 0 when every check passes, 1 when one fails, 2 when the test could not run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, killBrowser, newTab, playToMenu, sleep, findBrowser } from "./cdp.mjs";
import { startServer, STUB_AUTH } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

export async function smoke({ stage = path.join(ROOT, "webclient-build", "stage"), site = path.join(ROOT, "havoc9.org"), browser, port = 9455, say = console.log } = {}) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail || "" }); say(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ": " + detail : ""}`); };
  const found = findBrowser(browser);
  if (!found) return { ran: false, ok: false, why: "no Chromium browser found (Edge or Opera GX)", checks };
  for (const [what, p] of [["stage", path.join(stage, "manifest.json")], ["site", path.join(site, "webclient", "client.js")]]) {
    if (!fs.existsSync(p)) return { ran: false, ok: false, why: `no ${what} at ${p}`, checks };
  }
  const profile = path.join(ROOT, "webclient-build", "test-profile-" + found.name);
  const srv = await startServer({ site, stage });
  let br = null, tab = null;
  const consoleLines = [];
  try {
    br = await launch({ browser: found.name, profile, port });
    tab = await newTab(port);
    tab.on("Runtime.consoleAPICalled", (p) => consoleLines.push("[" + p.type + "] " + p.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(" ")));
    // the script an exception came from is named, so one from the browser's own extensions is not taken for the page's
    tab.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails;
      const from = d.url || (d.stackTrace && d.stackTrace.callFrames && d.stackTrace.callFrames[0] && d.stackTrace.callFrames[0].url) || "";
      consoleLines.push("[exception] " + ((d.exception && d.exception.description) || d.text) + (from ? " (from " + from + ")" : ""));
    });
    const inject = fs.readFileSync(path.join(HERE, "inject.js"), "utf8");
    try {
      await playToMenu({ tab, url: srv.url + "/webclient/index.html", inject, say: (t) => say("  " + t) });
      check("engine", true, found.name + " " + br.version.Browser);
    } catch (e) {
      check("engine", false, e.message);
      return { ran: true, ok: false, checks, console: consoleLines.slice(-40) };
    }

    const log = () => tab.eval("window.h9web.log.slice(-600)");
    const command = async (c) => { await tab.eval(`window.h9web.module().ccall("Cbuf_AddText", null, ["string"], [${JSON.stringify(c + "\n")}])`); await sleep(600); };
    const cvar = async (name) => {
      await command(name);
      const lines = await log();
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = new RegExp('"' + name + '" is "([^"]*)"').exec(lines[i]);
        if (m) return m[1];
      }
      return null;
    };

    // the objects the engine calls into
    const have = await tab.eval(`(() => { const m = window.h9web.module(); return Object.fromEntries(["net", "video", "motd", "travel", "avatar"].map((k) => [k, typeof m[k]])); })()`);
    const missing = Object.entries(have).filter(([, t]) => t === "undefined").map(([k]) => k);
    check("bridges", !missing.length, missing.length ? "missing from the page's engine config: " + missing.join(", ") : Object.keys(have).join(", "));

    // the chain: the page reads the list when the engine is up
    let gen = null, list = null;
    for (let i = 0; i < 20 && gen !== "1"; i++) {
      await sleep(500);
      gen = await cvar("_h9srv_gen");
    }
    list = await cvar("_h9srv");
    const want = " " + STUB_AUTH.split("\n").slice(1).filter(Boolean).map((l) => { const [a, c] = l.split(" "); return a + "=" + c[0]; }).join(" ") + " ";
    check("chain", gen === "1" && list === want, `_h9srv_gen ${JSON.stringify(gen)}, _h9srv ${JSON.stringify(list)}`);

    // a command the page runs must exist: an unknown one is named in the log
    await command("h9_avatar_page 1 1 1");
    const unknown = (await log()).filter((l) => /Unknown command "h9_avatar_page"/.test(l));
    check("commands", !unknown.length, unknown.length ? "h9_avatar_page is not registered in the engine" : "h9_avatar_page is registered");

    // the picture: the page fetches what the engine names and writes it where the engine reads it
    const file = "/ts/downloads/h9avatars/web_424242_3.png";
    await tab.eval(`window.h9web.module().avatar.want(7, 424242, 3)`);
    let size = 0;
    for (let i = 0; i < 20 && !size; i++) {
      await sleep(300);
      size = await tab.eval(`(() => { try { return window.h9web.module().FS.stat(${JSON.stringify(file)}).size; } catch (e) { return 0; } })()`);
    }
    check("picture", size > 100, size ? `${file} is ${size} bytes` : `${file} was not written`);

    // frame times, as information
    await sleep(1500);
    const from = await tab.eval("performance.now()");
    await sleep(5000);
    const perf = await tab.eval(`window.__perf.summary(${from}, performance.now())`);
    say(`  info frames: ${perf.fps} per second, p95 ${perf.frameMs.p95} ms, ${perf.longTasks.count} long tasks`);

    const bad = (await tab.eval("window.h9web.log.slice()")).filter((l) => /The game stopped|\babort\(|RuntimeError|Uncaught/.test(l)).concat(consoleLines.filter((l) => /^\[exception\]/.test(l)));
    check("stable", !bad.length, bad.length ? bad.slice(0, 3).join(" | ") : "no stop, abort or exception");
    return { ran: true, ok: checks.every((c) => c.ok), checks, perf: { fps: perf.fps, frameMs: perf.frameMs, longTasks: perf.longTasks }, browser: found.name + " " + br.version.Browser };
  } catch (e) {
    check("test", false, e.message);
    return { ran: true, ok: false, checks, console: consoleLines.slice(-40) };
  } finally {
    if (tab) tab.close();
    await srv.close();
    killBrowser(profile);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
  const result = await smoke({ stage: arg("stage", undefined), site: arg("site", undefined), browser: arg("browser", undefined) });
  if (arg("json")) fs.writeFileSync(arg("json"), JSON.stringify(result, null, 1));
  if (!result.ran) console.log("smoke test could not run: " + result.why);
  else console.log(result.ok ? "smoke test passed" : "smoke test FAILED");
  process.exit(!result.ran ? 2 : result.ok ? 0 : 1);
}
