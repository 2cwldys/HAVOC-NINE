// The tactical map of h9_siege_lift: each deck from above, with what each class can open and every way between
// the decks, written as out\h9_siege_lift-tactical.svg (and drawn to a .png beside it by a headless Edge, when
// one is installed). Its numbers are lift.mjs's own plan: change one there, change it here.
//
//   node tactical.mjs
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");

const STEP = 15;
const R_CORE = 160, R_IN = 1056, R_OUT = 1088, R_GANTRY = 1216;
const STAIRS = [
  { sector: 1, from: "cargo", to: "passenger" },
  { sector: 13, from: "cargo", to: "passenger" },
  { sector: 7, from: "passenger", to: "drive" },
  { sector: 19, from: "passenger", to: "drive" },
];
const POD_STAIRS = [11, 14];
const HATCHES = { cargo: [5, 17], passenger: [9, 22], drive: [3, 15] };
const LADDERS = [
  { sector: 11, from: "cargo", to: "passenger" },
  { sector: 23, from: "cargo", to: "passenger" },
  { sector: 2, from: "passenger", to: "drive" },
  { sector: 14, from: "passenger", to: "drive" },
];
const ROOMS = [
  { deck: "cargo", sectors: [23, 0, 1], r: 480, breach: 0, engWall: 30, vent: 23, label: "TETHER CLAMPS", n: 1 },
  { deck: "passenger", sectors: [5, 6, 7], r: 500, breachWall: 75, engWall: 120, vent: 5, label: "POWER CORE", n: 2 },
  { deck: "drive", sectors: [11, 12, 13], r: 600, breach: 13, engWall: 165, vent: 12, label: "MAIN DRIVE", n: 3 },
];
const OBJ_SECTOR = { 1: 0, 2: 6, 3: 12 };
const SHAFTS = [
  { sector: 20, from: "cargo", to: "passenger" },
  { sector: 4, from: "passenger", to: "drive" },
];
const SHAFT_R = 880;
const DECKS = [
  { id: "drive", title: "DRIVE DECK (top)", note: "MSR start here, round the outer ring" },
  { id: "passenger", title: "PASSENGER DECK (middle)", note: "Insurgents respawn here (south-west) once the power is cut" },
  { id: "cargo", title: "CARGO DECK (bottom)", note: "Insurgents respawn here (south-west) once the clamps are blown" },
  { id: "pod", title: "UNDERSIDE POD + DOCK", note: "Insurgents start here" },
];

const C = {
  bg: "#120c0c",
  deck: "#2a2224",
  hull: "#8a7f80",
  core: "#5a4a4c",
  gantry: "#4a3a30",
  text: "#f0e6e0",
  dim: "#a89890",
  room: "#3a2a20",
  obj: "#ff6a2a",
  breach: "#ff3030",
  eng: "#ffd040",
  hatch: "#40d0ff",
  ladder: "#60e070",
  stairsUp: "#d0d0d0",
  window: "#ff9a70",
  door: "#c8c0b8",
  vent: "#b070ff",
  msr: "#4ab0f0",
  ins: "#ff4a3c",
};

