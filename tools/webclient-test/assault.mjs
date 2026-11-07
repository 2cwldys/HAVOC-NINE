// A perf.mjs scenario: ASSAULT (ts_assault) seen from a player's screen. Joins the assault test server (D:\temp\h9-assault-server.bat:
// h9_as_lift, port 27015, rcon password in H9_RCON, tsm_bots 6), takes a side and a class from the menus, starts the match, and takes a
// picture at each step: the capture points' marks through the walls and the row of them under the top notices, the scoreboard with the
// side's pool of lives, a point changing hands, a death drawing from the pool, a respawn wave. The server's own account of each step
// (amx_tsm_assault, amx_tsm_debug, tsm_pres_prog) is printed from here over rcon.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login <test-account> --phases none --script assault.mjs --name assault
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_RCON=<password>        its rcon password (required)
import dgram from "node:dgram";
import fs from "node:fs";

// One rcon command to the server from here, over UDP: what it printed.
function rconCall(command, port, password) {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const out = [];
    s.on("message", (m) => out.push(m.toString("latin1").replace(/[^\x20-\x7e\n]/g, "?").replace(/^\?\?\?\?/, "").trim()));
    s.send(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from(`rcon ${password} ${command}\n`, "latin1")]), port, "127.0.0.1");
    setTimeout(() => { s.close(); resolve(out.join("\n").split("\n").filter((l) => l !== "print").join("\n")); }, 1500);
  });
}

const KEY = { "1": 49, "2": 50, "3": 51, "4": 52, "5": 53 };

