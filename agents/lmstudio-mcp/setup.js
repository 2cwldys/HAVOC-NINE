#!/usr/bin/env node
import chalk                         from "chalk";
import { select, input, confirm }    from "@inquirer/prompts";
import {
    writeFileSync, existsSync, readFileSync,
    readdirSync, statSync, mkdirSync, rmSync,
} from "fs";
import { fileURLToPath }             from "url";
import { dirname, join }             from "path";
import { execSync, spawnSync }       from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const line = chalk.cyan(" " + "═".repeat(50));

// Paths for both supported model locations
const NATIVE_MODELS_DIR = process.platform === "win32"
    ? join(process.env.USERPROFILE ?? "", ".lmstudio", "models")
    : join(process.env.HOME        ?? "", ".lmstudio", "models");
const LOCAL_MODELS_DIR  = join(__dirname, "models");
const LMS_SETTINGS_PATH = process.platform === "win32"
    ? join(process.env.USERPROFILE ?? "", ".lmstudio", "settings.json")
    : join(process.env.HOME        ?? "", ".lmstudio", "settings.json");

// Redirect (or restore) LM Studio's downloadsFolder in settings.json.
// Returns the previous value so callers can log it.
function setLmsDownloadsFolder(dir) {
    try {
        const s = JSON.parse(readFileSync(LMS_SETTINGS_PATH, "utf8"));
        s.downloadsFolder = dir;
        writeFileSync(LMS_SETTINGS_PATH, JSON.stringify(s, null, 2));
        return true;
    } catch { return false; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function killLlmster() {
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/IM", "llmster.exe"], { stdio: "ignore", shell: true });
    } else {
        spawnSync("pkill", ["-9", "-x", "llmster"], { stdio: "ignore", shell: true });
    }
}

function lmInternalDir() {
    if (process.platform === "win32")  return join(process.env.USERPROFILE ?? "", ".lmstudio", ".internal");
    if (process.platform === "darwin") return join(process.env.HOME ?? "", "Library", "Application Support", "LM Studio", ".internal");
    return join(process.env.HOME ?? "", ".lmstudio", ".internal");
}

// Returns true if any LM Studio download job file contains a reference to wrongDir.
// Pass the directory that should NOT be in the job files (the old/unwanted location).
// Works in both directions: local→native and native→local switches.
function checkForStaleJobs(wrongDir) {
    const internalDir = lmInternalDir();
    // In JSON files, Windows backslashes are escaped as \\
    const needle = wrongDir.replace(/\\/g, "\\\\");
    for (const name of ["download-jobs-info.json", "single-downloads-info.json"]) {
        try {
            const text = readFileSync(join(internalDir, name), "utf8");
            if (text.includes(needle) || text.includes(wrongDir)) return true;
        } catch {}
    }
    return false;
}

// Clear LM Studio's in-progress download job records so llmster doesn't
// auto-resume stale jobs pointing to the wrong directory on next start.
// Cleans .part files from BOTH dirs to handle switches in either direction.
// MUST be called after killLlmster() so the files are no longer locked.
function clearStaleDownloadJobs() {
    const internalDir = lmInternalDir();
    for (const name of ["download-jobs-info.json", "single-downloads-info.json"]) {
        try {
            const p = join(internalDir, name);
            if (existsSync(p)) writeFileSync(p, "{}");
        } catch {}
    }
    // Delete .part files from both dirs -- handles switches in either direction
    for (const dir of [NATIVE_MODELS_DIR, LOCAL_MODELS_DIR]) {
        try {
            for (const pub of readdirSync(dir)) {
                const pubDir = join(dir, pub);
                try {
                    if (!statSync(pubDir).isDirectory()) continue;
                    for (const model of readdirSync(pubDir)) {
                        const modelDir = join(pubDir, model);
                        try {
                            if (!statSync(modelDir).isDirectory()) continue;
                            for (const f of readdirSync(modelDir)) {
                                if (f.endsWith(".part")) {
                                    try { rmSync(join(modelDir, f), { force: true }); } catch {}
                                }
                            }
                        } catch {}
                    }
                } catch {}
            }
        } catch {}
    }
}

function isEmbedding(id = "") {
    return /embed(ding)?|rerank|encoder|nomic-embed|bge-|e5-|gte-|all-mini/i.test(id);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatGB(val) {
    if (val == null) return "";
    if (typeof val === "string") {
        const m = val.match(/(\d+\.?\d*)\s*[GgMm][Bb]/);
        if (m) return val.replace(/\s+GB/i, " GB");
        return val;
    }
    if (typeof val === "number") {
        if (val >= 1e9)  return `${(val / 1e9).toFixed(1)} GB`;
        if (val >= 1e6)  return `${(val / 1e6).toFixed(0)} MB`;
    }
    return String(val);
}

function pad(str, n) { return str.padEnd(n); }

// Walk a 2-level model directory (publisher/model-id/*.gguf).
// Returns [{ id: "publisher/model-id", ggufPath: "/abs/path/file.gguf" }].
function scanModelsDir(dir) {
    if (!existsSync(dir)) return [];
    const results = [];
    for (const pub of readdirSync(dir)) {
        const pubDir = join(dir, pub);
        try { if (!statSync(pubDir).isDirectory()) continue; } catch { continue; }
        for (const modelId of readdirSync(pubDir)) {
            const modelDir = join(pubDir, modelId);
            try { if (!statSync(modelDir).isDirectory()) continue; } catch { continue; }
            for (const f of readdirSync(modelDir)) {
                if (f.endsWith(".gguf"))
                    results.push({ id: `${pub}/${modelId}`, ggufPath: join(modelDir, f) });
            }
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Catalog fetch -- live from lmstudio.ai/models?sort=stars
// Falls back to a hardcoded list built from the same page.
// ---------------------------------------------------------------------------

const FALLBACK_CATALOG = [
    { id: "gemma-4",         stars: 10, note: "Google  Gemma 4          5B-31B"  },
    { id: "qwen3",           stars: 6,  note: "Qwen    Qwen3            4B-235B" },
    { id: "deepseek-r1",     stars: 6,  note: "DeepSeek R1             7B-70B"  },
    { id: "ministral",       stars: 6,  note: "Mistral Ministral       3B-14B"  },
    { id: "gemma-3",         stars: 5,  note: "Google  Gemma 3         1B-27B"  },
    { id: "phi-4-reasoning", stars: 3,  note: "MS      Phi-4 Reasoning 3.8B-14B"},
    { id: "phi-4",           stars: 2,  note: "MS      Phi-4           3B-14B"  },
    { id: "qwen3-coder",     stars: 2,  note: "Qwen    Qwen3 Coder     30B+"    },
    { id: "gemma-3n",        stars: 2,  note: "Google  Gemma 3n        4.5B-7B" },
];

function extractFromNextData(obj, isVariant, depth = 0) {
    if (depth > 12 || obj === null || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
        if (obj.length >= 2 && isVariant(obj[0])) return obj;
        for (const item of obj) {
            const found = extractFromNextData(item, isVariant, depth + 1);
            if (found) return found;
        }
        return null;
    }
    for (const val of Object.values(obj)) {
        const found = extractFromNextData(val, isVariant, depth + 1);
        if (found) return found;
    }
    return null;
}

async function fetchCatalogModels() {
    try {
        const res = await fetch("https://lmstudio.ai/models?sort=stars", {
            signal: AbortSignal.timeout(8000),
            headers: { "User-Agent": "Mozilla/5.0 (compatible; lmstudio-mcp-setup/1.0)" },
        });
        const html = await res.text();
        const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
        if (m) {
            const nd = JSON.parse(m[1]);
            const rows = extractFromNextData(nd, o =>
                typeof o?.id === "string" && typeof o?.stars === "number"
            );
            if (rows?.length >= 3) return rows.sort((a, b) => b.stars - a.stars);
        }
    } catch {}
    return FALLBACK_CATALOG;
}

// ---------------------------------------------------------------------------
// Model variant fetch -- live from lmstudio.ai/models/<familyId>
// Returns [{id, fileSize}] sorted by fileSize ascending, or null on failure.
// ---------------------------------------------------------------------------

function parseSizeBytes(s) {
    if (!s) return 0;
    const m = String(s).match(/([\d.]+)\s*GB/i);
    return m ? parseFloat(m[1]) * 1e9 : 0;
}

async function fetchModelVariants(familyId) {
    let html;
    try {
        const res = await fetch(`https://lmstudio.ai/models/${familyId}`, {
            signal: AbortSignal.timeout(10000),
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        });
        html = await res.text();
    } catch { return null; }

    const seen   = new Map();
    const ID_PAT = /\b([a-z][a-z0-9-]+\/[a-z][a-z0-9._-]+)\b/g;

    // Strategy 1: JSON blobs in <script> tags -- forward-only context to avoid
    // picking up the previous entry's fileSize via a backward lookback window.
    for (const scriptM of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
        const src = scriptM[1];
        if (!src.includes("/")) continue;
        for (const idM of src.matchAll(/"id"\s*:\s*"([a-z][a-z0-9-]+\/[a-z][a-z0-9._-]+)"/g)) {
            const id  = idM[1];
            if (seen.has(id)) continue;
            const ctx = src.slice(idM.index, idM.index + 400);
            const fsM = ctx.match(/"fileSize"\s*:\s*"?([\d.]+\s*GB)"?/i)
                     || ctx.match(/"size"\s*:\s*"?([\d.]+\s*GB)"?/i)
                     || ctx.match(/([\d]+\.[\d]+)\s*GB|([\d]+)\s*GB/i);
            const size = fsM ? (fsM[1] || `${fsM[2] || fsM[3]} GB`) : null;
            seen.set(id, { id, fileSize: size ? size.replace(/\s+/, " ") : null });
        }
    }

    // Strategy 2: Visible text after stripping tags -- fills missing sizes too
    {
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&[a-z]+;/gi, " ")
            .replace(/\s+/g, " ");

        for (const idM of text.matchAll(ID_PAT)) {
            const id = idM[1];
            if (/\.(js|css|png|svg|woff|ico|json)$/.test(id)) continue;
            const existing = seen.get(id);
            if (existing?.fileSize) continue;
            const ctx   = text.slice(idM.index, idM.index + 300);
            const sizeM = ctx.match(/([\d]+\.[\d]+)\s*GB|([\d]+)\s*GB/i);
            const size  = sizeM ? `${(sizeM[1] || sizeM[2]).trim()} GB` : null;
            if (existing) { existing.fileSize = size; }
            else          { seen.set(id, { id, fileSize: size }); }
        }
    }

    if (seen.size === 0) return null;

    const variants = [...seen.values()].filter(v =>
        /^[a-z][a-z0-9-]+\/[a-z][a-z0-9._-]+$/.test(v.id)
    );
    return variants.sort((a, b) => parseSizeBytes(a.fileSize) - parseSizeBytes(b.fileSize));
}

// ---------------------------------------------------------------------------
// LM Studio local API -- returns downloaded chat model IDs.
// Also auto-imports any .gguf files found in LOCAL_MODELS_DIR.
// ---------------------------------------------------------------------------

async function queryModels() {
    let models = [];
    try {
        const r = await fetch("http://localhost:1234/api/v0/models", { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        const list = Array.isArray(j) ? j : (j?.data ?? []);
        if (list.length > 0 && "type" in list[0]) {
            models = list.filter(m => m.type === "llm").map(m => m.id);
        }
    } catch {}

    if (models.length === 0) {
        try {
            const r = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(5000) });
            const j = await r.json();
            models = (j?.data ?? []).map(m => m.id).filter(id => !isEmbedding(id));
        } catch {}
    }

    // Auto-import any local .gguf files LM Studio doesn't know yet (silent, best-effort)
    const known    = new Set(models);
    let   imported = false;
    for (const m of scanModelsDir(LOCAL_MODELS_DIR)) {
        if (!known.has(m.id)) {
            spawnSync("lms", ["import", m.ggufPath], { stdio: "ignore", shell: true });
            imported = true;
        }
    }
    // Re-query so newly imported models appear in the list
    if (imported) {
        try {
            const r = await fetch("http://localhost:1234/api/v0/models", { signal: AbortSignal.timeout(5000) });
            const j = await r.json();
            const list = Array.isArray(j) ? j : (j?.data ?? []);
            if (list.length > 0 && "type" in list[0]) {
                models = list.filter(m => m.type === "llm").map(m => m.id);
            }
        } catch {}
    }

    return models;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------
console.log();
console.log(line);
console.log(chalk.cyan(" ║") + chalk.bold.white("   HAVOC 9  ──  LM Studio Agent Setup         ") + chalk.cyan("  ║"));
console.log(chalk.cyan(" ║") + chalk.gray("   Pairs your local AI with Claude Code         ") + chalk.cyan("║"));
console.log(line);
console.log();

// ---------------------------------------------------------------------------
// Step 1 -- LM Studio CLI check + auto-start server
// ---------------------------------------------------------------------------
console.log(chalk.bold.white(" Step 1  ─  Checking LM Studio"));
console.log();

let hasLmsCLI = false;
try { execSync("lms --version", { stdio: "ignore" }); hasLmsCLI = true; } catch {}

console.log(hasLmsCLI
    ? chalk.green("   OK   ") + "lms CLI found"
    : chalk.yellow("   !!   ") + "lms CLI not found -- run install.cmd / install.sh first");

let serverRunning = false;
try {
    await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(2000) });
    serverRunning = true;
    console.log(chalk.green("   OK   ") + "LM Studio server is running");
} catch {
    if (hasLmsCLI) {
        console.log(chalk.gray("          Starting LM Studio server..."));
        spawnSync("lms", ["server", "start", "--port", "1234"], { stdio: "ignore", shell: true });
        await sleep(3000);
        try {
            await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(3000) });
            serverRunning = true;
            console.log(chalk.green("   OK   ") + "LM Studio server started");
        } catch {
            console.log(chalk.yellow("   !!   ") + "Server did not respond -- model list may be incomplete");
        }
    } else {
        console.log(chalk.yellow("   !!   ") + "Server not running -- start with start-server.cmd");
    }
}

// ---------------------------------------------------------------------------
// Step 2 -- Check already-downloaded models (both native + local dirs)
// ---------------------------------------------------------------------------
console.log();
console.log(chalk.bold.white(" Step 2  ─  Select your model"));
console.log();

let models = await queryModels();
let chosenModel;

// Read saved preferences from .env
let modelsDir = null; // null = not yet configured (will prompt below)
{
    let envText = "";
    if (existsSync(join(__dirname, ".env"))) {
        try { envText = readFileSync(join(__dirname, ".env"), "utf8"); } catch {}
    }
    const savedDir   = (envText.match(/^MODELS_DIR=(.+)$/m)   ?? [])[1]?.trim();
    const savedModel = (envText.match(/^MODEL_NAME=(.+)$/m)   ?? [])[1]?.trim();
    if (savedDir)  modelsDir = savedDir;

    // Keep settings.json in sync with the saved preference so switching modes
    // always corrects LM Studio's downloadsFolder -- no manual fixup needed.
    // Also clears stale download-job records that have hardcoded C: paths:
    // llmster auto-resumes those on startup and ignores settings.json for resumed jobs.
    if (modelsDir === "local" || modelsDir === "native") {
        const wantedFolder = modelsDir === "local" ? LOCAL_MODELS_DIR : NATIVE_MODELS_DIR;
        let currentFolder = null;
        try {
            currentFolder = JSON.parse(readFileSync(LMS_SETTINGS_PATH, "utf8")).downloadsFolder ?? null;
        } catch {}
        const wrongFolder         = modelsDir === "local" ? NATIVE_MODELS_DIR : LOCAL_MODELS_DIR;
        const needsSettingsUpdate = currentFolder !== wantedFolder;
        const hasStaleJobs        = checkForStaleJobs(wrongFolder);
        if (needsSettingsUpdate || hasStaleJobs) {
            killLlmster();
            await sleep(500);
            clearStaleDownloadJobs();
            if (needsSettingsUpdate) setLmsDownloadsFolder(wantedFolder);
            spawnSync("lms", ["server", "start", "--port", "1234"], { stdio: "ignore", shell: true });
            if (hasStaleJobs) {
                console.log(chalk.green("   OK   ") + "Cleared stale download jobs (were pointing to wrong dir).");
            }
        }
    }

    // Warn if .env references a model that can't be found
    if (models.length === 0 && savedModel) {
        console.log(chalk.yellow("   !!   ") + `.env has MODEL_NAME=${chalk.bold(savedModel)}`);
        console.log(chalk.gray("          but that model isn't found on this machine."));
        console.log(chalk.gray("          The download flow below will fix this and update .env."));
        console.log();
    }
}

// ---------------------------------------------------------------------------
// Step 3 -- Download flow: location → catalog → family → variant → lms get
// ---------------------------------------------------------------------------
if (models.length === 0) {
    console.log(chalk.yellow("   !!   ") + "No chat models downloaded yet -- let's get one.");
    console.log();

    // ── 3a-3c. Location → Family → Variant (loop supports going back) ──────────
    // Fetch the catalog once up front so navigating back doesn't re-fetch.
    process.stdout.write(chalk.gray("          Fetching model catalog from lmstudio.ai... "));
    const catalog = await fetchCatalogModels();
    const isLive  = catalog !== FALLBACK_CATALOG;
    console.log(isLive ? chalk.green("live") : chalk.gray("offline fallback"));
    console.log();

    let downloadId;

    while (!downloadId) {
        // ── 3a. Storage location ───────────────────────────────────────────────
        if (modelsDir === null) {
            console.log(chalk.gray(`         Native dir:  ${NATIVE_MODELS_DIR}`));
            console.log(chalk.gray(`         Local dir:   ${LOCAL_MODELS_DIR}`));
            console.log();
            modelsDir = await select({
                message: "Where should downloaded models be stored?",
                choices: [
                    {
                        name:        "Native  -- default LM Studio directory (usually on C:)",
                        value:       "native",
                        description: NATIVE_MODELS_DIR,
                    },
                    {
                        name:        "Local   -- agents/lmstudio-mcp/models/  (git repo, saves C: space)",
                        value:       "local",
                        description: LOCAL_MODELS_DIR,
                    },
                ],
            });
            console.log();
            if (modelsDir === "local") {
                console.log(chalk.cyan("   >>   ") + "Local mode: model will be downloaded directly to the git repo.");
                console.log(chalk.gray("          LM Studio's download folder will be redirected to agents/lmstudio-mcp/models/"));
                console.log(chalk.gray("          No C: space used at all."));
                console.log();
            }
        } else {
            console.log(chalk.gray(`          Models dir: ${modelsDir === "local" ? "local (agents/lmstudio-mcp/models/)" : "native (~/.lmstudio/models/)"}`));
            console.log();
        }

        // ── 3b. Model family ───────────────────────────────────────────────────
        const MAX_SHOW = 8;
        const topModels = catalog.slice(0, MAX_SHOW);

        const familyChoices = [
            ...topModels.map(m => {
                const stars  = "★".repeat(Math.min(m.stars, 5)) + (m.stars > 5 ? `+${m.stars - 5}` : "");
                const starsP = chalk.yellow(stars.padEnd(7));
                return {
                    name: `${starsP} ${pad(m.id, 20)} ${chalk.gray(m.note || "")}`,
                    value: m.id,
                };
            }),
            { name: chalk.gray("Enter a model ID manually..."), value: "__manual__" },
            { name: chalk.gray("← Change storage location"),    value: "__back_location__" },
        ];

        const familyId = await select({
            message: "Which model family?",
            choices: familyChoices,
        }) ?? "__manual__";

        if (familyId === "__back_location__") {
            modelsDir = null;  // force location to be re-asked
            continue;
        }

        let resolvedFamilyId = familyId;
        if (familyId === "__manual__") {
            resolvedFamilyId = await input({ message: "Model family ID (e.g. gemma-4, qwen3):", default: "gemma-4" });
        }

        // ── 3c. Variants for chosen family ────────────────────────────────────
        console.log();
        process.stdout.write(chalk.gray(`          Fetching variants for ${resolvedFamilyId}... `));
        const variants = await fetchModelVariants(resolvedFamilyId);

        if (variants && variants.length > 0) {
            console.log(chalk.green(`${variants.length} found`));
            console.log();

            const variantChoices = variants.map(v => {
                const sizeStr = formatGB(v.fileSize);
                const col1    = pad(v.id, 42);
                const col2    = sizeStr ? chalk.cyan(pad(sizeStr, 10)) : "          ";
                return { name: `${col1} ${col2}`, value: v.id };
            });
            variantChoices.push({ name: chalk.gray("Enter a model ID manually..."), value: "__manual_variant__" });
            variantChoices.push({ name: chalk.gray("← Back to model families"),     value: "__back_family__" });

            const selected = await select({
                message: `Which variant of ${resolvedFamilyId}?`,
                choices: variantChoices,
            });

            if (selected === "__back_family__") { console.log(); continue; }

            downloadId = selected === "__manual_variant__"
                ? await input({ message: "Full model ID (e.g. google/gemma-4-e4b):", default: resolvedFamilyId })
                : selected;
        } else {
            console.log(chalk.yellow("could not parse variants from page"));
            console.log();
            console.log(chalk.gray(`         Open https://lmstudio.ai/models/${resolvedFamilyId} to find the`));
            console.log(chalk.gray("         exact model ID (e.g. google/gemma-4-e4b) then enter it below."));
            console.log();
            downloadId = await input({
                message: "Model ID to download (or leave blank to go back):",
                default: "",
            });
            if (!downloadId.trim()) { downloadId = undefined; console.log(); continue; }
        }
    }

    // ── 3d. Run lms get ────────────────────────────────────────────────────────
    if (!hasLmsCLI) {
        console.log();
        console.log(chalk.red("   ✗    ") + "lms CLI not found -- cannot download automatically.");
        console.log(chalk.gray("         Run install.cmd first, then re-run: npm run setup"));
        process.exit(1);
    }

    const modelsBefore   = new Set(await queryModels());
    const localSnapshot  = scanModelsDir(LOCAL_MODELS_DIR);
    const getArg         = downloadId;

    console.log();
    const go = await confirm({
        message: `Start download of ${chalk.bold(getArg)}?`,
        default: true,
    });
    if (!go) {
        console.log(chalk.yellow("   --   ") + "Download cancelled.");
        process.exit(0);
    }

    // For local mode: redirect LM Studio's downloadsFolder so lms get writes
    // directly to agents/lmstudio-mcp/models/ -- no C: space used at all.
    if (modelsDir === "local") {
        console.log();
        console.log(chalk.cyan("   >>   ") + "Local mode requires updating LM Studio's model directory setting.");
        console.log(chalk.gray(`          This will change  settings.json  "downloadsFolder"  to:`));
        console.log(chalk.white("          " + LOCAL_MODELS_DIR));
        console.log(chalk.gray("          LM Studio's model browser will point here from now on."));
        console.log();
        const okSettings = await confirm({
            message: "Update LM Studio settings.json now?",
            default: true,
        });
        if (!okSettings) {
            console.log(chalk.yellow("   --   ") + "Skipped. Download will go to native dir instead.");
            modelsDir = "native";
        } else {
            // Kill llmster so the job files are unlocked -- then clear them so it
            // doesn't auto-resume stale C: paths on next start, regardless of
            // what settings.json says.
            killLlmster();
            await sleep(500);
            clearStaleDownloadJobs();
            mkdirSync(LOCAL_MODELS_DIR, { recursive: true });
            if (setLmsDownloadsFolder(LOCAL_MODELS_DIR)) {
                console.log(chalk.green("   OK   ") + "settings.json updated -- downloads will go to agents/lmstudio-mcp/models/");
                console.log(chalk.green("   OK   ") + "Stale download jobs cleared -- fresh start.");
            } else {
                console.log(chalk.yellow("   !!   ") + "Could not patch settings.json -- download may still go to native dir.");
            }
            // Restart llmster so lms get can connect and creates fresh job records
            // with the correct downloadsFolder path.
            spawnSync("lms", ["server", "start", "--port", "1234"], { stdio: "ignore", shell: true });
            await sleep(2000);
        }
    }

    console.log();
    console.log(chalk.gray("         (First download can take several minutes -- that is normal.)"));
    console.log();

    const dl = spawnSync("lms", ["get", getArg, "-y"], { stdio: "inherit", shell: true });

    if (dl.status !== 0) {
        console.log();
        console.log(chalk.red("   ✗    ") + "Download failed or was cancelled.");
        console.log(chalk.gray("         Check your connection and try again."));
        console.log(chalk.gray("         Or open LM Studio → Discover tab, download manually, then re-run: npm run setup"));
        // Restore native downloads folder if we changed it
        if (modelsDir === "local") setLmsDownloadsFolder(NATIVE_MODELS_DIR);
        process.exit(1);
    }

    // ── 3e. Post-download: verify + restart server ───────────────────────────
    if (modelsDir === "local") {
        const localNow    = scanModelsDir(LOCAL_MODELS_DIR);
        const snapshotIds = new Set(localSnapshot.map(m => m.id));
        const newEntries  = localNow.filter(m => !snapshotIds.has(m.id));

        if (newEntries.length === 0) {
            console.log(chalk.yellow("   !!   ") + "Could not detect new files in agents/lmstudio-mcp/models/.");
            console.log(chalk.gray("          The download may have gone to the native dir -- check:"));
            console.log(chalk.gray("          " + NATIVE_MODELS_DIR));
        } else {
            for (const entry of newEntries) {
                console.log(chalk.green("   OK   ") + `Downloaded to agents/lmstudio-mcp/models/${entry.id}`);
            }
        }

        // Restart server so it reads the updated downloadsFolder
        spawnSync("lms", ["server", "start", "--port", "1234"], { stdio: "ignore", shell: true });
    }

    // ── 3f. Detect which model is now available ──────────────────────────────
    console.log();
    console.log(chalk.green("   OK   ") + "Download complete -- re-scanning...");
    await sleep(1500);
    models = await queryModels();

    const newModel = models.find(id => !modelsBefore.has(id));
    if (newModel) {
        chosenModel = newModel;
        console.log(chalk.green("   OK   ") + `Detected: ${chalk.bold(chosenModel)}`);
    } else {
        chosenModel = downloadId;
        console.log(chalk.yellow("   !!   ") + `Using: ${chosenModel} (API not yet updated)`);
    }
}

// ---------------------------------------------------------------------------
// Step 4 -- If already had models: show picker
// ---------------------------------------------------------------------------
if (!chosenModel) {
    if (models.length > 0) {
        console.log(chalk.green("   OK   ") + `${models.length} chat model(s) available`);
        console.log();
        const choices = [
            ...models.map(m => ({ name: m, value: m })),
            { name: chalk.gray("Enter a model name manually..."), value: "__manual__" },
        ];
        chosenModel = await select({ message: "Which model should the agent use?", choices });
    } else {
        chosenModel = await input({
            message: "Enter model name (saved for when server starts):",
            default: "gemma-4",
        });
    }
}

if (chosenModel === "__manual__") {
    chosenModel = await input({ message: "Model name:", default: "gemma-4" });
}

// Default modelsDir if we never entered the download flow
if (modelsDir === null) modelsDir = "native";

// ---------------------------------------------------------------------------
// Step 5 -- Load model (non-interactive)
// ---------------------------------------------------------------------------
if (serverRunning && hasLmsCLI) {
    console.log();
    console.log(chalk.gray(`         Loading ${chosenModel}...`));
    const r = spawnSync("lms", ["load", chosenModel], {
        input: "\n",
        encoding: "utf8",
        shell: true,
        stdio: ["pipe", "inherit", "ignore"],
    });
    if (r.status === 0) {
        console.log(chalk.green("   OK   ") + "Model loaded and ready");
    } else {
        console.log(chalk.yellow("   !!   ") + "Could not load -- start-server.cmd will retry on next launch");
    }
}

// ---------------------------------------------------------------------------
// Step 6 -- Save to .env
// ---------------------------------------------------------------------------
console.log();
console.log(chalk.bold.white(" Step 6  ─  Saving configuration"));
console.log();

writeFileSync(
    join(__dirname, ".env"),
    `LM_STUDIO_URL=http://localhost:1234/v1\nMODEL_NAME=${chosenModel}\nMODELS_DIR=${modelsDir}\n`
);
console.log(chalk.green("   OK   ") + `.env written  (MODEL_NAME=${chosenModel}, MODELS_DIR=${modelsDir})`);

const settingsPath = join(__dirname, "../../.claude/settings.json");
console.log(existsSync(settingsPath)
    ? chalk.green("   OK   ") + ".claude/settings.json found -- MCP registration in place"
    : chalk.yellow("   !!   ") + ".claude/settings.json not found -- run from inside the repo root");

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log();
console.log(line);
console.log(chalk.bold.green("   Setup complete!"));
console.log();
console.log(chalk.white("   Next: reload VS Code  (Ctrl+Shift+P → Developer: Reload Window)"));
console.log(chalk.gray('   Then type /mcp in Claude Code -- lmstudio should show as connected'));
console.log(chalk.gray('   Test: ask Claude "use lmstudio to say hello"'));
console.log(line);
console.log();
