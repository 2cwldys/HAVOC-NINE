#!/usr/bin/env node
// h9web-backup: backups of h9web's data, restores of all of it or of a part, and JSON exports of
// the forum or the communities for another h9web (lib/backup.js does the work; README.txt
// section 10 is the guide). Run it as the service's user, with the service's config:
//
//   sudo -u h9web node /opt/h9web/bin/h9web-backup.js --config /etc/h9web/config.json <command>
//
// Commands:
//   backup [--out DIR] [--keep N] [--encrypt [--with-keys]] [--passphrase-file FILE]
//          one .h9backup file into DIR (default <dataDir>/backups); safe while the service runs.
//          --keep N deletes this host's oldest backups in DIR beyond N. secrets.json and data.key
//          go in only with --with-keys, which needs --encrypt
//   restore <file> [--only PART[,PART...]] [--yes] [--allow-other-keys]
//          the whole backup, or the parts named: forum, community, accounts, or any module
//          (presence, discord). Refuses while the service runs; a safety backup comes first
//   list [--out DIR]                        the backups in DIR (default <dataDir>/backups), checked
//   verify <file>                           one backup, checked through
//   export --only forum|community [--format json] [--out FILE]
//   import <file.json> [--only forum|community] [--yes]
//
// The passphrase of an encrypted backup comes from H9WEB_BACKUP_PASSPHRASE or the first line of
// --passphrase-file, never from the command line. restore and import ask for "yes" in a
// terminal; elsewhere they need --yes. Exit status: 0 done, 1 refused or failed, 2 a wrong
// command line.

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error("h9web-backup needs Node.js 24 or newer (node:sqlite); this is " + process.version + ".");
  process.exit(1);
}

const { default: path } = await import("node:path");
const { default: readline } = await import("node:readline");
const { loadConfig } = await import("../lib/config.js");
const B = await import("../lib/backup.js");

const USAGE = `usage: h9web-backup [--config FILE] <command> ...
  backup  [--out DIR] [--keep N] [--encrypt [--with-keys]] [--passphrase-file FILE]
  restore <file> [--only forum|community|accounts|<module>[,...]] [--yes] [--allow-other-keys]
  list    [--out DIR]
  verify  <file>
  export  --only forum|community [--format json] [--out FILE]
  import  <file.json> [--only forum|community] [--yes]
The passphrase: H9WEB_BACKUP_PASSPHRASE, or the first line of --passphrase-file FILE.
README.txt section 10 has the details.`;

function fail(message, code = 1) {
  console.error("h9web-backup: " + message);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.some((a) => a === "--passphrase" || a.startsWith("--passphrase="))) {
  fail("a passphrase is never taken as an argument (the shell would keep it in its history): set H9WEB_BACKUP_PASSPHRASE or use --passphrase-file FILE", 2);
}
// every value of an option, each taken out of args
function values(name) {
  const out = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) fail(name + " needs a value", 2);
    out.push(v);
    args.splice(i, 2);
  }
  return out;
}
// the last value given wins, so a wrapper's default can be overridden after it
const option = (name) => values(name).pop();
function flag(name) {
  let found = false;
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    args.splice(i, 1);
    found = true;
  }
  return found;
}

if (flag("--help") || flag("-h") || args[0] === "help" || !args.length) {
  console.log(USAGE);
  process.exit(args.length || process.argv.length > 2 ? 0 : 2);
}
const configFile = option("--config") || process.env.H9WEB_CONFIG;
const out = option("--out");
const keepText = option("--keep");
const passphraseFile = option("--passphrase-file");
const format = option("--format");
const only = values("--only").flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
const yes = flag("--yes");
const encrypt = flag("--encrypt");
const withKeys = flag("--with-keys");
const allowOtherKeys = flag("--allow-other-keys");
const command = args.shift();
const unknown = args.find((a) => a.startsWith("-"));
if (unknown) fail("unknown option " + unknown + "\n" + USAGE, 2);

