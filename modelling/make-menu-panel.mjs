// The panels drawn behind the plugin's on-screen text.
//
//     node make-menu-panel.mjs
//
//   sprites/tsm_panel.spr    tall, behind the pick-a-side and class menus
//   sprites/tsm_banner.spr   wide and short, behind the round banner at the top
//
// WHY A SPRITE AND NOT A HUD ELEMENT. GoldSrc gives a server plugin no way to draw into
// the HUD -- but it does let one create a sprite entity, put it where it likes, and show
// it to one player and not another. A VP_PARALLEL sprite always faces the camera, so one
// placed a few units in front of a player's eye IS a screen overlay, and because the text
// is drawn by the HUD after the 3D view, it lands on top without being asked to. The class
// icons over players' heads already use every part of that; the only new thing is where
// the sprite goes.
//
// Neither can be aligned to the pixel. A world-space billboard projects differently at 4:3
// and 16:9 and moves with the player's field of view, so both are drawn with margin -- a
// panel the text sits inside rather than a frame around it -- and the plugin exposes
// distance, offset, scale and alpha as cvars for each.
//
// THE FORMAT is the one read off TS's own sprite and proven by the class sheet: IDSP
// version 2, type 2 (VP_PARALLEL), texFormat 3 (SPR_ALPHTEST), a 256-entry palette.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { K } from "./lib.mjs";

// Running this file draws and writes the sprites. IMPORTING it -- make-menu-viewmodel.mjs
// does, to put the same panel on a model's texture -- takes `panel` and `palette` and
// writes nothing.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const TRANSPARENT = 255;

const OUTS = [
  join(process.cwd(), "..", "sprites"),
  join(process.cwd(), "..", "export", "ts", "sprites"),
  "D:/SteamLibrary/steamapps/common/Half-Life/ts/sprites",
];

/*
 * The palette: dark metal with a coloured rail, because the text over it is white and the
 * one job here is to give white something to be read against. The colour is the panel's
 * because the menu TEXT cannot carry it: the client parses a fixed four colours, red, yellow,
 * white and dim grey, and that is the whole set.
 *
 * The ink is H9's purple, for the panels and the typing bubble alike: every colour sits at
 * the OKLCH hue (302.5) of the site's accent #be8cff (190 140 255, also the console colour),
 * the slab's greys barely tinted, the rail and brackets at full strength. The VGUI scheme's
 * purples in freevgui-h9-scheme.patch sit within four degrees of that hue (138 66 196 at
 * 306, 122 86 180 at 299).
 */
const INK = [
  [8, 7, 10],        // 0  the rim, nearly black
  [22, 19, 26],      // 1  panel, deepest
  [33, 30, 39],      // 2  panel, mid
  [45, 40, 52],      // 3  panel, lit
  [60, 54, 70],      // 4  brushed highlight
  [78, 56, 107],     // 5  purple rail, shadow
  [133, 98, 178],    // 6  purple rail
  [182, 145, 234],   // 7  purple rail, lit
  [216, 192, 252],   // 8  purple, hot
  [16, 10, 24],      // 9  dark plum, the surround outside the chamfer
];
const SURROUND = 9;

/** A 256-entry sprite palette: the ink at 0..9, TRANSPARENT keyed to pure blue, the rest black. */
function inkPalette(ink) {
  const pal = new Uint8Array(256 * 3);
  ink.forEach((c, i) => { pal[i * 3] = c[0]; pal[i * 3 + 1] = c[1]; pal[i * 3 + 2] = c[2]; });
  pal[TRANSPARENT * 3] = 0;
  pal[TRANSPARENT * 3 + 1] = 0;
  pal[TRANSPARENT * 3 + 2] = 255;
  return pal;
}

export const palette = inkPalette(INK);

/*
 * One routine, two proportions.
 *
 * `rail` says which edge carries the purple bar: "left" for the menus, where the numbered
 * lines start from that side, and "top" for the banner, whose text is centred and would be
 * cut through by a vertical bar.
 *
 * The surround is FILLED rather than left transparent. Cut-away corners leave the panel
 * ending on whatever is behind it, and SPR_ALPHTEST has no soft edge to ease that join --
 * it reads as a torn rectangle. Filled, the chamfer is a bevel on a slab instead of a hole
 * through one.
 */
