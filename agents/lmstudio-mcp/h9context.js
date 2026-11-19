// h9context.js -- the repo's OWN context files, handed to the local model.
//
// The point of this file is that there is no second description of HAVOC 9. CONTEXT.md and
// CLAUDE.md in the repo root are what a Claude Code session reads and what the maintainers keep
// current; a copy of them under context/ would drift within a week and then quietly teach the
// local model things that stopped being true. So they are read from where they live.
//
// context/PROJECT.md stays, but only for what those two do not say: which languages are really
// in here, and where a local model is likely to be wrong.
//
// CLAUDE.md is large (about 26 KB) and goes in front of every single query, so it is cut to a
// budget. The cut is from the TOP, because that is where its rules are. Raise or lower it with
// H9_CLAUDE_MD_CHARS in .env; 0 leaves CLAUDE.md out altogether.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));

// agents/lmstudio-mcp -> agents -> the repo
const REPO = join(HERE, "..", "..");

/** The repo root, or null when this folder has been moved somewhere else. */
export function repoRoot() {
    return existsSync(join(REPO, "CONTEXT.md")) ? REPO : null;
}

function readCapped(path, cap) {
    if (cap <= 0 || !existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    if (!text) return null;
    if (text.length <= cap) return text;
    return text.slice(0, cap).trimEnd() + "\n\n...(cut here: read the file itself for the rest)";
}

/**
 * CONTEXT.md and the head of CLAUDE.md, as one block, ready to go in front of a system prompt.
 * Returns "" when this folder is not inside the repo, so the caller needs no special case.
 */
export function loadRepoContext() {
    const root = repoRoot();
    if (!root) return "";

    const claudeCap = Number.parseInt(process.env.H9_CLAUDE_MD_CHARS ?? "8000", 10);
    const parts = [];

    const context = readCapped(join(root, "CONTEXT.md"), 20000);
    if (context) parts.push("## HAVOC 9 -- CONTEXT.md (the repo's own, read from the root)\n\n" + context);

    const claude = readCapped(join(root, "CLAUDE.md"), Number.isFinite(claudeCap) ? claudeCap : 8000);
    if (claude) parts.push("## HAVOC 9 -- CLAUDE.md, the working rules (the head of it)\n\n" + claude);

    return parts.join("\n\n---\n\n");
}
