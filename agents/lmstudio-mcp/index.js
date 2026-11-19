// Guard: fail fast with a readable message if npm install hasn't been run yet
import { existsSync } from "fs";
import { fileURLToPath as _fup } from "url";
import { dirname as _dn, join as _jn } from "path";
const _here = _dn(_fup(import.meta.url));
if (!existsSync(_jn(_here, "node_modules", "@modelcontextprotocol"))) {
    process.stderr.write(
        "[lmstudio-mcp] Dependencies not installed.\n" +
        "Run install.cmd (Windows) or install.sh (Linux/Mac) in agents/lmstudio-mcp/ first.\n"
    );
    process.exit(1);
}

import { McpServer }            from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }                    from "zod";
import OpenAI                   from "openai";
import { readFileSync, writeFileSync, mkdirSync, existsSync as fsExists } from "fs";
import { fileURLToPath }        from "url";
import { dirname, join }        from "path";
import { execSync }             from "child_process";
import { loadRepoContext }      from "./h9context.js";
import { registerH9Tools }      from "./h9tools.js";

// ---------------------------------------------------------------------------
// .env loader -- won't override values already set in environment
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath   = join(__dirname, ".env");
if (fsExists(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq  = t.indexOf("=");
        if (eq === -1) continue;
        const key = t.slice(0, eq).trim();
        const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && process.env[key] === undefined) process.env[key] = val;
    }
}

const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1";
const MODEL_NAME    = process.env.MODEL_NAME    ?? "local-model";

const client = new OpenAI({
    baseURL: LM_STUDIO_URL,
    apiKey:  "lm-studio",
});

// ---------------------------------------------------------------------------
// Shared context: PROJECT.md + SOLUTIONS.md
// Loaded lazily, cached until log_solution invalidates it
// ---------------------------------------------------------------------------
const CONTEXT_DIR = join(__dirname, "context");
let _contextCache = null;

function loadContext() {
    if (_contextCache !== null) return _contextCache;
    const parts = [];
    // H9: the repo's own CONTEXT.md and the head of CLAUDE.md go first, read from where they live
    // rather than copied in here, so there is one set of rules and it cannot drift (h9context.js)
    try {
        const repoContext = loadRepoContext();
        if (repoContext) parts.push(repoContext);
    } catch { /* not inside the repo: the local context files below still work */ }
    try {
        const projectPath   = join(CONTEXT_DIR, "PROJECT.md");
        const memoryPath    = join(CONTEXT_DIR, "MEMORY.md");
        const currentPath   = join(CONTEXT_DIR, "CURRENT.md");
        const solutionsPath = join(CONTEXT_DIR, "SOLUTIONS.md");

        // 1. Codebase overview -- always first
        if (fsExists(projectPath)) {
            parts.push("## Project Context\n" + readFileSync(projectPath, "utf8").trim());
        }
        // H9: where the local model is and is not reliable in this codebase. The Helix original
        // said this file was loaded automatically and no loader ever read it
        if (fsExists(memoryPath)) {
            parts.push("## How far to trust the local model here\n" + readFileSync(memoryPath, "utf8").trim());
        }
        // 2. Current working session -- what's being worked on right now
        if (fsExists(currentPath)) {
            const cur = readFileSync(currentPath, "utf8").trim();
            if (cur.length > 20) {
                parts.push("## Current Working Session\n" + cur);
            }
        }
        // 3. Past solutions -- trim to last ~4000 chars so it doesn't blow the window
        if (fsExists(solutionsPath)) {
            const raw = readFileSync(solutionsPath, "utf8").trim();
            if (raw.length > 100) {
                // 12000, not 4000: the header carries the scope and format rules and sits at the
                // TOP, so a tight tail-trim drops the very guidance the entries are meant to follow
                const trimmed = raw.length > 12000
                    ? "...(earlier entries omitted)\n\n" + raw.slice(-12000)
                    : raw;
                parts.push("## Known Solutions & Past Fixes\n" + trimmed);
            }
        }
    } catch {}
    _contextCache = parts.join("\n\n---\n\n");
    return _contextCache;
}

function invalidateContext() { _contextCache = null; }

// ---------------------------------------------------------------------------
// Auto-start: if the server isn't running, try `lms server start` once
// ---------------------------------------------------------------------------
let _autoStartAttempted = false;

