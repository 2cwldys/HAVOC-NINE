// h9_tsrp_newbyzantium: New Byzantium, Alexandria's sister city and the MSR's regal capital, at night.
// plan.mjs lays the city out (STUDY.md is the brief, refs\ the three cities it is measured against);
// kit.mjs holds the pieces and the tiled carve that turns the plan's spaces into sealed rock.
//
//   node city.mjs                 write out\h9_tsrp_newbyzantium.map, and check it
//   node city.mjs --plan          and draw its plan at every level into out\views
//   node city.mjs --compile       and compile it (Xash limits): a full vis, and light bounced between coarse patches
//   node city.mjs --compile --draft   a quick draft: hlvis's fast guess, and direct light only (no bounce)
//   node city.mjs --views         draw the compiled map from inside, into out\views
//   node city.mjs deploy          copy the .bsp into H9XASH's and the game's ts\maps
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K, M } from "../lib.mjs";
import { WADS as CITY_WADS } from "../h9_tsrp_hive/wads.mjs";
import { SKY_NAME } from "./sky.mjs";
import { carveTiled, clipBrush, wearFromSpaces } from "./kit.mjs";
import { buildCity, Z } from "./plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
// --preview builds the middle of the city alone: small enough for a version 30 file, which the renders can read
const PREVIEW = process.argv.includes("--preview");
const NAME = PREVIEW ? "h9_tsrp_newbyzantium_preview" : "h9_tsrp_newbyzantium";
const COMPILERS = join(HERE, "..", "sdhlt-goldsrc-net", "tools");
const H9XASH_MAPS = join(HERE, "..", "..", "H9XASH", "ts", "maps");
/** The wads it builds from: the cities' and The Specialists', not Valve's (halflife, liquids, xeno, decals). */
const VALVE_WADS = new Set(["halflife", "liquids", "xeno", "decals"]);
// and majestic.wad (Randy Reddig, scmapdb): the MSR's own corridors, doors and bridges wear it
const WADS = {
  ...Object.fromEntries(Object.entries(CITY_WADS).filter(([name, path]) => !VALVE_WADS.has(name) && existsSync(path))),
  majestic: join(HERE, "wads", "majestic.wad"),
};
const TOOL = new Set(["NULL", "CLIP", "SKIP", "HINT", "AAATRIGGER", "ORIGIN", "BEVEL", "SOLID", "SKY"]);

const flags = process.argv.slice(2);
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// ---- the plan, carved ----------------------------------------------------------------------------------
const { bag, publicSpaces, streets } = buildCity({ log: (s) => console.log(s) });
for (const note of bag.notes) console.log(`  ${note}`);
if (PREVIEW) {
  const R = 2600;
  const inside = ([x, y]) => x >= -R && x <= R && y >= -R && y <= R;
  const brushIn = (b) => {
    const s = M.shapeOf(b);
    return s.min[0] >= -R && s.max[0] <= R && s.min[1] >= -R && s.max[1] <= R;
  };
  bag.spaces = bag.spaces.filter((s) => s.outline.every(inside));
  bag.world = bag.world.filter(brushIn);
  bag.detail = bag.detail.filter(brushIn);
  bag.entities = bag.entities.filter((e) => (e.origin ? inside(e.origin.split(" ").map(Number)) : (e.brushes ?? []).every(brushIn)));
  console.log(`  preview: the ${bag.spaces.length} spaces inside +/-${R}`);
}
console.log(`  plan: ${bag.spaces.length} spaces, ${bag.world.length} world fittings, ${bag.detail.length} detail brushes, ${bag.entities.length} entities (${secs()})`);
// the undercity and the city over it are carved apart and meet at SEAM: a slab between them is cut only by
// the spaces on its own side, and the shafts that pass from one to the other are carved in both
const SEAM = -16;
const carveLayer = (spaces, keepBelow) =>
  carveTiled(spaces, {
    tile: 3072,
    wall: 64,
    texture: { floor: "grey_creteflr2", wall: "po_concretwall", ceiling: "crete3_ceil03c" },
    log: flags.includes("--tiles") ? (s) => console.log(s) : () => {},
  })
    .map((b) => clipBrush(b, 2, SEAM, keepBelow))
    .filter(Boolean);
