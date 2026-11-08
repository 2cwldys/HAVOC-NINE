// Secret scan for the files git tracks (or for the paths given). The same rules make-vps-package.ps1 uses when it builds
// a package, so the repository and the package are held to one list.
//
//   node tools/secret-scan.mjs                 every tracked file under the current git repository
//   node tools/secret-scan.mjs <path> [...]    only those files or folders
//
// Exit 0 = clean, 1 = a finding (file:line and the rule, never the value), 2 = could not run.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BAD_NAME = /^(secrets\.json|data\.key|serverlist\.cfg|ts_advertise\.cfg|backup-passphrase.*|\.env|id_rsa.*|id_ed25519.*|id_ecdsa.*)$|\.(h9backup|p12|pfx|ppk)$/;
// Public certificates and upstream test data are tracked on purpose.
const ALLOW_PATH = /^(xash3d-fwgs\/3rdparty\/|.*cacert\.pem$|.*amxx_easy_http_cacert\.pem$)/;
const TEXT_EXT = /\.(js|mjs|cjs|json|html|htm|css|txt|md|ini|cfg|sh|ps1|cmd|bat|py|service|timer|conf|example|template|xml|svg|yaml|yml|toml|sma|inc|cpp|h|c)$/i;
const RULES = [
  ["a Discord bot token", /[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/],
  ["a Discord webhook URL", /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a filled-in heartbeat_key or discord_token", /^[ \t]*(heartbeat_key|discord_token)[ \t]*=[ \t]*[^\s;#<]/m],
  ["h9web's password pepper or player id key", /"(passwordPepper|playerIdKey)"\s*:\s*"[A-Za-z0-9+/=]{16,}"/],
  ["a filled-in client secret or bot token", /"(clientSecret|botToken|client_secret|bot_token)"\s*:\s*"(?!<)[^"]{8,}"/],
  ["a GitHub token", /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}\b/],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["a literal rcon_password value", /^[ \t]*rcon_password[ \t]+"?(?!""|<)[^\s"]{3,}/m],
];

function listFiles(args) {
  if (args.length) {
    const out = [];
    const walk = (p) => {
      const st = fs.statSync(p);
      if (st.isDirectory()) { for (const n of fs.readdirSync(p)) if (n !== ".git" && n !== "node_modules") walk(path.join(p, n)); }
      else out.push(p.replace(/\\/g, "/"));
    };
    for (const a of args) walk(a);
    return out;
  }
  return execFileSync("git", ["ls-files", "-z"], { maxBuffer: 1 << 28 }).toString("utf8").split("\0").filter(Boolean);
}

let files;
try { files = listFiles(process.argv.slice(2)); } catch (e) { console.error("secret-scan: " + e.message); process.exit(2); }
let findings = 0, scanned = 0;
for (const f of files) {
  if (ALLOW_PATH.test(f)) continue;
  if (BAD_NAME.test(path.basename(f))) { console.log(`${f}: a file name that holds secrets`); findings++; continue; }
  if (!TEXT_EXT.test(f)) continue;
  let text;
  try { const st = fs.statSync(f); if (!st.isFile() || st.size > 8 * 1024 * 1024) continue; text = fs.readFileSync(f, "latin1"); } catch { continue; }
  scanned++;
  for (const [why, rx] of RULES) {
    const m = rx.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split("\n").length;
      console.log(`${f}:${line}: ${why}`);
      findings++;
    }
  }
}
console.log(`secret-scan: ${scanned} text files checked, ${findings} finding(s)`);
process.exit(findings ? 1 : 0);