let config = null;
function getConfig() {
  if (!config) config = loadConfig(configFile);
  return config;
}
const passphrase = () => B.readPassphrase({ passphraseFile });
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const versions = (mods) => Object.entries(mods || {}).map(([m, v]) => m + " v" + v).join(", ") || "none";

// Shows the plan; true to go on: --yes, or "yes" typed in a terminal.
function confirmer() {
  return async (lines) => {
    for (const l of lines) console.log(l);
    if (yes) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await new Promise((resolve) => rl.question("Type yes to go on: ", resolve));
      return answer.trim().toLowerCase() === "yes";
    } finally {
      rl.close();
    }
  };
}
function needConfirmation(what) {
  if (!yes && !process.stdin.isTTY) fail(what + " changes the data: run it in a terminal to confirm, or give --yes", 1);
}
function single(what) {
  const file = args.shift();
  if (!file) fail(command + " needs " + what + "\n" + USAGE, 2);
  if (args.length) fail("one " + what + " only: " + args.join(" "), 2);
  return path.resolve(file);
}
function printFixes(fixed) {
  for (const f of fixed) {
    const why = "their " + f.parent + " row is gone" + (f.parent === "accounts" ? " (as for a deleted account)" : "");
    console.log("  " + f.table + ": " + f.rows + (f.what === "left out" ? " row(s) left out: " : " row(s) with " + f.columns + " cleared: ") + why);
  }
}
function printWarnings(warnings) {
  for (const w of warnings || []) console.log("WARNING: " + w);
}

