// h9tools.js -- MCP tools for working IN this codebase, as opposed to asking a model about it.
//
// These answer from the repo's own files and never call a model, so they cannot invent a rule or a
// cvar that does not exist. That is the whole reason they are here: a 7B local model asked "where do
// engine changes go in HAVOC 9" will produce something fluent and wrong, and the real answer is
// written down in CONTEXT.md, docs\ADD_AN_ENGINE_CHANGE.txt and PATCH_CHANGELOG.md. A tool that
// reads those is worth more than a model that guesses at them.
//
// Model work for the toolkit itself (.mdl, .bsp, .wad, sprites) is NOT here: SMAK ships its own MCP
// server, registered beside this one in .claude/settings.json. See agents/README.md.

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { repoRoot } from "./h9context.js";

const MAX_HITS = 40;
const MAX_CHARS = 6000;

function cut(text, cap = MAX_CHARS) {
    const t = String(text);
    return t.length <= cap ? t : t.slice(0, cap).trimEnd() + "\n\n...(cut: open the file for the rest)";
}

function ok(text) {
    return { content: [{ type: "text", text: cut(text) }] };
}

function noRepo() {
    return ok(
        "This folder is not inside the HAVOC 9 repo (no CONTEXT.md two levels up), so these tools\n" +
        "have nothing to read. They expect to live at <repo>/agents/lmstudio-mcp/."
    );
}

/** Read a text file, or null. Latin-1 so a stray byte in a .sma or a patch never throws. */
function readText(path) {
    try { return readFileSync(path, "latin1"); } catch { return null; }
}

/** Files directly in `dir`, filtered, or [] when the folder is not there. */
function list(dir, keep) {
    try { return readdirSync(dir).filter(keep); } catch { return []; }
}

/** Lines of `path` holding `needle`, case-insensitive, with their 1-based line numbers. */
function grepFile(path, needle, limit = MAX_HITS) {
    const text = readText(path);
    if (text === null) return [];
    const want = needle.toLowerCase();
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < limit; i++) {
        if (lines[i].toLowerCase().includes(want)) out.push({ line: i + 1, text: lines[i].trim() });
    }
    return out;
}

