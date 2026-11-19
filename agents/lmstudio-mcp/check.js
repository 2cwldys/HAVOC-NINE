#!/usr/bin/env node
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const line = chalk.cyan(" " + "─".repeat(50));

console.log();
console.log(chalk.cyan(" " + "═".repeat(50)));
console.log(chalk.cyan(" ║") + chalk.bold.white("   HAVOC 9  ──  LM Studio Health Check           ") + chalk.cyan("║"));
console.log(chalk.cyan(" " + "═".repeat(50)));
console.log();

let allGood = true;

function ok(msg, detail)   {
    console.log(chalk.green("   OK  ") + " " + msg);
    if (detail) console.log(chalk.gray("         " + detail));
}
function warn(msg, fix) {
    console.log(chalk.yellow("   !!  ") + " " + msg);
    if (fix) console.log(chalk.gray("         → " + fix));
    allGood = false;
}
function fail(msg, fix) {
    console.log(chalk.red("   ✗   ") + " " + msg);
    if (fix) console.log(chalk.gray("         → " + fix));
    allGood = false;
}

// ---------------------------------------------------------------------------
// 1. Node.js version
// ---------------------------------------------------------------------------
const nodeVer = process.versions.node.split(".").map(Number);
if (nodeVer[0] >= 18) {
    ok(`Node.js v${process.versions.node}`);
} else {
    fail(`Node.js v${process.versions.node} -- need v18+`, "Download from https://nodejs.org");
}

// ---------------------------------------------------------------------------
// 2. LM Studio installed
// ---------------------------------------------------------------------------
let hasLms = false;
try { execSync("lms --version", { stdio: "ignore" }); hasLms = true; } catch {}

if (hasLms) {
    ok("LM Studio CLI (lms) installed");
} else {
    const guiPaths = [
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "LM-Studio", "LM Studio.exe"),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "LM Studio", "LM Studio.exe"),
        process.env.HOME && join(process.env.HOME, "Applications", "LM Studio.AppImage"),
        "/Applications/LM Studio.app",
    ].filter(Boolean);
    const guiFound = guiPaths.some(p => existsSync(p));

    if (guiFound) {
        warn("LM Studio GUI found but lms CLI not on PATH", "Re-run install.cmd / install.sh");
    } else {
        fail("LM Studio not installed", "Run install.cmd (Windows) or install.sh (Linux/Mac)");
    }
}

// ---------------------------------------------------------------------------
// 3. Dependencies installed
// ---------------------------------------------------------------------------
const mcpPath = join(__dirname, "node_modules/@modelcontextprotocol");
if (existsSync(mcpPath)) {
    ok("Dependencies installed (node_modules present)");
} else {
    fail("Dependencies not installed", "cd agents/lmstudio-mcp && npm install");
}

// ---------------------------------------------------------------------------
// 4. LM Studio API reachable + model loaded
// ---------------------------------------------------------------------------
let models = [];
let apiOK  = false;
try {
    const res  = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    models     = (json?.data ?? []).map(m => m.id ?? m);
    apiOK      = true;
    ok("LM Studio API server reachable (port 1234)");

    if (models.length > 0) {
        const extra = models.length > 1 ? ` (+${models.length - 1} more)` : "";
        ok(`Model loaded: ${models[0]}${extra}`);
    } else {
        warn("Server running but no model is loaded", "LM Studio → My Models tab → select a model → Load");
    }
} catch {
    fail("LM Studio API not reachable", "Open LM Studio → Developer tab → Start Server");
    fail("Cannot check model -- server offline");
}

// ---------------------------------------------------------------------------
// 5. .env present with MODEL_NAME
// ---------------------------------------------------------------------------
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
    const env  = readFileSync(envPath, "utf8");
    const name = env.match(/^MODEL_NAME=(.+)$/m)?.[1]?.trim();
    if (name) {
        ok(`.env present`, `MODEL_NAME=${name}`);
    } else {
        warn(".env exists but MODEL_NAME not set", "Run:  npm run setup");
    }
} else {
    warn(".env not found -- using settings.json defaults", "Run:  npm run setup  to create it");
}

// ---------------------------------------------------------------------------
// 6. .claude/settings.json MCP registration
// ---------------------------------------------------------------------------
const settingsPath = join(__dirname, "../../.claude/settings.json");
if (existsSync(settingsPath)) {
    try {
        const cfg = JSON.parse(readFileSync(settingsPath, "utf8"));
        if (cfg?.mcpServers?.lmstudio) {
            ok(".claude/settings.json -- lmstudio MCP registered");
        } else {
            warn(".claude/settings.json missing lmstudio entry", "Check agents/lmstudio-mcp/README.md");
        }
    } catch {
        warn(".claude/settings.json is not valid JSON");
    }
} else {
    fail(".claude/settings.json not found", "Make sure you are inside the HAVOC 9 repo (ts_h9_team_elimination)");
}

// ---------------------------------------------------------------------------
// 7. Context files
// ---------------------------------------------------------------------------
const contextDir     = join(__dirname, "context");
const projectCtx     = join(contextDir, "PROJECT.md");
const solutionsCtx   = join(contextDir, "SOLUTIONS.md");
const currentCtx     = join(contextDir, "CURRENT.md");

if (existsSync(projectCtx)) {
    ok("context/PROJECT.md -- codebase context present");
} else {
    warn("context/PROJECT.md not found", "Check agents/lmstudio-mcp/context/ exists in the repo");
}

if (existsSync(solutionsCtx)) {
    const raw      = readFileSync(solutionsCtx, "utf8");
    const entries  = (raw.match(/^###\s/gm) ?? []).length;
    ok(`context/SOLUTIONS.md -- ${entries} solution(s) on record`);
} else {
    warn("context/SOLUTIONS.md not found", "Check agents/lmstudio-mcp/context/ exists in the repo");
}

if (existsSync(currentCtx)) {
    const raw      = readFileSync(currentCtx, "utf8");
    const entries  = (raw.match(/^---$/gm) ?? []).length;
    const lastTs   = [...raw.matchAll(/_(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)_/g)].pop()?.[1] ?? "unknown";
    const lastBody = raw.split(/\n---\n/).pop()?.replace(/_.*UTC_\n*/g, "").trim().slice(0, 80) ?? "";
    ok(`context/CURRENT.md -- ${entries} session entr${entries === 1 ? "y" : "ies"} (last: ${lastTs})`,
       lastBody ? `"${lastBody}..."` : undefined);
} else {
    ok("context/CURRENT.md -- not set (will be created when Claude starts a task)");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log();
console.log(line);
if (allGood) {
    console.log(chalk.bold.green("   All checks passed -- agent is ready!"));
    console.log();
    console.log(chalk.gray("   Reopen the project in Claude Code, then ask:"));
    console.log(chalk.cyan('   "Use the local model to review this function"'));
} else {
    console.log(chalk.bold.yellow("   Some checks failed -- see hints above to fix them."));
    console.log(chalk.gray("   Run this again after fixing: npm run check"));
}
console.log(line);
console.log();