try {
  switch (command) {
    case "backup": {
      if (args.length) fail("backup takes no file: " + args.join(" ") + " (--out DIR names the folder)", 2);
      const keep = keepText === undefined ? undefined : Number(keepText);
      if (keepText !== undefined && !(Number.isInteger(keep) && keep >= 1)) fail("--keep must be a whole number of 1 or more", 2);
      const r = B.createBackup({ config: getConfig(), out, keep, encrypt, withKeys, passphrase: encrypt ? passphrase() : null });
      const m = r.manifest;
      console.log("wrote " + r.file + " (" + mb(r.size) + ")");
      console.log("  " + B.summarize(m.tables, m.modules));
      console.log("  " + versions(m.modules) + "; " + m.files.length + " files; " + (m.encrypted ? "encrypted" : "not encrypted") + "; " +
        (m.keys ? "secrets.json and data.key in it" : "secrets.json and data.key not in it (back them up once, apart from the backups)"));
      if (r.removed.length) console.log("  --keep " + keep + ": deleted " + r.removed.join(", "));
      break;
    }
    case "restore": {
      const file = single("the backup file");
      needConfirmation("restore");
      const r = await B.restoreArchive({ config: getConfig(), file, only, passphrase: passphrase(), confirm: confirmer(), allowOtherKeys });
      if (r.safety) console.log("safety backup of the data as it was: " + r.safety);
      if (r.kind === "full") {
        console.log("restored the whole backup into " + r.dataDir + " (rows per table):");
        for (const [t, n] of Object.entries(r.tables)) console.log("  " + t.padEnd(34) + String(n).padStart(7));
        console.log("  module files: " + r.files + "; keys: " + (r.keys.length ? r.keys.join(" and ") + " from the backup" : "the ones here, unchanged"));
        for (const a of r.asides) console.log("  the key that was here is kept as " + a);
      } else {
        console.log("restored " + r.names.join(", ") + " (rows per table, before -> after):");
        for (const t of r.tables) console.log("  " + t.padEnd(34) + String(r.before[t]).padStart(7) + " -> " + r.after[t]);
        printFixes(r.fixed);
        if (r.files.length) console.log("  files: " + r.files.join(", ") + " from the backup");
      }
      printWarnings(r.warnings);
      console.log("start h9web again: the local site with local-site.cmd; the VPS with sudo systemctl start h9web");
      break;
    }
    case "list": {
      if (args.length) fail("list takes no file (--out DIR names the folder)", 2);
      const dir = path.resolve(out || B.defaultOut(getConfig()));
      const items = B.listArchives(dir, { passphrase: passphrase() });
      if (!items.length) console.log("no backups in " + dir);
      for (const it of items) {
        const m = it.manifest;
        if (!it.ok) {
          console.log(it.name + "  " + mb(it.size) + "  " + (it.encrypted && /is encrypted/.test(it.error) ? "encrypted: set H9WEB_BACKUP_PASSPHRASE or --passphrase-file to check it" : "NOT OK: " + it.error));
          continue;
        }
        console.log(it.name + "  " + mb(it.size) + "  ok" + (it.encrypted ? ", encrypted" : "") + (m.keys ? ", with keys" : ""));
        console.log("    " + m.createdAt + " on " + m.host + ", h9web " + m.h9web + "; " + versions(m.modules));
        console.log("    " + B.summarize(m.tables, m.modules));
      }
      if (items.length) console.log(items.length + " backup(s) in " + dir + " (checksums checked; verify <file> also opens the database)");
      break;
    }
    case "verify": {
      const file = single("the backup file");
      const a = B.verifyArchive(file, { passphrase: passphrase() });
      const m = a.manifest;
      console.log(path.basename(file) + ": ok");
      console.log("  made " + m.createdAt + " on " + m.host + (m.origin ? " (" + m.origin + ")" : "") + ", h9web " + m.h9web + ", node " + m.node);
      console.log("  " + (a.encrypted ? "encrypted" : "not encrypted") + "; keys " + (m.keys ? "in it: " + m.files.filter((f) => f.role === "key").map((f) => f.path).join(", ") : "not in it") +
        "; made with secrets " + (m.secretsId || "?") + ", data key " + (m.dataKeyId || "?"));
      console.log("  versions: " + versions(m.modules));
      console.log("  " + m.files.length + " files, every checksum matches; the database passes quick_check and holds the rows the manifest lists:");
      for (const [t, n] of Object.entries(a.counts)) console.log("    " + t.padEnd(34) + String(n).padStart(7));
      break;
    }
    case "export": {
      if (args.length) fail("export takes no file (--out FILE names it)", 2);
      if (format && format !== "json") fail("--format: json is the one format", 2);
      if (only.length !== 1) fail("export needs --only forum or --only community", 2);
      const r = B.exportJson({ config: getConfig(), only: only[0], out });
      console.log("wrote " + r.file + " (" + r.doc.selection + ", " + r.doc.module + " v" + r.doc.version + ")");
      for (const [t, n] of Object.entries(r.doc.counts)) console.log("  " + t.padEnd(34) + String(n).padStart(7));
      if (r.doc.leftOut.length) console.log("  not in it: " + r.doc.leftOut.join(", ") + " (profile pictures move with a backup)");
      break;
    }
    case "import": {
      const file = single("the .json file");
      if (only.length > 1) fail("import takes one --only", 2);
      needConfirmation("import");
      const r = await B.importJson({ config: getConfig(), file, only: only[0], confirm: confirmer() });
      console.log("safety backup of the data as it was: " + r.safety);
      console.log("imported " + r.selection + " (rows per table, before -> after):");
      for (const t of r.tables) {
        const c = r.counts[t];
        const notes = [c.leftOut ? c.leftOut + " left out (no such account here)" : "", c.cleared ? c.cleared + " now from a deleted account" : ""].filter(Boolean).join(", ");
        console.log("  " + t.padEnd(34) + String(r.before[t]).padStart(7) + " -> " + r.after[t] + (notes ? "   " + notes : ""));
      }
      printFixes(r.fixed);
      if (r.missing.length) console.log("  usernames with no account here: " + r.missing.join(", "));
      console.log("start h9web again: the local site with local-site.cmd; the VPS with sudo systemctl start h9web");
      break;
    }
    default:
      fail((command ? "unknown command " + command + "\n" : "") + USAGE, 2);
  }
} catch (e) {
  if (e instanceof B.BackupError) fail(e.message, e.code === "usage" ? 2 : 1);
  fail(e && e.message ? e.message : String(e));
}
