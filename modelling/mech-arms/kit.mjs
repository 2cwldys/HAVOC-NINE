// Shapes shared by the Mech's arm-mounted weapons: the armoured forearm (the gauntlet) the weapon grows out of, the wrist
// collar, hydraulic pistons, hoses and plates. All in the view model's idle-pose space (+x forward from the eye, +y
// left, +z up); every part is named so that its first letters say which bone it rides on (see boneOf in each model).
import { W, gunmetal, edge, bolt, groove, inset, hazard, roundShade, times, mix, accent, STEEL, DARK, WORN, YELLOW, RUBBER } from "./paint.mjs";

export const cos8 = Math.cos(Math.PI / 8);
/** Half extents of an octagon's flat faces as the radii of its corners. */
export const r8 = (up, side) => [up / cos8, side / cos8];
/** An octagon tube left open at its ends (the collar and the next part cover them), and a four-sided slab closed with the caps zone. */
export const open8 = { sides: 8, seam: Math.PI / 8, caps: [false, false] };
export const slabOf = (Z) => ({ sides: 4, seam: Math.PI / 4, caps: [Z.CAPS, Z.CAPS] });

/** Face k of an octagon tube is centred (from the top, round to the right) at (k + 1) * 45 degrees: 7 top, 6 top left, 5 left. */
export const FACE = { topRight: 0, right: 1, bottomRight: 2, bottom: 3, bottomLeft: 4, left: 5, topLeft: 6, top: 7 };

/** `round` for a tube zone: each face's share of the zone's height, as pixels, from face 0 on (cumulative, 0 to 1). */
export function roundOf(pixels) {
  const total = pixels.reduce((a, b) => a + b, 0);
  const out = [0];
  for (const p of pixels) out.push(out.at(-1) + p / total);
  out[out.length - 1] = 1;
  return out;
}
/** Where face k lies in a zone of height h with those pixel heights: [v0, v1]. */
export const faceSpan = (pixels, k) => [pixels.slice(0, k).reduce((a, b) => a + b, 0), pixels.slice(0, k + 1).reduce((a, b) => a + b, 0)];

/**
 * The gauntlet: the arm's armoured forearm, an octagon tube from far behind the eye (so that the melee thrust never shows
 * its rear end) to the wrist. Its zone's width is shared by `rings`: [[s, u]] with s the distance from the first station.
 */
export function gauntlet(M, Z, g) {
  const r = r8(g.up, g.side);
  const path = g.stations.map((x) => [x, g.cy, g.cz, r]);
  const first = g.stations[0];
  return M.tube(path, Z.FORE, {
    name: "m60_fore", ...open8, smooth: 35,
    places: { rings: g.stations.map((x, i) => [x - first, g.u[i]]), round: roundOf(g.facePx) },
  });
}

/** A hydraulic piston: a cylinder with a bright rod running out of it into a bracket. */
export function piston(M, Z, name, y, z, x0, x1, x2, r = 0.42) {
  M.turn([{ s: x0, r: r - 0.1 }, { s: x0 + 0.12, r, crease: true }, { s: x1 - 0.12, r, crease: true }, { s: x1, r: r - 0.1, crease: true }], Z.PISTON,
    { name: `${name}_body`, sides: 12, at: (s, a, b) => [s, y + a, z + b], seam: Math.PI * 0.5, caps: [Z.CAPS, Z.CAPS], smooth: 35 });
  M.turn([[x1, r * 0.48], [x2, r * 0.48]], Z.ROD, { name: `${name}_rod`, sides: 8, at: (s, a, b) => [s, y + a, z + b], seam: Math.PI * 0.5, caps: [false, Z.CAPS] });
}

/** A hose: a ribbed black tube along a path of [x, y, z] points. */
export function hose(M, Z, name, pts, r = 0.2) {
  return M.tube(pts.map(([x, y, z], i) => [x, y, z, i === pts.length - 1 ? r * 0.9 : r]), Z.CABLE, { name, sides: 6, caps: [Z.CAPS, Z.CAPS] });
}

/** A flat armour plate lying on a face: half extents (up, side) about (y, z), from x0 to x1. */
export function plate(M, Z, zone, name, x0, x1, y, z, up, side, o = {}) {
  return M.tube([[x0, y, z, [up, side]], [x1, y, z, [up, side]]], zone, { name, ...slabOf(Z), smooth: 30, ...o });
}

/** The paint of the gauntlet: gunmetal in panels, vents on the flank, bolts along its visible front. */
export function paintFore(S, Z, g) {
  const z = Z.FORE;
  const sum = g.facePx.reduce((a, b) => a + b, 0);
  const px = g.facePx.map((p) => (p * z.h) / sum);              // the faces' heights in this zone's own pixels
  const starts = px.map((_, k) => px.slice(0, k).reduce((a, b) => a + b, 0));
  const faceOf = (v) => {
    let k = 7;
    for (let q = 0; q < 8; q++) if (v < starts[q] + px[q]) { k = q; break; }
    return [k, v - starts[k], px[k]];
  };
  const split = g.u[1] * z.w;                      // where the long hidden rear ends and the visible front begins
  S.zone(z, (u, v) => {
    const [k, vin, fh] = faceOf(Math.min(v, z.h - 0.01));
    let c = gunmetal(u, v, 17, k === FACE.top ? 1.4 : k === FACE.left ? 1.2 : 1.3);
    for (let q = 0; q < 8; q++) c = groove(c, v - starts[q], 0.7);                                          // the seams between faces
    if (u > split) {
      for (const x of [0.33, 0.72]) c = groove(c, u - (split + x * (z.w - split)), 0.8);                   // panel seams across
      if (k === FACE.left) for (let j = 0; j < 4; j++) c = inset(c, u, v, split + 0.52 * (z.w - split), starts[k] + 4 + j * fh * 0.2, 40, 2.6, times(DARK, 1.1));   // vent louvres
      if (k === FACE.top && u > split + 0.1 * (z.w - split) && u < split + 0.26 * (z.w - split) && Math.abs(vin - fh * 0.5) < 2) c = [0.74, 0.58, 0.12];
      for (let x = split + 11; x < z.w - 5; x += 20) {
        for (const kk of [FACE.left, FACE.top, FACE.topLeft]) {
          c = bolt(c, u, v, x, starts[kk] + 4, 1.5);
          c = bolt(c, u, v, x, starts[kk] + px[kk] - 4, 1.5);
        }
      }
    }
    return mix(c, WORN, 0.22 * edge(u, v, z, 1.2));
  });
}
