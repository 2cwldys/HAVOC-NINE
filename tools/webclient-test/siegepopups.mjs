// A perf.mjs scenario: the siege's popups on the screen of an H9 game (ts_matchmode's tsm.alarm, tsm.plant.warn, tsm.fuse, tsm.live).
// Joins the siege test server (D:\temp\h9-siege-server.bat: h9_siege_lift, rcon password in H9_RCON), takes a side and a class from the
// menus, starts the match, then forces the siege's events with the plugin's own debug commands (rcon) and takes a picture after each:
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login <test-account> --phases none --script siegepopups.mjs --name siege
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_RCON=<password>        its rcon password (required)
const KEY = { "1": 49, "2": 50, "3": 51, "4": 52, "5": 53 };

export default async function siegepopups({ tab, cmd, sleep, shot, results, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const rcon = process.env.H9_RCON;
  if (!rcon) throw new Error("set H9_RCON to the test server's rcon password");
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

  // a side and a class from the menus (number keys), then the match
  await press("1");
  await sleep(2500);
  await shot("siege-1-side");
  await press("1");
  await sleep(2500);
  await shot("siege-2-class");
  await cmd("rcon_address " + server);
  await cmd("rcon_password " + rcon);
  await cmd("rcon amx_match_start");
  console.log(stamp() + " match started");
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    await shot("siege-3-start-" + i);
  }

  // the siege's events, forced by the plugin's own debug commands
  await cmd("rcon amx_tsm_siege_alarm");
  console.log(stamp() + " alarm forced");
  await sleep(1200);
  await shot("siege-4-alarm-a"); // popped, under the round timer
  await sleep(7000);
  await shot("siege-4-alarm-b"); // faded away (5 s and a fade)
  await sleep(15000);
  await shot("siege-4-alarm-c"); // popped again (tsm_alarm_every 20)
  await cmd("rcon amx_tsm_siege_plant 1");
  console.log(stamp() + " satchel planted on 1");
  await sleep(800);
  await shot("siege-5-fuse-a");
  await sleep(2400);
  await shot("siege-6-fuse-b");
  await sleep(3500);
  await shot("siege-7-after");
  results.siege = { server, rcon: "set", done: true };
}
