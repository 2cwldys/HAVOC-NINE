// Minimal Chrome DevTools Protocol driver for the web client tests: launches a Chromium-family browser on a
// throwaway profile, opens a tab, and speaks CDP over Node's own WebSocket. No dependencies.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

function operaExe() {
  const root = path.join(process.env.LOCALAPPDATA || "", "Programs", "Opera GX");
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(d.name))
      .map((d) => d.name).filter((n) => fs.existsSync(path.join(root, n, "opera.exe")));
  } catch (e) { /* not installed */ }
  dirs.sort((a, b) => a.split(".").map(Number).reduce((r, x, i) => r || x - Number(b.split(".")[i]), 0));
  return dirs.length ? path.join(root, dirs[dirs.length - 1], "opera.exe") : null;
}

const edgeExe = () => ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p)) || null;

export const BROWSERS = { edge: edgeExe, opera: operaExe };

/** The browser to use: the named one, else Edge, else Opera GX. */
export function findBrowser(name) {
  const order = name ? [name] : ["edge", "opera"];
  for (const n of order) {
    const exe = BROWSERS[n] && BROWSERS[n]();
    if (exe) return { name: n, exe };
  }
  return null;
}

export async function launch({ browser, profile, port = 9444, size = "1280,800", headless = true, extra = [] }) {
  const found = findBrowser(browser);
  if (!found) throw new Error("no Chromium browser found (Edge or Opera GX)");
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    ...(headless ? ["--headless=new"] : []),
    // --disable-extensions: the browser's own add-ons (a Discord presence extension among them) run scripts in the page, throw errors of
    // their own into the test's exception list and draw popups over its screenshots
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--autoplay-policy=no-user-gesture-required", `--window-size=${size}`,
    // the tests judge pictures and the engine's own account of itself, and a test run is heard through the speakers of the PC it runs
    // on: silent unless H9_TEST_SOUND is set (the audio backend's own checks)
    ...(process.env.H9_TEST_SOUND ? [] : ["--mute-audio"]),
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    ...extra, "about:blank",
  ];
  const child = spawn(found.exe, args, { stdio: "ignore", windowsHide: true, detached: false });
  child.on("error", (e) => console.log("browser spawn error: " + e.message));
  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    await sleep(250);
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (e) { /* not up yet */ }
  }
  if (!version) { try { child.kill(); } catch (e) { /* gone */ } throw new Error("the browser did not open its debugging port"); }
  return { child, exe: found.exe, name: found.name, version, port, profile };
}

/** Stops the browser this test started, found by its own profile folder: nobody else's. */
export function killBrowser(profile) {
  const like = profile.replace(/\\/g, "\\\\").replace(/'/g, "''");
  spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
}

export class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error("cdp socket error"));
      this.ws.onmessage = (m) => {
        const d = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString("utf8"));
        if (d.id && this.pending.has(d.id)) {
          const { res, rej } = this.pending.get(d.id);
          this.pending.delete(d.id);
          if (d.error) rej(new Error(d.error.message + " (" + JSON.stringify(d.error.data || "") + ")"));
          else res(d.result);
        } else if (d.method) {
          for (const fn of this.handlers.get(d.method) || []) fn(d.params);
        }
      };
      this.ws.onclose = () => { for (const { rej } of this.pending.values()) rej(new Error("cdp closed")); this.pending.clear(); };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page threw: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* closed */ } }
}

export async function newTab(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const t = await r.json();
  return new Cdp(t.webSocketDebuggerUrl).open();
}

/** Opens the page with the test hooks (inject.js) in, waits for PLAY, plays, and waits for the engine's main menu. */
export async function playToMenu({ tab, url, inject, say = () => {}, upSeconds = 120 }) {
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  await tab.send("Log.enable");
  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  await tab.send("Page.navigate", { url });
  let state = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      state = await tab.eval(`(() => ({ title: (document.getElementById('webclientTitle')||{}).textContent, play: [...document.querySelectorAll('button')].some(e => e.textContent.trim() === 'PLAY'), gl: window.__perf && window.__perf.gl }))()`);
    } catch (e) { continue; }
    if (state.play && /PLAY IN YOUR BROWSER/i.test(state.title || "")) break;
  }
  if (!state || !state.play || !/PLAY IN YOUR BROWSER/i.test(state.title || "")) throw new Error("the page never offered PLAY: " + JSON.stringify(state));
  say("page offers PLAY, drawing on " + ((state.gl && state.gl.renderer) || "an unknown GPU"));
  await tab.eval(`[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'PLAY').click()`);
  let up = false;
  for (let i = 0; i < upSeconds * 2 && !up; i++) {
    await sleep(500);
    try { up = await tab.eval(`!!(window.h9web && window.h9web.module && window.h9web.module())`); } catch (e) { /* loading */ }
  }
  if (!up) throw new Error("the engine did not come up in " + upSeconds + " seconds");
  say("engine up");
  return state;
}
