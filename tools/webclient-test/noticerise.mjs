// A perf.mjs scenario: a notice comes up. Joins the siege test server (D:\temp\h9-siege-server.bat), takes a side and a class, starts the
// match, forces the siege alarm (the plugin's own debug command, over rcon) and takes pictures of where its banner shows, one after
// another, while it comes up. The mean brightness of that part of each picture is what is printed: it rises over about 0.35 s
// (reTS cl_dll h9_vgui.cpp NoticeDrawAlpha), then holds.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login <account> --phases none --script noticerise.mjs --name rise
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_RCON=h9test            its rcon password
const KEY = { "1": 49 };

export default async function noticerise({ tab, cmd, sleep, shot, results, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const rcon = process.env.H9_RCON || "h9test";
  const press = async (k) => {
    const base = { windowsVirtualKeyCode: KEY[k], nativeVirtualKeyCode: KEY[k], key: k, code: "Digit" + k };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", text: k, unmodifiedText: k, ...base });
    await sleep(80);
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

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
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await tab.send("Input.dispatchMouseEvent", { type, x: 407, y: 532, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await sleep(80);
  }
  await sleep(2500);
  await tab.eval("document.getElementById('canvas') && document.getElementById('canvas').focus()");
  console.log(stamp() + " in the game");

  await press("1");
  await sleep(2500);
  await press("1");
  await sleep(2500);
  await cmd("rcon_address " + server);
  await cmd("rcon_password " + rcon);
  await cmd("rcon amx_match_start");
  console.log(stamp() + " match started");
  await sleep(16000); // the freeze, and the round live

  // where the banner shows: under the round timer, centred (the picture is the page's viewport)
  const box = await tab.eval(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const clip = { x: box.x + box.w * 0.40, y: box.y + box.h * 0.135, width: box.w * 0.20, height: box.h * 0.12, scale: 1 };
  const bright = async () => {
    const t = await tab.eval("performance.now()");
    const { data } = await tab.send("Page.captureScreenshot", { format: "jpeg", quality: 70, clip });
    const mean = await tab.eval(`(async () => {
      const img = new Image();
      img.src = "data:image/jpeg;base64,${data}";
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let s = 0, hot = 0;
      for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; s += l; if (d[i + 2] > 140 && d[i] < 90) hot++; }
      return { mean: s / (d.length / 4), blueText: hot };
    })()`);
    return { t, ...mean };
  };

  const before = await bright();
  await cmd("rcon amx_tsm_siege_alarm");
  const t0 = await tab.eval("performance.now()");
  const rows = [];
  for (let i = 0; i < 16; i++) rows.push(await bright());
  await sleep(1500);
  const after = await bright();
  console.log(stamp() + " the banner's region before the alarm: mean " + before.mean.toFixed(1) + ", blue text pixels " + before.blueText);
  for (const r of rows) console.log("  +" + String(Math.round(r.t - t0)).padStart(5) + " ms   mean " + r.mean.toFixed(1).padStart(6) + "   blue text pixels " + r.blueText);
  console.log("  held (+1.5 s)  mean " + after.mean.toFixed(1) + "   blue text pixels " + after.blueText);
  results.rise = { before, rows, after };
}
