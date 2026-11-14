// The pictures the wasteland is built from, and a contact sheet to look at them.
//
//   node textures.mjs          list the palette and check every name is in a wad
//   node textures.mjs --sheet  write out/textures.png, six to a row, in the order listed
//
// The map names textures only; the pictures live in the game's wads, and are put inside the
// .bsp by the compile (wadinclude). Every name below is from a wad the game already has:
// specialists.wad carries the desert and ruin set (sand, adobe, canyon rock, rusted metal),
// halflife.wad the concrete, dirt, stains and rusted grate, avp2.wad the asphalt and dirt.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K, M } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, "out");

export const WADS = {
  halflife: join(GAME_DIR, "valve", "halflife.wad"),
  liquids: join(GAME_DIR, "valve", "liquids.wad"),
  decals: join(GAME_DIR, "valve", "decals.wad"),
  specialists: join(GAME_DIR, "ts", "specialists.wad"),
  avp2: join(GAME_DIR, "ts", "avp2.wad"),
};

/** The names the map uses. A group is one part of the place, so a wall never wears a floor. */
export const T = {
  // the cracked lakebed and its drifts
  sand: "sand",
  sandCracked: "dusty1",
  sandPale: "adobe1",
  sandPaleB: "adobe1b",
  dirt: "OUT_DIRT1",
  dirtStain: "STAIN_WALL01",
  asphalt: "masphalt",
  asphaltWorn: "masphalt3",
  pavement: "pavement",
  paving: "outpave002",
  // the low ruined buildings: sun-bleached concrete and adobe
  concrete: "concrete2",
  concreteB: "h_concrete4",
  concreteC: "crete32b",
  concreteD: "crete36",
  concreteE: "crete41",
  adobe: "adobe1c",
  stucco: "stucco",
  plaster: "plaster1",
  brick: "bricks",
  brickB: "brickx2",
  block: "muro",
  blockB: "muro3",
  blockC: "muro7",
  // the central ruin and the rock round the bowl
  rock: "rocks",
  rockB: "rocks2",
  rockC: "rocks3",
  rockD: "rocks4",
  canyon: "canyon1",
  canyonB: "canyon_bryce2",
  canyonC: "canyon_bryce4",
  stone: "stonewall1",
  stoneB: "stonewall1a",
  // rusted steel, wire and timber
  rust: "metal_rusty5eee",
  rustB: "metal_rusty5ccc",
  metal: "metal2",
  metalB: "metal6a",
  grate: "GRATE_RUST",
  rail: "{RUSTYRAIL",
  wire: "wire1",
  fence: "fence001",
  wood: "wood2",
  woodB: "wood4a",
  woodC: "crapwood1c",
  beam: "beam1c",
  panel: "panel",
  // what a way is marked with, and what is left in it
  sign: "danger",
  signB: "cautions",
  window: "window006",
  windowB: "windows001",
  door: "door002",
  doorB: "door005",
  // the ground at the edge of the map, and the sky's own faces
  sky: "sky",
};

/** Every name above, with the wad it was found in. */
export function palette() {
  const found = new Map();
  for (const [wad, file] of Object.entries(WADS)) {
    let names;
    try {
      names = M.wadTextureNames(readFileSync(file));
    } catch {
      continue;
    }
    for (const name of names) if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, wad });
  }
  return Object.entries(T).map(([key, name]) => ({ key, name, ...(found.get(name.toLowerCase()) ?? { wad: null }) }));
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  const list = palette();
  const missing = list.filter((t) => !t.wad);
  for (const t of list) console.log(`${t.wad ? "ok " : "MISSING"}  ${t.key.padEnd(12)} ${t.name.padEnd(18)} ${t.wad ?? ""}`);
  if (missing.length) {
    console.error(`\n${missing.length} texture(s) are in no wad.`);
    process.exitCode = 1;
  }
  if (process.argv.includes("--sheet")) {
    mkdirSync(OUT, { recursive: true });
    const wads = Object.fromEntries(
      Object.entries(WADS).map(([key, file]) => {
        try {
          return [key, M.readWad(readFileSync(file))];
        } catch {
          return [key, { textures: [] }];
        }
      }),
    );
    const tile = 128;
    const cols = 6;
    const rows = Math.ceil(list.length / cols);
    const rgba = new Uint8Array(cols * tile * rows * tile * 4);
    // a dark backing, so a picture with holes or a dark edge is seen
    for (let i = 0; i < rgba.length; i += 4) rgba.set([24, 22, 19, 255], i);
    list.forEach((t, n) => {
      if (!t.wad) return;
      const texture = M.textureFromWad(wads[t.wad], t.name);
      if (!texture) return;
      const image = M.textureRgba(texture);
      const [tx, ty] = [(n % cols) * tile, Math.floor(n / cols) * tile];
      for (let y = 0; y < tile; y++)
        for (let x = 0; x < tile; x++) {
          const sx = Math.min(image.width - 1, Math.floor((x / tile) * image.width));
          const sy = Math.min(image.height - 1, Math.floor((y / tile) * image.height));
          const from = (sy * image.width + sx) * 4;
          const to = ((ty + y) * cols * tile + tx + x) * 4;
          rgba[to] = image.rgba[from];
          rgba[to + 1] = image.rgba[from + 1];
          rgba[to + 2] = image.rgba[from + 2];
          rgba[to + 3] = 255;
        }
    });
    const file = join(OUT, "textures.png");
    writeFileSync(file, K.png(cols * tile, rows * tile, rgba));
    console.log(`\n  ${file}`);
    console.log(`  ${cols} a row, in the order listed above.`);
  }
  void writeFileSync;
}
