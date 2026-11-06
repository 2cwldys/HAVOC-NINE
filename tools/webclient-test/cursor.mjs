// A perf.mjs scenario: the scoreboard's cursor. Joins the test server, then measures, window by window, the audio and the frames while
//   idle -> TAB held (the scoreboard) -> a click on the board (mute mode: the cursor appears, the mouse lock is let go) -> the mouse moved
//   over the rows -> a double-click on a picture -> TAB let go (mute mode ends, the mouse is grabbed again) -> idle.
// Each window prints its audio underruns (a buffer that plays later than the one before it ended), its frame times and its long tasks,
// and writes a CPU profile (cursor-<window>.cpuprofile, perf.mjs --top <file>).
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --signup --phases none --script cursor.mjs --name cursor
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_CPU=3                  slow the page's CPU that many times once in the game
export default async function cursor({ tab, cmd, sleep, out, shot, results, nowMs, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
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
  const mouse = async (type, x, y, extra = {}) => {
    await tab.send("Input.dispatchMouseEvent", { type, x, y, button: extra.button || "none", buttons: extra.buttons || 0, clickCount: extra.clickCount || 0 });
  };
  const click = async (x, y, count = 1) => {
    for (let i = 1; i <= count; i++) {
      await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: i });
      await sleep(40);
      await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: i });
      await sleep(60);
    }
  };
  await click(407, 532); // the server's MOTD: OK
  await sleep(2500);
  await tab.eval("document.getElementById('canvas') && document.getElementById('canvas').focus()");
  if (process.env.H9_CPU) {
    await tab.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.H9_CPU) });
    console.log(stamp() + " CPU slowed " + process.env.H9_CPU + " times");
  }
  console.log(stamp() + " in the game");

  const tabKey = { windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: "Tab", code: "Tab" };
  let holding = false, repeater = null;
  const holdTab = async () => {
    holding = true;
    await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...tabKey });
    repeater = (async () => {
      await sleep(500);
      while (holding) {
        await tab.send("Input.dispatchKeyEvent", { type: "rawKeyDown", autoRepeat: true, ...tabKey });
        await sleep(33);
      }
    })();
  };
  const releaseTab = async () => {
    holding = false;
    await repeater;
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...tabKey });
  };

  results.cursor = {};
  const fs = await import("node:fs");
  const path = await import("node:path");
  const window_ = async (name, action) => {
    await sleep(1200);
    const began = await nowMs();
    await tab.send("Profiler.start");
    await action();
    const ended = await nowMs();
    const { profile } = await tab.send("Profiler.stop");
    fs.writeFileSync(path.join(out, "cursor-" + name + ".cpuprofile"), JSON.stringify(profile));
    const s = await tab.eval(`window.__perf.summary(${began}, ${ended})`);
    const d = await tab.eval(`(() => { const a = window.__perf.audio.filter((x) => x[0] >= ${began} && x[0] <= ${ended}); const i0 = window.__perf.audioInfo; const buf = i0 ? i0.bufferSize / i0.sampleRate : 0; let n = 0, silent = 0, worst = 0; for (let i = 1; i < a.length; i++) { const g = a[i][2] - a[i - 1][2]; if (g > buf * 1.5) { n++; silent += g - buf; worst = Math.max(worst, g - buf); } } return { n, silent: Math.round(silent * 1000), worst: Math.round(worst * 1000) }; })()`);
    const info = await tab.eval(`(() => ({ lock: !!document.pointerLockElement, focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none", cursor: getComputedStyle(document.getElementById('canvas')).cursor }))()`);
    results.cursor[name] = { ...s, underruns: d, info };
    console.log(`${name.padEnd(14)} ${String(s.seconds).padStart(4)} s  frames ${String(s.fps).padStart(5)}/s  p95 ${String(s.frameMs && s.frameMs.p95).padStart(5)} ms  max ${String(s.frameMs && s.frameMs.max).padStart(6)} ms  long tasks ${s.longTasks && s.longTasks.count} (${s.longTasks && s.longTasks.totalMs} ms)  UNDERRUNS ${d.n} (${d.silent} ms of silence, worst ${d.worst} ms)  pointer lock ${info.lock}  cursor ${info.cursor}  focus ${info.focus}`);
    await shot("cursor-" + name);
  };

  await window_("idle", () => sleep(4000));
  await window_("tab held", async () => { await holdTab(); await sleep(3000); });
  await window_("click (mute)", async () => { await click(300, 130); await sleep(2500); });
  await window_("mouse moved", async () => {
    for (let i = 0; i < 90; i++) {
      await mouse("mouseMoved", 120 + (i * 6) % 500, 90 + (i * 7) % 220, { buttons: 0 });
      await sleep(33);
    }
  });
  await window_("double-click", async () => { await click(48, 105, 2); await sleep(1500); });
  await window_("tab let go", async () => { await releaseTab(); await sleep(3000); });
  await window_("idle again", () => sleep(4000));
}
