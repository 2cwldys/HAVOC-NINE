// A perf.mjs scenario: CAPTURE THE FLAG (ts_ctf) seen from a player's screen and checked against the server's own account. Joins the flag test
// server (D:\temp\h9-ctf-server.bat: h9_ctf_drainage, port 27015, rcon password h9test, tsm_bots 6), takes a side and a class from the menus,
// starts the match, and then walks the flag through its life with the mode's test commands: taken (the carrier in his side's colour), the
// carrier at his own pad with his own flag away (no capture) and then home (a capture), dropped, flown home, dropped by a death, captured by
// each side, and the third capture ending the match. Pictures at each step; the verdicts print PASS or FAIL.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --signup --phases none --script ctf.mjs --name ctf
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_RCON=h9test            its rcon password
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

export default async function ctf({ tab, cmd, sleep, shot, results, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const rcon = process.env.H9_RCON || "h9test";
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

  const human = (await (async () => {
    const t = await ask("amx_tsm_debug");
    return [...t.matchAll(/\[TSM\]\s{3}(\S.*?)\s+raw#=\d+ raw='[^']*' -> resolved=(\d)/g)].map((m) => ({ name: m[1].trim(), side: +m[2] }));
  })()).find((p) => !/^(Enforcer|Insurgent) \d+$/.test(p.name) && p.side === 1);
  console.log(stamp() + " the human is " + (human ? human.name : "not found"));
  const verdict = (name, ok, detail) => { console.log(stamp() + (ok ? " PASS " : " FAIL ") + name + (detail ? " -- " + detail : "")); results.checks = results.checks || []; results.checks.push({ name, ok }); };
  const cf = (c) => rconCall(c, port, rcon);
  // a command that needs a player in play (a person killed a moment ago is back with his side's next wave): asked again until the server says
  // it was done
  const till = async (command, done, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      const out = await cf(command);
      if (done.test(out)) return out;
      await sleep(1500);
    }
    console.log(stamp() + " gave up on: " + command);
    return "";
  };
  const give = (flag, who) => till("amx_tsm_cf_give " + flag + " " + who, /is on a player of side/);
  const tp = (who, pad) => till("amx_tsm_cf_tp " + who + " " + pad, /is on pad/);
  // the server's own account: each side's flag, and the captures
  const flags = async () => {
    const t = await cf("amx_tsm_cf_list");
    const out = {};
    for (const m of t.matchAll(/side (\d): pad at[^;\n]*; its flag is (at its pad|carried|dropped)/g)) out[+m[1]] = m[2];
    return out;
  };
  const caps = async () => {
    const m = /"tsm_pres_prog" is "(\d+)\/(\d+)\/(\d+)"/.exec(await cf("tsm_pres_prog"));
    return m ? { 1: +m[1], 2: +m[2], to: +m[3] } : null;
  };
  const stateOf = async () => {
    const m = /state=(\d+) round=(\d+) score=(\d+)-(\d+)/.exec(await cf("amx_tsm_debug"));
    return m ? { state: +m[1], round: +m[2] } : null;
  };

  // ---- the mode took the map, and both flags stand at their pads
  const mode = await cf("tsm_pres_mode");
  verdict("the map is a Capture the Flag map (tsm_pres_mode)", /"tsm_pres_mode" is "ctf"/.test(mode), mode.trim());
  await ask("amx_tsm_ctf");
  let f = await flags();
  verdict("both flags stand at their pads when the round goes live", f[1] === "at its pad" && f[2] === "at its pad", JSON.stringify(f));
  let c = await caps();
  verdict("no captures yet, first to 3", !!c && c[1] === 0 && c[2] === 0 && c.to === 3, JSON.stringify(c));
  await sleep(2500);
  await shot("ctf-1-base");

  // ---- a flag taken: the carrier has it on his back, in his side's colour
  await cf("tsm_cf_return 6");
  await give(2, 1);
  await sleep(1200);
  f = await flags();
  verdict("side 1 takes side 2's flag: it is carried", f[2] === "carried" && f[1] === "at its pad", JSON.stringify(f));
  await shot("ctf-2-side-1-has-the-flag");

  // ---- the carrier at his own pad with his own flag away: no capture; the flag home: a capture
  await give(1, 2);   // side 2 takes side 1's flag
  await sleep(600);
  await tp(1, 1);     // the carrier walks onto his own pad
  await sleep(1500);
  c = await caps();
  verdict("the carrier on his own pad with his own flag away does not capture", !!c && c[1] === 0 && c[2] === 0, JSON.stringify(c));
  await shot("ctf-3-own-flag-away");
  await cf("amx_tsm_cf_give 1 0");   // side 1's flag is back at its pad
  await sleep(1500);
  c = await caps();
  f = await flags();
  verdict("with his own flag home the carrier on his pad captures", !!c && c[1] === 1 && c[2] === 0, JSON.stringify(c));
  verdict("a captured flag is back at its pad", f[2] === "at its pad", JSON.stringify(f));
  await shot("ctf-4-first-capture");

  // ---- dropped by the carrier's own hand (the console command), grey, and flown home on its own. The carrier is put on the ENEMY's pad, where
  // he takes the flag by touch and cannot score it: handed to him on his own pad it would be a capture at once.
  await tp(1, 2);
  await sleep(800);
  await cmd("dropflag");
  await sleep(1200);
  f = await flags();
  verdict("dropflag lets the flag go where the carrier stands", f[2] === "dropped", JSON.stringify(f));
  await shot("ctf-5-dropped");
  await tp(1, 1);   // he walks away from it, to his own pad, carrying nothing, so nobody touches the flag that lies there
  await sleep(7500);
  f = await flags();
  verdict("a dropped flag nobody touches flies home after tsm_cf_return seconds", f[2] === "at its pad", JSON.stringify(f));

  // ---- the carrier killed: the flag falls where he was
  await tp(1, 2);
  await sleep(800);
  f = await flags();
  const carried = f[2] === "carried";
  if (human) await cf('amx_tsm_simelim "' + human.name + '"');
  await sleep(1500);
  f = await flags();
  verdict("a carrier who is killed drops the flag", carried && f[2] === "dropped", JSON.stringify(f));
  await cf("amx_tsm_cf_give 2 0");   // home again for the rest
  await sleep(600);

  // ---- side 2 captures as well; then side 1 twice more: the third capture wins the match
  await cf("tsm_cf_return 20");
  await cf("amx_tsm_wave 1");
  await sleep(14000);                 // the human is back in play
  await give(1, 2);
  await sleep(600);
  await tp(2, 2);
  await sleep(1500);
  c = await caps();
  verdict("side 2 captures side 1's flag at its own pad", !!c && c[1] === 1 && c[2] === 1, JSON.stringify(c));
  await shot("ctf-6-side-2-captured");
  for (let n = 2; n <= 3; n++) {
    await give(2, 1);
    await sleep(600);
    await tp(1, 1);
    await sleep(1500);
    c = await caps();
    verdict("side 1 captures again (" + n + ")", !!c && c[1] === n, JSON.stringify(c));
  }
  await shot("ctf-7-third-capture");
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const s = await stateOf();
    if (s) { seen.push(s.state + "/r" + s.round); if (s.state === 0 && seen.some((x) => x.startsWith("5/"))) break; }
    await sleep(900);
  }
  const trail = seen.filter((v, i, a) => i === 0 || v !== a[i - 1]).join(" ");
  verdict("the third capture ends the match (round end, match end, warmup; no second round)", /4\/r1/.test(trail) && /5\/r1/.test(trail) && !/r2/.test(trail), trail);
  await shot("ctf-8-match-over");
  results.ctf = { server, rcon: "set", done: true };
}
