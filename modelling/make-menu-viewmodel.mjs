// The menu backdrop and the round banner as a VIEW MODEL, which is the only way a server
// plugin puts a picture at a fixed place on the screen.
//
//     node make-menu-viewmodel.mjs
//
//   models/v_tsmpanel.mdl              both panels, drawn in front of the eye
//   export-mdl/v_tsmpanel_preview.png  what they look like at three resolutions
//
// WHY THIS AND NOT A SPRITE. The first try at this was a sprite entity parked a few units in
// front of the player's eye. It worked and it was useless: the client PREDICTS the view from
// the mouse immediately but RECEIVES entity positions from the server and interpolates between
// them, so a networked entity can never keep up with a turn. The panel swam.
//
// A view model does not, because it is not a networked entity. The player's viewmodel field
// reaches the client as part of the player's own state and the client draws it as a child of
// the camera -- the same path the player's weapon takes, which is why a gun never lags behind
// the mouse. It is drawn with the 3D scene, so the HUD and the engine's menu land on top of it
// without being asked to, which is exactly the layering a backdrop wants.
//
// WHAT IT COSTS, AND IT IS NOT SMALL. A player has ONE view model. They do not stack: setting
// this one REPLACES the weapon's, so while a panel is up the gun is not drawn. That is why
// both of these belong to the pick-a-class countdown, the one moment a player is holding
// nothing, and why the banner cannot stay up into a live round.
//
// VIEW SPACE is the model's own space, Quake's: +X forward, +Y LEFT, +Z up, the origin at the
// eye. A panel is a rectangle at a constant X, and because its depth is constant its
// projection is affine: a plain rectangle on the screen, with no perspective to fight.
//
// ---------------------------------------------------------------------------------------
// THE ONE THING THAT DECIDES EVERY NUMBER BELOW
//
// The text these sit behind is drawn in WHOLE PIXELS and does not grow with the screen. The
// engine's own menu, from the SDK's CHudMenu::Draw, is at x = 20 with twelve pixels a line,
// wherever the screen ends. A view model is an ANGLE, so it takes the same SHARE of the screen
// at every resolution. Those two cannot agree at more than one resolution at a time.
//
// So nothing here is sized by eye. The panels are drawn around the text's real pixel rectangle
// at one resolution, and every other resolution in FITS gets an animation of its own holding
// the bones where that same rectangle lands there -- solved, not guessed, by fitTo(). The
// plugin picks one with a cvar and sends it as a weapon animation, which costs nothing to carry
// and saves the model being rebuilt and downloaded again by everyone each time it is a little
// off.
// ---------------------------------------------------------------------------------------
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { K } from "./lib.mjs";
import { panel, palette } from "./make-menu-panel.mjs";

// ---- where it goes ----------------------------------------------------------------------
const OUTS = [
  join(process.cwd(), "out"),
  // beside sprites/, which is where export.bat picks both of them up from; writing into
  // export/ directly would leave the package unbuildable from a clean clone
  join(process.cwd(), "..", "models"),
  "D:/SteamLibrary/steamapps/common/Half-Life/ts/models",
];

// ---- what the engine does, which is what these are sized against -------------------------
/*
 * From the Half-Life SDK, hud_menu.cpp: twelve pixels a line, twenty in from the left, the
 * block centred and then lifted forty pixels "to make sure it is above the say text". All of
 * it in real pixels, none of it scaled with the screen.
 */
const MENU_X = 20;
const MENU_LINE = 12;
const MENU_LIFT = 40;
/** The engine's console face is eight pixels to the character. */
const CHAR_W = 8;
/** Title, a gap, six classes, a gap, exit. */
const MENU_LINES = 10;
/** "TS Match -- pick your class", the longest line it has. */
const MENU_WIDEST = 27;

/*
 * The round banner is a hudmessage, and those ARE placed in fractions of the screen -- but
 * their TEXT is the same fixed pixels, so the panel behind it is sized the same way. Two lines,
 * from show_hudmessage in ts_matchmode.sma: "ROUND n -- m:ss" over "<team> n -- n <team>".
 */
const BANNER_Y = 0.03;
const BANNER_LINES = 2;
const BANNER_WIDEST = 30;

/** Pixels of panel beyond the text on every side. */
const MARGIN = 10;

