// Pictures of a map, with nothing but arithmetic: no browser, no GPU. A compile that passes can still be dark
// or have a door in the wrong wall, and only a picture shows it.
//
//   drawMap(bsp, options)        a view from a point inside a compiled map, textured and lit by its lightmaps
//   planOf(bsp, options)         the map from above: floors, walls, every entity marked, a scale and north
//   viewsOf(bsp, options)        several views in one picture: from each start, and from the largest rooms
//   drawSource(map, options)     a view of brush source (what `writeMap` takes), before any compile
//   planOfSource(map, options)   its plan: a cut through the brushes at a height
//   viewFrom(bspOrMap, which)    where an entity stands and the way it looks, for a view from it
//
// Each gives `{ width, height, rgba, facts }`: a picture as `render` gives one (`png(width, height, rgba)`
// writes it), and what was drawn in numbers and sentences. Axes are the game's: +x east, +y north, +z up.
//
// The light of a compiled map is its own: each face's lightmap, made brighter by one number that stands in
// for what the engine does to it. Textures come from the map itself, from textures handed over, or from the .wad
// files of the game's folders; one that is found nowhere is drawn in a flat colour of its own and named in
// `facts.missing`. A point entity's model is not looked for: it is marked by a small box with its class.
import { sub, dot, cross, unit } from "../vec.mjs";
import { label, tile } from "../render.mjs";
import { drawLine } from "../pixels.mjs";
import {
  CONTENTS,
  LUXEL,
  contentsAt,
  contentsName,
  leafAt,
  floorUnder,
  worldBounds,
  facePolygon,
  faceNormal,
  faceLightmap,
  visibleFrom,
  embeddedTexture,
} from "./bsp.mjs";
import { textureKind, HOLE } from "./miptex.mjs";
import { texturesFor } from "./wad.mjs";
import { valueOf, numberOf, originOf, anglesOf, brushModelOf } from "./entities.mjs";
import { shapeOf } from "./source.mjs";

// ── constants ───────────────────────────────────────────────────────────────
/** A view's size and how wide it looks, in degrees across, unless told. */
const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 480;
const VIEW_FOV = 90;
/** A picture's side may be this many pixels at the least and at the most. */
const SIDE_LEAST = 16;
const SIDE_MOST = 4096;
/** What is nearer the eye than this many units is cut off. */
const NEAR = 2;
/** A face whose plane passes this near the eye (units) is seen edge on and not drawn. */
const EDGE_ON = 0.01;
/** A standing player's eyes are this far over its origin (which is 36 over the floor: eyes at 64). */
const EYE_OVER_ORIGIN = 28;
/** The eyes over a floor, for a view from the middle of a room. */
const EYE_OVER_FLOOR = 64;
/** The colours of what has no picture: the sky, a view's ground where nothing is, and a plan's. */
const SKY_COLOUR = [118, 164, 214];
const NOTHING = [14, 14, 18];
/**
 * The colours of a plan. `solid` is what a cut finds filled; `rock` what the plan from above finds no floor
 * in; `water` and `sky` tint what a cut finds of them.
 */
export const PLAN_COLOURS = {
  solid: [112, 74, 58],
  rock: [26, 28, 34],
  water: [52, 96, 168],
  sky: [150, 186, 226],
  wall: [236, 236, 240],
  ink: [235, 235, 235],
};
/** The colours of the marks, by what an entity is. */
export const MARK_COLOURS = {
  start: [70, 230, 90],
  light: [255, 226, 70],
  monster: [255, 80, 70],
  other: [90, 220, 235],
  brush: [255, 150, 40],
  trigger: [225, 90, 230],
};
/** What tells the kinds of entities apart, by classname. */
const KIND_PATTERNS = {
  start: /^(info_player_|ms_player_)/,
  light: /^light/,
  monster: /^(monster_|msmonster_|ms_npc|msnpc_|npc_)/,
};
/** Brush entities that the game never draws, whatever they wear. */
const NEVER_DRAWN = /^(trigger_|func_ladder$|func_monsterclip$|func_buyzone$|func_bomb_target$|msarea_)/;
/** The render modes of an entity in which `renderamt` says how solid it looks (0: not at all). */
const FADING_MODES = [1, 2, 3, 5];
const ADDITIVE_MODE = 5;
const FULL_AMOUNT = 255;
/** How solid a liquid of the world is drawn: what is under it shows through. */
const LIQUID_ALPHA = 0.62;
/**
 * What a light sample is multiplied by before it multiplies the texture: the game shows a map brighter
 * than the bytes its compiler stored. Measured against the game's own screenshots of one map (Xash in the
 * browser, its defaults): a straight 1.55 came within 10 levels in 255 a channel, with no tint; a curve
 * (a gamma) fitted worse and tinted the picture. 1 is the samples as stored.
 */
const BRIGHTNESS = 1.55;
/**
 * The light styles a picture adds up, by its `light`: all under the number. Style 0 is always on; 1 to 31
 * are the game's own patterns (a torch that flickers), which are on by themselves and drawn at their full;
 * from 32 up are the lights a switch turns on and off.
 */
const STYLES_BELOW = { true: 32, steady: 1, all: 256 };
const LIGHT_WORDS = {
  true: "lightmaps: the steady light and the flickering styles (0 to 31)",
  steady: "lightmaps: the steady light alone (style 0)",
  all: "lightmaps: every style, the switched lights as if on",
};
/** A plan with more marks than this labels only the places to start, unless told to label all. */
const LABELS_MOST = 60;
/**
 * A view of source draws each face's edges darker, the face's colour times this; an edge is drawn where
 * what the picture shows there is no nearer than this share of the edge's own distance, and is walked in no
 * more steps than the last.
 */
const OUTLINE_SHARE = 0.55;
const OUTLINE_NEARER = 0.985;
const OUTLINE_STEPS_MOST = 8192;
/** Without lightmaps: every face gets `AMBIENT`, and up to `DIRECT` more as it turns to the lamp. */
const AMBIENT = 0.5;
const DIRECT = 0.5;
const LAMP = unit([0.35, 0.5, 0.8]);
/** A smaller size of a texture is used once a pixel covers this many of its texels. */
const TEXELS_A_PIXEL = 1.4;
/** On a plan a floor keeps this much of its colour in no light at all, so that a dark room is still read. */
const PLAN_AMBIENT = 0.4;
/** And every floor of a plan is lifted this far towards white, so that the darkest is lighter than the rock. */
const PLAN_LIFT = 40;
/** A view whose mean brightness is under this (of 255) is said to be dark, with what to do about it. */
const DARK_VIEW = 24;
/** A plan's side unless told, its margin, and the band under it for the scale and the legend (pixels). */
const PLAN_SIDE = 1024;
const PLAN_MARGIN = 24;
const PLAN_FOOT = 46;
/** A face that looks this much upwards is a floor on a plan; one that looks this little, a wall. */
const FLOOR_LEAST = 0.3;
const WALL_MOST = 0.3;
/** A wall's line on a plan is hidden by a floor more than this many units above its top. */
const LINE_COVER = 2;
/** The lengths a plan's scale bar may have (units), and the pixels it may take at most. */
const BAR_LENGTHS = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
const BAR_MOST = 180;
/** A mark on a plan: the dot's radius, and the length of the line that shows which way it faces (pixels). */
const DOT_RADIUS = 3;
const FACING_LENGTH = 9;
/** The side of the box a point entity is marked by in a view (units). */
const MARK_SIDE = 16;
/** `viewsOf`: its cells unless told, their size, and how many go in a row. */
const VIEWS_COUNT = 8;
const CELL_WIDTH = 320;
const CELL_HEIGHT = 240;
const VIEWS_COLUMNS = 4;
/** The four ways a room is looked at from its middle (yaw, degrees). */
const FOUR_WAYS = [0, 90, 180, 270];
/** A leaf under this height or width is no room to stand in. */
const ROOM_LEAST = 64;
/** A letter of the kit's labels is this wide and high at size 1 (pixels), with its gap. */
const LETTER_WIDE = 4;
const LETTER_HIGH = 6;

const DEGREES = Math.PI / 180;

// ── small arithmetic ────────────────────────────────────────────────────────
/** `a + b * k`, for points. */
const plus = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
/** Three numbers from a value of a map: `[x, y, z]`, `"x y z"`, or null. */
function vectorFrom(value) {
  if (Array.isArray(value)) return value.length === 3 ? value.map(Number) : null;
  if (typeof value !== "string") return null;
  const numbers = value.trim().split(/\s+/).map(Number);
  return numbers.length === 3 && numbers.every(Number.isFinite) ? numbers : null;
}
/** A colour for a name, the same every time: for a texture whose picture is not to be had. */
function colourOfName(name) {
  let hash = 7;
  for (const letter of name.toLowerCase()) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  const hue = (hash % 360) / 60;
  const band = Math.floor(hue);
  const rise = hue - band;
  const low = 112;
  const high = 178;
  const up = Math.round(low + (high - low) * rise);
  const down = Math.round(high - (high - low) * rise);
  return [
    [high, up, low],
    [down, high, low],
    [low, high, up],
    [low, down, high],
    [up, low, high],
    [high, low, down],
  ][band];
}
/** A picture's side as asked for, or a refusal in words. */
function sideOf(value, otherwise, what) {
  const side = value ?? otherwise;
  if (!Number.isInteger(side) || side < SIDE_LEAST || side > SIDE_MOST)
    throw new Error(`${what}: a whole number from ${SIDE_LEAST} to ${SIDE_MOST}, not ${side}`);
  return side;
}
/** A point as a label writes it: whole numbers. */
const pointText = (point) => point.map((value) => Math.round(value)).join(" ");

