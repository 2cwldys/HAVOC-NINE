// Lint for the documents a public repository (and a stranger's AI agent) will read: no machine paths, no real addresses, no
// e-mail addresses, no secrets. The AI-context files are kept public on purpose; this keeps them to what is safe to publish.
//
//   node tools/lint-public-docs.mjs            the default set (below), under the current directory
//   node tools/lint-public-docs.mjs <file> ... only those files
//
// Exit 0 = clean, 1 = a finding (file:line and the rule, never the value).
import fs from "node:fs";
import path from "node:path";

const DEFAULT = ["CLAUDE.md", "CONTEXT.md", "README.txt", "SECURITY.md", "docs/ai_context", "havoc9.org/join/HAVOC9-AI-CONTEXT.md"];
const TEXT = /\.(md|txt)$/i;

// documentation addresses (RFC 5737, RFC 3849), loopback, private ranges used as examples, and 0.0.0.0
const OK_IP = /^(127\.|10\.|192\.168\.|0\.0\.0\.0|255\.|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
const RULES = [
  ["a machine path", /\b[A-Za-z]:\\(?:Users|Downloads|SteamLibrary|GIT Storage|temp|Temp)\b/],
  ["a user's home folder", /\/(?:home|Users)\/[A-Za-z0-9_.-]+\//],
  ["an e-mail address", /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9-]+\.[A-Za-z]{2,}\b/],
  ["a Discord token or webhook", /[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}|discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an SSH command to a host", /\b(?:ssh|scp)\s+(?:-\w+\s+\S+\s+)*[\w.-]+@(?!<)[\w.-]+/],
];

function files(args) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
    else if (TEXT.test(p)) out.push(p.replace(/\\/g, "/"));
  };
  for (const a of args.length ? args : DEFAULT) walk(a);
  return out;
}

let findings = 0, checked = 0;
for (const f of files(process.argv.slice(2))) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  checked++;
  lines.forEach((line, i) => {
    for (const [why, rx] of RULES) if (rx.test(line)) { console.log(`${f}:${i + 1}: ${why}`); findings++; }
    for (const m of line.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b(?!\.\d)/g)) {
      const ip = m[1];
      if (ip.split(".").every((n) => Number(n) <= 255) && !OK_IP.test(ip) && !/^\d+\.\d+\.\d+\.\d+$/.test(line.trim())) {
        // a version number such as 1.2.3.4 is not an address: only flag when the line talks about hosts
        if (/\b(host|server|ip|address|connect|ssh|scp|nginx|origin)\b/i.test(line)) { console.log(`${f}:${i + 1}: a real-looking IPv4 address`); findings++; }
      }
    }
  });
}
console.log(`lint-public-docs: ${checked} files checked, ${findings} finding(s)`);
process.exit(findings ? 1 : 0);