// ---------------------------------------------------------------------------
// h9_rules -- what the rules are for the path you are about to edit
// ---------------------------------------------------------------------------
// Every entry is a real rule with the file that states it. Ordered most specific first; a path can
// match several and they are all returned, because they all apply.
const RULES = [
    {
        when: (p) => p.startsWith("h9xash/"),
        text:
            "H9XASH/ IS GENERATED OUTPUT. Nothing you edit here survives: xash.bat and export.bat write\n" +
            "this folder from the master tree on every build. Edit the master instead --\n" +
            "xash3d-h9-patches/overlay for content, the patches for engine code -- and run xash.bat.\n" +
            "Source: CONTEXT.md, and the header of xash3d-h9-patches/xash.bat.",
    },
    {
        when: (p) => p.startsWith("xash3d-fwgs/"),
        text:
            "THIS IS THE ENGINE, AND IT IS A PATCH CHAIN. xash3d-fwgs is pristine upstream (a submodule)\n" +
            "with H9's patches applied on top, so a change to the working tree is only half the change:\n" +
            "it must also go into xash3d-h9-patches/patches/<name>.patch, and\n" +
            "xash3d-h9-patches/patches/PATCH_CHANGELOG.md needs a dated entry in the SAME turn -- that\n" +
            "file says so itself, and skipping it has already broken a build (see its 2026-10-23 entry).\n" +
            "xash.bat reverse-checks every patch on every build, so a tree and a patch that disagree fail\n" +
            "the next one. Procedure: docs/ADD_AN_ENGINE_CHANGE.txt. Health: tools/chain.cmd doctor.",
    },
    {
        when: (p) => p.includes("xash3d-h9-patches/patches/") && p.endsWith(".patch"),
        text:
            "A TRACKED PATCH. PATCH_CHANGELOG.md in this folder is required reading and required editing:\n" +
            "add a dated entry in the same turn you touch a patch. Prove the result with\n" +
            "tools/chain.cmd check --all, and remember xash.bat's apply order is its own list, not this\n" +
            "folder's alphabet. Also: the :dllpatch description line in xash.bat is within ~30 characters\n" +
            "of cmd's 8,191-character limit, so a NEW patch name may not fit -- check before naming one.",
    },
    {
        when: (p) => p.endsWith(".sma") || p.endsWith(".inc"),
        text:
            "AMX MOD X PAWN. Build with build.bat, never by hand, and build ONLY what changed: amxxpc is\n" +
            "not deterministic, so recompiling an unchanged plugin still gives it a new hash and the\n" +
            "official preset list then names files no server is running (docs/SHIP_A_VERSION.txt).\n" +
            "A new command or cvar belongs in docs/COMMANDS.txt and CVARS.md in the same change.\n" +
            "Pawn is not C: no pointers, no malloc, fixed-size arrays, and strings are cells.",
    },
    {
        when: (p) => p.startsWith("rets/"),
        text:
            "reTS -- the game and client DLL source (mp.dll, client.dll). reTS/scripts/\n" +
            "build-win32-dropin.ps1 OVERWRITES client.dll.patch and mp.dll.patch with old release notes:\n" +
            "save those notes somewhere first and restore them after. ship.ps1 does NOT build reTS, it\n" +
            "only compares the master's tree with the git copy's, so build this by hand before shipping.",
    },
    {
        when: (p) => p.startsWith("h9web/") || p.startsWith("havoc9.org/"),
        text:
            "THE SITE. export.bat does not carry h9web or havoc9.org between the trees, so these are\n" +
            "edited where they live. A site change is not a release and must not move the join gate:\n" +
            "deliver it with packaging.site-only.ini, which sets bump = never and sends nothing else.",
    },
    {
        when: (p) => p.startsWith("tools/"),
        text:
            "MIRRORED FROM THE MASTER TREE. export.bat copies tools/ from D:/Downloads/TSM into this\n" +
            "repo, so an edit made here is overwritten by the next export. Edit the master's copy.",
    },
    {
        when: (p) => p.startsWith("apollo-rp/"),
        text:
            "APOLLO RP, as H9 builds it. Every H9 change to it is recorded in apollo-rp/ORIGIN.txt with\n" +
            "its own H9-*.patch diff; add yours there. docs/APOLLO_RP.txt is what a player sees.",
    },
    {
        when: (p) => basename(p).startsWith("packaging") && p.endsWith(".ini"),
        text:
            "A PACKAGING SWITCH FILE. Read its header before changing a value: several switches only make\n" +
            "sense in pairs ([package] make with [deploy] site and webclient), and [ship] bump decides\n" +
            "whether the join gate moves and every player is asked to update. packaging.ini is the\n" +
            "ordinary release; site-only, engine-inplace and mod-inplace each explain their own case.",
    },
    {
        when: (p) => /^(smak|strippercs2|sdhlt|es|bat2exe|hyperframes|entmod4\/uchmviewer)\//.test(p),
        text:
            "A GIT SUBMODULE. A change here does not belong in a commit to this repo: it belongs upstream\n" +
            "in that project. See .gitmodules. A clone without --recurse-submodules has these empty,\n" +
            "which is a common cause of 'the tool is missing' rather than a real fault.",
    },
];

const ALWAYS =
    "Always, anywhere in this repo:\n" +
    "  - ASCII only in files and in commands. A non-ASCII character has broken tool calls here before.\n" +
    "  - Most files are CRLF. Edit them with an exact byte replace; sed -i rewrites the whole file to LF.\n" +
    "  - One heavy job at a time: builds take D:/temp/HEAVY-JOB.lock. Never create that file by hand.\n" +
    "  - Never commit, branch or push unless you were asked to. No Co-Authored-By lines, ever.\n" +
    "  - CLAUDE.md in the repo root is the full set of working rules; CONTEXT.md is the map.";

