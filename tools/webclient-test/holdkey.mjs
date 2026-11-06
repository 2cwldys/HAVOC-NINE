// A perf.mjs scenario: what a held key does to the audio. Joins the test server, then measures the same seconds idle, with TAB held
// (the scoreboard) and with W held (walking), each with the browser's key auto-repeat (a keydown every 33 ms after 500 ms, as Windows
// repeats), and prints the audio callback's gaps (a gap over two buffers is a click or a stutter you hear), the frame times and the
// long tasks of each.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --signup --phases none --script holdkey.mjs --name holdkey
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_SECS=6                 seconds each key is held
//   H9_KEYS=idle,Tab,w        what to hold, in order: idle, or a key name (Tab, w, a, Shift, Space)
//   H9_CPU=3                  slow the page's CPU that many times once in the game (a PC slower than this one)
//   H9_PROFILE=1              a CPU profile of each window, hold-<key>.cpuprofile in the run's folder (perf.mjs --top file)
//   H9_SOUND=alexandria/thedig.wav   the sound played from the console so there is something to hear (none: leave the game as it is)
const KEYS = {
  Tab: { key: "Tab", code: "Tab", vk: 9, text: "" },
  w: { key: "w", code: "KeyW", vk: 87, text: "w" },
  a: { key: "a", code: "KeyA", vk: 65, text: "a" },
  s: { key: "s", code: "KeyS", vk: 83, text: "s" },
  d: { key: "d", code: "KeyD", vk: 68, text: "d" },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16, text: "" },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
};

export default async function holdkey({ tab, cmd, sleep, out, window_, shot, results, nowMs, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const secs = Number(process.env.H9_SECS || 6);
  const plan = (process.env.H9_KEYS || "idle,Tab,w").split(",").map((s) => s.trim()).filter(Boolean);

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
  // the server's MOTD covers the game until its OK is pressed
  await sleep(4000);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await tab.send("Input.dispatchMouseEvent", { type, x: 407, y: 532, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await sleep(80);
  }
  await sleep(2500);
  await tab.eval("document.getElementById('canvas') && document.getElementById('canvas').focus()");
  // H9_CPU=3: the page's CPU slowed that many times (CDP), a PC slower than this one
  if (process.env.H9_CPU) {
    await tab.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.H9_CPU) });
    console.log(stamp() + " CPU slowed " + process.env.H9_CPU + " times");
  }
  console.log(stamp() + " in the game; measuring " + plan.join(", ") + " for " + secs + " s each");

  const hold = async (spec, ms) => {
    const t0 = Date.now();
    const base = { windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, key: spec.key, code: spec.code };
    await tab.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", text: spec.text || undefined, unmodifiedText: spec.text || undefined, ...base });
    await sleep(500); // Windows waits before it repeats
    while (Date.now() - t0 < ms) {
      await tab.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", text: spec.text || undefined, unmodifiedText: spec.text || undefined, autoRepeat: true, ...base });
      await sleep(33);
    }
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  // The game's sound on the audio thread (Module.audio, client.js audioFeed): frames played and frames played as silence because the
  // page had not sent them (starved), counted by the worklet itself; they replace the ScriptProcessor figures below when it is in use.
  const audioStats = () => tab.eval("(() => { const m = window.h9web && window.h9web.module && window.h9web.module(); return m && m.audio && m.audio.stats ? m.audio.stats() : null; })()");

  // Something to hear: a long music track played from the console, again once it has run out. The mixer sends silence when nothing plays, so
  // a silent game proves little about a dropout. H9_SOUND=none leaves the game as it is.
  const SOUND = process.env.H9_SOUND || "alexandria/thedig.wav";
  let soundAt = 0;
  const sound = async () => {
    if (SOUND === "none" || Date.now() - soundAt < 40000) return;
    soundAt = Date.now();
    await cmd("play " + SOUND);
  };

  results.hold = {};
  for (const what of plan) {
    await sleep(1500);
    await sound();
    await sleep(500);
    const a0 = await audioStats();
    const began = await nowMs();
    if (process.env.H9_PROFILE) await tab.send("Profiler.start");
    if (what === "idle") await sleep(secs * 1000);
    else if (KEYS[what]) await hold(KEYS[what], secs * 1000);
    else { console.log("unknown key " + what); continue; }
    const ended = await nowMs();
    const a1 = await audioStats();
    if (process.env.H9_PROFILE) {
      const { profile } = await tab.send("Profiler.stop");
      (await import("node:fs")).writeFileSync((await import("node:path")).join(out, "hold-" + what + ".cpuprofile"), JSON.stringify(profile));
    }
    const s = await tab.eval(`window.__perf.summary(${began}, ${ended})`);
    results.hold[what] = s;
    // an underrun is a callback whose buffer plays later than the one before it ended: the audio thread had nothing to play in between
    const drop = await tab.eval(`(() => { const a = window.__perf.audio.filter((x) => x[0] >= ${began} && x[0] <= ${ended}); const i0 = window.__perf.audioInfo; const buf = i0 ? i0.bufferSize / i0.sampleRate : 0; let n = 0, silent = 0, worst = 0; for (let i = 1; i < a.length; i++) { const d = a[i][2] - a[i - 1][2]; if (d > buf * 1.5) { n++; silent += d - buf; worst = Math.max(worst, d - buf); } } return { buf: Math.round(buf * 1000), n, silent: Math.round(silent * 1000), worst: Math.round(worst * 1000) }; })()`);
    results.hold[what].dropouts = drop;
    const a = s.audio || {};
    console.log(`${what.padEnd(6)} frames ${String(s.fps).padStart(5)}/s  p50 ${String(s.frameMs && s.frameMs.p50).padStart(5)} ms  p95 ${String(s.frameMs && s.frameMs.p95).padStart(6)} ms  max ${String(s.frameMs && s.frameMs.max).padStart(7)} ms  long tasks ${s.longTasks && s.longTasks.count} (${s.longTasks && s.longTasks.totalMs} ms)  audio: ${a.callbacks} callbacks, gaps p95 ${a.gapMs && a.gapMs.p95} ms max ${a.gapMs && a.gapMs.max} ms, over 2 buffers ${a.gapsOver2Buffers}, callback p95 ${a.callbackMs && a.callbackMs.p95} ms | UNDERRUNS ${drop.n} (${drop.silent} ms of silence, worst ${drop.worst} ms; buffer ${drop.buf} ms)`);
    if (a0 && a1) {
      const d = (k) => (a1[k] || 0) - (a0[k] || 0);
      const w = { mode: a1.mode, state: a1.state, rate: a1.rate, queued: a1.queued, peak: a1.peak, playedFrames: d("played"), starvedFrames: d("starved"), pushedFrames: d("pushed"), wallMs: Math.round(ended - began) };
      results.hold[what].worklet = w;
      console.log(`       worklet ${w.mode}/${w.state} @ ${w.rate} Hz: played ${(w.playedFrames / w.rate).toFixed(2)} s of ${(w.wallMs / 1000).toFixed(2)} s, STARVED ${w.starvedFrames} frames (${Math.round((w.starvedFrames / w.rate) * 1000)} ms), pushed ${(w.pushedFrames / w.rate).toFixed(2)} s, loudest sample ${w.peak === undefined ? "?" : Number(w.peak).toFixed(3)}`);
    } else console.log("       worklet: no Module.audio (SDL's device is in use)");
    await shot("hold-" + what);
  }
}