/** The resolution the panels are DRAWN at. Every other one is solved for from here. */
const REF = { w: 1280, h: 720 };

// ---- view space ---------------------------------------------------------------------------
const DEPTH = 10;
/*
 * At fov 90 the left edge of the view is at Y = DEPTH * tan(45) = DEPTH, and GoldSrc holds the
 * HORIZONTAL fov -- a wider monitor shows less above and below, never more to the sides. The
 * vertical half-angle therefore depends on the aspect, which is why a fit is solved for a whole
 * RESOLUTION and not just a width: the same panel that sits over its text at 1280x720 sits
 * above it at 640x480 unless the height is in the sum.
 */
const ndcToY = (ndc, depth) => -ndc * depth;
const ndcToZ = (ndc, depth, w, h) => ndc * depth * (h / w);

/** Where the engine will put the class menu's text, in pixels. */
const menuText = (w, h) => ({
  x0: MENU_X,
  x1: MENU_X + MENU_WIDEST * CHAR_W,
  y0: h / 2 - (MENU_LINES / 2) * MENU_LINE - MENU_LIFT,
  y1: h / 2 + (MENU_LINES / 2) * MENU_LINE - MENU_LIFT,
});
/** Where the round banner's text goes, in pixels: centred, a fraction down. */
const bannerText = (w, h) => ({
  x0: (w - BANNER_WIDEST * CHAR_W) / 2,
  x1: (w + BANNER_WIDEST * CHAR_W) / 2,
  y0: BANNER_Y * h,
  y1: BANNER_Y * h + BANNER_LINES * MENU_LINE,
});
/** That rectangle with the panel's margin round it. The menu's left margin is cut to the screen
 *  edge: the text starts twenty real pixels in, and a panel floating twenty pixels off the side
 *  of the screen reads as a mistake rather than as a frame. */
const around = (r, toEdge = false) => ({
  x0: toEdge ? 0 : r.x0 - MARGIN,
  x1: r.x1 + MARGIN,
  y0: r.y0 - MARGIN,
  y1: r.y1 + MARGIN,
});

/** A pixel rectangle as a box in view space, at DEPTH, on a screen w by h. */
const boxOf = (r, w, h) => ({
  left: ndcToY((2 * r.x0) / w - 1, DEPTH),
  right: ndcToY((2 * r.x1) / w - 1, DEPTH),
  top: ndcToZ(1 - (2 * r.y0) / h, DEPTH, w, h),
  bottom: ndcToZ(1 - (2 * r.y1) / h, DEPTH, w, h),
});

const MENU = boxOf(around(menuText(REF.w, REF.h), true), REF.w, REF.h);
const BANNER = boxOf(around(bannerText(REF.w, REF.h)), REF.w, REF.h);

/**
 * Where to put a box's bone so the box lands on `want` (pixels) on a screen w by h.
 *
 * A rigid quad has three degrees of freedom here and four things to satisfy, so something has
 * to give: this fits the WIDTH exactly, pins the LEFT edge exactly, and centres it vertically
 * on the text. The height then falls where the proportions put it, which is right at the
 * resolution the panel was drawn for and close everywhere else -- and a backdrop a little
 * taller than its text is fine, where one a little short is not.
 */
function fitTo(box, want, w, h) {
  // the quad's width in ndc is (left - right) / depth, so the depth that makes it `want` wide
  const depth = ((box.left - box.right) * w) / (2 * (want.x1 - want.x0));
  const midZ = (box.top + box.bottom) / 2;
  return [
    depth - DEPTH,
    ndcToY((2 * want.x0) / w - 1, depth) - box.left,
    ndcToZ(1 - (want.y0 + want.y1) / h, depth, w, h) - midZ,
    0, 0, 0,
  ];
}

/*
 * Every resolution anyone is going to run this on. Each is one frame of one animation, which is
 * a handful of bytes, so the list costs nothing and covers the 4:3 and 16:10 shapes as well as
 * the widescreens.
 */
const FITS = [
  [640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 720], [1280, 960], [1280, 1024],
  [1366, 768], [1440, 900], [1600, 900], [1600, 1200], [1680, 1050], [1920, 1080], [1920, 1200],
  [2560, 1440], [3840, 2160],
];
const placement = (w, h) => [
  fitTo(MENU, around(menuText(w, h), true), w, h),
  fitTo(BANNER, around(bannerText(w, h)), w, h),
];

