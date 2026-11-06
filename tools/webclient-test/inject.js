// Installed before the page's own scripts (Page.addScriptToEvaluateOnNewDocument).
// Records what a player would feel: frames, long tasks, synchronous file reads, the audio callback.
(() => {
  if (window.__perf) return;
  const P = (window.__perf = { frames: [], longtasks: [], sync: [], audio: [], audioInfo: null, gl: null, marks: [] });

  // the sign-in gate is the only thing stubbed: a fixed test id, no account
  const stub = { ready: async () => { window.h9webAccount = Object.freeze({ playerId: window.__testId || "0123456789abcdef0123456789abcdef", username: "perf-test" }); return true; } };
  if (!window.__realAuth) {
    Object.defineProperty(window, "h9auth", { configurable: true, get: () => stub, set: () => {} });
  }

  // window.__glcount (set before this runs): the WebGL calls, draws and uploaded bytes at each frame, from the GL entry points
  const G = (P.glc = { calls: 0, draws: 0, upBytes: 0, texBytes: 0, at: [] });
  if (window.__glcount) {
    const proto = WebGL2RenderingContext.prototype;
    const DRAW = new Set(["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]);
    for (const name of Object.getOwnPropertyNames(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      const f = desc && desc.value;
      if (typeof f !== "function" || name === "constructor") continue;
      proto[name] = function (...a) {
        G.calls++;
        if (DRAW.has(name)) G.draws++;
        else if (name === "bufferData" || name === "bufferSubData") { const d = a[1]; G.upBytes += (d && d.byteLength) || (typeof d === "number" ? d : 0); }
        else if (name === "texImage2D" || name === "texSubImage2D") { const d = a[a.length - 1]; G.texBytes += (d && d.byteLength) || 0; }
        return f.apply(this, a);
      };
    }
  }
  const tick = (t) => { P.frames.push(t); G.at.push([t, G.calls, G.draws, G.upBytes, G.texBytes]); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push([e.startTime, e.duration]); }).observe({ entryTypes: ["longtask"] });
  } catch (e) { /* no longtask support */ }

  // synchronous XHR is how a lazy game file is read
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, a) { this.__u = u; this.__sync = a === false; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (!this.__sync) return send.apply(this, arguments);
    const s = performance.now();
    try { return send.apply(this, arguments); } finally {
      let len = 0;
      try { len = (this.responseText || "").length; } catch (e) { /* binary */ }
      P.sync.push([s, performance.now() - s, String(this.__u).split("/").slice(-3).join("/"), len]);
    }
  };

  // the SDL audio callback: when it ran and how long it took
  try {
    const cps = AudioContext.prototype.createScriptProcessor;
    AudioContext.prototype.createScriptProcessor = function (size) {
      P.audioInfo = { bufferSize: size, sampleRate: this.sampleRate, baseLatency: this.baseLatency, state: this.state };
      return cps.apply(this, arguments);
    };
    const d = Object.getOwnPropertyDescriptor(ScriptProcessorNode.prototype, "onaudioprocess");
    if (d) {
      Object.defineProperty(ScriptProcessorNode.prototype, "onaudioprocess", {
        configurable: true,
        get() { return d.get.call(this); },
        set(fn) {
          if (typeof fn !== "function") return d.set.call(this, fn);
          d.set.call(this, function (e) {
            const s = performance.now();
            const r = fn.call(this, e);
            P.audio.push([s, performance.now() - s, e.playbackTime]);
            return r;
          });
        },
      });
    }
  } catch (e) { /* no script processor */ }

  const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
  const r1 = (x) => Math.round(x * 10) / 10;

  // a summary of the window [from, to] in performance.now() milliseconds
  P.summary = (from, to) => {
    const inWin = (t) => t >= from && t <= to;
    const secs = (to - from) / 1000;
    const f = P.frames.filter(inWin);
    const dt = [];
    for (let i = 1; i < f.length; i++) dt.push(f[i] - f[i - 1]);
    const sd = dt.slice().sort((a, b) => a - b);
    const lt = P.longtasks.filter((x) => inWin(x[0]));
    const sy = P.sync.filter((x) => inWin(x[0]));
    const au = P.audio.filter((x) => inWin(x[0]));
    const gaps = [];
    for (let i = 1; i < au.length; i++) gaps.push(au[i][0] - au[i - 1][0]);
    const sg = gaps.slice().sort((a, b) => a - b);
    const ad = au.map((x) => x[1]).sort((a, b) => a - b);
    const bufMs = P.audioInfo ? (P.audioInfo.bufferSize / P.audioInfo.sampleRate) * 1000 : 0;
    const g = G.at.filter((x) => inWin(x[0]));
    const gl = window.__glcount && g.length > 1 ? (() => { const a = g[0], b = g[g.length - 1], n = g.length - 1;
      return { callsPerFrame: Math.round((b[1] - a[1]) / n), drawsPerFrame: Math.round((b[2] - a[2]) / n), bufferMBPerFrame: r1((b[3] - a[3]) / n / 1048576), textureMBPerFrame: r1((b[4] - a[4]) / n / 1048576) }; })() : null;
    return {
      glPerFrame: gl,
      seconds: r1(secs),
      frames: f.length, fps: r1(f.length / secs),
      frameMs: { p50: r1(pct(sd, 0.5)), p95: r1(pct(sd, 0.95)), p99: r1(pct(sd, 0.99)), max: r1(sd[sd.length - 1] || 0) },
      framesOver: { "33ms": dt.filter((x) => x > 33.4).length, "50ms": dt.filter((x) => x > 50).length, "100ms": dt.filter((x) => x > 100).length, "250ms": dt.filter((x) => x > 250).length },
      longTasks: { count: lt.length, totalMs: Math.round(lt.reduce((s, x) => s + x[1], 0)), maxMs: Math.round(Math.max(0, ...lt.map((x) => x[1]))) },
      syncReads: { count: sy.length, totalMs: Math.round(sy.reduce((s, x) => s + x[1], 0)), maxMs: Math.round(Math.max(0, ...sy.map((x) => x[1]))),
        slowest: sy.slice().sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => Math.round(x[1]) + " ms " + x[2] + " (" + x[3] + " chars)") },
      audio: { info: P.audioInfo, bufferMs: r1(bufMs), callbacks: au.length, perSecond: r1(au.length / secs),
        gapMs: { p50: r1(pct(sg, 0.5)), p95: r1(pct(sg, 0.95)), max: r1(sg[sg.length - 1] || 0) },
        gapsOver2Buffers: bufMs ? gaps.filter((x) => x > bufMs * 2).length : null,
        callbackMs: { p50: r1(pct(ad, 0.5)), p95: r1(pct(ad, 0.95)), max: r1(ad[ad.length - 1] || 0) } },
    };
  };

  // which GPU the page really draws on
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    const e = gl && gl.getExtension("WEBGL_debug_renderer_info");
    P.gl = gl ? { renderer: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: e ? gl.getParameter(e.UNMASKED_VENDOR_WEBGL) : "" } : null;
    const lose = gl && gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
  } catch (e) { /* none */ }
})();
