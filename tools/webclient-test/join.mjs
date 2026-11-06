// A perf.mjs scenario: the real flow, through the site's relay. Opens the server browser (its chain), joins a server, opens the
// scoreboard (its pictures) and measures the game for a while.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --signup --phases none --script join.mjs --name join1
//
// The server is H9_JOIN (default 127.0.0.1:27015, the local test server: D:\temp\h9-local-server.bat). The site's list must name it.
export default async function join({ tab, cmd, sleep, window_, shot, results, nowMs, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const logLen = () => tab.eval("window.h9web.log.length");
  const logTail = (n) => tab.eval(`window.h9web.log.slice(-${n}).join("\\n")`);

  // console commands to run first, from H9_PRE (separated by ;): a setting to try before joining
  for (const c of (process.env.H9_PRE || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    await cmd(c);
    console.log(stamp() + " " + c);
  }

  // the browser: the relay answers the master query, the page's chain feed has the list by now
  await cmd("menu_internetgames");
  await sleep(8000);
  await shot("browser");
  results.chain = await tab.eval(`(() => { try { const m = window.h9web.module(); return "page feed ready: " + (typeof m.avatar); } catch (e) { return String(e); } })()`);

  // join, and wait until the engine stops talking
  const began = await nowMs();
  let last = await logLen(), quiet = 0, waited = 0;
  await cmd("connect " + server);
  console.log(stamp() + " connect " + server);
  await sleep(2500);
  await shot("downloading");
  // the join is over when the engine has been quiet for 6 s and the page is not still fetching the files it asked for
  const fetching = () => tab.eval(`(() => { const l = window.h9web.log; let s = -1, d = -1; for (let i = 0; i < l.length; i++) { if (l[i].includes("H9 WARM: the page fetches")) s = i; else if (l[i].includes("H9 WARM:") && (l[i].includes("here after") || l[i].includes("did not finish"))) d = i; } return s > d; })()`);
  while (waited < 300000) {
    await sleep(500);
    waited += 500;
    const n = await logLen();
    if (n !== last) { last = n; quiet = 0; } else quiet += 500;
    if (waited >= 6000 && quiet >= 6000 && !(await fetching())) break;
  }
  const joined = await nowMs();
  results.joinSeconds = Math.round((joined - began) / 100) / 10;
  results.phases.join = await tab.eval(`window.__perf.summary(${began}, ${joined})`);
  console.log("\n== join (" + results.joinSeconds + " s) ==\n" + JSON.stringify(results.phases.join, null, 1));
  console.log("last engine lines:\n" + (await logTail(12)));
  // every synchronous file read of the join, in the order the engine made them: [ms from the start, ms it took, file, characters]
  const reads = await tab.eval(`window.__perf.sync.map((x) => [Math.round(x[0] - ${began}), Math.round(x[1]), x[2].replace(/\\?v=[0-9a-f]+$/, ""), x[3]])`);
  results.joinReads = reads;
  const bytes = reads.reduce((s, r) => s + r[3], 0);
  console.log(`join read ${reads.length} files, ${(bytes / 1048576).toFixed(0)} MB, waiting ${reads.reduce((s, r) => s + r[1], 0)} ms in all`);
  const big = reads.slice().sort((a, b) => b[3] - a[3]).slice(0, 14).map((r) => `${(r[3] / 1048576).toFixed(1)} MB ${r[2]}`);
  console.log("biggest:\n  " + big.join("\n  "));
  const byKind = {};
  for (const r of reads) { const k = r[2].split("/").slice(0, 2).join("/").replace(/\.[a-z0-9]+$/i, ""); byKind[k] = (byKind[k] || 0) + r[3]; }
  console.log("by folder (MB): " + Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + " " + (v / 1048576).toFixed(1)).join(", "));
  await shot("joined");

  // the server's MOTD covers the scoreboard until its OK is pressed
  await sleep(4000);
  const click = async (x, y) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await tab.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
      await sleep(80);
    }
  };
  await click(407, 532);
  await sleep(1500);

  // H9_DIAG=1: what this client sends the server as userinfo (key names and sizes: never a value), against the limit
  if (process.env.H9_DIAG) {
    await cmd("userinfo");
    await sleep(1200);
    const text = await tab.eval("window.h9web.log.slice(-60).join(String.fromCharCode(10))");
    const rows = [];
    for (const line of text.split("\n")) {
      const m = /^\[[0-9:]+\]\s+(\S+)\s+(.*)$/.exec(line) || /^(\S+)\s{2,}(.*)$/.exec(line);
      if (m && !/^(Warning|Error|execing)/.test(m[1])) rows.push([m[1], m[2].length]);
    }
    console.log("userinfo keys (name: value length): " + rows.map(([k, n]) => k + ": " + n).join(", "));
    results.userinfoKeys = rows;
    const state = await tab.eval("(() => { const m = window.h9web.module(); return { account: !!window.h9webAccount, playerIdShape: /^[0-9a-f]{32}$/.test((window.h9webAccount || {}).playerId || '') }; })()");
    console.log("page account: " + JSON.stringify(state));
  }

  // the scoreboard, with its pictures
  await cmd("+showscores");
  await sleep(2500);
  await shot("scoreboard");
  // what the scoreboard's fonts were made at, and the canvas's drawing buffer against its size on screen (perf.mjs --inject fontlog.js)
  results.fonts = await tab.eval("window.__fonts ? window.__fonts.calls : null");
  results.canvas = await tab.eval("window.__canvasInfo ? window.__canvasInfo() : null");
  await cmd("-showscores");

  // H9_AB=1: the same view drawn without and with the batched world drawing (gl_vbo), for a picture-to-picture comparison; the
  // spectator camera does not move on its own, so the two pictures differ only where the renderer does
  if (process.env.H9_AB) {
    await sleep(1500);
    for (const v of [0, 1, 0, 1]) {
      await cmd("gl_vbo " + v);
      await sleep(2500);
      await shot("vbo" + v + "-" + (v ? "b" : "a") + String(results.abShots = (results.abShots || 0) + 1));
    }
  }

  await window_("ingame", 30);
}