// one deck's picture: 300 px across for the gantry ring, north up
const S = 300 / (2 * R_GANTRY + 80);
const pt = (cx, cy, r, deg) => [cx + Math.cos((deg * Math.PI) / 180) * r * S, cy - Math.sin((deg * Math.PI) / 180) * r * S];
const mid = (k) => k * STEP + STEP / 2;
function arcPath(cx, cy, r0, r1, a0, a1) {
  const [x0, y0] = pt(cx, cy, r1, a0), [x1, y1] = pt(cx, cy, r1, a1);
  const [x2, y2] = pt(cx, cy, r0, a1), [x3, y3] = pt(cx, cy, r0, a0);
  const big = a1 - a0 > 180 ? 1 : 0;
  return `M${x0},${y0} A${r1 * S},${r1 * S} 0 ${big} 0 ${x1},${y1} L${x2},${y2} A${r0 * S},${r0 * S} 0 ${big} 1 ${x3},${y3} Z`;
}
const dot = (x, y, r, fill, extra = "") => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" ${extra}/>`;
const label = (x, y, text, fill = C.text, size = 9, anchor = "middle", weight = 600) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="Segoe UI, Arial">${text}</text>`;

function deckPicture(deck, cx, cy) {
  const out = [];
  const id = deck.id;
  if (id === "pod") {
    // the pod: a wedge south-west under the cargo deck, the dock off it
    out.push(`<path d="${arcPath(cx, cy, 448, R_IN, 150, 225)}" fill="${C.deck}" stroke="${C.hull}" stroke-width="1.5"/>`);
    out.push(`<path d="${arcPath(cx, cy, R_OUT, R_GANTRY + 96, 165, 210)}" fill="${C.gantry}" stroke="${C.dim}" stroke-width="1"/>`);
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R_CORE * S}" fill="${C.core}"/>`);
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R_OUT * S}" fill="none" stroke="${C.hull}" stroke-dasharray="3 4" opacity="0.35"/>`);
    for (const k of POD_STAIRS) {
      const [x, y] = pt(cx, cy, 768, mid(k));
      out.push(`<rect x="${x - 6}" y="${y - 6}" width="12" height="12" fill="${C.stairsUp}"/>`, label(x, y + 3.5, "▲", "#120c0c", 9));
    }
    const [hx, hy] = pt(cx, cy, R_OUT - 6, mid(12));
    out.push(dot(hx, hy, 5, C.hatch));
    const [lx, ly] = pt(cx, cy, R_OUT + 14, mid(13));
    out.push(dot(lx, ly, 4.5, C.ladder));
    const [sx, sy] = pt(cx, cy, 720, 187);
    out.push(dot(sx, sy, 9, C.ins, `opacity="0.85"`), label(sx, sy + 3, "INS", "#fff", 7));
    const [dx, dy] = pt(cx, cy, R_GANTRY + 140, 187);
    out.push(label(dx - 4, dy + 3, "DOCK", C.dim, 8, "end"));
    return out.join("");
  }
  // the gantry ring, the hull, the floor, the core
  out.push(`<circle cx="${cx}" cy="${cy}" r="${R_GANTRY * S}" fill="${C.gantry}"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="${R_OUT * S}" fill="${C.hull}"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="${R_IN * S}" fill="${C.deck}"/>`);
  // windows: a light arc on the hull
  const WIN = { cargo: [0, 8, 16], passenger: [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 23], drive: [0, 1, 5, 6, 8, 9, 10, 11, 12, 16, 17, 18, 20, 21, 22] };
  for (const k of WIN[id]) out.push(`<path d="${arcPath(cx, cy, R_IN, R_OUT, k * STEP + 1, (k + 1) * STEP - 1)}" fill="${C.window}" opacity="0.55"/>`);
  // the objective's room
  for (const room of ROOMS.filter((r) => r.deck === id)) {
    const a0 = room.sectors[0] * STEP, a1 = (room.sectors.at(-1) + 1) * STEP;
    const from = a0 > a1 ? a0 - 360 : a0;
    out.push(`<path d="${arcPath(cx, cy, R_CORE, room.r, from, a1)}" fill="${C.room}" stroke="${C.dim}" stroke-width="1"/>`);
    const [ox, oy] = pt(cx, cy, R_CORE + 120, mid(OBJ_SECTOR[room.n]));
    out.push(`<polygon points="${[0, 1, 2, 3, 4].map((i) => { const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5; return `${ox + Math.cos(a) * 9},${oy + Math.sin(a) * 9}`; }).join(" ")}" fill="${C.obj}"/>`);
    const [tx, ty] = pt(cx, cy, room.r + 150, mid(OBJ_SECTOR[room.n]));
    out.push(label(tx, ty, `OBJ ${room.n}: ${room.label}`, C.obj, 8.5));
    const halfway = (R_CORE + room.r) / 2;
    const [bx, by] = room.breachWall !== undefined ? pt(cx, cy, halfway, room.breachWall) : pt(cx, cy, room.r + 8, mid(room.breach));
    out.push(`<rect x="${bx - 5}" y="${by - 5}" width="10" height="10" fill="${C.breach}"/>`, label(bx, by + 3, "B", "#fff", 8));
    const [ex, ey] = pt(cx, cy, halfway, room.engWall);
    out.push(`<rect x="${ex - 5}" y="${ey - 5}" width="10" height="10" fill="${C.eng}"/>`, label(ex, ey + 3, "E", "#120c0c", 8));
    const [vx, vy] = pt(cx, cy, room.r + 8, mid(room.vent));
    out.push(`<rect x="${vx - 5}" y="${vy - 3}" width="10" height="6" fill="${C.vent}"/>`);
  }
  out.push(`<circle cx="${cx}" cy="${cy}" r="${R_CORE * S}" fill="${C.core}"/>`);
  out.push(label(cx, cy + 3, "TETHER", C.dim, 7));
  // stairs: up (solid) from this deck, down (outline) to it
  for (const s of STAIRS) {
    if (s.from !== id && s.to !== id) continue;
    const [x, y] = pt(cx, cy, 768, mid(s.sector));
    const up = s.from === id;
    out.push(`<rect x="${x - 6}" y="${y - 6}" width="12" height="12" fill="${up ? C.stairsUp : "none"}" stroke="${C.stairsUp}" stroke-width="1.2"/>`);
    out.push(label(x, y + 3.5, up ? "▲" : "▼", up ? "#120c0c" : C.stairsUp, 9));
  }
  if (id === "cargo")
    for (const k of POD_STAIRS) {
      const [x, y] = pt(cx, cy, 768, mid(k));
      out.push(`<rect x="${x - 6}" y="${y - 6}" width="12" height="12" fill="none" stroke="${C.stairsUp}" stroke-width="1.2"/>`, label(x, y + 3.5, "▼", C.stairsUp, 9));
    }
  // the engineers' shafts: a yellow door on each deck they join
  for (const sh of SHAFTS) {
    if (sh.from !== id && sh.to !== id) continue;
    out.push(`<path d="${arcPath(cx, cy, SHAFT_R, R_IN, sh.sector * STEP, (sh.sector + 1) * STEP)}" fill="${C.eng}" opacity="0.28"/>`);
    const [ex, ey] = pt(cx, cy, SHAFT_R - 8, mid(sh.sector));
    out.push(`<rect x="${ex - 5}" y="${ey - 5}" width="10" height="10" fill="${C.eng}"/>`, label(ex, ey + 3, "E", "#120c0c", 8));
    const [lx, ly] = pt(cx, cy, (SHAFT_R + R_IN) / 2 + 30, mid(sh.sector));
    out.push(label(lx, ly + 3, sh.from === id ? "▲" : "▼", C.eng, 9));
  }
  // hatches out to the gantry, and the gantry ladders
  for (const k of HATCHES[id]) {
    const [x, y] = pt(cx, cy, (R_IN + R_OUT) / 2, mid(k));
    out.push(dot(x, y, 5, C.hatch));
  }
  for (const l of LADDERS) {
    if (l.from !== id && l.to !== id) continue;
    const [x, y] = pt(cx, cy, R_OUT + 14, mid(l.sector));
    out.push(dot(x, y, 4.5, C.ladder), label(x + (x > cx ? 9 : -9), y + 3, l.from === id ? "▲" : "▼", C.ladder, 8));
  }
  if (id === "cargo") {
    const [x, y] = pt(cx, cy, R_OUT + 14, mid(13));
    out.push(dot(x, y, 4.5, C.ladder), label(x - 9, y + 3, "▼", C.ladder, 8));
  }
  // spawns
  if (id === "drive") {
    for (const a of [40, 160, 280]) {
      const [x, y] = pt(cx, cy, 920, a);
      out.push(dot(x, y, 9, C.msr, `opacity="0.85"`), label(x, y + 3, "MSR", "#fff", 7));
    }
  } else {
    const [x, y] = pt(cx, cy, 940, 190);
    out.push(dot(x, y, 9, C.ins, `opacity="0.85"`), label(x, y + 3, id === "cargo" ? "T1" : "T2", "#fff", 7));
  }
  return out.join("");
}