// ── the picture being drawn ─────────────────────────────────────────────────
/** A picture of one colour, with how near what each pixel shows is (nothing yet: Infinity). */
function newCanvas(width, height, colour) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) rgba.set([...colour, 255], pixel * 4);
  return { width, height, rgba, nearness: new Float32Array(width * height).fill(Infinity) };
}
/** The picture as the kit hands pictures on. */
const pictureOf = (canvas) => ({
  width: canvas.width,
  height: canvas.height,
  rgba: new Uint8Array(canvas.rgba.buffer),
});
/** The share of a picture's pixels that show something, to a thousandth. */
function shareDrawn(canvas) {
  let drawn = 0;
  for (const near of canvas.nearness) if (near !== Infinity) drawn++;
  return Math.round((drawn / canvas.nearness.length) * 1000) / 1000;
}
/** The mean brightness of a picture, 0 to 255. */
function meanBrightness(canvas) {
  let sum = 0;
  for (let pixel = 0; pixel < canvas.width * canvas.height; pixel++)
    sum +=
      0.3 * canvas.rgba[pixel * 4] + 0.59 * canvas.rgba[pixel * 4 + 1] + 0.11 * canvas.rgba[pixel * 4 + 2];
  return sum / (canvas.width * canvas.height);
}
/**
 * The table that turns a light sample (a byte) into what the texture is multiplied by: the sample as a share
 * of 255, times `brightness`. Over 1 it brightens the texture, as far as white.
 */
function lightTable(brightness) {
  const table = new Float32Array(256);
  for (let sample = 0; sample < 256; sample++) table[sample] = (sample / 255) * brightness;
  return table;
}

// ── textures made ready ─────────────────────────────────────────────────────
/** The mean colour of a texture's smallest size, its holes left out. */
function meanColour(pixels, palette, holes) {
  const sum = [0, 0, 0];
  let counted = 0;
  for (const index of pixels) {
    if (holes && index === HOLE) continue;
    for (let channel = 0; channel < 3; channel++) sum[channel] += palette[index * 3 + channel];
    counted++;
  }
  return sum.map((value) => (counted ? Math.round(value / counted) : 0));
}
/** A map texture (miptex.mjs) as the drawing reads it: its sizes, its palette, its mean colour. */
function readyTexture(texture) {
  const sizes = texture.mips ?? [texture.pixels];
  const levels = sizes.map((pixels, level) => ({
    width: texture.width >> level,
    height: texture.height >> level,
    pixels,
  }));
  const holes = texture.holes ?? textureKind(texture.name).holes;
  return {
    name: texture.name,
    levels,
    palette: texture.palette,
    holes,
    flat: null,
    mean: meanColour(levels.at(-1).pixels, texture.palette, holes),
  };
}
/** A stand-in for a texture with no picture: one colour. */
const flatTexture = (name, colour) => ({
  name,
  levels: null,
  palette: null,
  holes: false,
  flat: colour,
  mean: colour,
});

// ── a face made ready, and filled ───────────────────────────────────────────
/**
 * What a face is drawn as, whatever it came from: `{ polygon, normal, dist, sAxis, tAxis, texture, light,
 * shade, kind }`. `normal` and `dist` are its plane as seen from its front; the axes give a point's place on
 * the texture (`axis . p + axis[3]`); `light` is `{ width, height, originS, originT, rgb }` or null, and
 * `shade` what the texture is multiplied by when there is none. `kind`: "face", "sky" or "liquid".
 */
const NO_AXIS = [0, 0, 0, 0];
/** The stand-in shade of a face from the way it looks. */
const shadeOf = (normal) => AMBIENT + DIRECT * Math.max(0, dot(normal, LAMP));

/**
 * The camera of a view: where it stands, its three axes in the world, and the pixels a unit takes at one
 * unit from the eye. `yaw` turns anticlockwise from +x, seen from above; `pitch` over 0 looks up.
 */
function cameraOf({ from, to, yaw = 0, pitch = 0, fov = VIEW_FOV }, width, height) {
  if (!vectorFrom(from)) throw new Error(`from: where the eye is, [x, y, z], not ${JSON.stringify(from)}`);
  if (!(fov > 1 && fov < 179)) throw new Error(`fov: degrees across, between 1 and 179, not ${fov}`);
  let forward = [
    Math.cos(pitch * DEGREES) * Math.cos(yaw * DEGREES),
    Math.cos(pitch * DEGREES) * Math.sin(yaw * DEGREES),
    Math.sin(pitch * DEGREES),
  ];
  if (to) {
    if (!vectorFrom(to)) throw new Error(`to: the point looked at, [x, y, z], not ${JSON.stringify(to)}`);
    const way = sub(to, from);
    if (!Math.hypot(...way)) throw new Error("to: the point looked at is the eye itself");
    forward = unit(way);
  }
  const level = Math.hypot(forward[0], forward[1]);
  // looking straight up or down, "right" is taken from the yaw
  const right =
    level > 1e-6 ? unit(cross(forward, [0, 0, 1])) : [Math.sin(yaw * DEGREES), -Math.cos(yaw * DEGREES), 0];
  const up = cross(right, forward);
  return {
    perspective: true,
    eye: [...from],
    right,
    up,
    forward,
    focal: width / 2 / Math.tan((fov * DEGREES) / 2),
    centreX: width / 2,
    centreY: height / 2,
    least: 0,
    yaw: Math.round(Math.atan2(forward[1], forward[0]) / DEGREES),
    pitch: Math.round(Math.asin(forward[2]) / DEGREES),
    fov,
  };
}

/** A polygon in the camera's space with what is nearer than `NEAR` cut off. */
function cutNear(polygon) {
  const kept = [];
  polygon.forEach((here, index) => {
    const next = polygon[(index + 1) % polygon.length];
    if (here[2] >= NEAR) kept.push(here);
    if (here[2] >= NEAR !== next[2] >= NEAR) {
      const share = (NEAR - here[2]) / (next[2] - here[2]);
      kept.push(here.map((value, axis) => value + (next[axis] - value) * share));
    }
  });
  return kept;
}

/**
 * Where a surface falls on the picture and how a pixel finds its place on it: `{ corners, depth: [a, b, c],
 * s: [a, b, c, d], t: [a, b, c, d] }`, or null when it is not seen (behind the eye, seen from behind, edge
 * on). For a pixel at (x, y): with perspective, `reach = 1 / (a x + b y + c)` of `depth` is how far it is,
 * and its place on the texture `reach * (a x + b y + c) + d`; on a plan `depth` gives minus its height and
 * the place on the texture is `a x + b y + c`. `shift` is where the surface's entity stands.
 */
function placed(view, surface, shift, twoSided) {
  const { normal, dist, sAxis, tAxis } = surface;
  if (!view.perspective) {
    if (normal[2] < FLOOR_LEAST) return null;
    const left = view.x0 - shift[0];
    const top = view.y0 - shift[1];
    const corners = surface.polygon.map((point) => [
      (point[0] - left) * view.scale,
      (top - point[1]) * view.scale,
    ]);
    // the height of the plane under a pixel: an affine sum of its column and its row
    const heightX = -normal[0] / (normal[2] * view.scale);
    const heightY = normal[1] / (normal[2] * view.scale);
    const heightAt0 = (dist - normal[0] * left - normal[1] * top) / normal[2];
    const along = (axis) => [
      axis[0] / view.scale + axis[2] * heightX,
      -axis[1] / view.scale + axis[2] * heightY,
      axis[0] * left + axis[1] * top + axis[2] * heightAt0 + axis[3],
      0,
    ];
    return {
      corners,
      depth: [-heightX, -heightY, -(heightAt0 + shift[2])],
      s: along(sAxis),
      t: along(tAxis),
    };
  }
  const eye = sub(view.eye, shift);
  const behind = dist - dot(normal, eye);
  if (twoSided ? Math.abs(behind) < EDGE_ON : behind > -EDGE_ON) return null;
  const inCamera = surface.polygon.map((point) => {
    const offset = sub(point, eye);
    return [dot(offset, view.right), dot(offset, view.up), dot(offset, view.forward)];
  });
  const cut = cutNear(inCamera);
  if (cut.length < 3) return null;
  const corners = cut.map(([x, y, z]) => [
    view.centreX + (x * view.focal) / z,
    view.centreY - (y * view.focal) / z,
  ]);
  // a pixel's ray is forward + right * (x - centreX) / focal - up * (y - centreY) / focal
  const overRay = (vector) => {
    const across = dot(vector, view.right) / view.focal;
    const down = -dot(vector, view.up) / view.focal;
    return [across, down, dot(vector, view.forward) - across * view.centreX - down * view.centreY];
  };
  const along = (axis) => [...overRay(axis), dot(axis, eye) + axis[3]];
  return {
    corners,
    depth: overRay(normal).map((value) => value / behind),
    s: along(sAxis),
    t: along(tAxis),
  };
}

/**
 * Fills one surface into the picture. `paint`: `{ alpha (1), additive, stipple (every other pixel left
 * open), twoSided, mean (the texture's mean colour in place of its picture), ambient (the share of its
 * colour a surface keeps in no light), outline (its edges drawn darker: the share of the colour kept) }`. A pixel is drawn
 * where the surface is nearer than what is there; one that is not opaque hides nothing after it.
 */
