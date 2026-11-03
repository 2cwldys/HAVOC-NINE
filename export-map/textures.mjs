// What textures there are to build with, and which of them the base map already uses.
//
//     node textures.mjs            every wad, counted, with a sample
//     node textures.mjs stone      only names holding "stone", across every wad
//
// A map names its textures and nothing more; the pictures live in .wad files. Choosing them is
// most of how a map looks, so this exists to make the choice from what is actually there rather
// than from memory.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { M, WADS, GAME_DIR, readBase } from "./lib.mjs";

/** The two wads pulled out of other TS maps: a sunken-city map and a cyberpunk-city one. */
const EXTRA = {
  alexandria: join(GAME_DIR, "..", "..", "..", "..", "Downloads", "TSM", "export", "ts", "maps", "alexandria_msr_b4v3_generated.wad"),
  xenoncity: join(GAME_DIR, "..", "..", "..", "..", "Downloads", "TSM", "export", "ts", "maps", "xenoncity_true_b3v2_generated.wad"),
};
// Resolved relative to this folder instead, which is where they really are.
const HERE_MAPS = join(import.meta.dirname, "..", "export", "ts", "maps");
EXTRA.alexandria = join(HERE_MAPS, "alexandria_msr_b4v3_generated.wad");
EXTRA.xenoncity = join(HERE_MAPS, "xenoncity_true_b3v2_generated.wad");

const ALL = { ...WADS, ...EXTRA };
const want = (process.argv[2] ?? "").toLowerCase();

/** What the base map already wears, so a new room can be made to match it. */
const base = readBase();
const used = new Set();
for (const b of base.brushes) for (const f of b.faces) used.add(f.texture.toUpperCase());
for (const e of base.entities) for (const b of e.brushes ?? []) for (const f of b.faces) used.add(f.texture.toUpperCase());

const found = new Map();
for (const [name, file] of Object.entries(ALL)) {
  if (!existsSync(file)) {
    console.log(`  ${name.padEnd(16)} -- not on disk`);
    continue;
  }
  let names;
  try {
    names = M.wadTextureNames(readFileSync(file));
  } catch (error) {
    console.log(`  ${name.padEnd(16)} -- ${error.message}`);
    continue;
  }
  found.set(name, names);
  if (want) {
    const hits = names.filter((t) => t.toLowerCase().includes(want));
    if (hits.length) console.log(`  ${name} (${hits.length}):\n     ${hits.join("  ")}`);
  } else {
    const sample = names.slice(0, 10).join("  ");
    console.log(`  ${name.padEnd(16)} ${String(names.length).padStart(5)} textures   ${sample}`);
  }
}

if (!want) {
  console.log(`\n  the base map wears ${used.size}:`);
  for (const t of [...used].sort()) {
    const where = [...found.entries()].filter(([, names]) => names.some((n) => n.toUpperCase() === t)).map(([w]) => w);
    console.log(`     ${t.padEnd(20)} ${where.length ? where.join(", ") : "IN NONE OF THEM"}`);
  }
  console.log("\n  node textures.mjs <word>   to search every wad for a name");
}