const W = 760, H = 1050;
const cells = [[190, 260], [570, 260], [190, 650], [570, 650]];
const parts = [`<rect width="${W}" height="${H}" fill="${C.bg}"/>`];
parts.push(label(W / 2, 30, "H9_SIEGE_LIFT -- TACTICAL MAP", C.text, 17, "middle", 700));
parts.push(label(W / 2, 48, "h9_siege_lift. Insurgents attack upward: clamps, power, drive. Each objective room: Breacher, Engineer or vent only.", C.dim, 10, "middle", 400));
DECKS.forEach((deck, i) => {
  const [cx, cy] = cells[i];
  parts.push(label(cx, cy - 175, deck.title, C.text, 12, "middle", 700));
  parts.push(deckPicture(deck, cx, cy));
  parts.push(label(cx, cy + 178, deck.note, C.dim, 9, "middle", 400));
});
// the legend
const legend = [
  [`<rect x="0" y="-8" width="10" height="10" fill="${C.breach}"/>`, "Breacher door (tsm_breach_*): locked to everyone; a Breacher's +USE forces it, and it stays open for the round"],
  [`<rect x="0" y="-8" width="10" height="10" fill="${C.eng}"/>`, "Engineer door (tsm_eng_door): opens only for a Combat Engineer, closes after 4 s -- into a maintenance shaft, or straight into an objective room"],
  [`<rect x="0" y="-8" width="10" height="10" fill="${C.eng}" opacity="0.4"/>`, "Maintenance shaft: a ladder inside the hull between two decks (cargo-passenger SE, passenger-drive NE)"],
  [`<rect x="0" y="-6" width="10" height="6" fill="${C.vent}"/>`, "Crawl vent into an objective room: shoot or knife the grate out, then crouch through (anyone; bots use these)"],
  [`<circle cx="5" cy="-3" r="5" fill="${C.hatch}"/>`, "Hatch out to the gantry (anyone): the outside route"],
  [`<circle cx="5" cy="-3" r="4.5" fill="${C.ladder}"/>`, "Gantry ladder between gantry levels (anyone): up or down as marked"],
  [`<rect x="0" y="-8" width="10" height="10" fill="${C.stairsUp}"/>`, "Stairs up from this deck   (outline: stairs coming down to it)"],
  [`<rect x="0" y="-6" width="12" height="5" fill="${C.window}" opacity="0.6"/>`, "Windows"],
  [`<polygon points="5,-11 7.5,-4 12,-4 8.5,0 10,6 5,2 0,6 1.5,0 -2,-4 2.5,-4" fill="${C.obj}"/>`, "Siege objective"],
];
legend.forEach(([icon, text], i) => {
  const y = 868 + i * 16;
  parts.push(`<g transform="translate(40 ${y})">${icon}</g>`, label(60, y, text, C.text, 10, "start", 400));
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
const svgFile = join(OUT, "h9_siege_lift-tactical.svg");
writeFileSync(svgFile, svg);
console.log(`wrote ${svgFile}`);

const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
if (existsSync(edge)) {
  const png = join(OUT, "h9_siege_lift-tactical.png");
  execFileSync(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--screenshot=${png}`, `--window-size=${W},${H}`, pathToFileURL(svgFile).href], { stdio: "ignore" });
  console.log(`drew ${png}`);
}