function fill(canvas, view, surface, shift, paint, table) {
  const place = placed(view, surface, shift, paint.twoSided);
  if (!place) return 0;
  const { corners } = place;
  const [depthA, depthB, depthC] = place.depth;
  const [sA, sB, sC, sD] = place.s;
  const [tA, tB, tC, tD] = place.t;
  const { width, height, rgba, nearness } = canvas;
  const { perspective, least } = view;
  const texture = surface.texture;
  const flat = paint.mean || !texture.levels ? texture.mean : null;
  const holes = !flat && texture.holes;
  const palette = texture.palette;
  const light = surface.light;
  const ambient = paint.ambient ?? 0;
  const lightShare = 1 - ambient;
  const shade = ambient + lightShare * surface.shade;
  const lift = paint.lift ?? 0;
  const kept = 1 - lift / 255;
  const alpha = paint.alpha ?? 1;
  const opaque = alpha >= 1 && !paint.additive;
  // how far a pixel has to be for each smaller size of the texture
  const texelsAUnit = Math.hypot(surface.sAxis[0], surface.sAxis[1], surface.sAxis[2]) || 1;
  const firstSmaller = perspective ? (TEXELS_A_PIXEL * view.focal) / texelsAUnit : Infinity;
  const mostLevel = flat ? 0 : texture.levels.length - 1;

  let top = Infinity;
  let bottom = -Infinity;
  for (const corner of corners) {
    top = Math.min(top, corner[1]);
    bottom = Math.max(bottom, corner[1]);
  }
  const firstRow = Math.max(0, Math.ceil(top - 0.5));
  const lastRow = Math.min(height - 1, Math.floor(bottom - 0.5));
  let drawn = 0;
  for (let row = firstRow; row <= lastRow; row++) {
    const y = row + 0.5;
    // the stretch of the row inside the polygon, which is convex: between its two crossings
    let left = Infinity;
    let right = -Infinity;
    for (let index = 0; index < corners.length; index++) {
      const here = corners[index];
      const next = corners[(index + 1) % corners.length];
      if (here[1] <= y === next[1] <= y) continue;
      const x = here[0] + ((y - here[1]) * (next[0] - here[0])) / (next[1] - here[1]);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    const firstColumn = Math.max(0, Math.ceil(left - 0.5));
    const lastColumn = Math.min(width - 1, Math.floor(right - 0.5));
    for (let column = firstColumn; column <= lastColumn; column++) {
      const x = column + 0.5;
      const at = row * width + column;
      let reach = 1;
      let near = depthA * x + depthB * y + depthC;
      if (perspective) {
        if (near <= 0) continue;
        reach = 1 / near;
        near = reach;
      }
      if (near < least || near >= nearness[at]) continue;
      if (paint.stipple && (row + column) & 1) continue;
      const s = reach * (sA * x + sB * y + sC) + sD;
      const t = reach * (tA * x + tB * y + tC) + tD;

      let red;
      let green;
      let blue;
      if (flat) {
        red = flat[0];
        green = flat[1];
        blue = flat[2];
      } else {
        let level = 0;
        if (reach >= firstSmaller)
          level = reach >= firstSmaller * 2 ? (reach >= firstSmaller * 4 ? 3 : 2) : 1;
        if (level > mostLevel) level = mostLevel;
        const size = texture.levels[level];
        let texelX = (Math.floor(s) >> level) % size.width;
        let texelY = (Math.floor(t) >> level) % size.height;
        if (texelX < 0) texelX += size.width;
        if (texelY < 0) texelY += size.height;
        const index = size.pixels[texelY * size.width + texelX];
        if (holes && index === HOLE) continue;
        red = palette[index * 3];
        green = palette[index * 3 + 1];
        blue = palette[index * 3 + 2];
      }

      if (light) {
        // the four samples about the point, mixed by how near each is
        const across = Math.min(Math.max((s - light.originS) / LUXEL, 0), light.width - 1);
        const down = Math.min(Math.max((t - light.originT) / LUXEL, 0), light.height - 1);
        const column0 = Math.min(Math.floor(across), Math.max(0, light.width - 2));
        const row0 = Math.min(Math.floor(down), Math.max(0, light.height - 2));
        const column1 = Math.min(column0 + 1, light.width - 1);
        const row1 = Math.min(row0 + 1, light.height - 1);
        const shareX = across - column0;
        const shareY = down - row0;
        const a = (row0 * light.width + column0) * 3;
        const b = (row0 * light.width + column1) * 3;
        const c = (row1 * light.width + column0) * 3;
        const d = (row1 * light.width + column1) * 3;
        const samples = light.rgb;
        const mixed = (channel) => {
          const upper = samples[a + channel] + (samples[b + channel] - samples[a + channel]) * shareX;
          const lower = samples[c + channel] + (samples[d + channel] - samples[c + channel]) * shareX;
          return table[Math.min(255, Math.round(upper + (lower - upper) * shareY))];
        };
        red *= ambient + lightShare * mixed(0);
        green *= ambient + lightShare * mixed(1);
        blue *= ambient + lightShare * mixed(2);
      } else {
        red *= shade;
        green *= shade;
        blue *= shade;
      }

      if (lift) {
        red = lift + Math.min(255, red) * kept;
        green = lift + Math.min(255, green) * kept;
        blue = lift + Math.min(255, blue) * kept;
      }
      const o = at * 4;
      if (opaque) {
        rgba[o] = red;
        rgba[o + 1] = green;
        rgba[o + 2] = blue;
        nearness[at] = near;
      } else if (paint.additive) {
        rgba[o] += red * alpha;
        rgba[o + 1] += green * alpha;
        rgba[o + 2] += blue * alpha;
      } else {
        rgba[o] += (red - rgba[o]) * alpha;
        rgba[o + 1] += (green - rgba[o + 1]) * alpha;
        rgba[o + 2] += (blue - rgba[o + 2]) * alpha;
      }
      drawn++;
    }
  }
  if (drawn && paint.outline) outline(canvas, view, place, paint.outline);
  return drawn;
}

/**
 * The edges of a surface that was just filled, drawn darker where the surface itself is what the picture
 * shows: faces of one flat colour are told apart by their edges. `share`: how much of the colour is kept.
 */
function outline(canvas, view, place, share) {
  const { width, height, rgba, nearness } = canvas;
  const [depthA, depthB, depthC] = place.depth;
  place.corners.forEach((from, index) => {
    const to = place.corners[(index + 1) % place.corners.length];
    const steps = Math.min(
      OUTLINE_STEPS_MOST,
      Math.ceil(Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]))),
    );
    for (let step = 0; step <= steps; step++) {
      const x = from[0] + ((to[0] - from[0]) * step) / Math.max(1, steps);
      const y = from[1] + ((to[1] - from[1]) * step) / Math.max(1, steps);
      const column = Math.floor(x);
      const row = Math.floor(y);
      if (column < 0 || row < 0 || column >= width || row >= height) continue;
      const depth = depthA * x + depthB * y + depthC;
      const near = view.perspective ? 1 / depth : depth;
      const at = row * width + column;
      // drawn where nothing nearer than this edge was drawn (a little is forgiven: the edge is the face's own)
      if (!(near > 0) || nearness[at] < near * OUTLINE_NEARER) continue;
      for (let channel = 0; channel < 3; channel++) rgba[at * 4 + channel] *= share;
    }
  });
}

/** The six faces of a box of one colour, as surfaces: a mark in a view. */
function boxSurfaces(min, max, colour) {
  const texture = flatTexture("mark", colour);
  const corner = (x, y, z) => [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]];
  const sides = [
    {
      normal: [1, 0, 0],
      dist: max[0],
      of: [corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)],
    },
    {
      normal: [-1, 0, 0],
      dist: -min[0],
      of: [corner(0, 0, 0), corner(0, 1, 0), corner(0, 1, 1), corner(0, 0, 1)],
    },
    {
      normal: [0, 1, 0],
      dist: max[1],
      of: [corner(0, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(0, 1, 1)],
    },
    {
      normal: [0, -1, 0],
      dist: -min[1],
      of: [corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)],
    },
    {
      normal: [0, 0, 1],
      dist: max[2],
      of: [corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)],
    },
    {
      normal: [0, 0, -1],
      dist: -min[2],
      of: [corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0)],
    },
  ];
  return sides.map((side) => ({
    polygon: side.of,
    normal: side.normal,
    dist: side.dist,
    sAxis: NO_AXIS,
    tAxis: NO_AXIS,
    texture,
    light: null,
    shade: shadeOf(side.normal),
    kind: "face",
  }));
}

// ── what is in a map, in one form for compiled maps and for source ──────────
/** What an entity is, for its mark's colour: "start", "light", "monster", "trigger", "brush" or "other". */
function kindOf(classname, isBrush) {
  if (isBrush) return NEVER_DRAWN.test(classname) ? "trigger" : "brush";
  for (const [kind, pattern] of Object.entries(KIND_PATTERNS)) if (pattern.test(classname)) return kind;
  return "other";
}
/** Whether an entity names a model or a sprite of the game's, or is a monster: marked in a view by a box. */
const hasBody = (thing) => thing.kind === "monster" || /\.(mdl|spr)$/i.test(thing.modelFile ?? "");

/**
 * How a brush entity is drawn, from its keys: `{ hidden, alpha, additive }`. Hidden: a class the game never
 * draws, one faded to nothing, or one the compiler was told to leave unseen (`zhlt_invisible`).
 */
function lookOf(classname, rendermode, renderamt, invisible) {
  if (invisible || NEVER_DRAWN.test(classname)) return { hidden: true, alpha: 0, additive: false };
  if (!FADING_MODES.includes(rendermode)) return { hidden: false, alpha: 1, additive: false };
  const alpha = Math.min(1, Math.max(0, renderamt / FULL_AMOUNT));
  return { hidden: alpha <= 0, alpha, additive: rendermode === ADDITIVE_MODE };
}

/** The entities of a compiled map as the drawing reads them. */
function thingsOfBsp(bsp) {
  return bsp.entities.map((entity, number) => {
    const classname = valueOf(entity, "classname") ?? "";
    const model = number === 0 ? 0 : brushModelOf(entity);
    const angles = anglesOf(entity);
    return {
      number,
      classname,
      origin: originOf(entity),
      yaw: angles[1],
      pitch: -angles[0],
      turned: valueOf(entity, "angles") !== undefined || valueOf(entity, "angle") !== undefined,
      model,
      modelFile: model === null ? valueOf(entity, "model") : undefined,
      kind: kindOf(classname, model !== null),
      look: lookOf(
        classname,
        numberOf(entity, "rendermode", 0),
        numberOf(entity, "renderamt", 0),
        valueOf(entity, "zhlt_invisible") === "1",
      ),
    };
  });
}

