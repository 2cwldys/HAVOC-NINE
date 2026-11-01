#!/usr/bin/env node
// h9web: HAVOC 9 accounts, sessions, and the web client's WebSocket-to-UDP relay.
//
//   node server.js [--config /etc/h9web/config.json]
//
// Without --config it reads config.json beside this file when there is one, and the built-in
// defaults otherwise. README.txt covers setup, nginx, systemd, backups and admin tasks.

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error("h9web needs Node.js 24 or newer (node:sqlite); this is " + process.version + ".");
  process.exit(1);
}

const { loadConfig } = await import("./lib/config.js");
const { createApp } = await import("./lib/app.js");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const config = loadConfig(argValue("--config") || process.env.H9WEB_CONFIG);
const app = await createApp(config);
await app.listen();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app.log.info("shutdown", { signal });
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  try {
    await app.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