export function panel(W, H, rail) {
  const px = new Uint8Array(W * H).fill(SURROUND);
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    px[y * W + x] = v;
  };

  const M = Math.max(4, Math.round(Math.min(W, H) * 0.025));
  const CUT = Math.max(10, Math.round(Math.min(W, H) * 0.09));
  const L = M, R = W - 1 - M, T = M, B = H - 1 - M;

  const inPanel = (x, y) => {
    if (x < L || x > R || y < T || y > B) return false;
    if ((L + CUT - x) + (T + CUT - y) > CUT) return false;
    if ((x - (R - CUT)) + (T + CUT - y) > CUT) return false;
    if ((L + CUT - x) + (y - (B - CUT)) > CUT) return false;
    if ((x - (R - CUT)) + (y - (B - CUT)) > CUT) return false;
    return true;
  };

  // Brushed metal: a vertical grain with a top-to-bottom fall so it has a light source
  // rather than being an even fill, and a faint scanline so it reads as a screen.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inPanel(x, y)) continue;
      const streak = Math.sin(x * 2.3) * 0.5 + Math.sin(x * 0.7 + 1.3) * 0.5 + Math.sin(x * 7.1) * 0.25;
      const fall = 1 - (y / H) * 0.55;
      const scan = (y % 3 === 0) ? -0.12 : 0;
      const g = fall + streak * 0.10 + scan;
      put(x, y, g > 0.86 ? 4 : g > 0.68 ? 3 : g > 0.46 ? 2 : 1);
    }
  }

  // The purple rail, on the edge the text does not start from.
  const RW = Math.max(3, Math.round(Math.min(W, H) * 0.02));
  if (rail === "left") {
    const RX = L + Math.round(W * 0.027);
    for (let y = T + CUT - 4; y <= B - CUT + 4; y++) {
      for (let x = RX; x < RX + RW; x++) {
        if (!inPanel(x, y)) continue;
        const t = (x - RX) / RW;
        put(x, y, t < 0.25 ? 5 : t < 0.7 ? 6 : 7);
      }
    }
  } else {
    const RY = T + Math.round(H * 0.08);
    for (let x = L + CUT - 4; x <= R - CUT + 4; x++) {
      for (let y = RY; y < RY + RW; y++) {
        if (!inPanel(x, y)) continue;
        const t = (y - RY) / RW;
        put(x, y, t < 0.25 ? 5 : t < 0.7 ? 6 : 7);
      }
    }
  }

  /*
   * Corner brackets rather than a full border: a continuous frame competes with the text
   * for attention, where brackets only bound it.
   */
  const BR = Math.max(16, Math.round(Math.min(W, H) * 0.14)), BW = 3;
  const bracket = (cx, cy, dx, dy) => {
    for (let i = 0; i < BR; i++) {
      for (let w = 0; w < BW; w++) {
        put(cx + dx * i, cy + dy * w, 7);
        put(cx + dx * w, cy + dy * i, 7);
      }
    }
  };
  bracket(L + CUT, T + 2, 1, 1);
  bracket(R - CUT, T + 2, -1, 1);
  bracket(L + CUT, B - 2, 1, -1);
  bracket(R - CUT, B - 2, -1, -1);

  // The rim last, so it sits over everything: a dark ring where panel meets surround,
  // turning the chamfer into a bevelled edge rather than a colour change.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inPanel(x, y)) continue;
      let touches = false;
      for (let dy = -2; dy <= 2 && !touches; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (inPanel(x + dx, y + dy)) { touches = true; break; }
        }
      }
      if (touches) put(x, y, 0);
    }
  }

  return px;
}

