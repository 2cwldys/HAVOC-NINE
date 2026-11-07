// A perf.mjs scenario: the OFFICER'S WAITING LIST seen from his screen. Joins the assault test server (D:\temp\h9-assault-server.bat:
// h9_as_lift, port 27015, rcon password in H9_RCON, tsm_bots 6), takes side 1 and the Officer class (the seventh) from the menus, starts the
// match, has three of his side's bots eliminated and takes a picture: the panel on the right (ts_matchmode's wait_panel) naming the
// teammates who wait for a wave. Then a wave brings them back and a second picture shows the panel gone.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --signup --phases none --script waitlist.mjs --name waitlist
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_RCON=<password>        its rcon password (required)
import dgram from "node:dgram";

function rconCall(command, port, password) {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const out = [];
    s.on("message", (m) => out.push(m.toString("latin1").replace(/[^\x20-\x7e\n]/g, "?").replace(/^\?\?\?\?/, "").trim()));
    s.send(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from(`rcon ${password} ${command}\n`, "latin1")]), port, "127.0.0.1");
    setTimeout(() => { s.close(); resolve(out.join("\n").split("\n").filter((l) => l !== "print").join("\n")); }, 1500);
  });
}

const KEY = { "0": 48, "1": 49, "2": 50, "3": 51, "4": 52, "5": 53, "6": 54, "7": 55 };

export default async function waitlist({ tab, cmd, sleep, shot, results, stamp }) {
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
  const ask = async (c) => {
    const text = await rconCall(c, port, rcon);
    console.log(stamp() + " rcon " + c + "\n" + text.split("\n").map((l) => "    " + l).join("\n"));
    return text;
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

  await rconCall("tsm_bots 6", port, rcon);

  // side 1 from the menu, then a class to get on the side (a class picked before the freeze is cleared when the match begins); the Officer
  // can only be picked in the freeze, so that comes after the match starts
  await press("1");
  await sleep(2500);
  await press("1");
  await sleep(2500);
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
    await press("1");
    await sleep(2500);
  }
  await cmd("rcon_address " + server);
  await cmd("rcon_password " + rcon);
  await cmd("rcon amx_match_start");
  console.log(stamp() + " match started");
  // the freeze: TS's own equipment menu may be up (its 0 closes it), then the seventh class, the Officer
  await sleep(1500);
  await press("0");
  await sleep(500);
  await press("7");
  await sleep(2000);
  await shot("wl-1-class");
  for (let i = 0; i < 3; i++) {
    await sleep(3000);
    await shot("wl-2-start-" + i);
  }

  // who is who, from the server's own player list
  const text = await ask("amx_tsm_debug");
  const mates = [...text.matchAll(/\[TSM\]\s{3}(\S.*?)\s+raw#=\d+ raw='[^']*' -> resolved=(\d)/g)]
    .map((m) => ({ name: m[1].trim(), side: +m[2] })).filter((p) => /^(Enforcer|Insurgent) \d+$/.test(p.name) && p.side === 1);
  console.log(stamp() + " his side's bots: " + mates.map((m) => m.name).join(", "));

  // three of them fall: the wave clock puts the list on the Officer's screen within a second
  for (const m of mates.slice(0, 3)) await rconCall('amx_tsm_simelim "' + m.name + '"', port, rcon);
  await sleep(2200);
  await shot("wl-3-list-up");
  await sleep(2000);
  await shot("wl-4-list-still-up");

  // a wave brings them back: the panel goes
  await rconCall("amx_tsm_wave 1", port, rcon);
  await sleep(6000);
  await shot("wl-5-after-the-wave");
  results.waitlist = { server, bots: mates.map((m) => m.name), done: true };
}