export default async function assault({ tab, cmd, sleep, shot, results, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const rcon = process.env.H9_RCON;
  if (!rcon) throw new Error("set H9_RCON to the test server's rcon password");
  const port = Number(server.split(":")[1]);
  const press = async (k) => {
    const base = { windowsVirtualKeyCode: KEY[k], nativeVirtualKeyCode: KEY[k], key: k, code: "Digit" + k };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", text: k, unmodifiedText: k, ...base });
    await sleep(80);
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  // join, and wait until the engine has been quiet for a while
  await cmd("menu_internetgames");
  await sleep(6000);
  await cmd("connect " + server);
  console.log(stamp() + " connect " + server);
  let last = await tab.eval("window.h9web.log.length"), quiet = 0, waited = 0;
  while (waited < 240000) {
    await sleep(500);
    waited += 500;
    const n = await tab.eval("window.h9web.log.length");
    if (n !== last) { last = n; quiet = 0; } else quiet += 500;
    const fetching = await tab.eval(`(() => { const l = window.h9web.log; let s = -1, d = -1; for (let i = 0; i < l.length; i++) { if (l[i].includes("H9 WARM: the page fetches")) s = i; else if (l[i].includes("H9 WARM:") && (l[i].includes("here after") || l[i].includes("did not finish"))) d = i; } return s > d; })()`);
    if (waited >= 6000 && quiet >= 6000 && !fetching) break;
  }
  await sleep(4000);
  // the server's MOTD covers the game until its OK is pressed
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await tab.send("Input.dispatchMouseEvent", { type, x: 407, y: 532, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await sleep(80);
  }
  await sleep(2500);
  await tab.eval("document.getElementById('canvas') && document.getElementById('canvas').focus()");
  console.log(stamp() + " in the game");
  await shot("siege-0-joined");

  // the bots the match fills with (they wait in spectator until a human has taken a side)
  await rconCall("tsm_bots 6", port, rcon);

  // a side and a class from the menus (number keys), then the match
  await press("1");
  await sleep(2500);
  await shot("as-1-side");
  await press("1");
  await sleep(2500);
  await shot("as-2-class");
  // a join that was slow can miss the menus: ask again until the server has a human on a side
  const humanOnSide = async () => {
    const m = /humans_on_a_side=(\d+)/.exec(await rconCall("amx_tsm_debug", port, rcon));
    return m ? Number(m[1]) : 0;
  };
  for (let tries = 0; tries < 8 && !(await humanOnSide()); tries++) {
    console.log(stamp() + " no human on a side yet: asking for the first side and class again");
    await cmd("menuselect 1");
    await sleep(1500);
    await press("1");
    await sleep(2500);
  }
  await cmd("rcon_address " + server);
  await cmd("rcon_password " + rcon);
  await cmd("rcon amx_match_start");
  console.log(stamp() + " match started");
  for (let i = 0; i < 4; i++) {
    await sleep(3000);
    await shot("as-3-start-" + i);
  }

  // the mode's state, asked of the server over rcon from here
  const ask = async (c) => {
    const text = await rconCall(c, port, rcon);
    console.log(stamp() + " rcon " + c + "\n" + text.split("\n").map((l) => "    " + l).join("\n"));
    return text;
  };
  await ask("amx_tsm_assault");
  await ask("amx_tsm_debug");

  // the scoreboard (TAB held): the pool of lives in the team rows
  const tab_key = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: "Tab", code: "Tab" };
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...tab_key });
  await sleep(1500);
  await shot("as-4-scoreboard");
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...tab_key });
  await sleep(800);

  // points change hands: the marks follow, and the notices say so
  await cmd("rcon amx_tsm_as_give 1 1");
  await sleep(1500);
  await shot("as-5-point1-side1");
  await cmd("rcon amx_tsm_as_give 3 2");
  await sleep(1500);
  await shot("as-6-point3-side2");
  await cmd("rcon amx_tsm_as_give 2 1");
  await cmd("rcon amx_tsm_as_give 4 2");
  await sleep(1500);
  await shot("as-7-four-held");
  await ask("amx_tsm_assault");
  await ask("tsm_pres_prog");

  // a death draws from the pool; the scoreboard shows it
  await ask("amx_tsm_simelim");
  await sleep(2500);
  await ask("amx_tsm_debug");
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...tab_key });
  await sleep(1500);
  await shot("as-8-scoreboard-after");
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...tab_key });

  // a wave puts the fallen back at the points their side holds
  await ask("amx_tsm_wave");
  await sleep(3000);
  await shot("as-9-after-wave");
  await ask("amx_tsm_debug");
  // ---- the respawn sets: a wave lands at the FRONT set of the points its side holds, and at its base while it holds none.
  // The placements are read from the server's own debug log (tsm_debug_log 1 writes "placed <id> (team <t>) at x y z -- <why>").
  const GAME_DIR = process.env.H9_GAME_DIR || "D:/GIT Storage/ts_h9_team_elimination/H9XASH";
  const SPAWNS = GAME_DIR + "/ts/addons/amxmodx/configs/tsm_spawns_" + (process.env.H9_MAP || "h9_as_lift") + ".cfg";
  const DBGLOG = GAME_DIR + "/ts/addons/amxmodx/logs/tsm_debug.log";
  const spawns = fs.readFileSync(SPAWNS, "latin1").split(/\r?\n/).map((l) => l.split("//")[0].trim().split(/\s+/))
    .filter((t) => t[0] === "tsm_spawn" && t.length >= 5)
    .map((t) => ({ team: +t[1], x: +t[2], y: +t[3], z: +t[4], tier: t[7] !== undefined ? +t[7] : 0 }));
  const mid = (team, tier) => {
    const p = spawns.filter((s) => s.team === team && s.tier === tier);
    return p.length ? { x: p.reduce((a, s) => a + s.x, 0) / p.length, y: p.reduce((a, s) => a + s.y, 0) / p.length, z: p.reduce((a, s) => a + s.z, 0) / p.length, n: p.length } : null;
  };
  // what the core should pick: of the held points' sets that have places for the side, the one nearest the other side's base
  const expectedTier = (team, held) => {
    const foe = mid(3 - team, 0);
    let best = 0, bd = Infinity;
    for (const t of held) {
      const m = mid(team, t);
      if (!m) continue;
      const d = foe ? Math.hypot(m.x - foe.x, m.y - foe.y, m.z - foe.z) : t;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  };
  // the debug log prints whole units, cut toward zero, so a logged place is within one unit of its line in the spawn file
  const inTier = (team, tier, p) => spawns.some((s) => s.team === team && s.tier === tier && Math.abs(s.x - p.x) < 1 && Math.abs(s.y - p.y) < 1 && Math.abs(s.z - p.z) < 1);
  const logSize = () => (fs.existsSync(DBGLOG) ? fs.statSync(DBGLOG).size : 0);
  const placedSince = (from) => {
    if (!fs.existsSync(DBGLOG)) return [];
    const buf = fs.readFileSync(DBGLOG);
    const text = buf.subarray(Math.min(from, buf.length)).toString("latin1");
    return [...text.matchAll(/placed (\d+) \(team (\d)\) at (-?\d+) (-?\d+) (-?\d+) -- (wave revive[^;]*)/g)]
      .map((m) => ({ id: +m[1], team: +m[2], x: +m[3], y: +m[4], z: +m[5], why: m[6] }));
  };
  // the sides' bots, by name, from the server's own player list
  const roster = async () => {
    const t = await ask("amx_tsm_debug");
    const out = { 1: [], 2: [] };
    for (const m of t.matchAll(/\[TSM\]\s{3}(\S.*?)\s+raw#=\d+ raw='[^']*' -> resolved=(\d)/g)) {
      if (out[+m[2]] && /^(Enforcer|Insurgent) \d+$/.test(m[1].trim())) out[+m[2]].push(m[1].trim());
    }
    return out;
  };
  const verdict = (name, ok, detail) => { console.log(stamp() + (ok ? " PASS " : " FAIL ") + name + (detail ? " -- " + detail : "")); results.checks = results.checks || []; results.checks.push({ name, ok }); };

  await ask("tsm_logging 1");
  await ask("tsm_debug_log 1");
  // The respawn sets are judged on ownership alone: whether an enemy standing in a point shuts its set (tsm_as_spawn_under_attack 0)
  // depends on where the bots wander, and a check cannot wait for them to leave.
  await ask("tsm_as_spawn_under_attack 1");
  const bots = await roster();
  console.log(stamp() + " bots: side 1 " + bots[1].join(", ") + "; side 2 " + bots[2].join(", "));

  // ---- the respawn sets, judged against the points as the server has them AT THE MOMENT OF THE WAVE. Bots do not play the objective, but
  // a bot standing in a point takes it like anyone else, so the points change by themselves while a test runs: each wave is therefore
  // judged against what amx_tsm_as_list says just before it goes, never against what the test set up a moment earlier.
  const give = (n, owner) => rconCall("amx_tsm_as_give " + n + " " + owner, port, rcon);
  const giveAll = async (owner) => { for (const n of [1, 2, 3, 4, 5]) await give(n, owner); };
  const holders = async () => {
    const t = await rconCall("amx_tsm_as_list", port, rcon);
    const held = { 1: [], 2: [] };
    for (const m of t.matchAll(/point (\d+) \(\w\)[^\n]*held by (\d)/g)) if (+m[2] === 1 || +m[2] === 2) held[+m[2]].push(+m[1]);
    return held;
  };
  const everyone = async () => {
    const t = await ask("amx_tsm_debug");
    return [...t.matchAll(/\[TSM\]\s{3}(\S.*?)\s+raw#=\d+ raw='[^']*' -> resolved=(\d)/g)].map((m) => ({ name: m[1].trim(), side: +m[2] }));
  };
  const human = (await everyone()).find((p) => !/^(Enforcer|Insurgent) \d+$/.test(p.name) && p.side === 1);
  const checksSince = (from) => {
    if (!fs.existsSync(DBGLOG)) return [];
    const buf = fs.readFileSync(DBGLOG);
    const text = buf.subarray(Math.min(from, buf.length)).toString("latin1");
    return [...text.matchAll(/revive check: (.+?) \((\d+)\) is (\d+) units from the point the wave put him on, at (-?\d+) (-?\d+) (-?\d+) \(it put him at (-?\d+) (-?\d+) (-?\d+), tier (\d+)\)/g)]
      .map((m) => ({ name: m[1], id: +m[2], off: +m[3], at: { x: +m[4], y: +m[5], z: +m[6] }, put: { x: +m[7], y: +m[8], z: +m[9] }, tier: +m[10] }));
  };
  const nearTier = (team, tier, p, r) => spawns.some((s) => s.team === team && s.tier === tier && Math.hypot(s.x - p.x, s.y - p.y) <= r && Math.abs(s.z - p.z) <= 48);
  const wall = () => new Date().toTimeString().slice(0, 8);
  const logTextSince = (from) => {
    if (!fs.existsSync(DBGLOG)) return "";
    const buf = fs.readFileSync(DBGLOG);
    return buf.subarray(Math.min(from, buf.length)).toString("latin1");
  };
  // A player eliminated, and known to be: the server says so, or says he already was (dead and waiting for a wave), and the debug log
  // has the line. A simelim that landed on nobody is asked again.
  const eliminate = async (name) => {
    for (let i = 0; i < 6; i++) {
      const from = logSize();
      const said = await rconCall('amx_tsm_simelim "' + name + '"', port, rcon);
      if (/already eliminated/.test(said) || logTextSince(from).includes("simelim: " + name)) return true;
      await sleep(1500);
    }
    console.log(stamp() + " (" + wall() + ") could not eliminate " + name);
    return false;
  };
  // Of a wave's placements, the last of each player: where he ended up. A revive places a person up to three times (while TS still has
  // him dead, when he is back on his feet, and again after the spawn settles), and only the end of it is where he plays from.
  const finals = (list) => { const last = new Map(); for (const p of list) last.set(p.id, p); return [...last.values()]; };
  const tierAt = (team, p) => { const s = spawns.find((q) => q.team === team && Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) < 1 && Math.abs(q.z - p.z) < 1); return s ? s.tier : null; };
  // The fallen of a side are killed, the points read, the wave fired; where each of them ends up (the bots' last placements, and the
  // human's revive check) must be in the set the core should pick for the points as they stood: the one nearest the enemy's base of those
  // the side holds, else its base. `wait` is how long the wave is given at most, `until(from)` how it knows it is done early (a person
  // killed a moment ago waits out TS's respawn time). A player carried from one set to another between his two placements on his feet
  // fails the second verdict.
  const oracleWave = async (team, names, label, wait = 4500, until = null) => {
    let killed = true;
    for (const n of names) killed = (await eliminate(n)) && killed;
    await sleep(1500);
    const held = await holders();
    const want = expectedTier(team, held[team]);
    const from = logSize();
    await rconCall("amx_tsm_wave " + team, port, rcon);
    for (let waited = 0; waited < wait; waited += 500) {
      await sleep(500);
      if (until && waited >= 2000 && until(from)) { await sleep(1000); break; }
    }
    const all = placedSince(from).filter((p) => p.team === team);
    const got = finals(all);
    const there = got.filter((p) => inTier(team, want, p)).length;
    verdict(label + " [side " + team + " holds " + (held[team].join(" and ") || "nothing") + ": " + (want ? "set " + want : "its base") + "] (" + wall() + ")",
      killed && got.length > 0 && there === got.length, got.length + " placed, " + there + " there" + (killed ? "" : ", a kill did not land"));
    // the two placements on his feet (back on his feet, then the arm's respawn) agree on the set
    const pairs = [];
    for (const p of got) {
      const mine = all.filter((q) => q.id === p.id && /back on his feet|arm's respawn/.test(q.why));
      const feet = mine.find((q) => /back on his feet/.test(q.why));
      const arm = mine.filter((q) => /arm's respawn/.test(q.why)).pop();
      if (feet && arm) pairs.push([p.id, tierAt(team, feet), tierAt(team, arm)]);
    }
    if (pairs.length) verdict("  and nobody is carried from one set to another by his second placement", pairs.every((x) => x[1] === x[2]), pairs.map((x) => x[0] + ":" + x[1] + "/" + x[2]).join(" "));
    return { held, want, got, from };
  };
  const killSide2 = async () => { for (const b of bots[2]) await eliminate(b); };

  // 1-2. side 1 holds point 3, then 2 and 3: the wave goes to the one nearer the enemy's base, and to that one only
  await giveAll(0);
  await give(3, 1);
  await oracleWave(1, bots[1].slice(0, 3), "side 1, its wave lands in the set of the point it holds");
  await shot("as-10-wave-at-point-3");
  await give(2, 1);
  await oracleWave(1, bots[1].slice(0, 3), "side 1, with two points held the wave goes to the front one");
  await ask("amx_tsm_debug").then((t) => console.log(stamp() + " " + (t.split("\n").find((l) => l.includes("waves land at")) || "no 'waves land at' line").trim()));

  // 3. side 2 holds nothing: its wave lands at its base
  for (const n of (await holders())[2]) await give(n, 0);
  await oracleWave(2, bots[2].slice(0, 3), "side 2, holding nothing, lands at its base");

  // 4. losing the front point: its set closes, and the wave goes to the point still held
  await give(expectedTier(1, (await holders())[1]), 2);
  await oracleWave(1, bots[1].slice(0, 3), "side 1, after losing its front point");
  await shot("as-11-after-the-front-point-fell");

  // 5. side 2's forward sets work as side 1's do, and when side 1 takes its front point from it the wave goes to the other
  await giveAll(0);
  await give(1, 2);
  await give(4, 2);
  const r5 = await oracleWave(2, bots[2].slice(0, 3), "side 2, with points 1 and 4 held the wave goes to the front one");
  await shot("as-17-side-2-wave");
  if (r5.want) await give(r5.want, 1);
  await oracleWave(2, bots[2].slice(0, 3), "side 2, after side 1 took its front point");

  // ---- the player's own revive. The checks above revive the bots; the person at the screen goes through the same wave by his own path
  // (ghosted while he waits, TS's respawn, then placed again), so he is killed too, and the server's own position check -- "revive check"
  // in the debug log, 0.6 s after the placement that ends a wave revive -- says where he really is.
  const lastDetail = (c) => (c ? "put at " + c.put.x + " " + c.put.y + " " + c.put.z + " (tier " + c.tier + "), " + c.off + " units off a moment later, at " + c.at.x + " " + c.at.y + " " + c.at.z : "no revive check line for him");
  const humanWave = async (label) => {
    const r = await oracleWave(1, [human.name], label, 20000, (from) => checksSince(from).some((x) => x.name === human.name));
    const mine = checksSince(r.from).filter((x) => x.name === human.name);
    const c = mine[mine.length - 1] || null;
    verdict("  and he stays where the wave put him", !!c && c.off <= 100 && c.tier === r.want && (r.want === 0 || nearTier(1, r.want, c.at, 120)), lastDetail(c));
    return r;
  };
  if (!human) {
    verdict("the human is on a side to be killed and revived", false, "no human found in the roster");
  } else {
    console.log(stamp() + " the human is " + human.name);
    // 6. his wave puts him in the set of the point his side holds
    await giveAll(0);
    await give(3, 1);
    await humanWave("the human, killed and revived by a wave, is put in the set of the point his side holds");
    await shot("as-12-human-revived-at-point-3");

    // 7. a point taken by STANDING in it. The human and side 2's bots are dead while the points are handed over (a person standing in a
    // point that goes neutral takes it back by himself, and a bot walking in fights him: neither is the thing under test), then he is
    // revived into point 4's set, so he stands in the point; the point goes neutral under his feet and he takes it for his side.
    await rconCall("tsm_as_time 20", port, rcon);
    // The points are handed over first, so that a natural wave (every tsm_as_wave seconds) that comes while this runs finds them as the
    // check wants them; the person is killed last and the wave fired at once.
    await killSide2();
    await giveAll(0);
    await give(4, 1);
    const killedHuman = await eliminate(human.name);
    let at = logSize();
    await rconCall("amx_tsm_wave 1", port, rcon);
    for (let waited = 0; waited < 20000; waited += 500) {
      await sleep(500);
      if (waited >= 2000 && checksSince(at).some((x) => x.name === human.name)) { await sleep(500); break; }
    }
    if (!killedHuman) console.log(stamp() + " (" + wall() + ") the human was not eliminated before this wave");
    {
      const mine = checksSince(at).filter((x) => x.name === human.name);
      const c = mine[mine.length - 1] || null;
      verdict("the human is revived into point 4's set (he stands in the point)", !!c && c.tier === 4 && nearTier(1, 4, c.put, 1.5), lastDetail(c));
    }
    await rconCall("tsm_as_time 3", port, rcon);
    await give(4, 0);
    await sleep(6000);
    const listed = await rconCall("amx_tsm_as_list", port, rcon);
    console.log(stamp() + " rcon amx_tsm_as_list\n" + listed.split("\n").map((l) => "    " + l).join("\n"));
    verdict("standing in a neutral point takes it for his side (the plugin's own capture, not amx_tsm_as_give)", /point 4 \(\w\)[^\n]*held by 1\b/.test(listed), (/point 4 \(\w\)[^\n]*/.exec(listed) || ["point 4 not listed"])[0]);
    await rconCall("tsm_as_time 20", port, rcon);
    await humanWave("a point he took by standing in it opens its set: his next wave puts him there");
    await shot("as-13-human-revived-at-the-point-he-took");

    // 8. the enemy takes it: its set closes for his side, and with nothing held he goes back to his base
    await give(4, 2);
    await humanWave("once the enemy holds the point he took, the human is put at his own base or at the point his side still holds");
    await shot("as-14-human-revived-at-the-base");
  }

  // ---- rounds. By default (h9_assault_rounds 0) the first round that ends is the whole match; with 1 there are rounds as in the other modes.
  const stateOf = async () => {
    const t = await rconCall("amx_tsm_debug", port, rcon);
    const m = /state=(\d+) round=(\d+) score=(\d+)-(\d+)/.exec(t);
    return m ? { state: +m[1], round: +m[2], s1: +m[3], s2: +m[4] } : null;
  };
  const watch = async (secs, stop) => {
    const seen = [];
    for (let i = 0; i < secs; i++) {
      const s = await stateOf();
      if (s) { seen.push(s); if (stop(s, seen)) break; }
      await sleep(900);
    }
    return seen;
  };
  const brief = (seen) => seen.map((s) => s.state + "/r" + s.round).filter((v, i, a) => i === 0 || v !== a[i - 1]).join(" ");
  await giveAll(0);
  await rconCall("h9_assault_rounds 1", port, rcon);
  await sleep(2000);
  const before = await stateOf();
  console.log(stamp() + " before the round ends: " + JSON.stringify(before));
  await rconCall("amx_tsm_simwin 1", port, rcon);
  const withRounds = await watch(40, (s) => s.round >= 2 && s.state === 3);
  verdict("h9_assault_rounds 1: after a round ends round 2 goes live", withRounds.some((s) => s.round >= 2 && s.state === 3), brief(withRounds));
  await shot("as-15-round-two");
  await rconCall("h9_assault_rounds 0", port, rcon);
  await sleep(2500);
  await rconCall("amx_tsm_simwin 2", port, rcon);
  const single = await watch(40, (s, all) => s.state === 0 && all.some((x) => x.state === 5));
  verdict("h9_assault_rounds 0: the round that ends is the whole match (match end, then warmup, no round 3)",
    single.some((s) => s.state === 5 || s.state === 0) && !single.some((s) => s.round >= 3), brief(single));
  await shot("as-16-match-over");

  await ask("tsm_debug_log 0");
  await ask("tsm_logging 0");
  results.assault = { server, rcon: "set", done: true };
}