/** The entities of brush source as the drawing reads them: the world is 0, the others follow from 1. */
function thingsOfSource(map) {
  return (map.entities ?? []).map((entity, index) => {
    const classname = String(entity.classname ?? "");
    const isBrush = Boolean(entity.brushes?.length);
    const angles = vectorFrom(entity.angles) ?? [0, Number(entity.angle ?? 0) || 0, 0];
    return {
      number: index + 1,
      classname,
      origin: vectorFrom(entity.origin),
      yaw: angles[1],
      pitch: -angles[0],
      turned: entity.angles !== undefined || entity.angle !== undefined,
      model: isBrush ? index + 1 : null,
      modelFile: isBrush ? undefined : entity.model,
      brushes: entity.brushes ?? [],
      kind: kindOf(classname, isBrush),
      look: lookOf(
        classname,
        Number(entity.rendermode ?? 0),
        Number(entity.renderamt ?? 0),
        String(entity.zhlt_invisible ?? "") === "1",
      ),
    };
  });
}

/** Whether this is a compiled map (what `readBsp` gives) and not brush source. */
const isCompiled = (map) => Array.isArray(map?.faces) && Array.isArray(map?.leaves);

/**
 * Where an entity stands and the way it looks, for a view from it: `{ from, yaw, pitch, name, number }`.
 * `which`: its number, or a classname (the first of that class). A place to start is looked from at the
 * height of a player's eyes; anything else from its origin. `map`: a compiled map or brush source.
 */
export function viewFrom(map, which) {
  const things = isCompiled(map) ? thingsOfBsp(map) : thingsOfSource(map);
  const byNumber = typeof which === "number" || /^\d+$/.test(String(which));
  const thing = byNumber
    ? things.find((each) => each.number === Number(which))
    : things.find((each) => each.classname === which);
  if (!thing)
    throw new Error(
      byNumber
        ? `no entity ${which}: they are numbered from 0 to ${things.at(-1)?.number ?? 0}`
        : `no entity of the class ${which}`,
    );
  if (!thing.origin || thing.model !== null)
    throw new Error(
      `entity ${thing.number} (${thing.classname}) has no place of its own to look from: give a point`,
    );
  const from = thing.kind === "start" ? plus(thing.origin, [0, 0, 1], EYE_OVER_ORIGIN) : [...thing.origin];
  return {
    from,
    yaw: thing.yaw,
    pitch: thing.kind === "start" ? 0 : thing.pitch,
    name: `${thing.number} ${thing.classname}`,
    number: thing.number,
  };
}

// ── a compiled map made ready ───────────────────────────────────────────────
const scenes = new WeakMap();

/**
 * A compiled map with what the drawing needs worked out once: its textures (found where they can be), its
 * entities, and its faces as surfaces, each made the first time it is drawn. Kept for the map and these
 * options, so that the second picture of a map does not look for its textures again.
 */
function sceneOf(bsp, { textures, folders, light = true, sky = SKY_COLOUR }) {
  const key = JSON.stringify([folders ?? [], (textures ?? []).map((texture) => texture.name), light, sky]);
  const kept = scenes.get(bsp);
  if (kept?.key === key) return kept;
  const given = new Map((textures ?? []).map((texture) => [texture.name.toLowerCase(), texture]));
  let fromWads = null;
  const ready = new Map();
  const missing = new Set();
  /** The texture of the map's directory at `index`, found or stood in for. */
  const textureAt = (index) => {
    if (ready.has(index)) return ready.get(index);
    const entry = bsp.textures[index];
    const name = entry?.name ?? "";
    let found = entry && !entry.absent && entry.embedded ? embeddedTexture(bsp, index) : null;
    found ??= given.get(name.toLowerCase());
    if (!found && folders?.length) {
      fromWads ??= new Map(
        texturesFor(bsp, folders, { pixels: true }).textures.map((each) => [
          each.name.toLowerCase(),
          each.texture,
        ]),
      );
      found = fromWads.get(name.toLowerCase());
    }
    const made = found ? readyTexture(found) : flatTexture(name, colourOfName(name));
    if (!found && !textureKind(name).sky && !textureKind(name).tool) missing.add(name);
    ready.set(index, made);
    return made;
  };
  const lit = light !== false && bsp.lumps.lighting.length > 0;
  const skyTexture = flatTexture("sky", sky);
  const surfaces = new Array(bsp.faces.length);
  /** The face `index` as a surface; null for one that is never drawn (a tool's texture). */
  const surfaceAt = (index) => {
    if (surfaces[index] !== undefined) return surfaces[index];
    const face = bsp.faces[index];
    const texinfo = bsp.texinfo[face.texinfo];
    const name = bsp.textures[texinfo.texture]?.name ?? "";
    const kind = textureKind(name);
    let surface = null;
    if (!kind.tool) {
      const normal = faceNormal(bsp, face);
      const plane = bsp.planes[face.plane];
      const special = kind.sky || kind.water;
      surface = {
        polygon: facePolygon(bsp, face),
        normal,
        dist: face.side ? -plane.dist : plane.dist,
        sAxis: texinfo.s,
        tAxis: texinfo.t,
        texture: kind.sky ? skyTexture : textureAt(texinfo.texture),
        light: null,
        // a face the compiler left without light is black where the map has light, as in the game
        shade: special || light === false ? 1 : lit ? 0 : shadeOf(normal),
        kind: kind.sky ? "sky" : kind.water ? "liquid" : "face",
      };
      if (lit && !special) surface.light = lightOf(bsp, face, STYLES_BELOW[light] ?? STYLES_BELOW.true);
      if (surface.light) surface.shade = 1;
    }
    surfaces[index] = surface;
    return surface;
  };
  const scene = { key, bsp, things: thingsOfBsp(bsp), surfaceAt, missing, lit, light };
  scenes.set(bsp, scene);
  return scene;
}

/**
 * A face's light as the drawing reads it: its styles under `below` added up (one alone is the map's own
 * bytes, not a copy); null for a face with none of them.
 */
function lightOf(bsp, face, below) {
  const lightmap = faceLightmap(bsp, face);
  if (!lightmap) return null;
  const wanted = lightmap.styles.filter((each) => each.style < below);
  if (!wanted.length) return null;
  let rgb = wanted[0].rgb;
  if (wanted.length > 1) {
    rgb = new Uint8ClampedArray(rgb.length);
    for (const each of wanted) for (let at = 0; at < rgb.length; at++) rgb[at] += each.rgb[at];
  }
  return {
    width: lightmap.width,
    height: lightmap.height,
    originS: lightmap.originS,
    originT: lightmap.originT,
    rgb,
  };
}

/** The numbers of the world's faces that can be seen from a leaf: all of them when the map does not say. */
function facesSeenFrom(bsp, leaf) {
  const world = bsp.models[0];
  const seen = leaf > 0 ? visibleFrom(bsp, leaf) : null;
  if (!seen)
    return {
      faces: Array.from({ length: world.faceCount }, (_, nth) => world.firstFace + nth),
      byVisibility: false,
    };
  const marked = new Uint8Array(bsp.faces.length);
  const faces = [];
  for (const other of seen) {
    const { firstMarkSurface, markSurfaceCount } = bsp.leaves[other];
    for (let nth = 0; nth < markSurfaceCount; nth++) {
      const face = bsp.marksurfaces[firstMarkSurface + nth];
      if (marked[face]) continue;
      marked[face] = 1;
      faces.push(face);
    }
  }
  return { faces, byVisibility: true };
}

/** The numbers of the faces of one of the map's models. */
const facesOfModel = (bsp, model) =>
  Array.from({ length: bsp.models[model].faceCount }, (_, nth) => bsp.models[model].firstFace + nth);

/** The first place to start of a map's entities, or undefined. */
const firstStart = (things) => things.find((thing) => thing.kind === "start" && thing.origin);

// ── marks in a view ─────────────────────────────────────────────────────────
/** The point entities a view marks: those with a body (`"models"`), every one (`"all"`), or none. */
function markedThings(things, entities) {
  if (entities === false || entities === "none") return [];
  const points = things.filter((thing) => thing.model === null && thing.origin);
  return entities === "all" ? points : points.filter(hasBody);
}

/**
 * Draws a box at each marked entity and, where its middle is seen, its number and class over it. Returns
 * `[{ number, classname, at: [x, y] }]` for those seen.
 */
function drawMarks(canvas, view, marked, table, labels) {
  const half = MARK_SIDE / 2;
  for (const thing of marked) {
    const min = plus(thing.origin, [1, 1, 1], -half);
    const max = plus(thing.origin, [1, 1, 1], half);
    for (const surface of boxSurfaces(min, max, MARK_COLOURS[thing.kind]))
      fill(canvas, view, surface, [0, 0, 0], {}, table);
  }
  const seen = [];
  for (const thing of marked) {
    const offset = sub(thing.origin, view.eye);
    const depth = dot(offset, view.forward);
    if (depth < NEAR) continue;
    const x = Math.round(view.centreX + (dot(offset, view.right) * view.focal) / depth);
    const y = Math.round(view.centreY - (dot(offset, view.up) * view.focal) / depth);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
    // seen when nothing is nearer than the box's own front
    if (canvas.nearness[y * canvas.width + x] < depth - MARK_SIDE) continue;
    seen.push({ number: thing.number, classname: thing.classname, at: [x, y] });
    if (labels === false) continue;
    // the words over the box: its half side on the picture, and a line of letters, above its middle
    const words = `${thing.number} ${thing.classname}`;
    const wide = words.length * LETTER_WIDE;
    const left = Math.max(1, Math.min(canvas.width - wide - 1, x - Math.round(wide / 2)));
    const above = Math.round((half * view.focal) / depth) + LETTER_HIGH + 4;
    label(canvas, words, left, Math.max(1, y - above), 1);
  }
  return seen;
}

