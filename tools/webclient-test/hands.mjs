// A perf.mjs scenario: THE MATCHMODE HANDS seen from a player's screen. Joins the test server (port 27015, rcon password h9test), takes the
// side in H9_SIDE (1 the MSR, 2 the Insurgents; default 1) and the first class from the menus, starts the match and takes pictures of the
// first-person view: with h9_customhands on (that side's hands), off (the game's own), and on again. The pictures are the judge: the sleeve is
// black with a blue cuff for side 1, a green one for side 2.
//
//   H9_SIDE=2 node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login perf51n99t --phases none --script hands.mjs --name hands2
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_RCON=h9test            its rcon password
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

export default async function hands({ tab, cmd, sleep, shot, results, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const rcon = process.env.H9_RCON || "h9test";
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

  const side = process.env.H9_SIDE || "1";
  await rconCall("tsm_bots 6", port, rcon);

  // the side from the menu, then a class to get on the side
  await press(side);
  await sleep(2500);
  await press("1");
  await sleep(2500);
  const humanOnSide = async () => {
    const m = /humans_on_a_side=(\d+)/.exec(await rconCall("amx_tsm_debug", port, rcon));
    return m ? Number(m[1]) : 0;
  };
  for (let tries = 0; tries < 8 && !(await humanOnSide()); tries++) {
    console.log(stamp() + " no human on a side yet: asking for side " + side + " and the class again");
    await cmd("menuselect " + side);
    await sleep(1500);
    await press(side);
    await sleep(2500);
    await press("1");
    await sleep(2500);
  }
  await cmd("rcon_address " + server);
  await cmd("rcon_password " + rcon);
  await cmd("rcon amx_match_start");
  console.log(stamp() + " match started");
  // the freeze: TS's own equipment menu may be up (its 0 closes it), then the first class
  await sleep(1500);
  await press("0");
  await sleep(500);
  await press("1");
  await sleep(3500);
  await ask("h9_customhands");
  for (let i = 0; i < 2; i++) {
    await sleep(2500);
    await shot("hands-side" + side + "-" + i);
  }
  await rconCall("h9_customhands 0", port, rcon);
  await sleep(2500);
  await shot("hands-side" + side + "-stock");
  await rconCall("h9_customhands 1", port, rcon);
  await sleep(2500);
  await shot("hands-side" + side + "-back");
  results.hands = { server, side, done: true };
}