function toolRules(server, z) {
    server.tool(
        "h9_rules",
        "The rules that apply to a path in the HAVOC 9 repo, before you edit it. Answered from the " +
        "repo's own files, not from a model, so it cannot invent one. Ask this FIRST when you are " +
        "about to change anything under H9XASH, xash3d-fwgs, the patches, a .sma, reTS, the site or " +
        "a packaging ini -- those are the places where an edit in the obvious spot is the wrong edit.",
        {
            path: z.string().describe("A repo-relative path, e.g. 'xash3d-fwgs/engine/client/cl_main.c' or 'ts_matchmode.sma'"),
        },
        async ({ path }) => {
            const p = String(path).replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
            const hit = RULES.filter((r) => r.when(p)).map((r) => r.text);
            const head = hit.length
                ? `Rules for ${path}:\n\n` + hit.join("\n\n")
                : `No special rule is recorded for ${path}. It is an ordinary file in the repo.`;
            return ok(head + "\n\n" + ALWAYS);
        }
    );
}

// ---------------------------------------------------------------------------
// h9_doc -- find the document that answers a question, and read it
// ---------------------------------------------------------------------------
// Keyword to document. The point is to land on the ONE file that answers a question instead of
// grepping 67 of them; everything not listed falls back to a filename match.
const TOPICS = {
    release: ["docs/SHIP_A_VERSION.txt", "docs/H9_RELEASE.txt"],
    ship: ["docs/SHIP_A_VERSION.txt"],
    deploy: ["docs/SHIP_A_VERSION.txt", "docs/DEPLOY_CLOUDFLARE.txt"],
    version: ["docs/H9_RELEASE.txt", "docs/SHIP_A_VERSION.txt"],
    gate: ["docs/H9_RELEASE.txt"],
    engine: ["docs/ADD_AN_ENGINE_CHANGE.txt", "docs/ENGINE_DIFFERENTIALS.txt"],
    patch: ["docs/ADD_AN_ENGINE_CHANGE.txt", "docs/PATCH_CHAIN_HARNESS.txt"],
    chain: ["docs/PATCH_CHAIN_HARNESS.txt"],
    cvar: ["CVARS.md"],
    command: ["docs/COMMANDS.txt"],
    preset: ["docs/AMX_PRESETS.txt", "docs/H9_PRESENCE.txt"],
    auth: ["docs/H9_PRESENCE.txt"],
    presence: ["docs/H9_PRESENCE.txt", "docs/RICH_PRESENCE.txt"],
    linux: ["docs/LINUX_SUPPORT.txt", "docs/LINUX_BUILD_LAYOUT.txt"],
    build: ["docs/BUILDING.txt"],
    docker: ["docs/DOCKER.txt"],
    texture: ["docs/HD_TEXTURES.txt", "docs/H9_UPSCALE.txt"],
    map: ["docs/MAP_ENTITIES.txt", "docs/CUSTOM_SPAWNPOINTS.txt"],
    mode: ["docs/GAME_MODES.txt"],
    bot: ["docs/BOT_OBJECTIVES.txt"],
    network: ["docs/NETWORKING.txt"],
    lfs: ["docs/GIT_LFS.txt"],
    ssh: ["docs/ADD_AN_SSH_KEY.txt"],
    privacy: ["docs/PRIVACY_NOTES.txt"],
    rp: ["docs/APOLLO_RP.txt", "docs/ARP_COMMANDS.txt"],
};

