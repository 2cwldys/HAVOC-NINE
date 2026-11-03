// nexus.mjs: the MSR Nexus, standing in the well -- the MSR's headquarters and the city's central precinct.
//
// The podium and the hall are rock, carved from inside like everything else in the city: the well's open air is
// laid round them in pieces, so what is not air is the Nexus itself.
//   THE PODIUM (two tiers, 0..176 and 176..352, climbed by the grand steps on all four sides):
//     the undercroft (0..160): the jail block (a row of twelve cells with grate doors, a guard post), booking and
//     interrogation, the armory and the locker room, the sally port garage that opens on the plaza;
//   THE HALL (an octagon, 352..1408, its four great doors at the head of the steps):
//     the public lobby (352..688) with the front desk in its booth, benches, banners;
//     the operations floor (704..1040), where the four ward tubes come in from the ward ring;
//     the command floor (1056..1392): the antechamber the Mese's bridges open into, and the Lord Commander's
//     office behind it, its windows over the well and its balcony on the north bridge;
//   TWO STAIRS run through it all: the MSR stair (south-west) from the tunnels to the command floor, a locked door
//     onto the lobby; the Lord Commander's own stair (north-east) from the office straight down to the tunnels;
//   THE TUNNELS (-176..-16): under the plaza and the avenues to the four cardinal precincts' cores.
// Over the hall the dome steps in, a spire banded in gold rises out of the well, and a beacon tops it.
import { M } from "../lib.mjs";
import { DOOR, door, glass, plate, lamp, prop, spiralCore, column } from "./kit.mjs";
import { FRAMES, fbox, octagon, cut, H, rect, boundsOf, COMPASS } from "./geo.mjs";

const IN = 448; // the hall's inner faces stand this far from the middle
const OUTER = 480; // and its outer ones
const STEP_OUT = 1312; // the foot of the lower steps and their pedestals
const T = (a) => Math.round(a * 0.414214);

/**
 * The well's open air, in pieces round the podium and the hall, each convex: the plaza at the foot of the
 * steps, the steps' own band, the terrace on the lower tier, the air beside the hall and over it, the air
 * of the rest of the well up to the sky. `add(name, outline, floor, ceiling, texture)` makes each a space.
 */
export function wellSpaces({ add, wellOutline, Z }) {
  const sky = Z.wellSky;
  const outerWall = { floor: "hMarb_surfaced3", wall: "wallvault1", ceiling: "sky" };
  const marbleWall = { floor: "hMarb_surfaced3", wall: "sinmarblewall", ceiling: "sky" };
  /** The four pieces of an outline outside the square of half-side `a`. */
  const ring = (poly, a) => ({
    n: cut(poly, H.yge(a)),
    s: cut(poly, H.yle(-a)),
    e: cut(poly, H.xge(a), H.yge(-a), H.yle(a)),
    w: cut(poly, H.xle(-a), H.yge(-a), H.yle(a)),
  });
  const square = (a) => rect([-a, -a, a, a]);
  // the plaza, round the steps' band; the band itself, its inner faces the lower tier's marble
  for (const [d, poly] of Object.entries(ring(wellOutline, STEP_OUT))) if (poly) add(`well_plaza_${d}`, poly, 0, 352, outerWall);
  for (const [d, poly] of Object.entries(ring(square(STEP_OUT), 928))) if (poly) add(`well_steps_${d}`, poly, 0, 352, marbleWall);
  // the terrace on the lower tier, round the upper one
  for (const [d, poly] of Object.entries(ring(square(928), 576))) if (poly) add(`well_terrace_${d}`, poly, 176, 352, { floor: "marb", wall: "sinmarblewall", ceiling: "sky" });
  // beside the hall: the band between it and a square of 640, the hall's faces marble, its foot the upper tier's top
  for (const [d, poly] of Object.entries(ring(square(640), OUTER))) if (poly) add(`well_hallside_${d}`, poly, 352, 1408, { floor: "marb", wall: "sinmarblewall", ceiling: "sky" });
  const t = T(OUTER);
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const tri = [[sx * OUTER, sy * t], [sx * OUTER, sy * OUTER], [sx * t, sy * OUTER]];
    const ordered = sx * sy > 0 ? tri : [...tri].reverse();
    add(`well_hallcorner_${sx > 0 ? "e" : "w"}${sy > 0 ? "n" : "s"}`, ordered, 352, 1408, { floor: "marb", wall: "sinmarblewall", ceiling: "sky" });
  }
  // the rest of the well, from the hall's foot up to the sky; and over the hall's roof
  for (const [d, poly] of Object.entries(ring(wellOutline, 640))) if (poly) add(`well_air_${d}`, poly, 352, sky, outerWall);
  add("well_roof", square(640), 1408, sky, { floor: "stec_panel5b", wall: "wallvault1", ceiling: "sky" });
}