async function ensureServerRunning() {
    try {
        await fetch(`${LM_STUDIO_URL}/models`, { signal: AbortSignal.timeout(2000) });
        return true;
    } catch {
        if (_autoStartAttempted) return false;
        _autoStartAttempted = true;
        try {
            process.stderr.write("[lmstudio-mcp] Server not running -- attempting auto-start via lms CLI...\n");
            execSync("lms server start --port 1234", { timeout: 20000, stdio: "ignore" });
            await new Promise(r => setTimeout(r, 2000));
            await fetch(`${LM_STUDIO_URL}/models`, { signal: AbortSignal.timeout(3000) });
            process.stderr.write("[lmstudio-mcp] Server started successfully.\n");
            _autoStartAttempted = false;
            return true;
        } catch {
            process.stderr.write("[lmstudio-mcp] Auto-start failed -- lms CLI may not be installed.\n");
            return false;
        }
    }
}

function isConnectionError(err) {
    return (
        err?.cause?.code === "ECONNREFUSED" ||
        err?.code        === "ECONNREFUSED" ||
        String(err).includes("ECONNREFUSED") ||
        String(err).includes("fetch failed")
    );
}

const UNREACHABLE_MSG =
    "LM Studio server is not running and could not be auto-started.\n\n" +
    "To fix:\n" +
    "  • Run start-server.cmd (Windows) or ./start-server.sh (Linux/Mac)\n" +
    "  • Or in any terminal: lms server start\n\n" +
    "Then ask Claude to try again.";

function handleError(err) {
    return {
        content: [{
            type: "text",
            text: isConnectionError(err) ? UNREACHABLE_MSG : `LM Studio error: ${String(err)}`
        }]
    };
}