// ── a view of a compiled map ────────────────────────────────────────────────
/**
 * A view from a point inside a compiled map (`bsp`: what `readBsp` gave), as a player would see it without
 * the models: textured, and lit by the map's own lightmaps.
 *
 *   from          where the eye is, [x, y, z]. Without it: the first place to start, at eye height, looking
 *                 the way it faces; a map with none is looked at from the middle of its largest room
 *   to            the point looked at; or
 *   yaw, pitch    degrees: yaw 0 looks along +x and turns anticlockwise seen from above (90: +y); pitch over
 *                 0 looks up
 *   fov           degrees across (90)
 *   width, height the picture (640 x 480)
 *   light         true: the lightmaps: the light that is always on (style 0) with the game's flickering
 *                 styles (1 to 31: a torch) at their full. "steady": style 0 alone. "all": the switched
 *                 lights (32 and up) too, as if each were on. false: the textures as they are
 *   brightness    what the light is multiplied by (1.55: about what the game shows; 1: the samples as the
 *                 compiler stored them; more, to look into a dark map)
 *   textures      map textures to wear by name where the map has no pixels of its own: `readWad(...).textures`
 *   folders       the game's folders (the mod's own, then `valve`): their .wad files are looked in
 *   entities      "models" (unless told): a labelled box at each point entity that names a .mdl or .spr or is
 *                 a monster; "all": at every point entity; false: none. `labels: false` leaves the words out
 *   sky           the colour of sky faces, [r, g, b]
 *
 * What is drawn: the world's faces the eye's leaf can see (all of them when the eye is in solid or the map
 * has no visibility), and every brush entity where its `origin` puts it, but those the game never shows
 * (triggers, ladders, entities faded to nothing, faces wearing aaatrigger, clip, null, origin, hint, skip).
 * A `{` texture has its holes, sky is one flat colour, a liquid of the world lets what is under it show.
 * NOT drawn: the models (.mdl) and sprites of point entities, decals, the sky's own picture, a brush
 * entity's turn (`angles`), and what a script does when the game runs.
 *
 * Returns `{ width, height, rgba, facts }`. `facts`: `{ from, yaw, pitch, fov, leaf, contents, faces
 * (drawn), pixels (the share of the picture that shows something), light, brightness (the picture's mean,
 * 0 to 255: a number for "too dark"), missing (texture names found
 * nowhere, drawn flat), marked ([{ number, classname, at }]), notes (sentences) }`.
 */
export function drawMap(bsp, options = {}) {
  const width = sideOf(options.width, VIEW_WIDTH, "width");
  const height = sideOf(options.height, VIEW_HEIGHT, "height");
  const scene = sceneOf(bsp, options);
  const notes = [];
  let stand = options;
  if (!options.from) {
    const start = firstStart(scene.things);
    if (start) stand = { ...options, ...viewFrom(bsp, start.number), ...definedOnly(options) };
    else {
      const [room] = largestRooms(bsp, 1);
      if (!room) throw new Error("drawMap: the map has no place to start and no open room: give `from`");
      stand = { ...options, from: room.at };
      notes.push("the map has no place to start: looked at from the middle of its largest room");
    }
  }
  const view = cameraOf(stand, width, height);
  const canvas = newCanvas(width, height, NOTHING);
  const table = lightTable(options.brightness ?? BRIGHTNESS);
  const leaf = leafAt(bsp, view.eye);
  const contents = contentsAt(bsp, view.eye);
  const seen = facesSeenFrom(bsp, leaf);
  if (contents === CONTENTS.SOLID)
    notes.push(
      "the eye is in solid (inside a wall or outside the map): every face is drawn, from behind where it looks away",
    );
  else if (!seen.byVisibility)
    notes.push("the map keeps no visibility for the eye's leaf: every face is drawn");
  if (!scene.lit && options.light !== false)
    notes.push(
      "the map has no light data (not passed through hlrad): shaded plainly by the way each face looks",
    );

  let faces = 0;
  const later = [];
  /** Draws a surface now when it is opaque, or keeps it for after the rest. */
  const draw = (surface, shift, look) => {
    if (!surface) return;
    const paint = { alpha: look.alpha, additive: look.additive };
    if (surface.kind === "liquid" && look.alpha >= 1) paint.alpha = LIQUID_ALPHA;
    if (surface.kind === "liquid") paint.twoSided = true;
    if (paint.alpha < 1 || paint.additive) {
      later.push({ surface, shift, paint });
      return;
    }
    if (fill(canvas, view, surface, shift, paint, table)) faces++;
  };
  const plain = { alpha: 1, additive: false };
  for (const face of seen.faces) draw(scene.surfaceAt(face), [0, 0, 0], plain);
  for (const thing of scene.things) {
    if (!thing.model || thing.look.hidden || !bsp.models[thing.model]) continue;
    for (const face of facesOfModel(bsp, thing.model))
      draw(scene.surfaceAt(face), thing.origin ?? [0, 0, 0], thing.look);
  }
  const marked = drawMarks(
    canvas,
    view,
    markedThings(scene.things, options.entities ?? "models"),
    table,
    options.labels,
  );
  for (const { surface, shift, paint } of later)
    if (fill(canvas, view, surface, shift, paint, table)) faces++;

  if (scene.missing.size)
    notes.push(
      `${scene.missing.size} textures were found nowhere and are drawn in a flat colour each: ${[...scene.missing].sort().slice(0, 12).join(", ")}${scene.missing.size > 12 ? "..." : ""}`,
    );
  if (marked.length)
    notes.push(`${marked.length} point entities are marked by a box: their models are not drawn`);
  const brightness = Math.round(meanBrightness(canvas));
  if (scene.lit && options.light !== false && brightness < DARK_VIEW)
    notes.push(
      `the picture is dark (${brightness} of 255 on average): so is the map there, as the game shows it. \`brightness: 4\` looks into it, \`light: false\` shows the textures alone`,
    );
  const facts = {
    from: view.eye,
    yaw: view.yaw,
    pitch: view.pitch,
    fov: view.fov,
    leaf,
    contents: contentsName(contents),
    faces,
    pixels: shareDrawn(canvas),
    light: scene.lit ? (LIGHT_WORDS[scene.light] ?? LIGHT_WORDS.true) : "none",
    brightness,
    missing: [...scene.missing].sort(),
    marked,
    notes,
  };
  return { ...pictureOf(canvas), facts };
}

/** The camera's own options of a call that were given: they win over where an entity looks. */
function definedOnly({ to, yaw, pitch, fov }) {
  const given = {};
  if (to !== undefined) given.to = to;
  if (yaw !== undefined) given.yaw = yaw;
  if (pitch !== undefined) given.pitch = pitch;
  if (fov !== undefined) given.fov = fov;
  return given;
}

// ── the largest rooms ───────────────────────────────────────────────────────
/**
 * The middles of a map's largest open places, to look from: `[{ at, leaf, size }]`, the largest first, no
 * two of them in sight of one another while such are to be had. A "room" is an empty leaf of the world's
 * tree by the size of its box; the eye is put 64 over the floor under its middle.
 */
function largestRooms(bsp, count) {
  const world = bsp.models[0];
  const candidates = [];
  for (let leaf = 1; leaf <= world.visLeaves && leaf < bsp.leaves.length; leaf++) {
    const { contents, mins, maxs } = bsp.leaves[leaf];
    if (contents !== CONTENTS.EMPTY) continue;
    const size = sub(maxs, mins);
    if (Math.min(...size) < ROOM_LEAST) continue;
    const middle = mins.map((value, axis) => (value + maxs[axis]) / 2);
    if (leafAt(bsp, middle) !== leaf) continue;
    const floor = floorUnder(bsp, middle);
    const eye = floor === null ? middle[2] : Math.min(floor + EYE_OVER_FLOOR, maxs[2] - NEAR * 2);
    const at = [middle[0], middle[1], eye];
    if (contentsAt(bsp, at) !== CONTENTS.EMPTY) continue;
    candidates.push({ at: at.map(Math.round), leaf: leafAt(bsp, at), size: size[0] * size[1] * size[2] });
  }
  candidates.sort((a, b) => b.size - a.size);
  const chosen = [];
  // first those that no chosen room sees; then, when the map is all one open place, those far from the chosen
  for (const room of candidates) {
    if (chosen.length >= count) break;
    const inSight = chosen.some((other) => visibleFrom(bsp, other.leaf)?.includes(room.leaf) ?? true);
    if (!inSight) chosen.push(room);
  }
  const bounds = worldBounds(bsp);
  const apart = Math.hypot(...sub(bounds.maxs, bounds.mins)) / 6;
  for (const room of candidates) {
    if (chosen.length >= count) break;
    if (chosen.every((other) => Math.hypot(...sub(other.at, room.at)) > apart)) chosen.push(room);
  }
  return chosen;
}

// ── several views in one picture ────────────────────────────────────────────
/**
 * Several views of a compiled map in one picture, each named in its corner with where it was taken from: an
 * overview in one call.
 *
 *   count          how many cells (8): from each place to start, looking the way it faces (half the cells at
 *                  the most), then from the middle of the largest rooms, each looked at four ways
 *   at             instead: the places yourself, `[{ from, yaw, pitch, to, name }]`, an entity's number or a
 *                  classname in place of any of them
 *   width, height  one cell (320 x 240); `cols` cells in a row (4)
 *   and what `drawMap` takes (light, brightness, textures, folders, entities, fov).
 *
 * Returns `{ width, height, rgba, facts }`; `facts.views` is `[{ name, from, yaw, pitch, faces, pixels }]`,
 * `facts.missing` and `facts.notes` as `drawMap` gives.
 */
