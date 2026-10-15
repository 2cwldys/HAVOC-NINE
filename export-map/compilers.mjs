// The compilers, under the names SMAK looks for.
//
//     node compilers.mjs
//
// WHY THIS EXISTS. SMAK runs the four GoldSrc compilers and looks for them by their VHLT names:
// hlcsg_x64.exe, hlcsg.exe, hlbsp_x64.exe and so on (src/maps/compile.mjs, COMPILERS and
// FILE_NAMES), with the compilers' own tool textures beside them as zhlt.wad (TOOL_WAD).
//
// This machine has SDHLT instead -- seedee's fork of Vluzacn's tools, which the base map was
// built with -- and every one of its files carries an "sd" prefix: sdHLCSG_x64.exe, sdhlt.wad.
// So SMAK finds nothing, and says so.
//
// SDHLT is a descendant of VHLT and takes the same arguments, so the only problem is the names.
// This makes a folder of copies under the names SMAK expects. It does NOT touch smak/ -- the kit
// stays as it came, exactly as modelling/README.txt requires -- and it does not touch SDHLT
// either; the originals are left where J.A.C.K. expects them.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { M, COMPILERS, SDHLT_DIR } from "./lib.mjs";

/** What SMAK looks for, and the SDHLT file it is a copy of. */
const PAIRS = [
  ["hlcsg_x64.exe", "sdHLCSG_x64.exe"],
  ["hlbsp_x64.exe", "sdHLBSP_x64.exe"],
  ["hlvis_x64.exe", "sdHLVIS_x64.exe"],
  ["hlrad_x64.exe", "sdHLRAD_x64.exe"],
  // The tool textures: ORIGIN, CLIP, NULL, HINT, SKIP and the rest. compileMap adds this to the
  // wad list by itself, by the name zhlt.wad, so a map using NULL or CLIP needs it present.
  ["zhlt.wad", "sdhlt.wad"],
];

if (!existsSync(SDHLT_DIR)) {
  console.error(`\n  SDHLT is not at ${SDHLT_DIR}.\n  Fix SDHLT at the top of lib.mjs, or set the SDHLT_DIR environment variable.\n`);
  process.exit(1);
}

mkdirSync(COMPILERS, { recursive: true });
let copied = 0;
let kept = 0;
for (const [wanted, original] of PAIRS) {
  const from = join(SDHLT_DIR, original);
  const to = join(COMPILERS, wanted);
  if (!existsSync(from)) {
    console.log(`  MISSING  ${original} is not in ${SDHLT_DIR}`);
    continue;
  }
  // Copied again whenever the original is newer, so updating SDHLT is picked up.
  if (existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs) {
    kept++;
    continue;
  }
  copyFileSync(from, to);
  copied++;
  console.log(`  ${original}  ->  ${wanted}`);
}
if (kept) console.log(`  ${kept} already current`);

// ---- and the proof: ask SMAK to find them ------------------------------------------------
const found = M.findCompilers({ folder: COMPILERS });
console.log(`\n  ${found.message}`);
if (!found.found) {
  console.log(`  missing: ${found.missing.join(", ")}\n`);
  process.exit(1);
}
for (const [tool, path] of Object.entries(found.tools)) console.log(`     ${tool.padEnd(6)} ${path}`);
console.log(`\n  The compilers are ready. compileMap({ compilers: { folder } }) will find them.\n`);