// ---- the textures ---------------------------------------------------------------------------
/*
 * Both sides a power of two: GoldSrc stretches a texture that is not to one as it loads it, and
 * the resample costs sharpness for nothing. Each is drawn at about the proportions it is seen at
 * so its bevels and its rail do not come out skewed.
 */
const SHAPES = {
  menu: { w: 256, h: 128, rail: "left", box: MENU },
  banner: { w: 256, h: 64, rail: "top", box: BANNER },
};

/**
 * One flat panel at DEPTH, wearing the whole of its texture, drawn on BOTH sides.
 *
 * Both sides because GoldSrc culls back faces on a studio model, so a flat quad facing the
 * wrong way is INVISIBLE rather than wrong-looking -- there is nothing to see and nothing to
 * tell you why. That is how the first cut of this failed: it rendered from exactly one angle
 * in SMAK's own sheet and from none in the game. Two faces cost two triangles and remove the
 * question permanently, which is worth more here than being clever about the winding.
 */
function quadOf(box, tw, th, bone) {
  const mesh = K.workshop.shape(tw, th);
  const corners = [
    [DEPTH, box.left, box.top],
    [DEPTH, box.right, box.top],
    [DEPTH, box.right, box.bottom],
    [DEPTH, box.left, box.bottom],
  ];
  // quad() turns the face away from the point given last, so putting that point first behind
  // the panel and then in front of it gives one face each way
  for (const away of [DEPTH + 10, DEPTH - 10]) {
    mesh.quad(
      ...corners.map((p, i) => mesh.V(p, [[0, tw, tw, 0][i], [0, 0, th, th][i]], 0)),
      [away, (box.left + box.right) / 2, (box.top + box.bottom) / 2],
    );
  }
  return mesh.tris.map((tri) => tri.map((corner) => ({ ...corner, bone })));
}

/*
 * flags 4 is STUDIO_NF_FULLBRIGHT. Without it a panel is lit by the map like any other model --
 * black in a dark room, blown out under a light -- and a backdrop whose brightness depends on
 * where the player happens to be standing is not a backdrop. With it the renderer skips lighting
 * for the texture and the panel reads the same everywhere, like a HUD element.
 */
const textureOf = (key) => ({
  name: `tsm${key}.bmp`,
  width: SHAPES[key].w,
  height: SHAPES[key].h,
  pixels: panel(SHAPES[key].w, SHAPES[key].h, SHAPES[key].rail),
  palette,
  flags: 4,
});

// ---- the model ------------------------------------------------------------------------------
/*
 * ONE BODYPART, ONE SUBMODEL, BOTH PANELS IN IT, ALWAYS DRAWN.
 *
 * This started out as two bodyparts, each with an empty submodel and a panel, so that `body`
 * could choose between them. It drew NOTHING in the game, and the reason is that `body`
 * defaults to 0, which selected the two EMPTY submodels -- the engine takes a view model's
 * body from the player's clientdata, not reliably from the byte in SVC_WEAPONANIM, so the
 * byte the plugin was sending never arrived and the default stood.
 *
 * Nothing here depends on `body` any more. Both panels are meshes of the same submodel, so
 * whatever the engine believes the body is, they draw. They are only ever up together anyway,
 * during the one window a panel is raised at all.
 */
const mdl = K.buildMdl({
  name: "v_tsmpanel.mdl",
  bones: [
    { name: "menu", parent: -1 },
    { name: "banner", parent: -1 },
  ],
  bodyparts: [
    {
      name: "panels",
      models: [
        {
          name: "panels",
          meshes: [
            { tris: quadOf(MENU, SHAPES.menu.w, SHAPES.menu.h, "menu"), texture: textureOf("menu") },
            { tris: quadOf(BANNER, SHAPES.banner.w, SHAPES.banner.h, "banner"), texture: textureOf("banner") },
          ],
        },
      ],
    },
  ],
  sequences: FITS.map(([w, h]) => ({
    name: `fit${w}x${h}`,
    fps: 10,
    loops: true,
    frames: [placement(w, h)],
  })),
});

