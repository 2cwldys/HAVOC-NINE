// A perf.mjs scenario: what a key press does to the page itself, in the main menu (no server needed). For TAB, W, Space, an arrow and F1 it
// sends one press with browser auto-repeat (a key-down every 33 ms after 500 ms, as Windows repeats), and prints
//   - whether the page's own default action ran (a key-down nobody called preventDefault on: TAB moves the focus, Space scrolls),
//   - where the focus was before and after, and every blur/focus the canvas and the window saw,
//   - the engine's lines said meanwhile.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --phases none --script keyfocus.mjs --name keyfocus
const KEYS = [
  { name: "Tab", key: "Tab", code: "Tab", vk: 9, text: "" },
  { name: "w", key: "w", code: "KeyW", vk: 87, text: "w" },
  { name: "Space", key: " ", code: "Space", vk: 32, text: " " },
  { name: "ArrowUp", key: "ArrowUp", code: "ArrowUp", vk: 38, text: "" },
  { name: "F1", key: "F1", code: "F1", vk: 112, text: "" },
];

export default async function keyfocus({ tab, cmd, sleep, results }) {
  await sleep(2000);
  await tab.eval(`(() => {
    const kf = (window.__kf = { down: [], focus: [] });
    const where = () => (document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none");
    // the last listener in the path (window, bubbling): defaultPrevented is final by now
    window.addEventListener("keydown", (e) => kf.down.push([e.key, e.repeat, e.defaultPrevented, where()]), false);
    const c = document.getElementById("canvas");
    window.addEventListener("blur", () => kf.focus.push("window blur"));
    window.addEventListener("focus", () => kf.focus.push("window focus"));
    c.addEventListener("blur", () => kf.focus.push("canvas blur -> " + where()));
    c.addEventListener("focus", () => kf.focus.push("canvas focus"));
    c.focus();
    return where();
  })()`);
  const lines = () => tab.eval("window.h9web.log.length");
  results.keys = {};
  for (const k of KEYS) {
    await tab.eval(`(window.__kf.down.length = 0, window.__kf.focus.length = 0, document.getElementById("canvas").focus(), 1)`);
    const before = await tab.eval(`document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none"`);
    const log0 = await lines();
    const base = { windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, key: k.key, code: k.code };
    const type = k.text ? "keyDown" : "rawKeyDown";
    await tab.send("Input.dispatchKeyEvent", { type, text: k.text || undefined, unmodifiedText: k.text || undefined, ...base });
    await sleep(500);
    for (let i = 0; i < 12; i++) {
      await tab.send("Input.dispatchKeyEvent", { type, text: k.text || undefined, unmodifiedText: k.text || undefined, autoRepeat: true, ...base });
      await sleep(33);
    }
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(300);
    const r = await tab.eval(`(() => { const d = window.__kf.down; const prevented = d.filter((x) => x[2]).length; return { events: d.length, prevented, notPrevented: d.length - prevented, focusAfter: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none", focusEvents: window.__kf.focus.slice(0, 6) }; })()`);
    const said = (await lines()) - log0;
    results.keys[k.name] = { before, ...r, engineLines: said };
    console.log(`${k.name.padEnd(8)} key-downs ${String(r.events).padStart(2)}  default actions left to the browser ${String(r.notPrevented).padStart(2)}  focus ${before} -> ${r.focusAfter}  focus events: ${JSON.stringify(r.focusEvents)}  engine lines: ${said}`);
  }
}