// Build system prompt: project context prefix + caller's own system prompt
function buildSystem(callerSystem) {
    const ctx = loadContext();
    if (!ctx) return callerSystem ?? "";
    return callerSystem ? `${ctx}\n\n---\n\n${callerSystem}` : ctx;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new McpServer({
    name:        "lmstudio",
    version:     "1.0.0",
    description: "Local LM Studio bridge -- routes tool calls to your local AI model",
});

// ---------------------------------------------------------------------------
// Tool: query_local_model
// ---------------------------------------------------------------------------
server.tool(
    "query_local_model",
    "Ask the local LM Studio model a question. " +
    "Good for quick lookups, boilerplate drafts, second opinions, or offline work. " +
    "Project context and past solutions are automatically included -- no need to re-explain the codebase. " +
    "Use this to offload tasks in parallel while handling complex reasoning yourself.",
    {
        prompt: z.string().describe("The question or task for the local model"),
        system: z.string().optional().describe("Optional extra system instructions (project context is already included)"),
    },
    async ({ prompt, system }) => {
        try {
            if (!await ensureServerRunning()) return { content: [{ type: "text", text: UNREACHABLE_MSG }] };
            const messages = [{ role: "system", content: buildSystem(system) }];
            messages.push({ role: "user", content: prompt });

            const res = await client.chat.completions.create({
                model:       MODEL_NAME,
                messages,
                temperature: 0.3,
            });

            return { content: [{ type: "text", text: res.choices[0]?.message?.content ?? "(empty response)" }] };
        } catch (err) {
            return handleError(err);
        }
    }
);

// ---------------------------------------------------------------------------
// Tool: review_code
// ---------------------------------------------------------------------------
server.tool(
    "review_code",
    "Get a focused code review from the local model. " +
    "Catches bugs, logic errors, and unclear code. " +
    "Project context and past solutions are automatically included. " +
    "Specify the language for a better system prompt.",
    {
        code:     z.string().describe("The code snippet to review"),
        language: z.string().optional().describe("Language (e.g. sma, c, powershell, javascript, python)"),
        context:  z.string().optional().describe("Brief description of what the code should do"),
    },
    async ({ code, language, context }) => {
        try {
            if (!await ensureServerRunning()) return { content: [{ type: "text", text: UNREACHABLE_MSG }] };
            const lang       = language ?? "code";
            const reviewRole =
                `You are an expert ${lang} code reviewer for the HAVOC 9 project. ` +
                "Be concise, specific, and actionable. " +
                "Focus on bugs, correctness, and logic. Skip minor style nitpicks.";
            const userMsg =
                `Review this ${lang}${context ? ` (${context})` : ""}:\n\`\`\`${lang}\n${code}\n\`\`\``;

            const res = await client.chat.completions.create({
                model:    MODEL_NAME,
                messages: [
                    { role: "system", content: buildSystem(reviewRole) },
                    { role: "user",   content: userMsg },
                ],
                temperature: 0.1,
            });

            return { content: [{ type: "text", text: res.choices[0]?.message?.content ?? "(empty response)" }] };
        } catch (err) {
            return handleError(err);
        }
    }
);

// ---------------------------------------------------------------------------
// Tool: log_solution
// ---------------------------------------------------------------------------
server.tool(
    "log_solution",
    "Save a genuine insight to the shared solutions database (context/SOLUTIONS.md). " +
    "Save a genuine insight to the shared solutions database (context/SOLUTIONS.md). " +
    "SCOPE: Log it if it has a meaningful connection to this project -- even if the problem came up " +
    "while working on something unrelated, if the solution directly helped with HAVOC 9, " +
    "The Specialists, Xash3D, AMX Mod X or the release pipeline here, it belongs. " +
    "The test is: does knowing this make " +
    "future work on this codebase easier? If yes, log it. " +
    "Do NOT log things that are purely about a different project with no connection to this one -- " +
    "e.g. a React bug fix that has no bearing on anything here. " +
    "Use this for real 'ah-ha' moments: non-obvious behaviors, tricky root causes, things that " +
    "surprised both the developer and the AI -- ESPECIALLY after long, frustrating sessions. " +
    "Entries are read by every AI model on future sessions and committed to git for the whole team.",
    {
        problem:  z.string().describe("1-2 sentences describing the problem as it presented (what was broken/confusing)"),
        solution: z.string().describe("What actually fixed it or what the insight was"),
        tags:     z.string().optional().describe("Comma-separated tags (e.g. 'sma, engine, patch-chain, deploy, cvar')"),
        files:    z.string().optional().describe("Relevant file paths (comma-separated)"),
    },
    async ({ problem, solution, tags, files }) => {
        try {
            mkdirSync(CONTEXT_DIR, { recursive: true });
            const solutionsPath = join(CONTEXT_DIR, "SOLUTIONS.md");

            const timestamp = new Date().toISOString().split("T")[0];
            const tagLine   = tags  ? `\n\n**Tags:** ${tags}`  : "";
            const fileLine  = files ? `\n\n**Files:** ${files}` : "";
            // "--", never an em dash: this repo is ASCII only (CLAUDE.md), and this template is
            // what writes every future entry
            const entry     = `\n\n---\n\n### ${timestamp} -- ${problem}\n\n**Solution:** ${solution}${tagLine}${fileLine}\n`;

            // Always read existing content and append below it -- never overwrite the header
            let existing = "";
            try { existing = readFileSync(solutionsPath, "utf8").trimEnd(); } catch {}
            writeFileSync(solutionsPath, existing + entry, "utf8");
            invalidateContext();

            return {
                content: [{
                    type: "text",
                    text: `Logged to SOLUTIONS.md:\n${entry}\nThis will be included in context for all future AI queries on this project.`
                }]
            };
        } catch (err) {
            return {
                content: [{
                    type: "text",
                    text: `Failed to log solution: ${String(err)}`
                }]
            };
        }
    }
);

// ---------------------------------------------------------------------------
// Tool: update_working_context
// ---------------------------------------------------------------------------
server.tool(
    "update_working_context",
    "Update the working session context file (context/CURRENT.md). " +
    "This file is automatically injected into EVERY local model query -- it keeps the local AI " +
    "oriented on what is currently being worked on without needing to re-explain each time. " +
    "Call this at the start of a new task or when focus shifts to a different area of the codebase. " +
    "The file is local to this machine (gitignored) -- not shared with other contributors. " +
    "Clear it with clear-context.cmd / ./clear-context.sh when starting something unrelated.",
    {
        summary: z.string().describe(
            "2-4 sentences describing: what is being worked on right now, " +
            "which files are involved, and what the goal is"
        ),
    },
    async ({ summary }) => {
        try {
            mkdirSync(CONTEXT_DIR, { recursive: true });
            const currentPath = join(CONTEXT_DIR, "CURRENT.md");
            const timestamp   = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
            const entry       = `\n\n---\n\n_${timestamp}_\n\n${summary}\n`;

            // Read existing content and append below it -- never overwrite previous entries
            let existing = "";
            if (fsExists(currentPath)) {
                existing = readFileSync(currentPath, "utf8").trimEnd();
            }
            // Seed the header on first write
            const base = existing || "# Current Working Context\n_Clear this file with clear-context.cmd / ./clear-context.sh when switching to an unrelated task._";
            writeFileSync(currentPath, base + entry, "utf8");
            invalidateContext();
            return {
                content: [{
                    type: "text",
                    text: `Working context saved (appended). Every local model query will now include:\n\n${summary}`
                }]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Failed to write context: ${String(err)}` }] };
        }
    }
);

// ---------------------------------------------------------------------------
// H9's own tools: the rules for a path, the document that answers a question, and where a cvar,
// plugin, patch or map lives. They answer from the repo's files and never call a model, so they
// cannot invent a rule that does not exist (h9tools.js).
// Model and map work (.mdl, .bsp, .wad, sprites) is SMAK's own MCP server, registered beside this
// one in .claude/settings.json -- not wrapped here.
// ---------------------------------------------------------------------------
registerH9Tools(server, z);

const transport = new StdioServerTransport();
await server.connect(transport);