const report = K.check(mdl, "goldsrc");
for (const line of report.facts) console.log(`  ${line}`);
for (const w of report.warnings) console.log(`  WARN  ${w}`);
for (const e of report.errors) console.log(`  ERROR ${e}`);
if (report.errors.length) process.exit(1);

let wrote = 0;
for (const dir of OUTS) {
  if (!existsSync(dir) && dir.startsWith("D:/SteamLibrary")) continue;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "v_tsmpanel.mdl"), mdl);
  wrote++;
}
console.log(`\n  v_tsmpanel.mdl  ${mdl.length} bytes  -> ${wrote} place(s)`);
console.log("  tsm_vm_fit, the screen it is fitted to:");
FITS.forEach(([w, h], i) =>
  console.log(`    ${String(i).padStart(2)}  ${w}x${h}${w === REF.w && h === REF.h ? "   (as drawn)" : ""}`),
);

// ===== the preview ===========================================================================
/*
 * Not a render of the model: a render of the SCREEN, at real resolutions, with the engine's own
 * text metrics. A panel's depth is constant so its projection is exactly a rectangle, and working
 * that rectangle out from the same constants the geometry uses is a truer preview than a camera
 * would be -- and putting the text at its real pixel size is the only way to see the thing that
 * actually decides whether these fit.
 */
function screenRect(box, w, h, [dx, dy, dz]) {
  const depth = DEPTH + dx;
  const ndcx = (y) => -(y + dy) / depth;
  const ndcy = (z) => (z + dz) / (depth * (h / w));
  return {
    x0: ((ndcx(box.left) + 1) / 2) * w,
    x1: ((ndcx(box.right) + 1) / 2) * w,
    y0: ((1 - ndcy(box.top)) / 2) * h,
    y1: ((1 - ndcy(box.bottom)) / 2) * h,
  };
}

// A 3x5 face at scale 2 is eight pixels to the character and ten tall, about what the engine's
// console face is -- and, like it, it does not grow with the screen.
const GLYPHS = {
  A: "111101111101101", B: "110101110101110", C: "111100100100111", D: "110101101101110",
  E: "111100111100111", F: "111100111100100", G: "111100101101111", H: "101101111101101",
  I: "111010010010111", J: "001001001101111", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "111101101101111", P: "111101111100100",
  Q: "111101101111001", R: "111101111110101", S: "111100111001111", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111",
  0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111",
  4: "101101111001001", 5: "111100111001111", 6: "111100111101111", 7: "111001001001001",
  8: "111101111101111", 9: "111101111001111",
  ".": "000000000000010", "-": "000000111000000", ":": "000010000010000", " ": "0".repeat(15),
};
const TEXT_SCALE = 2;

