// A perf.mjs scenario: what a browser's saved config holds once the game has started. With --inject oldname-inject.js (a config saved
// while the stock name and model were Sprayer and gordon), the page moves them to Proletarian and proletarian once and marks it done.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login perfcur1 --phases none --script namecheck.mjs --inject D:\temp\webperf\oldname-inject.js --name namecheck
export default async function namecheck({ tab, cmd, sleep }) {
  await sleep(4000);
  await cmd("name");
  await cmd("model");
  await sleep(800);
  const out = await tab.eval(`(() => ({ config: localStorage.getItem("h9web.config"), marker: localStorage.getItem("h9web.defaults"),
    log: window.h9web.log.filter((x) => /"(name|model)" is/i.test(x)).slice(-4) }))()`);
  console.log(JSON.stringify(out, null, 1));
}
