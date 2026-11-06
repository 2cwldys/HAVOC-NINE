// A perf.mjs scenario: the RELEASE GATE (docs\H9_RELEASE.txt) seen from the player's side. The test server (D:\temp\h9-assault-server.bat, port 27015,
// rcon password h9test) holds its joiners to h9_plugin_release; the web client carries the release its stage has (ts\h9_release.txt). The
// scenario asks the server to be on a NEWER release (the game is out of date: the update box with its button), on an OLDER one (the other
// advice), and then on the game's own (the join goes through), and takes a picture of each.
//
//   node perf.mjs --url http://127.0.0.1:8090/webclient/index.html --login perf51n99t --phases none --script gate.mjs --name gate
//
//   H9_JOIN=127.0.0.1:27015   the server (it must be in the site's servers.json)
//   H9_RCON=h9test            its rcon password
import dgram from "node:dgram";

function rconCall(command, port, password) {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const out = [];
    s.on("message", (m) => out.push(m.toString("latin1").replace(/[^\x20-\x7e\n]/g, "?").replace(/^\?\?\?\?/, "").trim()));
    s.send(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from(`rcon ${password} ${command}\n`, "latin1")]), port, "127.0.0.1");
    setTimeout(() => { s.close(); resolve(out.join("\n").split("\n").filter((l) => l !== "print").join("\n")); }, 1500);
  });
}

export default async function gate({ tab, cmd, sleep, shot, results, stamp }) {
  const server = process.env.H9_JOIN || "127.0.0.1:27015";
  const rcon = process.env.H9_RCON || "h9test";
  const port = Number(server.split(":")[1]);
  const checks = [];
  const verdict = (name, ok, detail) => { console.log(stamp() + (ok ? " PASS " : " FAIL ") + name + (detail ? " -- " + detail : "")); checks.push({ name, ok }); };
  const tail = async (n = 60) => String(await tab.eval(`window.h9web.log.slice(-${n}).join('\\n')`));
  const escape = async () => {
    const base = { windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: "Escape", code: "Escape" };
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await sleep(80);
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  // the clients on the server that came in over the network: its status lists an address for each (a bot is a fake client and has none)
  const humans = async () => (await rconCall("status", port, rcon)).split("\n").filter((l) => /^#\s*\d+\s.*\d+\.\d+\.\d+\.\d+:\d+/.test(l));
  const drop = async () => {
    await cmd("_h9_drop");
    await sleep(500);
    const lines = (await tail(12)).split("\n").filter((l) => l.includes("_h9_drop"));
    return lines.length ? lines[lines.length - 1] : "";
  };

  await cmd("menu_internetgames");
  await sleep(6000);
  const mine = (await rconCall("h9_plugin_release", port, rcon)).match(/is "([^"]*)"/);
  const release = mine ? mine[1] : "";
  console.log(stamp() + " the server's release: " + release);
  verdict("the server is on a release", /^\d{4}\.\d\d\.\d\d/.test(release), release);

  // 1. the server is on a newer release than this game: refused, and the box has its button
  await rconCall("h9_plugin_release 2099.01.01", port, rcon);
  await cmd("connect " + server);
  await sleep(14000);
  await shot("gate-1-out-of-date");
  let d = await drop();
  console.log(stamp() + " " + d);
  verdict("a game older than the server is refused with where to get the right one", /out of date \(release [\d.]+, this server runs 2099\.01\.01\).*havoc9\.org\/downloads/.test(d), d.slice(0, 200));
  verdict("and is not on the server", (await humans()).length === 0);
  await escape();
  await sleep(1500);

  // 2. the server is on an older release than this game: refused with the other advice
  await rconCall("h9_plugin_release 1999.01.01", port, rcon);
  await cmd("connect " + server);
  await sleep(14000);
  await shot("gate-2-server-older");
  d = await drop();
  console.log(stamp() + " " + d);
  verdict("a game newer than the server is refused and told to ask for the server to be updated", /runs an older HAVOC 9 \(release 1999\.01\.01, yours is [\d.]+\)/.test(d), d.slice(0, 200));
  verdict("and is not on the server", (await humans()).length === 0);
  await escape();
  await sleep(1500);

  // 3. the server is on this game's release: the join goes through
  await rconCall("h9_plugin_release " + release, port, rcon);
  await cmd("connect " + server);
  await sleep(20000);
  await shot("gate-3-joined");
  // joined: the server's status lists a client with an address. A fresh browser fetches the game and the map first (minutes the first time), so
  // the status is read until the client is there or the time is up
  let people = await humans();
  for (let waited = 0; waited < 180000 && !people.length; waited += 4000) {
    await sleep(4000);
    people = await humans();
  }
  verdict("the same release joins", people.length > 0, "the clients with an address: " + (people.map((l) => l.trim()).join(" | ") || "none"));
  results.gate = { server, release, checks, done: true };
}