const carved = [
  ...carveLayer(bag.spaces.filter((s) => s.floor < SEAM), true),
  ...carveLayer(bag.spaces.filter((s) => s.ceiling > SEAM), false),
];
// each rock face's floor and ceiling worn again from the spaces over and under it (kit.mjs says why)
const rock = wearFromSpaces(carved, bag.spaces);
console.log(`  carved: ${rock.brushes.length} brushes of rock, ${rock.changed} floors and ceilings worn from their spaces, ${rock.split} cut where two spaces see one (${secs()})`);
const map = {
  worldspawn: { wad: Object.values(WADS), skyname: SKY_NAME, MaxRange: 24000, message: "New Byzantium", sounds: 1 },
  brushes: [...rock.brushes, ...bag.world],
  entities: [...bag.entities, M.brushEntity("func_detail", bag.detail)],
};

// ---- every texture it wears has to be in a wad it embeds -----------------------------------------------
const have = new Set();
for (const path of Object.values(WADS)) for (const n of M.wadTextureNames(readFileSync(path))) have.add(n.toUpperCase());
const worn = new Map();
const wear = (brushes, where) => {
  for (const b of brushes ?? []) for (const f of b.faces) if (!worn.has(f.texture)) worn.set(f.texture, where);
};
wear(map.brushes, "world");
for (const e of map.entities) wear(e.brushes, e.classname);
const missing = [...worn.keys()].filter((t) => !TOOL.has(t.toUpperCase()) && !have.has(t.toUpperCase()));
if (missing.length) console.log(`  MISSING TEXTURES (${missing.length}): ${missing.map((t) => `${t} (${worn.get(t)})`).join(", ")}`);
else console.log(`  textures: ${worn.size}, all in the wads`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `${NAME}.map`), M.writeMap(map));
// the plan beside the map: every space with its kind, and the public ways (what the roaming citizens may walk:
// { name, kind, rect [x0, y0, x1, y1], floor, ceiling, connections: [names] }); nothing of the MSR's is public
writeFileSync(
  join(OUT, `${NAME}.plan.json`),
  JSON.stringify({
    // a street's `levels`: the heights of its floor and its galleries' walkways
    spaces: bag.spaces.map((sp) => {
      const st = streets.find((x) => x.name === sp.name);
      return { name: sp.name, kind: sp.kind, outline: sp.outline, floor: sp.floor, ceiling: sp.ceiling, ...(st?.galleries?.length ? { levels: [sp.floor, ...st.galleries.map((g) => sp.floor + g)] } : {}) };
    }),
    publicSpaces,
  }),
);
// sent with the map to a player who joins without it: the sky, the haze sprite and every sound it plays (the fire
// and the beacon's flare are H9's own, in valve)
writeFileSync(
  join(OUT, `${NAME}.res`),
  [
    `// ${NAME}: sent with the map to a player who joins without it`,
    ...["rt", "lf", "bk", "ft", "up", "dn"].map((s) => `gfx/env/${SKY_NAME}${s}.tga`),
    "sprites/h9_drain_fog.spr",
    ...(bag.sounds ?? []).map((f) => `sound/${f}`),
    "",
  ].join("\r\n"),
);
const brushCount = map.brushes.length + map.entities.reduce((n, e) => n + (e.brushes?.length ?? 0), 0);
console.log(`  wrote ${NAME}.map: ${map.brushes.length} world brushes, ${brushCount} brushes in all, ${map.entities.length} entities (${secs()})`);
// ---- ROAM WAYPOINTS (roamwaypoints.mjs, for tsrp_roambots): the roaming citizens' waypoints and spawn spots, laid
// from the .map and .plan.json just written, with --compile, --roam or deploy (not --noroam). A failure is told and
// the build goes on.
if (!PREVIEW) await import("./roamwaypoints.mjs").then((roam) => roam.roamStep({ name: NAME, flags }), (error) => console.log(`  ROAM WAYPOINTS FAILED: ${error.message}`));
if (!flags.includes("--nocheck")) {
  // big-world coordinates (engine-h9-bigworld.patch and ts\delta.lst) reach +/-32768
  const plan = M.checkPlan(map, { range: 32768 });
  for (const line of (plan.errors ?? []).slice(0, 12)) console.log(`  PLAN ERROR ${line}`);
  for (const line of (plan.warnings ?? []).slice(0, 8)) console.log(`  plan warn  ${line}`);
  console.log(`  checked (${secs()})`);
}

