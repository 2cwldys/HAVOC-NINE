// The sky over the wasteland: a dust storm closing over a dead lakebed, the sun a low smear behind it.
//
//   node sky.mjs            six sides into ..\out\gfx\env (beside the other maps' skies, where the views read
//                           them and export.bat collects them), a panorama into out\sky
//   node sky.mjs deploy     and copy the six sides into the game's ts\gfx\env
//
// WHAT IS IN IT, from the ground up:
//   the haze    a band of ochre dust lying along the horizon, thick enough to hide the land beyond
//   the cloud   one low lid of storm cloud, olive and brown, torn open in the south-west where the sun is
//   the sun     low, wide and pale behind the dust, its light coming across the bowl from the south-west
//   the hills   a far ridge, only a shade darker than the haze, closing the horizon all round
//
// Every pixel is a function of its direction alone, so the sides meet with no seam. Which side is which, and
// which way up, is SMAK's table (wayOfSide, the engine's own), so a drawn view shows the sky the game shows.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GAME_DIR, K, M, OUT as SHARED_OUT } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const SKY_NAME = "h9waste";
/** Where the six sides are written: the folder of skies the views read, and export.bat ships. */
export const SKY_FOLDER = SHARED_OUT;
const SIZE = 256;

/** The sky's colours and weather, as SMAK's makeSky reads them. */
export const SKY_DESC = {
  zenith: [0.29, 0.3, 0.2], // an olive murk overhead, the storm's belly
  horizon: [0.7, 0.63, 0.44], // dust caught in the low light
  ground: [0.3, 0.26, 0.17],
  haze: 0.9,
  clouds: { cover: 0.62, colour: [0.44, 0.42, 0.29], scale: 2, seed: 9 },
  // the sun low in the south-west: its light goes north-east, as the map's light_environment does
  sun: { yaw: 30, pitch: -19, size: 6, glow: 26, colour: [1, 0.9, 0.62] },
  hills: { height: 3.2, colour: [0.36, 0.32, 0.21], seed: 6, roughness: 0.85 },
  stars: 0,
};

/** The six sides, in SMAK's order (M.SKY_SIDES), each { width, height, rgb }, and their mean. */
export function paintSky(size = SIZE) {
  return M.makeSky({ ...SKY_DESC, size });
}

if (isMain) {
  const sky = paintSky();
  const env = join(SKY_FOLDER, "gfx", "env");
  mkdirSync(env, { recursive: true });
  const files = sky.sides.map((side, k) => ({
    name: `gfx/env/${SKY_NAME}${M.SKY_SIDES[k]}.tga`,
    bytes: M.writeTga(side),
  }));
  for (const file of files) writeFileSync(join(SKY_FOLDER, file.name), file.bytes);
  console.log(`\n  ${files.length} sides of ${SKY_NAME} into ${env}`);

  // the panorama: all round from just under the horizon to overhead, the sun's way in the middle
  const preview = join(HERE, "out", "sky");
  mkdirSync(preview, { recursive: true });
  const W = 1440;
  const H = 420;
  const LOW = -8;
  const HIGH = 88;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const az = 210 - ((x / W) - 0.5) * 360; // the sun's way (210) in the middle
      const el = HIGH - (y / H) * (HIGH - LOW);
      const rad = Math.PI / 180;
      const way = [Math.cos(el * rad) * Math.cos(az * rad), Math.cos(el * rad) * Math.sin(az * rad), Math.sin(el * rad)];
      const c = M.skyColour(sky, ...way);
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(c[k]);
      rgba[i + 3] = 255;
    }
  writeFileSync(join(preview, `${SKY_NAME}-panorama.png`), K.png(W, H, rgba));

  // and the six sides as the game holds them, under one another in SMAK's order
  const strip = new Uint8Array(SIZE * 6 * SIZE * 4);
  sky.sides.forEach((side, k) => {
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const from = (y * SIZE + x) * 3;
        const to = (y * SIZE * 6 + k * SIZE + x) * 4;
        strip[to] = side.rgb[from];
        strip[to + 1] = side.rgb[from + 1];
        strip[to + 2] = side.rgb[from + 2];
        strip[to + 3] = 255;
      }
  });
  writeFileSync(join(preview, `${SKY_NAME}-sides.png`), K.png(SIZE * 6, SIZE, strip));
  console.log(`  mean ${sky.mean.join(" ")}; pictures in ${preview}`);

  if (process.argv.includes("deploy")) {
    // both H9 installs, keeping any sides already there before they are replaced
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const backup = join(HERE, "out", "backups", `sky-${stamp}`);
    const installs = [join(GAME_DIR, "ts"), "D:/Downloads/TSM/H9XASH/ts"];
    let kept = 0;
    installs.forEach((ts, i) => {
      if (!existsSync(ts)) {
        console.log(`  no install at ${ts} -- skipped`);
        return;
      }
      const to = join(ts, "gfx", "env");
      mkdirSync(to, { recursive: true });
      for (const file of files) {
        const name = file.name.split("/").pop();
        const target = join(to, name);
        if (existsSync(target)) {
          mkdirSync(backup, { recursive: true });
          copyFileSync(target, join(backup, `${i === 0 ? "repo" : "downloads"}_${name}`));
          kept++;
        }
        copyFileSync(join(SKY_FOLDER, file.name), target);
      }
      console.log(`  deployed to ${to}`);
    });
    console.log(kept ? `  ${kept} replaced sides kept in ${backup}` : "  no sides replaced");
  }
}
