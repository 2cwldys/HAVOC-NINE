// A perf.mjs scenario: the laser rifle (weapon 40) in a live round, on the siege test server (D:\temp\h9-siege-server.bat,
// rcon password in H9_RCON). Joins, takes side 1 and the Officer class (7), starts the match, and when the round is live fires
// the rifle in bursts and takes pictures: the viewmodel, the muzzle flash and light, the bolt and its trail, the glow where it
// lands, the right click zoom (a blue overlay) and the reload.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login <test-account> --phases none --script laserrifle.mjs --name laserrifle
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_RCON=<password>        its rcon password (required)
const KEY = { "1": 49, "2": 50, "3": 51, "4": 52, "5": 53, "6": 54, "7": 55 };

export default async function laserrifle({ tab, cmd, sleep, shot, results, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const rcon = process.env.H9_RCON;
  if (!rcon) throw new Error("set H9_RCON to the test server's rcon password");
  const press = async (k) => {
    const base = { windowsVirtualKeyCode: KEY[k], nativeVirtualKeyCode: KEY[k], key: k, code: "Digit" + k };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", text: k, unmodifiedText: k, ...base });
    await sleep(80);
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const log = () => tab.eval("window.h9web.log.slice(-400)");

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
    if (waited >= 6000 && quiet >= 6000) break;
  }
  await sleep(4000);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await tab.send("Input.dispatchMouseEvent", { type, x: 407, y: 532, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await sleep(80);
  }
  await sleep(2500);
  await tab.eval("document.getElementById('canvas') && document.getElementById('canvas').focus()");
  console.log(stamp() + " in the game");

  await press("1"); // side
  await sleep(2500);
  await press("7"); // the Officer
  await sleep(2500);
  await shot("lr-0-class");
  await cmd("rcon_address " + server);
  await cmd("rcon_password " + rcon);
  await cmd("rcon amx_match_start");
  console.log(stamp() + " match started");
  for (let i = 0; i < 6; i++) await sleep(2500);
  await shot("lr-1-view");

  // what the engine says about the weapon
  await cmd("rcon h9_laserrifle");
  await sleep(600);
  const lines = await log();
  results.laserrifleCvar = lines.filter((l) => /h9_laserrifle|laser/i.test(l)).slice(-6);

  // fire: a held trigger, pictures along it
  await cmd("+attack");
  for (let i = 0; i < 6; i++) {
    await sleep(140);
    await shot("lr-2-fire-" + i);
  }
  await cmd("-attack");
  await sleep(1200);
  // right click: the zoom, and the overlay
  await cmd("+attack2");
  await sleep(150);
  await cmd("-attack2");
  await sleep(1200);
  await shot("lr-3-zoom-a");
  await cmd("+attack2");
  await sleep(150);
  await cmd("-attack2");
  await sleep(1200);
  await shot("lr-3-zoom-b"); // the second level
  await cmd("+attack");
  for (let i = 0; i < 3; i++) {
    await sleep(160);
    await shot("lr-3-zoomfire-" + i);
  }
  await cmd("-attack");
  await sleep(500);
  await cmd("+attack2");
  await sleep(150);
  await cmd("-attack2");
  await sleep(1000);
  // reload
  await cmd("+reload");
  await sleep(150);
  await cmd("-reload");
  for (let i = 0; i < 6; i++) {
    await sleep(450);
    await shot("lr-4-reload-" + i);
  }
  // the gunbash (the M4A1's "stock" animation)
  await sleep(1500);
  await cmd("+attack2");
  await sleep(150);
  await cmd("-attack2");
  await shot("lr-5-end");
  const end = await log();
  results.laserrifleLog = end.filter((l) => /error|can't|cannot|missing|not found|precache|laser/i.test(l)).slice(-25);
  results.laserrifle = { server, rcon: "set", done: true };
}