function toolDoc(server, z) {
    server.tool(
        "h9_doc",
        "Find and read the HAVOC 9 document that answers a question. 67 files in docs/ plus CVARS.md, " +
        "CONTEXT.md and CLAUDE.md -- this lands on the right one instead of guessing. Use topic='list' " +
        "to see every document's name. Prefer this over asking a model how something works here: the " +
        "answer is written down, and the model's version of it will be plausible and wrong.",
        {
            topic: z.string().describe("What you want to know: 'release', 'patch chain', 'cvar', 'linux', 'preset'... or 'list'"),
            chars: z.number().optional().describe("How much of the document to return (default 6000)"),
        },
        async ({ topic, chars }) => {
            const root = repoRoot();
            if (!root) return noRepo();
            const want = String(topic).toLowerCase().trim();
            const docs = list(join(root, "docs"), (f) => f.toLowerCase().endsWith(".txt")).sort();

            if (want === "list" || want === "") {
                return ok(
                    "docs/ (" + docs.length + " files):\n  " + docs.join("\n  ") +
                    "\n\nIn the repo root: CONTEXT.md (the map), CLAUDE.md (the working rules), CVARS.md,\n" +
                    "LICENSE.md, SECURITY.md, README.md.\n" +
                    "Also: xash3d-h9-patches/patches/PATCH_CHANGELOG.md (every tracked engine patch)."
                );
            }

            // the keyword table first, then a filename match
            const picks = [];
            for (const [key, files] of Object.entries(TOPICS)) {
                if (want.includes(key)) picks.push(...files);
            }
            for (const d of docs) {
                const stem = d.replace(/\.txt$/i, "").toLowerCase();
                if (want.split(/[^a-z0-9]+/).some((w) => w.length > 2 && stem.includes(w))) picks.push("docs/" + d);
            }

            const seen = [];
            for (const p of picks) if (!seen.includes(p) && existsSync(join(root, p))) seen.push(p);
            if (!seen.length) {
                return ok(
                    "Nothing matched \"" + topic + "\".\n\nTry h9_doc with topic='list' for every document's\n" +
                    "name, or h9_find to search for a cvar, command, plugin or patch by name."
                );
            }

            const first = seen[0];
            const body = readText(join(root, first)) ?? "";
            const cap = Number.isFinite(chars) && chars > 0 ? Math.min(chars, 20000) : MAX_CHARS;
            const rest = seen.slice(1);
            return {
                content: [{
                    type: "text",
                    text:
                        "### " + first + "\n\n" + cut(body, cap) +
                        (rest.length ? "\n\n---\nAlso relevant: " + rest.join(", ") : ""),
                }],
            };
        }
    );
}