/**
 * The Nexus: its fittings (the steps, the dome, the spire, the bridges and tubes across the well, the well's
 * own walls) and the headquarters carved inside it. `ctx`: { bag, Z, WELL, add, opening, say, countRoom }.
 */
export function buildNexus(ctx) {
  const { bag, Z, WELL, add, say } = ctx;
  const out = bag;
  const MARBLE = { top: "marb", bottom: "marb", sides: "sinmarblewall" };
  const STEEL = "stec_panel5b";
  const GOLD = "singold";
  /** A carved room of several convex pieces (they overlap, so they are one room), each `z0`..`z1`. */
  const room = (name, pieces, z0, z1, tex, kind = "msr") => pieces.filter(Boolean).forEach((p, k) => add(`${name}${pieces.length > 1 ? `_${k}` : ""}`, p, z0, z1, tex, kind));
  /** An opening between two spaces: a box, carved. */
  const hole = (name, b, tex) => ctx.opening(name, b, tex);
  /** A door in an opening, a use-only one (it opens for who uses it, named for the game to lock) unless told. */
  const shut = (name, b, tex, opts = {}) => {
    hole(name, b, opts.wall ?? tex);
    out.entities.push(door(b, tex, { use: true, name, ...opts }));
  };
  const box = (b, tex) => out.detail.push(M.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], tex));

  // ======== OUTSIDE ======================================================================================
  // the grand steps on all four sides, up the lower tier and then the upper; pedestals with lamps at their feet
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    for (const [u0, u1, z0] of [[928, 1280, 0], [576, 928, 176]]) {
      const b = fbox(f, [u0, -256, z0, u1, 256, z0 + 176]);
      out.detail.push(...M.stairs([b[0], b[1], b[2]], [b[3], b[4], b[5]], f.dir["-u"], MARBLE, { tread: 32, ramp: "CLIP" }));
    }
    for (const [u, z] of [[1312, 0], [848, 176]])
      for (const v of [-320, 320]) {
        const p = fbox(f, [u, v - 40, z, u + 80, v + 40, z + 96]);
        box(p, { top: GOLD, bottom: "marb", sides: "sinmarblewall" });
        out.entities.push(lamp([(p[0] + p[3]) / 2, (p[1] + p[4]) / 2, z + 128], [190, 140, 255], 200));
      }
    for (const [u, z] of [[1104, 300], [752, 476]]) out.entities.push(lamp([...f.p(u, z === 300 ? 0 : 0), z], [235, 220, 255], 320));
  }

  // the hall's ways out through its walls (448..480): the great doors at the head of the steps, a ward tube's
  // door a floor up, a bridge's door at the command floor
  const HQ_LOBBY = { floor: "marb", wall: "MJSTWALL10", ceiling: "sinceiling3" };
  const HQ_OPS = { floor: "MJSTFLOOR01", wall: "MJSTWALL04", ceiling: "MJSTFLAT03" };
  const HQ_ANTE = { floor: "sinpalacefloor", wall: "sinwoodwallluxu", ceiling: "sinceiling3" };
  const HQ_OFFICE = { floor: "sinwoodenfloor5", wall: "sinwoodwallluxu", ceiling: "sinceiling3" };
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const B = (b) => fbox(f, b);
    hole(`hq_gate_${d}`, B([IN, -96, 352, OUTER, 96, 544]), HQ_LOBBY);
    hole(`hq_ward_${d}`, B([IN, -64, Z.ward, OUTER, 64, Z.ward + 192]), HQ_OPS);
    hole(`hq_bridge_${d}`, B([IN, -96, Z.mese, OUTER, 96, Z.mese + 160]), d === "n" ? HQ_OFFICE : HQ_ANTE);
    // the great doors: a pair of solid MSR blast doors that swing in, one picture across the two
    const pair = B([IN + 8, -96, 352, IN + 16, 96, 544]);
    const pairX = pair[3] - pair[0] >= pair[4] - pair[1];
    const fit = M.fitted("MJSTDOOR02", [128, 128], [pair[0], pair[1], pair[2]], [pair[3], pair[4], pair[5]], { whole: true, faces: pairX ? ["north", "south"] : ["east", "west"], rest: "MJSTTRIM01" });
    for (const sgn of [-1, 1]) {
      const leaf = B([IN + 8, sgn > 0 ? 0 : -96, 352, IN + 16, sgn > 0 ? 96 : 0, 544]);
      const hinge = f.p(IN + 12, sgn * 96);
      out.entities.push(M.brushEntity("func_door_rotating", [M.box([leaf[0], leaf[1], leaf[2]], [leaf[3], leaf[4], leaf[5]], { ...fit, top: "MJSTTRIM01", bottom: "MJSTTRIM01" }), M.originBrush([hinge[0], hinge[1], 448])], { distance: 90, speed: 70, wait: 6, spawnflags: sgn > 0 ? 0 : 2 }));
    }
    // the ward tube: an enclosed bridge to the ward ring in the well's wall, its windows glazed
    const tube = (u0, v0, u1, v1, z0, z1, tex) => box(B([u0, v0, z0, u1, v1, z1]), tex);
    tube(OUTER, -80, WELL, 80, 688, 704, { top: "gratefloor", bottom: STEEL, sides: STEEL });
    tube(OUTER, -80, WELL, 80, 896, 912, { top: STEEL, bottom: "MJSTFLAT03", sides: STEEL });
    for (const v0 of [-80, 64]) {
      tube(OUTER, v0, WELL, v0 + 16, 704, 752, "MJSTWALL09");
      tube(OUTER, v0, WELL, v0 + 16, 848, 896, "MJSTWALL09");
      for (let u = OUTER; u < WELL; u += 192) tube(u, v0, Math.min(u + 16, WELL), v0 + 16, 752, 848, "MJSTTRIM01");
      const g = B([OUTER, v0 + 7, 752, WELL, v0 + 9, 848]);
      out.entities.push(M.brushEntity("func_wall", [M.box([g[0], g[1], g[2]], [g[3], g[4], g[5]], "glass_dark")], { rendermode: 2, renderamt: 80 }));
    }
    tube(1440, -48, 1504, 48, 0, 688, { top: STEEL, bottom: STEEL, sides: "wallvault2" });
    for (let u = 640; u < WELL; u += 448) out.entities.push(lamp([...f.p(u, 0), 872], [170, 110, 255], 120));
    // the upper bridge: open, railed, lamplit, from the Mese to the command floor
    tube(OUTER, -96, WELL, 96, 1040, 1056, { top: "marb", bottom: STEEL, sides: GOLD });
    for (const v0 of [-96, 92]) tube(OUTER, v0, WELL, v0 + 4, 1056, 1096, GOLD);
    for (const u of [800, 1300])
      for (const v of [-84, 84]) {
        const [px, py] = f.p(u, v);
        out.detail.push(M.cylinder("z", [px, py], 5, 1056, 1248, GOLD, { sides: 8, snap: 1 }));
        out.entities.push(lamp([px, py, 1236], [255, 220, 170], 160));
      }
    // over the great doors, outside: the MSR's banner, the HEADQUARTERS plate, and a lamp on them
    const bb = B([OUTER, -128, 560, OUTER + 4, 128, 688]);
    out.entities.push(M.brushEntity("func_wall", [M.box([bb[0], bb[1], bb[2]], [bb[3], bb[4], bb[5]], { ...M.fitted("{ax_msr", [256, 256], [bb[0], bb[1], bb[2]], [bb[3], bb[4], bb[5]], { whole: true, faces: [COMPASS[f.face["+u"]]], rest: "null" }) })], { rendermode: 4, renderamt: 255 }));
    out.entities.push(lamp([...f.p(OUTER + 96, 0), 640], [210, 170, 255], 220));
  }

  // the dome: six rings stepping in over the hall's roof, gold underneath, steel on top, and its cap
  const Z1 = 1408;
  for (let k = 0; k < 6; k++) {
    const p = octagon(448 - 56 * k);
    const q = octagon(480 - 40 * k);
    const z0 = Z1 + 64 * k;
    for (let i = 0; i < 8; i++) {
      const mid = (((i + 0.5) * 45 + 22.5) * Math.PI) / 180;
      const way = [Math.cos(mid), Math.sin(mid)];
      out.detail.push(M.prism("z", [p[i], p[(i + 1) % 8], q[(i + 1) % 8], q[i]], z0, z0 + 64, (n) => (n[2] < -0.5 ? "sinceiling3" : n[2] > 0.5 ? STEEL : n[0] * way[0] + n[1] * way[1] < 0 ? "sinceiling3" : STEEL)));
    }
  }
  const capZ = Z1 + 384;
  out.world.push(M.prism("z", octagon(288), capZ, capZ + 32, { top: STEEL, bottom: "sinceiling3", sides: GOLD }));
  // the spire, banded in gold, crowned, a beacon on top
  const spire0 = capZ + 32;
  out.world.push(M.cylinder("z", [0, 0], 112, spire0, 3584, STEEL, { sides: 8, snap: 1 }));
  for (let z = spire0 + 192; z < 3500; z += 256) out.detail.push(M.cylinder("z", [0, 0], 128, z, z + 32, GOLD, { sides: 8, snap: 1 }));
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const fin = [[112, -8], [288, -8], [288, 8], [112, 8]].map(([u, v]) => f.p(u, v));
    out.detail.push(M.prism("z", fin, spire0, spire0 + 384, STEEL));
  }
  out.detail.push(M.cone("z", [0, 0], 144, 3584, 3968, GOLD, { sides: 8 }));
  out.entities.push(lamp([0, 0, 3700], [190, 120, 255], 900));
  out.entities.push(M.pointEntity("env_sprite", [0, 0, 3990], { model: "sprites/flare6.spr", rendermode: 5, renderamt: 255, rendercolor: "200 140 255", scale: 3, spawnflags: 1 }));
  // the well's own walls: lit windows in rows, the MSR's banners, gold bands, a lamp on every side
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    let lit = 0;
    for (let z = 1600; z < 4000; z += 352)
      for (let v = -1152; v <= 1152; v += 384) {
        if (z < 2300 && Math.abs(v) < 400) continue;
        box(fbox(f, [WELL - 2, v - 32, z, WELL, v + 32, z + 96]), lit++ % 4 === 3 ? "glass_dark" : "glass_yellow1");
      }
    const bb = fbox(f, [WELL - 6, -160, 1600, WELL - 2, 160, 2240]);
    out.entities.push(plate([bb[0], bb[1], bb[2]], [bb[3], bb[4], bb[5]], "{ax_msr"));
    for (let z = 1504; z < 4200; z += 704) box(fbox(f, [WELL - 8, -1216, z, WELL, 1216, z + 16]), GOLD);
    out.entities.push(lamp([...f.p(WELL - 200, 0), 2400], [180, 120, 255], 500));
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 2 * Math.PI + Math.PI / 8;
    const [x, y] = [Math.round(1480 * Math.cos(a)), Math.round(1480 * Math.sin(a))];
    out.detail.push(M.cylinder("z", [x, y], 8, 0, 320, "metal5", { sides: 8, snap: 1 }));
    box([x - 20, y - 20, 320, x + 20, y + 20, 336], { top: "metal5", bottom: "glass_yellow1", sides: GOLD });
    out.entities.push(lamp([x, y, 300], [215, 190, 255], 260));
  }
  out.entities.push(M.pointEntity("light_environment", [0, 0, Z.wellSky - 64], { angles: "-70 140 0", pitch: -70, _light: "55 65 115 30" }));

  // ======== INSIDE: THE HEADQUARTERS ======================================================================
  const oct = octagon(IN);
  // the two stairs: the MSR's (south-west) and the Lord Commander's own (north-east), each a shaft 192 square
  const SW = [-304, -304, -112, -112];
  const NE = [112, 112, 304, 304];
  const SHAFT = { floor: "gratefloor", wall: "MJSTWALL04", ceiling: "MJSTFLAT03" };
  add("hq_stair_msr", rect(SW), -176, 1216, SHAFT, "msr");
  add("hq_stair_commander", rect(NE), -176, 1216, SHAFT, "msr");
  out.detail.push(...spiralCore([-208, -208], -176, 7, "n", "metal13dn"));
  out.detail.push(...spiralCore([208, 208], -176, 7, "w", "metal13dn"));
  for (const z of [-60, 300, 640, 990, 1150]) {
    out.entities.push(lamp([-208, -208, z], [190, 150, 255], 120));
    out.entities.push(lamp([208, 208, z], [255, 210, 160], 110));
  }
  /** A hall floor round both shafts: the octagon less each shaft and 16 of rock round it, in convex pieces. */
  const floorPieces = (extra = []) => [
    cut(oct, H.yle(-320), ...extra),
    cut(oct, H.xge(-96), H.yle(96), ...extra),
    cut(oct, H.xle(-320), ...extra),
    cut(oct, H.yge(-96), H.xle(96), ...extra),
    cut(oct, H.yge(320), ...extra),
    cut(oct, H.xge(320), ...extra),
  ];
  // the lobby: the public's, through any of the four great doors
  room("hq_lobby", floorPieces(), 352, 688, HQ_LOBBY, "msr");
  // the operations floor
  room("hq_ops", floorPieces(), Z.ward, 1040, HQ_OPS, "msr");
  // the command floor: the antechamber (y up to 96) and the office (from 112), 16 of rock between
  room("hq_antechamber", [cut(oct, H.yle(-320)), cut(oct, H.xge(-96), H.yle(96)), cut(oct, H.xle(-320), H.yle(96)), cut(oct, H.yge(-96), H.yle(96), H.xle(96))], Z.mese, 1392, HQ_ANTE, "msr");
  // (the corner east of the Lord Commander's stair is shut off by it and the hall's diagonal wall: it stays rock)
  room("commander_office", [cut(oct, H.yge(112), H.xle(96)), cut(oct, H.yge(320))], Z.mese, 1392, HQ_OFFICE, "msr");
  // the MSR stair's doors: a locked one onto the lobby, open ways onto the rest; the Lord Commander's only at the office
  shut("hq_stair_lobby", [-264, -112, 352, -152, -96, 352 + DOOR.h], "MJSTDOOR02", { wall: SHAFT });
  hole("hq_stair_ops", [-264, -112, Z.ward, -152, -96, Z.ward + DOOR.h], SHAFT);
  hole("hq_stair_command", [-264, -112, Z.mese, -152, -96, Z.mese + DOOR.h], SHAFT);
  shut("commander_stair", [96, 176, Z.mese, 112, 232, Z.mese + DOOR.h], "cd_wooddoor", { wall: HQ_OFFICE });
  shut("commander_office", [-56, 96, Z.mese, 0, 112, Z.mese + DOOR.h], "cd_wooddoor", { wall: HQ_ANTE });
  // the office's windows over the well: through the north-west diagonal wall, and either side of the balcony's door
  for (const [x0, x1] of [[-176, -120], [120, 176]]) {
    add(`commander_window_n${x0 < 0 ? "w" : "e"}`, rect([x0, IN, x1, OUTER]), Z.mese + 64, Z.mese + 224, HQ_OFFICE, "msr");
    out.entities.push(glass([x0, IN, Z.mese + 64, x1, OUTER, Z.mese + 224], "glass_dark", 90));
  }
  for (const sx of [-1]) {
    const m = [sx * 317, 317];
    const along = [-sx / Math.SQRT2, 1 / Math.SQRT2];
    const n = [sx / Math.SQRT2, 1 / Math.SQRT2];
    const half = 48;
    const pts = [
      [m[0] + along[0] * half - n[0] * 4, m[1] + along[1] * half - n[1] * 4],
      [m[0] - along[0] * half - n[0] * 4, m[1] - along[1] * half - n[1] * 4],
      [m[0] - along[0] * half + n[0] * 40, m[1] - along[1] * half + n[1] * 40],
      [m[0] + along[0] * half + n[0] * 40, m[1] + along[1] * half + n[1] * 40],
    ].map((p) => p.map((v) => Math.round(v)));
    const ordered = sx > 0 ? pts : [...pts].reverse();
    add("commander_window_diag", ordered, Z.mese + 64, Z.mese + 224, HQ_OFFICE, "msr");
    // the pane across it, halfway through the wall
    const g = [0, 1, 2, 3].map((i) => ordered[i]);
    const c = [(g[0][0] + g[1][0]) / 2 + n[0] * 18, (g[0][1] + g[1][1]) / 2 + n[1] * 18];
    const pane = M.turned([M.box([c[0] - 1, c[1] - half, Z.mese + 64], [c[0] + 1, c[1] + half, Z.mese + 224], "glass_dark")], sx > 0 ? -45 : 45, [c[0], c[1], 0], { lock: true, snap: 1 });
    out.entities.push(M.brushEntity("func_wall", pane, { rendermode: 2, renderamt: 90 }));
  }

  // ---- the lobby's things: the front desk in its booth, benches, banners, lamps -----------------------------
  // the booth: a counter to the south with glass over it, wooden sides, a door at its back
  box([0, -240, 352, 192, -224, 400], { top: "tabletops", bottom: "wooddark", sides: "sinfinewood" });
  out.entities.push(M.brushEntity("func_wall", [M.box([0, -233, 400], [192, -231, 464], "glass_dark")], { rendermode: 2, renderamt: 70 }));
  box([0, -224, 352, 16, -160, 464], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" });
  box([176, -224, 352, 192, -160, 464], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" });
  box([16, -176, 352, 72, -160, 464], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" });
  box([128, -176, 352, 176, -160, 464], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" });
  out.entities.push(door([72, -176, 352, 128, -160, 464], "cds_metaldoor1", { use: true, name: "hq_desk" }));
  out.entities.push(M.brushEntity("func_wall", [M.box([40, -244, 472], [152, -242, 528], M.fitted("cd_sign_hq", [96, 48], [40, -244, 472], [152, -242, 528], { whole: true, faces: ["south"], rest: "null" }))]));
  out.entities.push(lamp([96, -200, 560], [235, 225, 255], 180));
  out.entities.push(prop("hammertime/cg_radio01", [168, -200, 400], 270));
  // benches facing the booth, plants by the doors, the MSR's banners on the diagonal walls
  for (const x of [-64, 96, 256]) for (const y of [-400, -352]) out.entities.push(prop("schmung/bench3", [x, y, 352], 90));
  for (const [x, y] of [[-380, -150], [380, -150], [-380, 150], [380, 150]]) out.entities.push(prop("h9/arc_flower", [x, y, 352], 0));
  for (const [x, y, a] of [[-317, 317, 135], [317, -317, 315], [-317, -317, 225]]) {
    const c = [x - Math.sign(x) * 3, y - Math.sign(y) * 3];
    const banner = M.turned([M.box([c[0] - 2, c[1] - 64, 392], [c[0] + 2, c[1] + 64, 640], "{ax_msr")], a, [c[0], c[1], 0], { lock: true, snap: 1 });
    out.entities.push(M.brushEntity("func_wall", banner, { rendermode: 4, renderamt: 255 }));
  }
  for (let k = 0; k < 8; k++) {
    const a = ((22.5 + 45 * k) * Math.PI) / 180;
    out.entities.push(lamp([Math.round(380 * Math.cos(a)), Math.round(380 * Math.sin(a)), 620], [210, 180, 255], 170));
  }
  say([0, -300, 420], "ambience/computer_ambience.wav", 2, "small", 1);

  // ---- the operations floor: desks and screens round the walls, the briefing table in the middle ----------
  for (const [x, y] of [[-380, 40], [380, -40], [-40, 380], [40, -380], [300, -300], [-300, 300]]) {
    box([x - 48, y - 24, Z.ward, x + 48, y + 24, Z.ward + 32], { top: "dsk2_06", bottom: "metal5", sides: "tabletops" });
    box([x - 32, y - 4, Z.ward + 32, x + 32, y + 4, Z.ward + 72], { top: "metal5", bottom: "metal5", sides: "wht_monitors" });
    out.entities.push(prop("h9/matsalsstol", [x, y + (y < 0 ? 40 : -40), Z.ward], y < 0 ? 90 : 270));
  }
  box([-40, -80, Z.ward, 40, 80, Z.ward + 36], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" });
  for (const y of [-56, 0, 56]) for (const sx of [-1, 1]) out.entities.push(prop("h9/matsalsstol", [sx * 64, y, Z.ward], sx > 0 ? 180 : 0));
  out.entities.push(plate([-60, -446, Z.ward + 96], [60, -444, Z.ward + 216], "{ax_msr"));
  for (let k = 0; k < 8; k++) {
    const a = ((22.5 + 45 * k) * Math.PI) / 180;
    out.entities.push(lamp([Math.round(360 * Math.cos(a)), Math.round(360 * Math.sin(a)), Z.ward + 300], [175, 130, 255], 160));
  }
  say([0, 200, Z.ward + 96], "ambience/computer_ambience.wav", 2, "small", 1);

  // ---- the command floor: the antechamber's desk and couch; the Lord Commander's office -----------------
  box([-160, -360, Z.mese, 32, -320, Z.mese + 40], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" });
  out.entities.push(prop("alex-hlru/s_leather_chair", [-64, -296, Z.mese], 270));
  out.entities.push(prop("h9/couch_leather-black", [300, -60, Z.mese], 180));
  out.entities.push(prop("h9/arc_flower", [-380, 60, Z.mese], 0));
  out.entities.push(prop("h9/arc_flower", [380, 60, Z.mese], 0));
  box([-120, -120, Z.mese, 120, 60, Z.mese + 1], { top: "sinrug", bottom: "sinrug", sides: "sinrug" });
  out.entities.push(lamp([0, -200, Z.mese + 300], [255, 225, 185], 220));
  out.entities.push(lamp([-300, 0, Z.mese + 300], [255, 225, 185], 160));
  out.entities.push(lamp([300, 0, Z.mese + 300], [255, 225, 185], 160));
  // the office: the great desk facing the door, the MSR's banner behind it, the shelves, the rug, the lamps
  box([-200, 300, Z.mese, 40, 348, Z.mese + 40], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" });
  out.entities.push(prop("alex-hlru/s_leather_chair", [-80, 372, Z.mese], 270));
  out.entities.push(prop("alex-hlru/bookcase", [-372, 180, Z.mese], 0));
  out.entities.push(prop("alex-hlru/bookcase", [372, 120, Z.mese], 180));
  out.entities.push(prop("h9/couch_leather-black", [-300, 330, Z.mese], 315));
  box([-260, 140, Z.mese, 60, 280, Z.mese + 1], { top: "sinrug2", bottom: "sinrug2", sides: "sinrug2" });
  out.entities.push(plate([-160, 446, Z.mese + 64], [-40, 448, Z.mese + 304], "{ax_msr"));
  out.entities.push(lamp([-80, 300, Z.mese + 280], [255, 215, 170], 240));
  out.entities.push(lamp([300, 360, Z.mese + 200], [255, 215, 170], 140));
  out.entities.push(lamp([0, 448 + 300, Z.mese + 160], [255, 220, 180], 120));

  // ======== THE UNDERCROFT: the podium's own floor (0..160) ================================================
  const CROFT = { floor: "MJSTFLOOR02", wall: "MJSTWALL09", ceiling: "MJSTFLAT03" };
  const JAIL = { floor: "vaultfloor", wall: "stec_panel3", ceiling: "wallvault2" };
  add("hq_croft_x", rect([-560, -64, 576, 64]), 0, 160, CROFT, "msr");
  add("hq_croft_y", rect([-64, -576, 64, 576]), 0, 160, CROFT, "msr");
  hole("hq_croft_stair", [-264, -112, 0, -152, -64, DOOR.h], CROFT);
  // the jail block, along the north side: its corridor, twelve cells off it, a guard post that watches it
  add("jail_hq_corridor", rect([-880, 592, 880, 688]), 0, 160, JAIL, "msr");
  shut("jail_hq_door", [-56, 576, 0, 56, 592, DOOR.h], "MJSTDOOR02", { wall: CROFT });
  for (let k = 0; k < 12; k++) {
    const x0 = -880 + 144 * k;
    add(`jail_hq_cell${k}`, rect([x0, 704, x0 + 128, 880]), 0, 128, JAIL, "msr");
    ctx.opening(`jail_hq_celldoor${k}`, [x0 + 40, 688, 0, x0 + 88, 704, DOOR.h], JAIL);
    out.entities.push(door([x0 + 40, 688, 0, x0 + 88, 704, DOOR.h], "{grate1", { mesh: true, use: true, name: `cell_hq_${k}` }));
    box([x0 + 8, 832, 0, x0 + 88, 872, 20], { top: "mattress4", bottom: "metal5", sides: "metal5" });
    out.entities.push(prop("mecklenburg/toilette", [x0 + 108, 856, 0], 270));
    out.entities.push(lamp([x0 + 64, 800, 104], [190, 190, 255], 60));
  }
  for (let x = -800; x <= 800; x += 320) out.entities.push(lamp([x, 640, 140], [200, 200, 255], 110));
  add("jail_hq_guard", rect([-560, 432, -336, 576]), 0, 160, CROFT, "msr");
  hole("jail_hq_guarddoor", [-384, 576, 0, -328, 592, DOOR.h], CROFT);
  hole("jail_hq_guardwindow", [-528, 576, 48, -416, 592, 112], CROFT);
  out.entities.push(glass([-528, 576, 48, -416, 592, 112], "glass_dark", 80));
  box([-544, 528, 0, -400, 560, 40], { top: "dsk2_06", bottom: "metal5", sides: "tabletops" });
  box([-528, 548, 40, -432, 556, 80], { top: "metal5", bottom: "metal5", sides: "wht_monitors" });
  out.entities.push(prop("h9/matsalsstol", [-472, 500, 0], 90));
  out.entities.push(lamp([-448, 504, 140], [220, 220, 255], 120));
  // the sally port: the MSR's garage, its shutter onto the west plaza beside the steps
  add("hq_garage", rect([-880, -576, -592, 560]), 0, 160, { floor: "grey_creteflr", wall: "MJSTWALL10", ceiling: "ceilingpipec" }, "msr");
  shut("hq_garage_shutter", [-928, 336, 0, -880, 528, 144], "garage08", { up: true, wall: { floor: "grey_creteflr", wall: "MJSTWALL10", ceiling: "ceilingpipec" } });
  hole("hq_garage_door", [-592, -28, 0, -560, 28, DOOR.h], CROFT);
  out.entities.push(prop("CLANKILL3R/GPC_PALLETS", [-800, -400, 0], 0), prop("hammertime/cg_box03", [-820, -200, 0], 0), prop("hammertime/cg_box01", [-760, -160, 0], 30));
  for (const y of [-400, 0, 400]) out.entities.push(lamp([-736, y, 140], [255, 200, 150], 120));
  // the armory and the locker room off the east hall
  add("hq_east_hall", rect([592, -64, 880, 64]), 0, 160, CROFT, "msr");
  hole("hq_east_door", [576, -28, 0, 592, 28, DOOR.h], CROFT);
  add("hq_armory", rect([592, -576, 880, -80]), 0, 160, { floor: "MJSTFLOOR01", wall: "MJSTWALL04", ceiling: "MJSTFLAT03" }, "msr");
  shut("hq_armory_door", [704, -80, 0, 760, -64, DOOR.h], "metaldoor2dn", { wall: CROFT });
  for (let y = -544; y <= -176; y += 96) box([848, y, 0, 872, y + 72, 88], { top: "metal5", bottom: "metal5", sides: "armory11" });
  box([640, -480, 0, 736, -400, 36], { top: "tabletops", bottom: "metal5", sides: "metal5" });
  out.entities.push(lamp([736, -320, 140], [200, 200, 255], 150));
  add("hq_lockers", rect([592, 80, 880, 576]), 0, 160, { floor: "MJSTFLOOR01", wall: "MJSTWALL04", ceiling: "MJSTFLAT03" }, "msr");
  hole("hq_lockers_door", [704, 64, 0, 760, 80, DOOR.h], CROFT);
  for (let y = 112; y <= 528; y += 64) box([856, y, 0, 880, y + 56, 96], { top: "metal5", bottom: "metal5", sides: "cabnet02" });
  out.entities.push(prop("schmung/bench3", [720, 320, 0], 0));
  out.entities.push(lamp([736, 320, 140], [200, 200, 255], 130));
  // booking and interrogation on the south side
  add("hq_booking", rect([-560, -880, 64, -592]), 0, 160, CROFT, "msr");
  hole("hq_booking_door", [-28, -592, 0, 28, -576, DOOR.h], CROFT);
  box([-400, -736, 0, -144, -696, 44], { top: "dsk2_06", bottom: "metal5", sides: "tabletops" });
  out.entities.push(prop("h9/matsalsstol", [-272, -768, 0], 90), prop("h9/matsalsstol", [-272, -660, 0], 270));
  for (const x of [-480, -100]) out.entities.push(lamp([x, -736, 140], [220, 220, 255], 120));
  add("hq_interrogation", rect([80, -880, 400, -592]), 0, 160, { floor: "vaultfloor", wall: "stec_panel5b", ceiling: "wallvault2" }, "msr");
  shut("hq_interrogation_door", [64, -760, 0, 80, -704, DOOR.h], "metaldoor2dn", { wall: CROFT });
  box([200, -768, 0, 296, -704, 36], { top: "metal5", bottom: "metal5", sides: "metal5" });
  out.entities.push(prop("h9/matsalsstol", [248, -800, 0], 90), prop("h9/matsalsstol", [248, -672, 0], 270));
  out.entities.push(lamp([248, -736, 120], [255, 240, 200], 90));
  for (const [x, y] of [[0, 0], [-300, 0], [300, 0], [0, -300], [0, 300]]) out.entities.push(lamp([x, y, 140], [180, 140, 255], 120));
  // the MSR's mark in the undercroft
  out.entities.push(plate([-60, 574, 120], [60, 576, 156], "d_area"));

  // ======== THE TUNNELS (-176..-16): from under the Nexus to the four cardinal precincts' cores =============
  const TUNNEL = { floor: "MJSTFLOOR01", wall: "MJSTWALL10", ceiling: "MJSTFLAT03" };
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const arm = fbox(f, [-64, -64, -176, 3008, 64, -16]);
    add(`tunnel_${d}`, rect([arm[0], arm[1], arm[3], arm[4]]), -176, -16, TUNNEL, "msr");
    const stub = fbox(f, [2880, -208, -176, 3008, -64, -16]);
    add(`tunnel_${d}_core`, rect([stub[0], stub[1], stub[3], stub[4]]), -176, -16, TUNNEL, "msr");
    for (let u = 256; u <= 2944; u += 384) out.entities.push(lamp([...f.p(u, 0), -40], [170, 110, 255], 120));
    // its signs: the MSR's mark where it leaves the Nexus and where it meets the precinct
    const s0 = fbox(f, [600, -64, -144, 696, -62, -64]);
    out.entities.push(plate([s0[0], s0[1], s0[2]], [s0[3], s0[4], s0[5]], "d_area"));
  }
  // the stairs' ways into the tunnels: the MSR's from its north face, the Lord Commander's from its west face
  hole("hq_stair_tunnel", [-264, -112, -176, -152, -64, -176 + DOOR.h], TUNNEL);
  shut("commander_tunnel", [64, 176, -176, 112, 232, -176 + DOOR.h], "cd_wooddoor", { wall: TUNNEL });
  say([0, 1200, -96], "ambience/computer_ambience.wav", 2, "small", 2);
  return out;
}
