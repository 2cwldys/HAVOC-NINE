// A perf.mjs scenario: the pre-fetch of a join (warmFeed in client.js, cl_h9warm.c in the engine), watched while it runs.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login <name> --phases none --fresh --script prefetch.mjs --name prefetch
//
// Every 5 seconds from the connect it prints the page's counters (state 0 fetching, 1 done; files done and total; KB), the bytes
// that came, whether the page's main thread answered, the requests still in flight (how old, which files) and the engine's last
// lines. At the first poll it takes a screenshot of the download box and prints how the box is styled; it ends when every file is
// here (or after H9_SECS) and prints the engine's log from the pre-fetch on.
//
//   H9_JOIN=127.0.0.1:27015   the server to join (it must be in the site's servers.json)
//   H9_THROTTLE_MBPS=3        hold the page's connection to that many MB/s (CDP network emulation): a slow first visit. With --fresh
//                             (an empty cache) a join of 300 MB then takes minutes: the server's sv_connect_timeout (60 s by
//                             default, docs\H9WEB_ADMIN.txt) drops it unless server.cfg raises it, as H9XASH's does
//   H9_SECS=150               how long to watch
//   H9_DEV=2                  developer 2 first: the engine says more
//   H9_WAIT=6000              milliseconds in the server browser before the connect
export default async function prefetch({ tab, cmd, sleep, results, stamp, shot }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  await tab.send("Network.enable");
  const inflight = new Map(); // requestId -> { url, at }
  const stats = { started: 0, finished: 0, failed: 0, bytes: 0, received: 0, errors: {} };
  tab.on("Network.requestWillBeSent", (p) => { if (/\/webclient\/game\//.test(p.request.url)) { stats.started++; inflight.set(p.requestId, { url: p.request.url, at: Date.now() }); } });
  tab.on("Network.dataReceived", (p) => { if (inflight.has(p.requestId)) stats.received += p.dataLength || 0; });
  tab.on("Network.loadingFinished", (p) => { if (inflight.delete(p.requestId)) { stats.finished++; stats.bytes += p.encodedDataLength || 0; } });
  tab.on("Network.loadingFailed", (p) => { if (inflight.delete(p.requestId)) { stats.failed++; stats.errors[p.errorText] = (stats.errors[p.errorText] || 0) + 1; } });

  if (process.env.H9_THROTTLE_MBPS) {
    const bps = Math.round(Number(process.env.H9_THROTTLE_MBPS) * 1048576);
    await tab.send("Network.emulateNetworkConditions", { offline: false, latency: 30, downloadThroughput: bps, uploadThroughput: bps });
    console.log(stamp() + " network limited to " + process.env.H9_THROTTLE_MBPS + " MB/s");
  }
  if (process.env.H9_DEV) { await cmd("developer " + process.env.H9_DEV); await sleep(300); }
  await cmd("menu_internetgames");
  await sleep(Number(process.env.H9_WAIT || 6000));
  await cmd("connect " + server);
  console.log(stamp() + " connect " + server);

  const t0 = Date.now();
  let lastReceived = 0, shots = 0, resumed = 0, dumped = false;
  while (Date.now() - t0 < Number(process.env.H9_SECS || 150) * 1000) {
    await sleep(5000);
    const w = await Promise.race([
      tab.eval(`(() => { try { const m = window.h9web.module(); const w = m.warm; return w ? { state: w.state(), done: w.done(), total: w.total(), kb: w.kb() } : "no warm"; } catch (e) { return String(e); } })()`),
      sleep(8000).then(() => "MAIN THREAD DID NOT ANSWER IN 8 s"),
    ]);
    const old = [...inflight.values()].sort((a, b) => a.at - b.at).slice(0, 4).map((x) => ((Date.now() - x.at) / 1000).toFixed(0) + "s " + x.url.replace(/^.*\/webclient\/game\//, "").replace(/\?.*$/, ""));
    console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s  warm=${JSON.stringify(w)}  net: started ${stats.started} finished ${stats.finished} failed ${stats.failed} in flight ${inflight.size}  +${((stats.received - lastReceived) / 1048576).toFixed(1)} MB in 5 s  ${JSON.stringify(stats.errors)}`);
    lastReceived = stats.received;
    if (old.length) console.log("        oldest in flight: " + old.join(" | "));
    const log = await Promise.race([tab.eval(`window.h9web.log.slice(-4).join(" | ")`), sleep(3000).then(() => "(log unreadable)")]);
    console.log("        engine: " + String(log).slice(0, 420));
    if (w && w.state === 0 && w.total && shots < 2 && (shots === 0 || w.done > 60)) await shot("fetching-" + (++shots));
    if (w && w.state === 0 && w.total && !dumped) {
      dumped = true;
      const dump = await tab.eval(`(() => { const el = document.querySelector(".webclient-download"); if (!el) return "no box element"; const bar = el.querySelector(".dl-bar"); const i = bar && bar.querySelector("i"); const cs = (e) => (e ? getComputedStyle(e) : null); const b = cs(bar), f = cs(i); return JSON.stringify({ hidden: el.hidden, bar: b && { h: b.height, w: b.width, border: b.border, bg: b.backgroundColor }, fill: f && { h: f.height, w: f.width, bg: f.backgroundColor }, styleAttr: i && i.getAttribute("style") }); })()`);
      console.log("box: " + dump);
    }
    if (w && w.state === 1 && w.total && w.done >= w.total && ++resumed >= 2) break;
  }
  results.warm = stats;
  const after = await tab.eval(`(() => { const l = window.h9web.log; const i = l.findIndex((x) => x.includes("H9 WARM: the page fetches")); return i < 0 ? [] : l.slice(i, i + 80); })()`);
  console.log(["--- engine log from the pre-fetch on (" + after.length + " lines) ---", ...after.map((x) => String(x).slice(0, 200))].join(String.fromCharCode(10)));
}