/** One screen, at its true pixel size, with the panels at the fit solved for it. */
function frame(w, h, label) {
  const rgba = Buffer.alloc(w * h * 4);
  const put = (x, y, r, g, b) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  };
  // a stand-in for the world behind them, with edges to judge the panels against
  const horizon = h * 0.55;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = y < horizon ? 52 + (y / horizon) * 26 : 40 - ((y - horizon) / (h - horizon)) * 18;
      for (const [wx, ww] of [
        [w * 0.3, w * 0.1],
        [w * 0.62, w * 0.14],
      ])
        if (x > wx && x < wx + ww && y < horizon) v *= 1.35;
      if (Math.abs(y - horizon) < 1.5) v *= 1.5;
      put(x, y, v * 0.92, v, v * 1.08);
    }
  const place = placement(w, h);
  for (const [key, bone] of [
    ["menu", 0],
    ["banner", 1],
  ]) {
    const shape = SHAPES[key];
    const px = panel(shape.w, shape.h, shape.rail);
    const r = screenRect(shape.box, w, h, place[bone]);
    for (let y = Math.floor(r.y0); y < r.y1; y++)
      for (let x = Math.floor(r.x0); x < r.x1; x++) {
        const u = Math.min(shape.w - 1, Math.max(0, Math.floor(((x - r.x0) / (r.x1 - r.x0)) * shape.w)));
        const v = Math.min(shape.h - 1, Math.max(0, Math.floor(((y - r.y0) / (r.y1 - r.y0)) * shape.h)));
        const i = px[v * shape.w + u];
        put(x, y, palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]);
      }
  }
  /** A line of text in whole pixels, as the engine draws it. */
  const text = (s, x, y, colour) => {
    let cx = Math.round(x);
    for (const ch of s.toUpperCase()) {
      const g = GLYPHS[ch] ?? GLYPHS[" "];
      for (let gy = 0; gy < 5; gy++)
        for (let gx = 0; gx < 3; gx++)
          if (g[gy * 3 + gx] === "1")
            for (let sy = 0; sy < TEXT_SCALE; sy++)
              for (let sx = 0; sx < TEXT_SCALE; sx++)
                put(cx + gx * TEXT_SCALE + sx, y + gy * TEXT_SCALE + sy, colour[0], colour[1], colour[2]);
      cx += 4 * TEXT_SCALE;
    }
  };
  // the class menu, where CHudMenu::Draw puts it
  const lines = [
    "TS MATCH - PICK YOUR CLASS", "", "1. ASSAULT", "2. BREACHER", "3. MARKSMAN",
    "4. HEAVY", "5. MEDIC", "6. OFFICER", "", "0. EXIT",
  ];
  const mt = menuText(w, h);
  let y = mt.y0;
  for (const line of lines) {
    if (line) text(line, mt.x0, y, line.startsWith("TS") ? [255, 220, 90] : [235, 240, 248]);
    y += MENU_LINE;
  }
  // the round banner, where its own hudmessage puts it
  const bt = bannerText(w, h);
  let by = bt.y0;
  for (const line of ["ROUND 3 - 4:35", "MSR 2 - 1 INSURGENTS"]) {
    text(line, (w - line.length * CHAR_W) / 2, by, [0, 200, 255]);
    by += MENU_LINE;
  }
  text(label, 8, h - 16, [120, 200, 255]);
  return rgba;
}

// three real resolutions at their TRUE pixel sizes, never scaled to match each other, because the
// whole point is that the text stays the same size while the panels do not
const GAP = 12;
const ROWS = [
  [
    [640, 480, "640X480  4:3"],
    [1280, 720, "1280X720  AS DRAWN"],
  ],
  [[1920, 1080, "1920X1080"]],
];
const PW = Math.max(...ROWS.map((row) => row.reduce((n, s) => n + s[0], 0) + GAP * (row.length - 1)));
const PH = ROWS.reduce((n, row) => n + Math.max(...row.map((s) => s[1])), 0) + GAP * (ROWS.length - 1);
const out = Buffer.alloc(PW * PH * 4);
let oy = 0;
for (const row of ROWS) {
  const rowH = Math.max(...row.map((s) => s[1]));
  let ox = 0;
  for (const [w, h, label] of row) {
    const got = frame(w, h, label);
    const top = oy + Math.round((rowH - h) / 2);
    for (let y = 0; y < h; y++) got.copy(out, ((y + top) * PW + ox) * 4, y * w * 4, (y * w + w) * 4);
    ox += w + GAP;
  }
  oy += rowH + GAP;
}
const preview = join(process.cwd(), "..", "export-mdl", "v_tsmpanel_preview.png");
writeFileSync(preview, K.png(PW, PH, out));

// and the proof that the fit is a solve and not a guess: every resolution in FITS, the panel's
// rectangle against the text's, in pixels
console.log(`\n  ${preview}`);
console.log("  panel vs text, in pixels, at every fit:");
for (const [w, h] of FITS) {
  const place = placement(w, h);
  const r = screenRect(MENU, w, h, place[0]);
  const t = menuText(w, h);
  const b = screenRect(BANNER, w, h, place[1]);
  const bt = bannerText(w, h);
  const covers = (q, x) => q.x0 <= x.x0 + 0.5 && q.x1 >= x.x1 - 0.5 && q.y0 <= x.y0 + 0.5 && q.y1 >= x.y1 - 0.5;
  console.log(
    `    ${String(`${w}x${h}`).padEnd(10)} menu ${covers(r, t) ? "covers" : "MISSES"}` +
      ` (${Math.round(r.x1 - r.x0)}x${Math.round(r.y1 - r.y0)} over ${Math.round(t.x1 - t.x0)}x${Math.round(t.y1 - t.y0)})` +
      `   banner ${covers(b, bt) ? "covers" : "MISSES"}`,
  );
}