export function viewsOf(bsp, options = {}) {
  const count = options.count ?? VIEWS_COUNT;
  if (!Number.isInteger(count) || count < 1) throw new Error(`count: a whole number from 1, not ${count}`);
  const width = sideOf(options.width, CELL_WIDTH, "width");
  const height = sideOf(options.height, CELL_HEIGHT, "height");
  const scene = sceneOf(bsp, options);
  let stands;
  if (options.at) {
    const asked = Array.isArray(options.at) ? options.at : [options.at];
    stands = asked.map((each) => (typeof each === "object" ? each : viewFrom(bsp, each)));
  } else {
    const starts = scene.things.filter((thing) => thing.kind === "start" && thing.origin);
    const fromStarts = starts
      .slice(0, Math.max(1, Math.floor(count / 2)))
      .map((thing) => viewFrom(bsp, thing.number));
    const rooms = largestRooms(bsp, Math.max(1, Math.floor((count - fromStarts.length) / FOUR_WAYS.length)));
    const fromRooms = rooms.flatMap((room) =>
      FOUR_WAYS.map((yaw) => ({ from: room.at, yaw, pitch: 0, name: `room ${pointText(room.at)}` })),
    );
    stands = [...fromStarts, ...fromRooms].slice(0, Math.max(count, 1));
  }
  if (!stands.length) throw new Error("viewsOf: the map has no place to start and no open room: give `at`");
  const drawn = stands.map((stand) => drawMap(bsp, { ...options, ...stand, to: stand.to, width, height }));
  const names = stands.map(
    (stand, nth) => `${stand.name ?? `at ${pointText(stand.from)}`} yaw ${drawn[nth].facts.yaw}`,
  );
  const columns = options.cols ?? Math.min(VIEWS_COLUMNS, stands.length);
  const picture = tile(drawn, columns, names);
  const facts = {
    views: drawn.map((each, nth) => ({
      name: names[nth],
      from: each.facts.from,
      yaw: each.facts.yaw,
      pitch: each.facts.pitch,
      faces: each.facts.faces,
      pixels: each.facts.pixels,
    })),
    light: drawn[0].facts.light,
    missing: drawn[0].facts.missing,
    notes: viewsNotes(drawn.map((each) => each.facts)),
  };
  return { ...picture, facts };
}

/**
 * What several views have to say, each thing once: the notes that are the same for all, and one line each
 * for how many are dark and how many entities are marked, which every view words with its own numbers.
 */
function viewsNotes(facts) {
  const ofOneView = /^(the picture is dark|\d+ point entities are marked)/;
  const shared = new Set(facts.flatMap((each) => each.notes.filter((note) => !ofOneView.test(note))));
  const dark = facts.filter((each) => each.light !== "none" && each.brightness < DARK_VIEW).length;
  const notes = [...shared];
  if (facts.some((each) => each.marked.length))
    notes.push("point entities with a model are marked by a box: their models are not drawn");
  if (dark)
    notes.push(
      `${dark} of the ${facts.length} views are dark (under ${DARK_VIEW} of 255 on average): so is the map there, as the game shows it. \`brightness: 4\` looks into it`,
    );
  return notes;
}

// ── plans ───────────────────────────────────────────────────────────────────
/**
 * How a plan lies on its picture: `{ x0, y0, scale, width, height }`. `x0`, `y0`: the world's x at the
 * picture's left edge and its y at the top edge; `scale`: pixels a unit. A point (x, y) of the world is at
 * pixel ((x - x0) * scale, (y0 - y) * scale).
 */
function planFrame(min, max, { scale, width, height, area }) {
  const low = area?.min ?? min;
  const high = area?.max ?? max;
  const wide = high[0] - low[0];
  const deep = high[1] - low[1];
  if (!(wide > 0 && deep > 0)) throw new Error("area: `min` [x, y] must be under `max` [x, y] on both axes");
  if (scale !== undefined && !(scale > 0)) throw new Error(`scale: pixels a unit, over 0, not ${scale}`);
  const most = [sideOf(width, PLAN_SIDE, "width"), sideOf(height, PLAN_SIDE, "height")];
  const fitting = Math.min(
    (most[0] - 2 * PLAN_MARGIN) / wide,
    (most[1] - 2 * PLAN_MARGIN - PLAN_FOOT) / deep,
  );
  const perUnit = scale ?? fitting;
  const made = [
    width ?? Math.ceil(wide * perUnit + 2 * PLAN_MARGIN),
    height ?? Math.ceil(deep * perUnit + 2 * PLAN_MARGIN + PLAN_FOOT),
  ];
  return {
    perspective: false,
    x0: low[0] - PLAN_MARGIN / perUnit,
    y0: high[1] + PLAN_MARGIN / perUnit,
    scale: perUnit,
    width: sideOf(Math.min(made[0], SIDE_MOST), undefined, "the plan's width"),
    height: sideOf(Math.min(made[1], SIDE_MOST), undefined, "the plan's height"),
  };
}
/** The pixel of a plan a point of the world is at. */
const planPixel = (frame, point) => [
  Math.round((point[0] - frame.x0) * frame.scale),
  Math.round((frame.y0 - point[1]) * frame.scale),
];

/** A filled dot with a dark rim. */
function drawDot(canvas, [x, y], radius, colour) {
  for (let down = -radius - 1; down <= radius + 1; down++)
    for (let across = -radius - 1; across <= radius + 1; across++) {
      const far = Math.hypot(across, down);
      const column = x + across;
      const row = y + down;
      if (far > radius + 1 || column < 0 || row < 0 || column >= canvas.width || row >= canvas.height)
        continue;
      canvas.rgba.set(far <= radius ? [...colour, 255] : [0, 0, 0, 255], (row * canvas.width + column) * 4);
    }
}
/** A line on the canvas. */
const line = (canvas, from, to, colour) =>
  drawLine(canvas.rgba, canvas.width, canvas.height, from, to, [...colour, 255]);

/**
 * The rim of a shape seen from above, from its faces' corners: the edges that only one of its faces that
 * look one way along z has (an edge two share is inside the shape: a floor of many triangles is drawn as one
 * outline). Its top or its underside, whichever it has: on a plan they are one outline. A shape with
 * neither gives every edge. `[[from, to]]`, points of the world.
 */
function rimOf(polygons) {
  /** The faces whose corners turn one way seen from above, and that are not walls. */
  const turning = (sign) =>
    polygons.filter((polygon) => {
      const normal = cross(sub(polygon[1], polygon[0]), sub(polygon[2], polygon[0]));
      return normal[2] * sign > FLOOR_LEAST * Math.hypot(...normal);
    });
  const oneWay = turning(-1);
  const lookingUp = oneWay.length ? oneWay : turning(1);
  const edges = new Map();
  for (const polygon of lookingUp.length ? lookingUp : polygons)
    polygon.forEach((corner, index) => {
      const next = polygon[(index + 1) % polygon.length];
      const ends = [corner, next].map((point) => `${Math.round(point[0])} ${Math.round(point[1])}`).sort();
      if (ends[0] === ends[1]) return;
      const key = ends.join("|");
      edges.set(key, { ends: [corner, next], count: (edges.get(key)?.count ?? 0) + 1 });
    });
  const once = [...edges.values()].filter((edge) => edge.count === 1 || !lookingUp.length);
  return once.map((edge) => edge.ends);
}

/**
 * The marks of a plan: each brush entity's outline (handed over as lists of corners in the world), then each
 * point entity as a dot in the colour of its kind, with a short line the way it faces, and their labels
 * where there is room. Returns `[{ number, classname, kind, origin, at: [x, y] }]`.
 */
function drawPlanMarks(canvas, frame, things, outlineOf, labels) {
  const marks = [];
  const wanted = [];
  for (const thing of things) {
    if (thing.model === null || thing.number === 0) continue;
    const outline = outlineOf(thing);
    if (!outline.length) continue;
    const colour = MARK_COLOURS[thing.kind];
    let sum = [0, 0];
    let counted = 0;
    for (const [from, to] of rimOf(outline)) {
      line(canvas, planPixel(frame, from), planPixel(frame, to), colour);
      sum = [sum[0] + from[0], sum[1] + from[1]];
      counted++;
    }
    const middle = [sum[0] / counted, sum[1] / counted];
    const at = planPixel(frame, middle);
    marks.push({
      number: thing.number,
      classname: thing.classname,
      kind: thing.kind,
      origin: middle.map(Math.round),
      at,
    });
    wanted.push({ at, words: `${thing.number} ${thing.classname}`, order: thing.kind === "trigger" ? 3 : 2 });
  }
  for (const thing of things) {
    if (thing.model !== null || !thing.origin) continue;
    const at = planPixel(frame, thing.origin);
    if (thing.turned && thing.kind !== "light") {
      const way = [Math.cos(thing.yaw * DEGREES), -Math.sin(thing.yaw * DEGREES)];
      line(
        canvas,
        at,
        [at[0] + way[0] * FACING_LENGTH, at[1] + way[1] * FACING_LENGTH],
        MARK_COLOURS[thing.kind],
      );
    }
    drawDot(canvas, at, DOT_RADIUS, MARK_COLOURS[thing.kind]);
    marks.push({
      number: thing.number,
      classname: thing.classname,
      kind: thing.kind,
      origin: thing.origin,
      at,
    });
    const order = { start: 0, monster: 1, other: 4, light: 5 }[thing.kind];
    wanted.push({ at, words: `${thing.number} ${thing.classname}`, order });
  }
  if (labels === false) return marks;
  // the labels: the kinds that matter most first, and none over one already written
  const few = labels === true || wanted.length <= LABELS_MOST;
  const taken = [];
  for (const { at, words, order } of wanted.sort((a, b) => a.order - b.order)) {
    if (!few && order > 0) continue;
    const box = [at[0] + DOT_RADIUS + 3, at[1] - 3, words.length * LETTER_WIDE + 2, LETTER_HIGH + 2];
    const overlaps = taken.some(
      (other) =>
        box[0] < other[0] + other[2] &&
        other[0] < box[0] + box[2] &&
        box[1] < other[1] + other[3] &&
        other[1] < box[1] + box[3],
    );
    if (overlaps || box[0] + box[2] > canvas.width) continue;
    taken.push(box);
    label(canvas, words, box[0] + 1, box[1] + 1, 1);
  }
  return marks;
}

