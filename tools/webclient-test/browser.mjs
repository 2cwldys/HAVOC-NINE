// A perf.mjs scenario: the IN-GAME SERVER BROWSER with its Mode column. Opens the internet servers screen of the web client, gives the
// servers a while to answer and takes pictures at 9, 50 and 90 seconds (the page reads the site's server list when the game starts and
// every minute after, so a server that came up late shows in a later one). The servers the pictures should show are the ones the local
// site lists (servers.json): the test server on port 27015 and the second one on 27016 (D:\temp\h9-second-server.bat, a map as its argument).
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login perf51n99t --phases none --script browser.mjs --name browser
export default async function browser({ tab, cmd, sleep, shot, results, stamp }) {
  await cmd("menu_internetgames");
  console.log(stamp() + " the internet servers screen");
  await sleep(9000);
  await shot("browser-1");
  await sleep(41000);
  await shot("browser-2");
  await cmd("menu_internetgames");
  await sleep(40000);
  await shot("browser-3");
  const lines = await tab.eval("window.h9web.log.slice(-30).join('\\n')");
  console.log(stamp() + " the last engine lines:\n" + String(lines).split("\n").map((l) => "    " + l).join("\n"));
  results.browser = { done: true };
}