/** One frame, in the format read off TS's own sprites. */
function writeSpr(name, W, H, px) {
  const header = Buffer.alloc(42);
  header.write("IDSP", 0, "ascii");
  header.writeInt32LE(2, 4);
  header.writeInt32LE(2, 8);                      // VP_PARALLEL: always faces the viewer
  header.writeInt32LE(3, 12);                     // SPR_ALPHTEST
  header.writeFloatLE(Math.hypot(W, H) / 2, 16);  // bounding radius
  header.writeInt32LE(W, 20);
  header.writeInt32LE(H, 24);
  header.writeInt32LE(1, 28);
  header.writeFloatLE(0, 32);
  header.writeInt32LE(0, 36);
  header.writeInt16LE(256, 40);

  const fh = Buffer.alloc(20);
  fh.writeInt32LE(0, 0);
  fh.writeInt32LE(-W / 2, 4);
  fh.writeInt32LE(H / 2, 8);
  fh.writeInt32LE(W, 12);
  fh.writeInt32LE(H, 16);

  const spr = Buffer.concat([header, Buffer.from(palette), fh, Buffer.from(px)]);
  let wrote = 0;
  for (const dir of OUTS) {
    if (!existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), spr);
    wrote++;
  }
  console.log(`  ${name.padEnd(16)} ${W}x${H}  ${spr.length} bytes  -> ${wrote} place(s)`);
}

/*
 * The typing bubble, which is a different kind of thing from the panels.
 *
 * It is NOT screen UI and does not want to be: it marks a place in the world, above a
 * head, which is exactly what the class icons do and exactly what a sprite is good at.
 * That is also why the menu panel failed and this will not -- a world marker is supposed
 * to sit in the world.
 *
 * FOUR FRAMES, so it animates. The engine is told which frame to show through pev_frame,
 * the same way the class sheet is driven, so the dots can run without any new mechanism.
 */
function typingFrame(W, H, lit) {
  const px = new Uint8Array(W * H).fill(TRANSPARENT);
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    px[y * W + x] = v;
  };

  // A hard-edged tag rather than a soft speech balloon: chamfered left, notched right,
  // which reads as a readout rather than a cartoon.
  const T = 10, B = H - 20, Lx = 8, Rx = W - 9, CUT = 10;
  const inTag = (x, y) => {
    if (x < Lx || x > Rx || y < T || y > B) return false;
    if ((Lx + CUT - x) + (T + CUT - y) > CUT) return false;
    if ((Lx + CUT - x) + (y - (B - CUT)) > CUT) return false;
    return true;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inTag(x, y)) continue;
      const fall = 1 - ((y - T) / (B - T)) * 0.5;
      const scan = (y % 3 === 0) ? -0.12 : 0;
      const g = fall + scan;
      put(x, y, g > 0.80 ? 3 : g > 0.55 ? 2 : 1);
    }
  }

  // The stem, pointing down at the head it belongs to.
  const SX = Math.round(W * 0.26);
  for (let i = 0; i < 18; i++) {
    for (let w = -(9 - Math.round(i / 2)); w <= (9 - Math.round(i / 2)); w++) {
      put(SX + w, B + i, 1);
    }
  }

  // Three dots; the lit one is the frame's own.
  const DY = Math.round((T + B) / 2), DR = 7;
  for (let d = 0; d < 3; d++) {
    const cx = Math.round(W * 0.30) + d * Math.round(W * 0.20);
    const on = (d === lit);
    for (let y = DY - DR; y <= DY + DR; y++) {
      for (let x = cx - DR; x <= cx + DR; x++) {
        if ((x - cx) ** 2 + (y - DY) ** 2 > DR * DR) continue;
        put(x, y, on ? 8 : 5);
      }
    }
  }

  // The purple rail down the cut edge, and the dark rim, as the panels have.
  for (let y = T + CUT; y <= B - CUT; y++) {
    for (let x = Lx + 3; x < Lx + 6; x++) put(x, y, 7);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (px[y * W + x] !== TRANSPARENT) continue;
      let touches = false;
      for (let dy = -2; dy <= 2 && !touches; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (px[ny * W + nx] !== TRANSPARENT && px[ny * W + nx] !== 0) { touches = true; break; }
        }
      }
      if (touches) put(x, y, 0);
    }
  }
  return px;
}