/** The band under a plan: the kinds' colours, the scale bar, and which way is north. */
function drawPlanFoot(canvas, frame, kinds, words) {
  const top = canvas.height - PLAN_FOOT;
  for (let row = top; row < canvas.height; row++)
    for (let column = 0; column < canvas.width; column++)
      canvas.rgba.set([20, 22, 26, 255], (row * canvas.width + column) * 4);
  // the legend: a dot and a word for each kind of mark there is
  let x = PLAN_MARGIN;
  for (const kind of kinds) {
    drawDot(canvas, [x, top + 10], DOT_RADIUS, MARK_COLOURS[kind]);
    label(canvas, kind === "brush" ? "brush entity" : kind, x + 8, top + 8, 1, PLAN_COLOURS.ink);
    x += (kind === "brush" ? 12 : kind.length) * LETTER_WIDE + 22;
  }
  // the scale: the longest round length that fits
  const length = BAR_LENGTHS.filter((units) => units * frame.scale <= BAR_MOST).at(-1) ?? BAR_LENGTHS[0];
  const barY = top + 30;
  const barEnd = PLAN_MARGIN + Math.round(length * frame.scale);
  line(canvas, [PLAN_MARGIN, barY], [barEnd, barY], PLAN_COLOURS.ink);
  line(canvas, [PLAN_MARGIN, barY - 4], [PLAN_MARGIN, barY + 4], PLAN_COLOURS.ink);
  line(canvas, [barEnd, barY - 4], [barEnd, barY + 4], PLAN_COLOURS.ink);
  label(canvas, `${length} units  ${words}`, barEnd + 10, barY - 5, 2, PLAN_COLOURS.ink);
  // north: an arrow up the picture, in its top right corner
  const arrowX = canvas.width - PLAN_MARGIN;
  line(canvas, [arrowX, 8], [arrowX, 34], PLAN_COLOURS.ink);
  line(canvas, [arrowX, 8], [arrowX - 5, 16], PLAN_COLOURS.ink);
  line(canvas, [arrowX, 8], [arrowX + 5, 16], PLAN_COLOURS.ink);
  label(canvas, "+y", arrowX - 22, 6, 2, PLAN_COLOURS.ink);
  label(canvas, "+y up  +x right", 6, 6, 1, PLAN_COLOURS.ink);
  return length;
}

/** Tints a pixel of the canvas towards a colour. */
function tint(canvas, at, colour, share) {
  for (let channel = 0; channel < 3; channel++)
    canvas.rgba[at * 4 + channel] += (colour[channel] - canvas.rgba[at * 4 + channel]) * share;
}

/** What a plan's facts say of how it lies: the numbers a pixel is worked out from. */
const frameFacts = (frame) => ({
  scale: frame.scale,
  x0: frame.x0,
  y0: frame.y0,
  pixel: "a point (x, y) is at pixel ((x - x0) * scale, (y0 - y) * scale)",
});

/**
 * A compiled map seen from straight above: the picture that shows where a door or an entity IS. North (+y)
 * is up the picture and east (+x) to its right, as its corner says.
 *
 *   z              a height to cut at: what is above it is left out, and what is solid AT it (asked of the
 *                  world's tree, pixel by pixel) is filled in one colour: a floor plan of that storey, with
 *                  its doorways open. Without it the map is seen from above everything: each floor (the
 *                  highest wins: a roof hides its house), with the walls as lines
 *   slice          false: with `z`, no solid is filled; the walls are lines, as without it
 *   scale          pixels a unit; without it the map is fitted into `width` x `height` (1024 x 1024 at most)
 *   area           `{ min: [x, y], max: [x, y] }`: this part of the map only (a closer look)
 *   entities       false leaves the marks out. Each point entity is a dot: places to start in one colour,
 *                  lights in another, monsters and NPCs in a third, the rest in a fourth, with a short line
 *                  the way it faces; each brush entity is outlined (triggers in a colour of their own)
 *   labels         false leaves the words out. A label is an entity's number and class; where two would lie
 *                  over one another the less telling is left out (lights last), and a map of more than 60
 *                  marks labels only its places to start unless `labels` is true: `facts.marks` has them
 *                  all, and `area` gives a closer look
 *   and `light`, `brightness`, `textures`, `folders` as `drawMap` takes them: a floor is its texture's mean
 *   colour under the map's own light, so a dark room is dark on the plan.
 *
 * Returns `{ width, height, rgba, facts }`. `facts`: `{ scale, x0, y0, pixel (how a point finds its pixel),
 * z, bar (the scale bar's length in units), marks: [{ number, classname, kind, origin, at: [x, y] }],
 * missing, notes }`.
 */
export function planOf(bsp, options = {}) {
  const scene = sceneOf(bsp, options);
  const bounds = worldBounds(bsp);
  const frame = planFrame(bounds.mins, bounds.maxs, options);
  const cut = options.z;
  if (cut !== undefined && !Number.isFinite(cut)) throw new Error(`z: a height in units, not ${cut}`);
  const view = { ...frame, least: cut === undefined ? -Infinity : -cut };
  const canvas = newCanvas(frame.width, frame.height, PLAN_COLOURS.rock);
  const table = lightTable(options.brightness ?? BRIGHTNESS);
  const shown = scene.things.filter((thing) => thing.model && !thing.look.hidden && bsp.models[thing.model]);
  // the floors, the highest first in sight; liquids over them
  const liquids = [];
  const floor = (face, shift) => {
    const surface = scene.surfaceAt(face);
    if (!surface || surface.kind === "sky") return;
    if (surface.kind === "liquid") liquids.push({ surface, shift });
    else fill(canvas, view, surface, shift, { mean: true, ambient: PLAN_AMBIENT, lift: PLAN_LIFT }, table);
  };
  for (const face of facesOfModel(bsp, 0)) floor(face, [0, 0, 0]);
  for (const thing of shown)
    for (const face of facesOfModel(bsp, thing.model)) floor(face, thing.origin ?? [0, 0, 0]);
  for (const { surface, shift } of liquids)
    fill(canvas, view, surface, shift, { mean: true, alpha: LIQUID_ALPHA }, table);

  const sliced = cut !== undefined && options.slice !== false;
  if (sliced) {
    for (let row = 0; row < frame.height - PLAN_FOOT; row++)
      for (let column = 0; column < frame.width; column++) {
        const point = [frame.x0 + (column + 0.5) / frame.scale, frame.y0 - (row + 0.5) / frame.scale, cut];
        const contents = contentsAt(bsp, point);
        const at = row * frame.width + column;
        if (contents === CONTENTS.SOLID) canvas.rgba.set(PLAN_COLOURS.solid, at * 4);
        else if (contents === CONTENTS.SKY) canvas.rgba.set(PLAN_COLOURS.sky, at * 4);
        else if (contents !== CONTENTS.EMPTY) tint(canvas, at, PLAN_COLOURS.water, 0.5);
      }
  } else {
    // the walls as lines: each wall face's top edge, where no floor above hides it
    for (const face of facesOfModel(bsp, 0)) {
      const surface = scene.surfaceAt(face);
      if (!surface || surface.kind !== "face" || Math.abs(surface.normal[2]) > WALL_MOST) continue;
      const heights = surface.polygon.map((corner) => corner[2]);
      if (cut !== undefined && Math.min(...heights) > cut) continue;
      const top = Math.min(Math.max(...heights), cut ?? Infinity);
      surface.polygon.forEach((corner, index) => {
        const next = surface.polygon[(index + 1) % surface.polygon.length];
        wallLine(canvas, planPixel(frame, corner), planPixel(frame, next), top);
      });
    }
  }

  const outlineOf = (thing) =>
    bsp.models[thing.model]
      ? facesOfModel(bsp, thing.model).map((face) =>
          facePolygon(bsp, face).map((corner) => plus(corner, thing.origin ?? [0, 0, 0])),
        )
      : [];
  const marks =
    options.entities === false ? [] : drawPlanMarks(canvas, frame, scene.things, outlineOf, options.labels);
  const kinds = Object.keys(MARK_COLOURS).filter((kind) => marks.some((mark) => mark.kind === kind));
  const words = cut === undefined ? "seen from above" : `cut at z ${cut}`;
  const bar = drawPlanFoot(canvas, frame, kinds, words);
  const notes = [];
  if (scene.missing.size)
    notes.push(`${scene.missing.size} textures were found nowhere: their floors are a flat colour each`);
  if (!scene.lit) notes.push("the map has no light data: floors are shaded plainly");
  if (marks.length > LABELS_MOST && options.labels === undefined)
    notes.push(
      `${marks.length} entities are marked, too many to label: only the places to start are. \`area\` gives a closer look, and \`labels: true\` labels all that fit`,
    );
  const facts = {
    ...frameFacts(frame),
    z: cut ?? null,
    bar,
    marks,
    missing: [...scene.missing].sort(),
    notes,
  };
  return { ...pictureOf(canvas), facts };
}

