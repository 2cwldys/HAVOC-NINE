#!/usr/bin/env node
import chalk from "chalk";
import { createInterface } from "readline";
import { existsSync, readFileSync, readdirSync, mkdirSync, symlinkSync, appendFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { homedir } from "os";
import { execSync, spawnSync } from "child_process";
import OpenAI from "openai";
import { loadRepoContext } from "./h9context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const key = t.slice(0, eq).trim();
        const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && process.env[key] === undefined) process.env[key] = val;
    }
}

const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1";
const MODEL_NAME    = process.env.MODEL_NAME    ?? "local-model";
const MODELS_DIR    = process.env.MODELS_DIR    ?? "native";

// ---------------------------------------------------------------------------
// Load project context (PROJECT.md, CURRENT.md, SOLUTIONS.md)
// ---------------------------------------------------------------------------
function loadContext() {
    const dir   = join(__dirname, "context");
    const parts = [];
    // H9: the repo's own CONTEXT.md and CLAUDE.md first (h9context.js), same as the MCP server
    try {
        const repoContext = loadRepoContext();
        if (repoContext) parts.push(repoContext);
    } catch { /* not inside the repo */ }
    try {
        const project   = join(dir, "PROJECT.md");
        const memory    = join(dir, "MEMORY.md");
        const current   = join(dir, "CURRENT.md");
        const solutions = join(dir, "SOLUTIONS.md");

        if (existsSync(project))
            parts.push("## Project Context\n" + readFileSync(project, "utf8").trim());
        // H9: the trust assessment, which no loader used to read
        if (existsSync(memory))
            parts.push("## How far to trust the local model here\n" + readFileSync(memory, "utf8").trim());
        if (existsSync(current)) {
            const cur = readFileSync(current, "utf8").trim();
            if (cur.length > 20)
                parts.push("## Current Working Session\n" + cur);
        }
        if (existsSync(solutions)) {
            const raw = readFileSync(solutions, "utf8").trim();
            if (raw.length > 100) {
                const trimmed = raw.length > 12000
                    ? "...(earlier entries omitted)\n\n" + raw.slice(-12000)
                    : raw;
                parts.push("## Known Solutions & Past Fixes\n" + trimmed);
            }
        }
    } catch {}
    return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Ensure LM Studio server is running
// ---------------------------------------------------------------------------
async function ensureServer() {
    // For local model installs, junction/symlink the model folder into LM Studio's
    // catalog directory so lms load can find it without any file copy.
    const newLinks = MODELS_DIR === "local" ? linkLocalModels() : false;
    if (newLinks) {
        dbg("ensureServer: new links created -- stopping server so it rescans on next start");
        runLms(["server", "stop"], 5000);
        await new Promise(r => setTimeout(r, 1000));
    }

    const serverRunning = await fetch(`${LM_STUDIO_URL}/models`, { signal: AbortSignal.timeout(2000) })
        .then(() => true).catch(() => false);
    dbg("ensureServer: server running?", serverRunning);

    if (serverRunning && !newLinks) return true;

    process.stdout.write(chalk.yellow(" Starting LM Studio server..."));
    try {
        runLms(["server", "start", "--port", "1234"], 20000);
        await new Promise(r => setTimeout(r, 2000));
        await fetch(`${LM_STUDIO_URL}/models`, { signal: AbortSignal.timeout(3000) });
        process.stdout.write(chalk.green(" ready\n"));
        dbg("ensureServer: server started OK");
        return true;
    } catch (e) {
        process.stdout.write(chalk.red(" failed\n"));
        dbg("ensureServer: start failed:", e.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Model loading -- imports local .gguf files then loads the model.
// Uses stdio:'ignore' so lms never shows an interactive TUI that would hang.
// ---------------------------------------------------------------------------
// Scan models/ dir and return [{ filePath, repoId }] for every .gguf found.
// repoId = "publisher/modelfolder" derived from the directory structure.
function scanLocalModels() {
    const localModels = join(__dirname, "models");
    const results = [];
    if (!existsSync(localModels)) return results;
    try {
        for (const pub of readdirSync(localModels, { withFileTypes: true })) {
            if (!pub.isDirectory()) continue;
            for (const mod of readdirSync(join(localModels, pub.name), { withFileTypes: true })) {
                if (!mod.isDirectory()) continue;
                const modDir = join(localModels, pub.name, mod.name);
                for (const file of readdirSync(modDir)) {
                    if (!file.endsWith(".gguf")) continue;
                    if (file.startsWith("mmproj-")) continue;  // multimodal projector, not loadable standalone
                    results.push({
                        filePath: join(modDir, file),
                        repoId:   `${pub.name}/${mod.name}`,
                    });
                }
            }
        }
    } catch {}
    return results;
}

// ---------------------------------------------------------------------------
// Debug logger -- writes to chat-debug.log next to chat.js (cleared each run)
// ---------------------------------------------------------------------------
const DEBUG_LOG = join(__dirname, "chat-debug.log");
try { writeFileSync(DEBUG_LOG, `=== chat.js started ${new Date().toISOString()} ===\n`); } catch {}
function dbg(...args) {
    try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString().slice(11,23)}] ${args.join(" ")}\n`); } catch {}
}

// ---------------------------------------------------------------------------
// Link local models/ into LM Studio's catalog directory via junction (Win) / symlink (Unix).
// No file copy -- zero extra disk space. Returns true if any new links were created.
// ---------------------------------------------------------------------------
function linkLocalModels() {
    const isWin      = process.platform === "win32";
    const lmsModels  = join(homedir(), ".lmstudio", "models");
    const localModels = join(__dirname, "models");
    dbg("linkLocalModels: LM Studio dir:", lmsModels);
    dbg("linkLocalModels: local models:", localModels);
    if (!existsSync(localModels)) {
        dbg("linkLocalModels: local models dir missing -- skipping");
        return false;
    }
    let created = 0;
    try {
        for (const pub of readdirSync(localModels, { withFileTypes: true })) {
            if (!pub.isDirectory()) continue;
            for (const mod of readdirSync(join(localModels, pub.name), { withFileTypes: true })) {
                if (!mod.isDirectory()) continue;
                const src    = join(localModels, pub.name, mod.name);
                const pubDir = join(lmsModels, pub.name);
                const dest   = join(pubDir, mod.name);
                if (existsSync(dest)) {
                    dbg("linkLocalModels: already linked:", dest);
                    continue;
                }
                mkdirSync(pubDir, { recursive: true });
                if (isWin) {
                    symlinkSync(src, dest, "junction");
                } else {
                    symlinkSync(src, dest);
                }
                dbg("linkLocalModels: created link:", dest, "→", src);
                created++;
            }
        }
    } catch (e) {
        dbg("linkLocalModels: ERROR:", e.message);
    }
    dbg("linkLocalModels: done,", created, "new links created");
    return created > 0;
}

// Run an lms command with args passed directly (no shell, no quoting issues with spaces).
// Returns { ok, output } -- output has ANSI stripped so it's safe to print.
function runLms(args, timeoutMs = 15000) {
    const r = spawnSync("lms", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
    });
    const raw = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
    const clean = raw.replace(/\x1b\[[?0-9;]*[A-Za-z]/g, "").replace(/\r/g, "\n").trim();
    return { ok: r.status === 0 && !r.error, output: clean, status: r.status, signal: r.signal, error: r.error };
}

async function ensureModelLoaded(modelName) {
    const localFiles = MODELS_DIR === "local" ? scanLocalModels() : [];
    dbg("ensureModelLoaded: MODELS_DIR =", MODELS_DIR);
    dbg("ensureModelLoaded: localFiles:", localFiles.map(f => f.repoId + "/" + f.filePath.split(/[\\/]/).pop()).join(", ") || "(none)");

    // Ask LM Studio what it actually has -- the GGUF's internal metadata determines the catalog key,
    // not the folder name (e.g. our folder is lmstudio-community/gemma-* but the GGUF says google/gemma-*).
    const { output: lsOut } = runLms(["ls"], 5000);
    dbg("ensureModelLoaded: lms ls output:", lsOut);

    // Parse catalog: each line is "publisher/model-key   (size)" -- grab first token, skip embedding models.
    const catalogModels = (lsOut || "")
        .split("\n")
        .map(l => l.trim().replace(/^[>\s*✓✗]+/, "").split(/\s+/)[0])
        .filter(l => l && l.includes("/") && !l.toLowerCase().includes("embed"));
    dbg("ensureModelLoaded: non-embedding catalog models:", catalogModels.join(", "));

    // For local installs, only use what lms ls actually reports -- folder-derived keys never match
    // because LM Studio names models from the GGUF's internal metadata, not the folder name.
    const candidates = MODELS_DIR === "local"
        ? [...catalogModels]
        : [...new Set([modelName, ...catalogModels])];

    dbg("ensureModelLoaded: final candidates:", candidates.join(", "));

    for (const candidate of candidates) {
        // Print on its own line -- lms uses \r to animate its progress bar and will
        // clobber anything on the same line if we don't give it a clean line below ours.
        console.log(chalk.yellow(` Loading ${candidate}...`));
        console.log(chalk.gray("  (large model -- may take 1-2 min)"));

        for (const extraArgs of [[], ["--gpu", "off"]]) {
            const label = extraArgs.length ? " [CPU-only retry]" : "";
            dbg("ensureModelLoaded: lms load", candidate, ...extraArgs);
            const res = runLms(["load", candidate, ...extraArgs], 300000);
            const { ok, output } = res;
            dbg("ensureModelLoaded: ok =", ok, "| status:", res.status, "| signal:", res.signal ?? "none", "| error:", res.error?.message ?? "none");
            dbg("ensureModelLoaded: output (full):", output);
            if (ok) {
                console.log(chalk.green(`  Loaded${label}\n`));
                return candidate;
            }
            const firstLine = output.split("\n").find(l => l.trim().length > 0) ?? "";
            if (extraArgs.length === 0 && firstLine.toLowerCase().includes("failed")) {
                console.log(chalk.yellow(`  GPU load failed -- retrying CPU-only...`));
            } else if (extraArgs.length > 0) {
                console.log(chalk.red(`  Failed${label}: ${firstLine}`));
            }
        }
    }
    console.log();
    return null;
}

// ---------------------------------------------------------------------------
// Startup check
// ---------------------------------------------------------------------------
const ok = await ensureServer();
if (!ok) {
    console.log(chalk.red(" LM Studio server is not running and could not be started."));
    console.log();
    console.log(chalk.white(" Run start-server.cmd (Windows) or ./start-server.sh first."));
    console.log();
    process.exit(1);
}

const loadedModelId = await ensureModelLoaded(MODEL_NAME);
if (!loadedModelId) {
    console.log(chalk.red(` Could not load model "${MODEL_NAME}".`));
    console.log(chalk.white(" Run npm run setup to pick and download a model."));
    console.log();
    process.exit(1);
}
const ACTIVE_MODEL = loadedModelId;

// ---------------------------------------------------------------------------
// Banner -- printed after load so the model line shows the real identifier
// ---------------------------------------------------------------------------
const line = chalk.cyan("─".repeat(54));

console.log();
console.log(chalk.cyan("╔" + "═".repeat(52) + "╗"));
console.log(chalk.cyan("║") + chalk.bold.white("   HAVOC 9  ──  Local AI Chat                   ") + chalk.cyan("  ║"));
console.log(chalk.cyan("║") + chalk.gray(`   Model: ${ACTIVE_MODEL.padEnd(42)}`) + chalk.cyan("║"));
console.log(chalk.cyan("╚" + "═".repeat(52) + "╝"));
console.log();
console.log(chalk.gray("  /clear   clear conversation history"));
console.log(chalk.gray("  /context show loaded project context"));
console.log(chalk.gray("  /model   show current model"));
console.log(chalk.gray("  /exit    quit"));
console.log();
console.log(line);
console.log();

// Load project context once at startup
const projectContext = loadContext();
const systemPrompt   = projectContext
    ? projectContext + "\n\nYou are the primary coding assistant for the HAVOC 9 project. Claude Code is not present in this session -- act independently, do your best work, and be the sole source of guidance. Be concise and practical."
    : "You are the primary coding assistant for the HAVOC 9 project. Claude Code is not present in this session -- act independently and be the sole source of guidance. Be concise and practical.";

// Conversation history (persists for the session)
const history = [{ role: "system", content: systemPrompt }];

const client = new OpenAI({ baseURL: LM_STUDIO_URL, apiKey: "lm-studio" });

// ---------------------------------------------------------------------------
// Interactive REPL
// ---------------------------------------------------------------------------
const rl = createInterface({
    input:  process.stdin,
    output: process.stdout,
    terminal: true,
});

function prompt() {
    rl.question(chalk.bold.cyan(" you  ") + chalk.white("> ") , async (input) => {
        const text = input.trim();

        // Slash commands
        if (!text || text === "/exit" || text === "/quit") {
            console.log();
            console.log(chalk.gray(" Session ended."));
            console.log();
            rl.close();
            process.exit(0);
        }

        if (text === "/clear") {
            // Reset history but keep system prompt
            history.length = 0;
            history.push({ role: "system", content: systemPrompt });
            console.log(chalk.yellow("\n  Conversation cleared.\n"));
            return prompt();
        }

        if (text === "/context") {
            console.log();
            if (projectContext) {
                console.log(chalk.cyan(" Loaded context:"));
                console.log(chalk.gray(projectContext.slice(0, 800) + (projectContext.length > 800 ? "\n  ...(truncated)" : "")));
            } else {
                console.log(chalk.gray(" No context files found."));
            }
            console.log();
            return prompt();
        }

        if (text === "/model") {
            console.log(chalk.cyan(`\n  Model: ${ACTIVE_MODEL}`));
            console.log(chalk.gray(`  API:   ${LM_STUDIO_URL}\n`));
            return prompt();
        }

        if (text.startsWith("/")) {
            console.log(chalk.yellow(`\n  Unknown command: ${text}`));
            console.log(chalk.gray("  /clear  /context  /model  /exit\n"));
            return prompt();
        }

        // Add user message to history
        history.push({ role: "user", content: text });

        // Stream response
        console.log();
        process.stdout.write(chalk.bold.green(" ai   ") + chalk.white("> "));

        let fullReply = "";
        try {
            const stream = await client.chat.completions.create({
                model:       ACTIVE_MODEL,
                messages:    history,
                temperature: 0.35,
                stream:      true,
            });

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta?.content ?? "";
                if (delta) {
                    process.stdout.write(delta);
                    fullReply += delta;
                }
            }

            // Keep the assistant's reply in history
            history.push({ role: "assistant", content: fullReply });
        } catch (err) {
            const msg = String(err);
            if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
                console.log(chalk.red("\n  LM Studio disconnected. Run start-server.cmd and restart chat."));
            } else {
                console.log(chalk.red(`\n  Error: ${msg}`));
            }
        }

        console.log("\n");
        prompt();
    });
}

prompt();