// ---- the plan drawn at every level -----------------------------------------------------------------------
const views = join(OUT, "views");
if (flags.includes("--plan")) {
  mkdirSync(views, { recursive: true });
  const cuts = [
    ["1-cistern", Z.cistern + 36],
    ["2-sewers", Z.sewer + 36],
    ["3-streets", 36],
    ["4-galleries", 212],
    ["5-ward", Z.ward + 36],
    ["6-upper", Z.mese + 36],
  ];
  for (const [label, z] of cuts) {
    const img = M.planOfSource(map, { z, width: 1400, height: 1500, entities: false, labels: false });
    writeFileSync(join(views, `plan-${label}.png`), K.png(img.width, img.height, img.rgba));
  }
  console.log(`  drew ${cuts.length} plans into ${views} (${secs()})`);
}

// ---- compile, draw, deploy ---------------------------------------------------------------------------------
if (flags.includes("--compile")) {
  // a preview is a version 30 file for the renderer: it keeps the one clip hull a leak test needs, not the other two
  const perTool = ["-engine", "xash", "-threads", "8", ...(PREVIEW ? ["-format", "bsp30"] : [])];
  // hlrad's bounce light is its transfers: every patch to every patch it can see, by hlvis's answer. At its own
  // patch sizes (64, and 32 under a texture light) with hlvis's fast guess, the whole city's transfers run for
  // hours, so the build runs a full hlvis and bounces between 128-unit patches (64 under a texture light). The
  // direct light, and so every shadow, keeps its full detail; only the bounced light is coarser.
  // A draft takes hlvis's fast guess and hlrad -fast: no bounce at all, so no transfers.
  const DRAFT = flags.includes("--draft");
  const visArgs = DRAFT ? ["-fast"] : [];
  const radArgs = DRAFT ? ["-fast"] : ["-chop", "128", "-texchop", "64"];
  const result = M.compileMap(join(OUT, `${NAME}.map`), {
    wads: Object.values(WADS),
    wadinclude: true,
    out: join(OUT, `${NAME}.bsp`),
    compilers: { folder: COMPILERS },
    args: { hlcsg: perTool, hlbsp: [...perTool, ...(flags.includes("--notjunc") ? ["-notjunc"] : []), ...(PREVIEW ? ["-nohull2", "-nohull3"] : [])], hlvis: [...perTool, ...visArgs], hlrad: [...perTool, ...radArgs] },
    vis: true,
    light: true,
    timeout: { hlcsg: 1800000, hlbsp: 1800000, hlvis: 7200000, hlrad: 14400000 },
    // each compiler's output passes through to standard error as it comes, so a long run shows how far it is
    progress: true,
    keep: false,
  });
  console.log(`  bsp: ${result.bsp ?? "none"}`);
  for (const line of result.errors) console.log(`  ERROR ${line}`);
  for (const line of result.warnings.slice(0, 12)) console.log(`  warn  ${line}`);
  if (result.leak) console.log(`  LEAK from ${result.leak.entity?.classname} at ${result.leak.at}`);
  for (const log of result.logs) console.log(`  ${log.tool}: ${log.code ?? "?"} in ${log.seconds.toFixed(1)}s`);
}
if (flags.includes("--views")) {
  const VIEWS = [
    ["well-steps", [0, -1600, 120], [0, 0, 700]],
    ["well-up", [-1200, -1200, 60], [0, 0, 2600]],
    ["nexus-hall", [0, -300, 420], [0, 300, 700]],
    ["nexus-dome", [0, -380, 500], [0, 0, 1700]],
    ["ward-tube", [0, -1500, Z.ward + 60], [0, -600, Z.ward + 60]],
    ["mese", [-1800, 1870, Z.mese + 70], [1200, 1870, Z.mese + 160]],
    ["mese-well", [0, 1800, Z.mese + 70], [0, 0, 600]],
    ["avenue-n", [0, 1800, 60], [0, 4000, 220]],
    ["avenue-gallery", [150, 2600, 236], [150, 4200, 300]],
    ["ascent", [400, 2100, 60], [400, 2500, 700]],
    ["stacks-well", [-672, 3600, 40], [-672, 4300, 1400]],
    ["bazaar", [3500, -600, 60], [4600, -600, 120]],
    ["rookery", [-3700, 3600, 50], [-4400, 4300, 500]],
    ["foundry", [-3500, -3500, 60], [-4600, -4600, 200]],
    ["basilica", [1888, -2650, Z.mese + 60], [1888, -3400, Z.mese + 400]],
    ["cistern", [-1400, -1400, Z.cistern + 60], [400, 400, Z.cistern + 120]],
    ["sewer", [0, 2000, Z.sewer + 60], [0, 4000, Z.sewer + 60]],
    ["canal", [-2600, -6200, 120], [800, -7000, 60]],
    ["pumphouse", [-300, -7400, 100], [-200, -8200, 100]],
    ["south-gate", [0, -5000, 60], [0, -6500, 200]],
  ];
  const folders = [join(HERE, "..", "out"), join(GAME_DIR, "ts"), join(HERE, "..", "..", "H9XASH", "valve")];
  mkdirSync(views, { recursive: true });
  const bsp = M.readBsp(readFileSync(join(OUT, `${NAME}.bsp`)));
  for (const [label, from, to] of VIEWS) {
    try {
      const img = M.drawMap(bsp, { from, to, width: 640, height: 400, brightness: 1.5, folders, entities: "game", labels: false });
      writeFileSync(join(views, `${NAME}-${label}.png`), K.png(img.width, img.height, img.rgba));
    } catch (e) {
      console.log(`  ${label}: FAILED -- ${e.message}`);
    }
  }
  console.log(`  drew ${VIEWS.length} views into ${views}`);
}
// ---- seeing it before it is compiled, and flying through it ------------------------------------------
// --sketch draws the source (each face a flat colour by its texture, shaded by the way it looks); --fly renders a
// camera path through the city into out\fly and makes out\views\<map>-flythrough.mp4 of it, from the compiled map
// when it can read it (a --preview build) and from the source when it cannot.
const SHOTS = [
  ["well", [-1180, -1640, 1300], [0, 0, 1400]],
  ["grand-steps", [0, -1620, 90], [0, -400, 520]],
  ["nexus-hall", [0, -330, 420], [0, 300, 900]],
  ["mese", [-1820, 1870, Z.mese + 70], [1200, 1870, Z.mese + 140]],
  ["avenue", [0, 1720, 90], [0, 3600, 260]],
  ["street", [2432, 3000, 70], [3300, 3000, 120]],
  ["stacks-well", [-672, 3560, 40], [-672, 4300, 1300]],
  ["sewer", [0, 1800, Z.sewer + 64], [0, 3400, Z.sewer + 64]],
  ["cistern", [-1400, -1400, Z.cistern + 80], [300, 300, Z.cistern + 140]],
  ["canal", [-2700, -6100, 160], [600, -7100, 40]],
];
// what the preview (the middle of the city, inside +/-2600) holds
const PREVIEW_SHOTS = [
  ["well", [-1180, -1640, 1300], [0, 0, 1400]],
  ["well-floor", [-1300, -1300, 120], [0, 0, 900]],
  ["grand-steps", [0, -1620, 90], [0, -400, 520]],
  ["nexus-doors", [0, -700, 420], [0, 0, 520]],
  ["nexus-hall", [0, -330, 420], [0, 300, 900]],
  ["nexus-dome", [-200, -200, 500], [0, 0, 1700]],
  ["ward-tube", [0, -1560, Z.ward + 70], [0, -600, Z.ward + 70]],
  ["ward-ring", [-1792, -1700, Z.ward + 70], [-1792, 1200, Z.ward + 70]],
  ["mese", [-1820, 1870, Z.mese + 70], [1200, 1870, Z.mese + 140]],
  ["mese-arch", [-900, 1760, Z.mese + 70], [-700, 0, Z.mese - 100]],
  ["mese-shop", [600, 1960, Z.mese + 60], [600, 2300, Z.mese + 60]],
  ["upper-bridge", [0, 1500, Z.mese + 70], [0, 500, Z.mese + 140]],
  ["ascent", [400, 2100, 60], [400, 2500, 700]],
  ["avenue-gate", [0, 2500, 90], [0, 1700, 300]],
  ["avenue-gallery", [150, 2450, 236], [150, 1800, 300]],
  ["avenue-e", [1720, 120, 90], [2600, -60, 220]],
  ["cistern", [-1400, -1400, Z.cistern + 80], [300, 300, Z.cistern + 140]],
];
const PREVIEW_FLIGHT = [
  [[0, -2500, 110], [0, -1700, 160]],
  [[0, -1950, 140], [0, -900, 420]],
  [[0, -1450, 220], [0, -500, 520]],
  [[-500, -1150, 420], [0, 0, 700]],
  [[-1200, -400, 700], [0, 0, 1000]],
  [[-1150, 700, 1000], [0, 0, 1300]],
  [[-400, 1350, 1200], [0, 0, 1700]],
  [[300, 1550, 1150], [0, 0, 1100]],
  [[0, 1300, Z.mese + 80], [0, 1900, Z.mese + 100]],
  [[-300, 1870, Z.mese + 80], [-1600, 1870, Z.mese + 120]],
  [[-1600, 1870, Z.mese + 80], [-1600, 1000, Z.mese + 80]],
  [[-1650, 900, Z.mese + 80], [-500, 0, Z.mese - 200]],
];
const FLIGHT = [
  [[-2900, -6250, 220], [0, -6900, 60]],
  [[-600, -6000, 160], [0, -5400, 140]],
  [[0, -5200, 120], [0, -4200, 140]],
  [[0, -3300, 120], [0, -2200, 200]],
  [[0, -2100, 160], [0, -1000, 420]],
  [[0, -1450, 220], [0, -500, 520]],
  [[-700, -1100, 520], [0, 0, 700]],
  [[-1100, 0, 900], [0, 0, 1200]],
  [[-700, 1100, 1300], [0, 0, 1500]],
  [[0, 1500, 1500], [0, 0, 2300]],
  [[600, 1650, 1300], [0, 1870, 1180]],
  [[-1200, 1870, Z.mese + 80], [1600, 1870, Z.mese + 120]],
  [[1500, 1870, Z.mese + 80], [1872, 2600, Z.mese + 120]],
];
const camera = (path, t) => {
  // Catmull-Rom through the keys, both for where the camera is and for where it looks
  const n = path.length - 1;
  const f = Math.min(n - 1e-9, Math.max(0, t * n));
  const i = Math.floor(f);
  const u = f - i;
  const key = (k) => path[Math.max(0, Math.min(n, k))];
  const cr = (a, b, c, d) => a.map((_, j) => 0.5 * (2 * b[j] + (-a[j] + c[j]) * u + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * u * u + (-a[j] + 3 * b[j] - 3 * c[j] + d[j]) * u * u * u));
  return [0, 1].map((w) => cr(key(i - 1)[w], key(i)[w], key(i + 1)[w], key(i + 2)[w]));
};
if (flags.includes("--sketch") || flags.includes("--fly")) {
  const folders = [join(HERE, "..", "out"), join(GAME_DIR, "ts"), join(HERE, "..", "..", "H9XASH", "valve")];
  const bspFile = join(OUT, `${NAME}.bsp`);
  let bsp = null;
  // the full city compiles to Xash BSP2, which the renderer cannot read: only a preview build is drawn compiled
  if (PREVIEW && existsSync(bspFile)) {
    try {
      bsp = M.readBsp(readFileSync(bspFile));
    } catch {
      bsp = null;
    }
  }
  const draw = (from, to, width, height) =>
    bsp
      ? M.drawMap(bsp, { from, to, width, height, brightness: 1.6, folders, entities: "game", labels: false })
      : M.drawSource(map, { from, to, width, height, entities: "none", labels: false });
  mkdirSync(views, { recursive: true });
  if (flags.includes("--sketch")) {
    for (const [label, from, to] of PREVIEW ? PREVIEW_SHOTS : SHOTS) {
      const t = Date.now();
      try {
        const img = draw(from, to, 800, 450);
        writeFileSync(join(views, `${NAME}-${bsp ? "view" : "sketch"}-${label}.png`), K.png(img.width, img.height, img.rgba));
        console.log(`  ${label}: ${((Date.now() - t) / 1000).toFixed(1)}s`);
      } catch (e) {
        console.log(`  ${label}: FAILED -- ${e.message}`);
      }
    }
  }
  if (flags.includes("--fly")) {
    const frames = Number(flags.find((f) => f.startsWith("--frames="))?.slice(9) ?? 360);
    const dir = join(OUT, "fly");
    mkdirSync(dir, { recursive: true });
    for (let k = 0; k < frames; k++) {
      const [from, to] = camera(PREVIEW ? PREVIEW_FLIGHT : FLIGHT, k / (frames - 1));
      const img = draw(from, to, 960, 540);
      writeFileSync(join(dir, `f${String(k).padStart(4, "0")}.png`), K.png(img.width, img.height, img.rgba));
      if (k % 30 === 0) console.log(`  frame ${k}/${frames} (${secs()})`);
    }
    const mp4 = join(views, `${NAME}-flythrough.mp4`);
    const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "24", "-i", join(dir, "f%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", mp4], { stdio: "inherit" });
    console.log(run.status === 0 ? `  wrote ${mp4}` : `  ffmpeg failed (${run.status})`);
  }
}

if (flags.includes("--presence")) {
  // the Discord card's picture: the Nexus in its well, seen from the Mese's arcade
  const folders = [join(HERE, "..", "out"), join(GAME_DIR, "ts"), join(HERE, "..", "..", "H9XASH", "valve")];
  const bsp = M.readBsp(readFileSync(join(OUT, `${NAME}.bsp`)));
  const img = M.drawMap(bsp, { from: [-1180, -1640, 1300], to: [0, 0, 1500], width: 512, height: 512, brightness: 1.6, folders, entities: "game", labels: false });
  const file = join(HERE, "..", "..", "presence", "maps", `${NAME}.png`);
  writeFileSync(file, K.png(img.width, img.height, img.rgba));
  console.log(`  drew the presence picture: ${file}`);
}
if (flags.includes("deploy") && !PREVIEW) {
  for (const dir of [H9XASH_MAPS, join(GAME_DIR, "ts", "maps")]) {
    copyFileSync(join(OUT, `${NAME}.bsp`), join(dir, `${NAME}.bsp`));
    copyFileSync(join(OUT, `${NAME}.res`), join(dir, `${NAME}.res`));
    console.log(`  deployed the .bsp and .res to ${dir}`);
  }
}