/** A wall's line on a plan: drawn where no floor is more than a little above the wall's top. */
function wallLine(canvas, from, to, top) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]))));
  for (let step = 0; step <= steps; step++) {
    const column = Math.round(from[0] + ((to[0] - from[0]) * step) / steps);
    const row = Math.round(from[1] + ((to[1] - from[1]) * step) / steps);
    if (column < 0 || row < 0 || column >= canvas.width || row >= canvas.height - PLAN_FOOT) continue;
    const at = row * canvas.width + column;
    // a pixel's nearness on a plan is minus the height of the floor drawn there
    if (-canvas.nearness[at] > top + LINE_COVER) continue;
    canvas.rgba.set(PLAN_COLOURS.wall, at * 4);
  }
}

// ── brush source ────────────────────────────────────────────────────────────
/** A brush's faces as surfaces of one colour each, by the name of the texture; the tools' faces left out. */
function sourceSurfaces(brush, sky) {
  const surfaces = [];
  for (const face of shapeOf(brush).faces) {
    if (!face.normal || !(face.area > 0)) continue;
    const kind = textureKind(face.texture);
    if (kind.tool) continue;
    surfaces.push({
      polygon: face.polygon,
      normal: face.normal,
      dist: face.dist,
      sAxis: NO_AXIS,
      tAxis: NO_AXIS,
      texture: flatTexture(
        face.texture,
        kind.sky ? sky : kind.water ? PLAN_COLOURS.water : colourOfName(face.texture),
      ),
      light: null,
      shade: kind.sky ? 1 : shadeOf(face.normal),
      kind: kind.sky ? "sky" : kind.water ? "liquid" : "face",
      holes: kind.holes,
    });
  }
  return surfaces;
}

/** Brush source made ready: its entities, the world's surfaces, and each drawn brush entity's. */
function sourceScene(map, sky = SKY_COLOUR) {
  if (!map || !Array.isArray(map.brushes))
    throw new Error(
      "the map's source is { worldspawn, brushes, entities }: what `writeMap` takes and `readMap` gives",
    );
  const things = thingsOfSource(map);
  const world = map.brushes.flat().flatMap((brush) => sourceSurfaces(brush, sky));
  const others = things
    .filter((thing) => thing.model !== null && !thing.look.hidden)
    .map((thing) => ({ thing, surfaces: thing.brushes.flatMap((brush) => sourceSurfaces(brush, sky)) }));
  return { things, world, others };
}

/**
 * A view of a map that is only SOURCE: brushes and entities as `writeMap` takes them (or `readMap` gives),
 * with no compile. Each face is one flat colour, chosen by its texture's name and shaded by the way it
 * looks, with its edges drawn darker: the shapes, the openings and where things stand are true; the textures' pictures and the light are
 * not there yet. A `{` texture is drawn as a mesh that lets what is behind it show; sky is the sky's colour;
 * the compilers' own textures (clip, origin, hint, null, aaatrigger) are left out, and so are triggers.
 *
 *   from, to, yaw, pitch, fov, width, height, entities, labels, sky   as `drawMap` takes them; without
 *   `from`, the first place to start. `entities` is "all" unless told: every point entity is a labelled box.
 *
 * Returns `{ width, height, rgba, facts }`: `facts` has `from`, `yaw`, `pitch`, `fov`, `faces`, `pixels`,
 * `textures` (the names and the colour each was drawn in), `marked` and `notes`.
 */
export function drawSource(map, options = {}) {
  const width = sideOf(options.width, VIEW_WIDTH, "width");
  const height = sideOf(options.height, VIEW_HEIGHT, "height");
  const scene = sourceScene(map, options.sky);
  let stand = options;
  if (!options.from) {
    const start = firstStart(scene.things);
    if (!start) throw new Error("drawSource: the map has no place to start: give `from`");
    stand = { ...options, ...viewFrom(map, start.number), ...definedOnly(options) };
  }
  const view = cameraOf(stand, width, height);
  const canvas = newCanvas(width, height, NOTHING);
  const table = lightTable(BRIGHTNESS);
  let faces = 0;
  const later = [];
  const draw = (surface, look) => {
    const paint = {
      alpha: look.alpha,
      additive: look.additive,
      stipple: surface.holes,
      outline: OUTLINE_SHARE,
    };
    if (surface.kind === "liquid") paint.alpha = Math.min(paint.alpha, LIQUID_ALPHA);
    if (paint.alpha < 1 || paint.additive) {
      later.push({ surface, paint });
      return;
    }
    if (fill(canvas, view, surface, [0, 0, 0], paint, table)) faces++;
  };
  const plain = { alpha: 1, additive: false };
  for (const surface of scene.world) draw(surface, plain);
  for (const { thing, surfaces } of scene.others) for (const surface of surfaces) draw(surface, thing.look);
  const marked = drawMarks(
    canvas,
    view,
    markedThings(scene.things, options.entities ?? "all"),
    table,
    options.labels,
  );
  for (const { surface, paint } of later) if (fill(canvas, view, surface, [0, 0, 0], paint, table)) faces++;
  const names = [
    ...new Set(
      [...scene.world, ...scene.others.flatMap((each) => each.surfaces)].map(
        (surface) => surface.texture.name,
      ),
    ),
  ];
  const facts = {
    from: view.eye,
    yaw: view.yaw,
    pitch: view.pitch,
    fov: view.fov,
    faces,
    pixels: shareDrawn(canvas),
    light: "none",
    textures: names.sort().map((name) => ({ name, colour: colourOfName(name) })),
    marked,
    notes: [
      "source, not compiled: each face is one flat colour by its texture's name, shaded by the way it looks; no texture's picture and no light",
    ],
  };
  return { ...pictureOf(canvas), facts };
}

/** The height a source plan is cut at unless told: a place to start's, or the middle of the brushes. */
function cutHeightOf(things, min, max) {
  const start = firstStart(things);
  if (start) return start.origin[2];
  return (min[2] + max[2]) / 2;
}

/**
 * The plan of a map that is only SOURCE: a cut through its brushes at a height, seen from above, with the
 * floors under the cut in a colour for each texture name, and the entities marked as `planOf` marks them.
 * A brush of the world is solid where it is cut (liquids and sky in colours of their own; the compilers'
 * clip, hint and origin brushes are nothing); a brush entity is outlined, not filled.
 *
 *   z              the height of the cut. Without it: that of the first place to start (a player's middle,
 *                  36 over its floor), so that doorways are open and steps are not walls
 *   scale, width, height, area, entities, labels   as `planOf` takes them
 *
 * Returns `{ width, height, rgba, facts }`, `facts` as `planOf` gives (no `missing`).
 */
export function planOfSource(map, options = {}) {
  const scene = sourceScene(map);
  const shapes = map.brushes.flat().map((brush) => ({ brush, shape: shapeOf(brush) }));
  const sound = shapes.filter(({ shape }) => shape.corners.length && Number.isFinite(shape.volume));
  if (!sound.length) throw new Error("planOfSource: the map has no brush of the world to draw");
  const min = [0, 1, 2].map((axis) => Math.min(...sound.map(({ shape }) => shape.min[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...sound.map(({ shape }) => shape.max[axis])));
  const frame = planFrame(min, max, options);
  const cut = options.z ?? cutHeightOf(scene.things, min, max);
  if (!Number.isFinite(cut)) throw new Error(`z: a height in units, not ${cut}`);
  const view = { ...frame, least: -cut };
  const canvas = newCanvas(frame.width, frame.height, PLAN_COLOURS.rock);
  const table = lightTable(BRIGHTNESS);
  for (const surface of scene.world)
    if (surface.kind === "face") fill(canvas, view, surface, [0, 0, 0], {}, table);
  for (const { surfaces } of scene.others)
    for (const surface of surfaces)
      if (surface.kind === "face" && !surface.holes) fill(canvas, view, surface, [0, 0, 0], {}, table);

  // the cut: each brush of the world fills the pixels whose point at the cut's height is inside it
  for (const { brush, shape } of sound) {
    if (shape.min[2] > cut || shape.max[2] < cut) continue;
    const kind = textureKind(brush.faces[0].texture);
    if (kind.tool && brush.faces[0].texture.toLowerCase() !== "null") continue;
    const planes = shape.faces.filter((face) => face.normal);
    const [left, top] = planPixel(frame, [shape.min[0], shape.max[1]]);
    const [right, bottom] = planPixel(frame, [shape.max[0], shape.min[1]]);
    for (let row = Math.max(0, top - 1); row <= Math.min(frame.height - PLAN_FOOT - 1, bottom + 1); row++)
      for (let column = Math.max(0, left - 1); column <= Math.min(frame.width - 1, right + 1); column++) {
        const point = [frame.x0 + (column + 0.5) / frame.scale, frame.y0 - (row + 0.5) / frame.scale, cut];
        if (!planes.every((plane) => dot(plane.normal, point) <= plane.dist)) continue;
        const at = row * frame.width + column;
        if (kind.sky) canvas.rgba.set(PLAN_COLOURS.sky, at * 4);
        else if (kind.water) tint(canvas, at, PLAN_COLOURS.water, 0.5);
        else canvas.rgba.set(PLAN_COLOURS.solid, at * 4);
      }
  }

  const outlineOf = (thing) =>
    thing.brushes.flatMap((brush) =>
      shapeOf(brush)
        .faces.map((face) => face.polygon)
        .filter((polygon) => polygon.length >= 3),
    );
  const marks =
    options.entities === false ? [] : drawPlanMarks(canvas, frame, scene.things, outlineOf, options.labels);
  const kinds = Object.keys(MARK_COLOURS).filter((kind) => marks.some((mark) => mark.kind === kind));
  const bar = drawPlanFoot(canvas, frame, kinds, `source  cut at z ${cut}`);
  const facts = {
    ...frameFacts(frame),
    z: cut,
    bar,
    marks,
    notes: ["source, not compiled: floors are a flat colour by texture name; no light"],
  };
  return { ...pictureOf(canvas), facts };
}
