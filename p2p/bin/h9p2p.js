#!/usr/bin/env node
// h9p2p: the helper's command line. Output is JSON lines on stdout (one event per line), so a launcher or a plugin can read it.
//
//   node bin/h9p2p.js host --service <url> --token <bearer> [--game 127.0.0.1:27015] [--name <text>]
//        [--relay-only] [--no-relay] [--invite [--label <text>] [--ttl <s>] [--uses <n>] [--require-account] [--direct]]
//   --direct: the invites this process mints may use the direct leg (the friend then learns the host's address); without it they are
//   relay-only. --relay-only (a switch of the session) wins over --direct.
//   node bin/h9p2p.js join <code> --service <url> [--listen auto|<addr>[:<port>]] [--relay-only] [--no-relay] [--account <token>]
//
// host: stays up; prints {"ev":"ready"}, {"ev":"invite",...}, {"ev":"joiner",...}, {"ev":"path",...}; stdin lines "invite <label>",
//       "kick <flow>", "quit" are accepted.
// join: prints {"ev":"ready","listen":"127.101.x.y:27015"} when the relay leg answers; then connect the game to that address.
//
// --allow-private-peers is for LAN play and tests only: it lets the helper accept private addresses as a peer's.
// --bind <address> is the local address of the helper's UDP socket toward the service and the peer (default 0.0.0.0; tests on Windows use 127.0.0.1).
//
// The launchers (h9_p2p_host.*, h9_p2p_join.*) use three more forms, which read p2p.ini beside h9xash.bat (lib/launch.js says what is in it):
//   node bin/h9p2p.js host --ini <p2p.ini> | --ipc <data folder> [--service <url>] [--game <host:port>] [--idle-exit <minutes>]
//        file mode: the helper of the plugin h9_p2p.amxx. It is driven by the files in the game's data folder (lib/ipc.js has their
//        grammar), keeps one session open while the game says h9_p2p is 1, and prints readable lines (never a code, a key or the token).
//        The host token comes from the environment variable H9_P2P_TOKEN, else --token, else p2p.ini. Exit 2: options wrong,
//        4: a helper of this folder is running already.
//   node bin/h9p2p.js play <code> [--ini <p2p.ini>] [--service <url>] [--no-game] [--relay-only] [--port <n>]
//        the friend: redeems the code, waits for the relay, starts h9xash.bat (h9xash.sh on Linux) with +connect <address> (or prints
//        the address to type with --no-game, or when the game runs), and stops with the game.
//   node bin/h9p2p.js ensure --ini <p2p.ini>
//        starts the file-mode helper in the background (no window; output in p2p.log beside p2p.ini) unless one runs already.
//        Exit 0: started, 10: one is running already (left alone), 2: options wrong, 1: it did not come up.
//   node bin/h9p2p.js stop --ini <p2p.ini> | --ipc <data folder>
//        asks the file-mode helper of that folder to stop.

import readline from "node:readline";
import path from "node:path";
import { HostHelper, JoinHelper } from "../lib/helper.js";
import { HostIpc } from "../lib/ipc.js";
import { fileURLToPath } from "node:url";
import { hostOptions, readIni, playGame, stopHelper, ensureHelper } from "../lib/launch.js";

const args = process.argv.slice(2);
const mode = args[0];
const flag = (n) => args.includes(n);
const val = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const out = (o) => console.log(JSON.stringify({ t: Date.now(), ...o }));
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (text) => console.log("[" + stamp() + "] " + text);