/** Several frames in one sprite, which is what lets pev_frame animate it. */
function writeSprFrames(name, W, H, frames, pal) {
  const header = Buffer.alloc(42);
  header.write("IDSP", 0, "ascii");
  header.writeInt32LE(2, 4);
  header.writeInt32LE(2, 8);
  header.writeInt32LE(3, 12);
  header.writeFloatLE(Math.hypot(W, H) / 2, 16);
  header.writeInt32LE(W, 20);
  header.writeInt32LE(H, 24);
  header.writeInt32LE(frames.length, 28);
  header.writeFloatLE(0, 32);
  header.writeInt32LE(0, 36);
  header.writeInt16LE(256, 40);

  const parts = [header, Buffer.from(pal)];
  for (const px of frames) {
    const fh = Buffer.alloc(20);
    fh.writeInt32LE(0, 0);
    fh.writeInt32LE(-W / 2, 4);
    fh.writeInt32LE(H / 2, 8);
    fh.writeInt32LE(W, 12);
    fh.writeInt32LE(H, 16);
    parts.push(fh, Buffer.from(px));
  }
  const spr = Buffer.concat(parts);
  let wrote = 0;
  for (const dir of OUTS) {
    if (!existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), spr);
    wrote++;
  }
  console.log(`  ${name.padEnd(16)} ${W}x${H} x${frames.length}  ${spr.length} bytes  -> ${wrote} place(s)`);
  return spr;
}

if (isMain) {
  const SHAPES = [
    // The menus are a tall block of numbered lines, so the rail runs down the left where
    // those numbers start.
    { name: "tsm_panel.spr",  w: 256, h: 256, rail: "left" },
    // The round banner is a few centred lines, so a vertical rail would cut through it --
    // this one carries its bar along the top instead.
    { name: "tsm_banner.spr", w: 256, h: 96,  rail: "top" },
  ];

  for (const sh of SHAPES) {
    const px = panel(sh.w, sh.h, sh.rail);
    writeSpr(sh.name, sh.w, sh.h, px);

    const rgba = Buffer.alloc(sh.w * sh.h * 4);
    for (let i = 0; i < sh.w * sh.h; i++) {
      const v = px[i], o = i * 4;
      rgba[o] = palette[v * 3]; rgba[o + 1] = palette[v * 3 + 1]; rgba[o + 2] = palette[v * 3 + 2]; rgba[o + 3] = 255;
    }
    writeFileSync(join(process.cwd(), "..", "export-mdl", sh.name.replace(".spr", ".png")),
      K.png(sh.w, sh.h, rgba));
  }
  // The typing bubble: four frames, the lit dot walking along and then a blank beat.
  {
    const W = 128, H = 96;
    const frames = [0, 1, 2, -1].map((lit) => typingFrame(W, H, lit));
    writeSprFrames("tsm_typing.spr", W, H, frames, palette);

    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const v = frames[0][i], o = i * 4;
      /*
       * Dark plum where the sprite is transparent, the panels' surround, so the preview
       * shows the colour you would actually see around it rather than a flag colour.
       *
       * The BUBBLE really is transparent there and has to be: it is a tag with a stem
       * hanging over somebody's head, and filling the corners would put a plum rectangle
       * above every player instead of a shape.
       */
      if (v === TRANSPARENT) {
        rgba[o] = palette[SURROUND * 3]; rgba[o + 1] = palette[SURROUND * 3 + 1]; rgba[o + 2] = palette[SURROUND * 3 + 2]; rgba[o + 3] = 255;
        continue;
      }
      rgba[o] = palette[v * 3]; rgba[o + 1] = palette[v * 3 + 1]; rgba[o + 2] = palette[v * 3 + 2]; rgba[o + 3] = 255;
    }
    writeFileSync(join(process.cwd(), "..", "export-mdl", "tsm_typing.png"), K.png(W, H, rgba));
  }

  console.log("  wrote export-mdl/tsm_panel.png, tsm_banner.png and tsm_typing.png");
}
