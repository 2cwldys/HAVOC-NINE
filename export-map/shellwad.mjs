// The map's own textures, pulled back out of the compiled .bsp into a .wad.
//
//     node shellwad.mjs
//
// WHY THIS IS NEEDED. The developed h9_te_neuropolis.map names a single wad,
// "neuropolis_shell.wad", at a path on the machine of whoever built it -- so on any other
// machine the compilers stop at the first texture they cannot find and no .bsp is produced.
//
// The textures themselves are not lost, though. The map was compiled with -nowadtextures, which
// puts every texture INSIDE the .bsp, so the shipped .bsp carries them all. This reads them back
// out and writes the wad the map is asking for.
//
// Only the ones nothing else provides are taken. Everything already in halflife.wad, specialists.wad
// and the rest stays there, so this file holds the handful that are genuinely the map's own and does
// not shadow a stock texture with a copy of it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { M, MAP_NAME, GAME_DIR, wadList } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const FROM = join(GAME_DIR, "ts", "maps", `${MAP_NAME}.bsp`);
const TO = join(HERE, "neuropolis_shell.wad");

const bsp = M.readBsp(readFileSync(FROM));

// what the stock wads already answer for, so those are left alone
const known = new Set();
for (const w of wadList()) {
  try {
    for (const n of M.wadTextureNames(readFileSync(w))) known.add(n.toUpperCase());
  } catch {}
}

/*
 * A texture entry in a .bsp either carries its pixels or is a NAME ONLY -- a reference to a wad the
 * map was compiled against. Only the ones with pixels can be written back out, and an entry without
 * them is not a loss here: by definition it lives in a wad already.
 */
const take = [];
for (const t of bsp.textures ?? []) {
  if (!t?.name || !t.embedded || t.absent) continue;
  if (known.has(t.name.toUpperCase())) continue;
  // the entry only says WHERE the pixels are; embeddedTexture is what reads them out
  const tex = M.embeddedTexture(bsp, t.index);
  if (!tex) continue;
  take.push({ ...tex, name: t.name });
}

writeFileSync(TO, M.writeWad(take));
console.log(`\n  ${take.length} texture(s) out of ${FROM}`);
for (const t of take) console.log(`     ${t.name}  ${t.width}x${t.height}`);
console.log(`\n  wrote ${TO}\n`);