if (mode === "host" && (flag("--ipc") || flag("--ini"))) {
  const opt = hostOptions(args.slice(1));
  for (const w of opt.warnings) console.log("WARNING: " + w);
  if (!opt.ok) {
    for (const e of opt.errors) console.error("h9p2p: " + e);
    process.exit(2);
  }
  const ipc = new HostIpc({
    dir: opt.dir, service: opt.service, token: opt.token, game: opt.game, bindAddress: val("--bind", "0.0.0.0"),
    allowPrivatePeers: flag("--allow-private-peers"), idleExitMs: opt.idleExitMs, log: say,
  });
  try {
    ipc.start();
  } catch (e) {
    console.error("h9p2p: " + e.message);
    process.exit(e.code === "running" ? 4 : 1);
  }
  say("file mode: " + opt.dir);
  say("relay: " + (opt.service || "the address in the game's h9_p2p_service") + "; game: " + opt.game.host + ":" + opt.game.port);
  // a long-lived helper does not die of one failed promise: it says so and goes on
  process.on("unhandledRejection", (e) => say("internal error, the helper goes on: " + String((e && e.message) || e).slice(0, 160)));
  ipc.on("stopped", () => process.exit(0));
  const quit = () => { ipc.stop("stopped by the host").catch(() => process.exit(0)); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
} else if (mode === "host") {
  const [gh, gp] = String(val("--game", "127.0.0.1:27015")).split(":");
  const h = new HostHelper({
    service: val("--service"), token: val("--token"), game: { host: gh, port: Number(gp) }, name: val("--name", ""),
    direct: !flag("--relay-only"), relay: !flag("--no-relay"), allowPrivatePeers: flag("--allow-private-peers"), bindAddress: val("--bind", "0.0.0.0"),
  });
  h.on("ready", (r) => out({ ev: "ready", ...r }));
  h.on("joiner", (j) => out({ ev: "joiner", ...j }));
  h.on("path", (p) => out({ ev: "path", ...p }));
  h.on("gone", (g) => out({ ev: "gone", ...g }));
  h.on("session-lost", (g) => { out({ ev: "session-lost", ...g }); process.exit(3); });
  h.on("error", (e) => out({ ev: "error", error: e.message }));
  try {
    await h.open();
  } catch (e) {
    out({ ev: "error", error: e.message });
    process.exit(1);
  }
  const mint = async (label) => {
    try {
      const inv = await h.invite({ label, ttl: Number(val("--ttl", 600)), uses: Number(val("--uses", 1)), requireAccount: flag("--require-account"), direct: flag("--direct") });
      out({ ev: "invite", ...inv });
    } catch (e) {
      out({ ev: "error", error: e.message });
    }
  };
  if (flag("--invite")) await mint(val("--label", ""));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (cmd === "invite") await mint(rest.join(" "));
    else if (cmd === "kick") out({ ev: "kick", ...(await h.kick(Number(rest[0]))) });
    else if (cmd === "stats") out({ ev: "stats", flows: h.stats() });
    else if (cmd === "quit") { await h.close(); process.exit(0); }
  });
  rl.on("close", () => {});
  if (val("--stats-every")) setInterval(() => out({ ev: "stats", flows: h.stats() }), Number(val("--stats-every")) * 1000).unref();
  process.on("SIGTERM", async () => { await h.close(); process.exit(0); });
  process.on("SIGINT", async () => { await h.close(); process.exit(0); });
} else if (mode === "join") {
  const code = args[1];
  const listen = String(val("--listen", "auto"));
  let lh = "auto";
  let lp = 27015;
  if (listen !== "auto") {
    const i = listen.lastIndexOf(":");
    lh = i > 0 ? listen.slice(0, i) : listen;
    lp = i > 0 ? Number(listen.slice(i + 1)) : 27015;
  } else if (val("--port")) {
    lp = Number(val("--port"));
  }
  const j = new JoinHelper({
    service: val("--service"), code, listen: { host: lh, port: lp }, direct: !flag("--relay-only"), relay: !flag("--no-relay"),
    account: val("--account"), allowPrivatePeers: flag("--allow-private-peers"), bindAddress: val("--bind", "0.0.0.0"),
  });
  j.on("ready", (r) => out({ ev: "ready", ...r }));
  j.on("path", (p) => out({ ev: "path", ...p }));
  j.on("closed", (c) => { out({ ev: "closed", ...c }); process.exit(0); });
  j.on("error", (e) => out({ ev: "error", error: e.message }));
  try {
    await j.start();
  } catch (e) {
    out({ ev: "error", error: e.message, status: e.status || 0 });
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const cmd = line.trim();
    if (cmd === "stats") out({ ev: "stats", ...j.stats() });
    else if (cmd === "quit") { j.close().then(() => process.exit(0)); }
  });
  if (val("--stats-every")) setInterval(() => out({ ev: "stats", ...j.stats() }), Number(val("--stats-every")) * 1000).unref();
  process.on("SIGTERM", async () => { await j.close(); process.exit(0); });
  process.on("SIGINT", async () => { await j.close(); process.exit(0); });
} else if (mode === "play") {
  const code = args[1] && !args[1].startsWith("--") ? args[1] : "";
  const iniPath = val("--ini");
  const ini = iniPath ? readIni(iniPath) : { flat: {} };
  const folder = iniPath ? path.dirname(path.resolve(iniPath)) : process.cwd();
  const service = val("--service") || ini.flat.service || "";
  if (!code) { console.error("usage: h9p2p play <invite code> [--ini <p2p.ini>] [--service <url>] [--no-game]"); process.exit(2); }
  if (!service) { console.error("h9p2p: no relay address: put service= in p2p.ini (the host tells you which relay), or add --service <url>"); process.exit(2); }
  let session;
  try {
    session = await playGame({
      code, service, folder, noGame: flag("--no-game") || ini.flat.start_game === "0", relayOnly: flag("--relay-only"), account: val("--account"),
      listenPort: Number(val("--port", 27015)), bindAddress: val("--bind", "0.0.0.0"), allowPrivatePeers: flag("--allow-private-peers"), log: say,
    });
  } catch (e) {
    console.error("h9p2p: " + e.message);
    process.exit(1);
  }
  const quit = () => { session.stop().then(() => process.exit(0)); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  const r = await session.done;
  say(r.why);
  process.exit(r.code);
} else if (mode === "ensure") {
  const iniPath = val("--ini");
  if (!iniPath) { console.error("usage: h9p2p ensure --ini <p2p.ini>"); process.exit(2); }
  try {
    const r = await ensureHelper({ ini: iniPath, script: fileURLToPath(import.meta.url), extraArgs: args.slice(1).filter((a, i, all) => a !== "--ini" && all[i - 1] !== "--ini") });
    console.log(r.state === "started" ? "the helper started (pid " + r.pid + ", its output is in p2p.log)" : "a helper is running already" + (r.pid ? " (pid " + r.pid + ")" : "") + ": left alone");
    process.exit(r.state === "started" ? 0 : 10);
  } catch (e) {
    console.error("h9p2p: " + e.message);
    process.exit(/no host token|example token|cannot read|not an http|idle_exit/.test(e.message) ? 2 : 1);
  }
} else if (mode === "stop") {
  if (!flag("--ini") && !flag("--ipc")) { console.error("usage: h9p2p stop --ini <p2p.ini> | --ipc <data folder>"); process.exit(2); }
  const dir = hostOptions(args.slice(1)).dir;
  const r = await stopHelper(dir);
  console.log(r.was ? (r.stopped ? "the helper stopped" : "the helper did not stop in 8 seconds") : "no helper is running for " + dir);
  process.exit(r.stopped ? 0 : 1);
} else {
  console.error("usage: h9p2p host|join|play|stop ... (see the header of this file)");
  process.exit(2);
}
