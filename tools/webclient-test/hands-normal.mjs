// A perf.mjs scenario: THE CUSTOM HANDS IN NORMAL TS seen from a player's screen. Joins a test server on a stock TS map (port 27015, rcon password h9test: D:	emp\h9-stockmap-server.bat), where the
// match mode is off, and takes pictures of the first-person view with h9_customhands on (the default hands: a black sleeve with no stripe), off
// (the game's own) and on again.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login perf51n99t --phases none --script hands-normal.mjs --name handsn
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

export default async function handsNormal({ tab, cmd, sleep, shot, results, stamp }) {
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

  // TS's own equipment menu may be up (its 0 closes it)
  await sleep(4000);
  await shot("normal-0");
  await press("0");
  await sleep(2500);
  await shot("normal-1");
  await ask("h9_customhands");
  await rconCall("h9_customhands 0", port, rcon);
  await sleep(2500);
  await shot("normal-stock");
  await rconCall("h9_customhands 1", port, rcon);
  await sleep(2500);
  await shot("normal-back");
  results.handsNormal = { server, done: true };
}