// ---------------------------------------------------------------------------
// h9_find -- locate a cvar, command, plugin, patch, doc or map by name
// ---------------------------------------------------------------------------
// Bounded on purpose: each kind searches named files or one folder. A recursive search of this repo
// times out (it carries the engine, 467 plugins, the game content and several submodules), and that
// timeout is a documented trap, not a surprise.
function toolFind(server, z) {
    server.tool(
        "h9_find",
        "Locate something in HAVOC 9 by name: a cvar, a console command, a plugin (.sma), an engine " +
        "patch, a document or a map. Each kind searches only the files that can hold it, so it is fast " +
        "and never walks the whole repo (which times out). Returns real file paths and line numbers.",
        {
            kind: z.enum(["cvar", "command", "plugin", "patch", "doc", "map"]).describe("What kind of thing to look for"),
            name: z.string().describe("The name or part of it, e.g. 'h9_customweapons', 'joinscreen', 'wasteland'"),
        },
        async ({ kind, name }) => {
            const root = repoRoot();
            if (!root) return noRepo();
            const needle = String(name).trim();
            if (!needle) return ok("Give a name to look for.");

            if (kind === "cvar" || kind === "command") {
                const files = kind === "cvar"
                    ? ["CVARS.md", "docs/COMMANDS.txt"]
                    : ["docs/COMMANDS.txt", "CVARS.md"];
                const out = [];
                for (const f of files) {
                    const hits = grepFile(join(root, f), needle, 18);
                    if (hits.length) {
                        out.push("### " + f + "  (" + hits.length + " line(s))");
                        out.push(...hits.map((h) => "  " + f + ":" + h.line + "  " + h.text));
                    }
                }
                return ok(out.length
                    ? out.join("\n")
                    : "No " + kind + " line mentions \"" + needle + "\" in CVARS.md or docs/COMMANDS.txt.\n" +
                      "A cvar that exists but is undocumented is a real possibility here: the generator for\n" +
                      "CVARS.md has been known to drop whole sections. Check the .sma or the engine source too.");
            }

            if (kind === "plugin") {
                const low = needle.toLowerCase();
                const hits = [];
                // the plugin sources sit in the repo root and in apollo-rp; one level each, no walk
                for (const dir of [".", "apollo-rp", "include"]) {
                    for (const f of list(join(root, dir), (x) => /\.(sma|inc)$/i.test(x))) {
                        if (f.toLowerCase().includes(low)) hits.push((dir === "." ? "" : dir + "/") + f);
                    }
                }
                return ok(hits.length
                    ? "Plugin sources matching \"" + needle + "\":\n  " + hits.slice(0, MAX_HITS).join("\n  ") +
                      "\n\nBuild them with build.bat, and only the ones that changed (h9_rules on a .sma says why)."
                    : "No .sma or .inc in the repo root, apollo-rp/ or include/ matches \"" + needle + "\".");
            }

            if (kind === "patch") {
                const dir = join(root, "xash3d-h9-patches", "patches");
                const low = needle.toLowerCase();
                const hits = list(dir, (f) => f.endsWith(".patch") && f.toLowerCase().includes(low));
                if (!hits.length) {
                    const all = list(dir, (f) => f.endsWith(".patch"));
                    return ok("No patch name holds \"" + needle + "\". There are " + all.length + " of them; " +
                        "h9_doc topic='patch chain' explains how they are ordered and verified.");
                }
                const out = [];
                for (const f of hits.slice(0, 12)) {
                    const text = readText(join(dir, f)) ?? "";
                    const files = [...text.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
                    out.push("### xash3d-h9-patches/patches/" + f);
                    out.push("  touches " + files.length + " file(s): " + files.slice(0, 8).join(", ") +
                        (files.length > 8 ? ", ..." : ""));
                }
                out.push("\nEditing one of these means a dated entry in patches/PATCH_CHANGELOG.md in the same turn.");
                return ok(out.join("\n"));
            }

            if (kind === "doc") {
                const low = needle.toLowerCase();
                const hits = list(join(root, "docs"), (f) => f.toLowerCase().includes(low));
                return ok(hits.length
                    ? "docs/ matching \"" + needle + "\":\n  " + hits.join("\n  ") + "\n\nRead one with h9_doc."
                    : "No document name holds \"" + needle + "\". h9_doc topic='list' shows them all.");
            }

            // map
            const low = needle.toLowerCase();
            const mapDir = join(root, "H9XASH", "ts", "maps");
            const hits = list(mapDir, (f) => f.toLowerCase().endsWith(".bsp") && f.toLowerCase().includes(low));
            return ok(hits.length
                ? "H9XASH/ts/maps matching \"" + needle + "\":\n  " + hits.slice(0, MAX_HITS).join("\n  ") +
                  "\n\nThese are Git LFS objects. A 130-byte .bsp means the clone has no LFS: see docs/GIT_LFS.txt." +
                  "\nTo read one's textures or entities, use the SMAK MCP server, not this tool."
                : "No map in H9XASH/ts/maps holds \"" + needle + "\". A clone without Git LFS, or without the\n" +
                  "H9XASH folder, would also look like this.");
        }
    );
}

/** Register every H9 tool on an McpServer. `z` is the zod the caller already imported. */
export function registerH9Tools(server, z) {
    toolRules(server, z);
    toolDoc(server, z);
    toolFind(server, z);
}
