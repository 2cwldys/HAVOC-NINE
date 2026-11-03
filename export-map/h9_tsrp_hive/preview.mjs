// A picture of the merged map, drawn from out/h9_tsrp_hive.map -- not from a compiled .bsp.
//
//   node preview.mjs     write out/h9_tsrp_hive.preview.html
//
// Side elevation: every world brush's box on x/z, so the three shelves and their cities are one silhouette.
// Three plans: each city on x/y, with its travel zones, the arrivals in it, the spawns from the .cfg, and
// RCBot's waypoints and their paths once waypoints.mjs has made them.
// Schematic: the three two-way links between the cities.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M } from "../lib.mjs";

const MAP = join(process.cwd(), "out", "h9_tsrp_hive.map");
const CFG = join(process.cwd(), "out", "tsm_spawns_h9_tsrp_hive.cfg");
const ROUTE = join(process.cwd(), "out", "h9_tsrp_hive_waypoints.json");
const OUT = join(process.cwd(), "out", "h9_tsrp_hive.preview.html");
const TELEPORT = 1 << 21; // RCBot's W_FL_TELEPORT
const route = existsSync(ROUTE) ? JSON.parse(readFileSync(ROUTE, "utf8")) : null;

const map = M.readMap(readFileSync(MAP, "utf8"));
const spawns = readFileSync(CFG, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .filter((w) => w[0] === "tsm_spawn" && w.length >= 7)
  .map((w) => ({ team: Number(w[1]), x: Number(w[2]), y: Number(w[3]), z: Number(w[4]) }));

const CITIES = {
  alexandria: { name: "Alexandria", colour: "#7aa5ff", prefix: "al" },
  paradise: { name: "Paradise City", colour: "#ffb057", prefix: "pc" },
  xenon: { name: "Xenon City", colour: "#6ff2c8", prefix: "xe" },
};
const SPAN = (z) => (z < -1488 ? "alexandria" : z < 411 ? "paradise" : "xenon");

function boxOf(brush) {
  const shape = M.shapeOf(brush);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const face of shape.faces) for (const point of face.polygon)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], point[a]);
      max[a] = Math.max(max[a], point[a]);
    }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

const valueOf = (value) => String(value ?? "").trim().split(/\s+/).map(Number);
const r = (value) => Math.round(value * 10) / 10;
const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- the geometry, once ------------------------------------------------------------------------------------
const brushes = { alexandria: [], paradise: [], xenon: [] };
const allBoxes = map.brushes.map(boxOf).filter(Boolean);
for (const box of allBoxes) {
  const span = SPAN((box.min[2] + box.max[2]) / 2);
  brushes[span].push(box);
}
const extent = (list) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const box of list) for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a], box.min[a]);
    max[a] = Math.max(max[a], box.max[a]);
  }
  return { min, max };
};
const boxes = Object.fromEntries(Object.entries(brushes).map(([key, list]) => [key, extent(list)]));
const world = extent(allBoxes);

// ---- travel zones and spawns ------------------------------------------------------------------------------
const byPrefix = Object.fromEntries(Object.values(CITIES).map((city) => [city.prefix, city]));
// a city's travel zones (hive_<city>_pad_<to>), each at the middle of its trigger's floor
const zonesOf = (prefix) =>
  map.entities
    .filter((e) => e.classname === "trigger_teleport" && String(e.targetname ?? "").startsWith(`hive_${prefix}_pad_`))
    .map((e) => {
      const list = (e.brushes ?? []).map(boxOf).filter(Boolean);
      const min = [0, 1, 2].map((a) => Math.min(...list.map((b) => b.min[a])));
      const max = [0, 1].map((a) => Math.max(...list.map((b) => b.max[a])));
      return { to: String(e.targetname).slice(`hive_${prefix}_pad_`.length), lands: e.target, x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: min[2] };
    });
// where players from another city land in this one (hive_<city>_arrive_<from>)
const arrivalsOf = (prefix) =>
  map.entities
    .filter((e) => e.classname === "info_teleport_destination" && String(e.targetname ?? "").startsWith(`hive_${prefix}_arrive_`))
    .map((e) => {
      const [x, y, z] = valueOf(e.origin);
      return { name: e.targetname, from: String(e.targetname).slice(`hive_${prefix}_arrive_`.length), x, y, z };
    });
const zones = Object.fromEntries(Object.values(CITIES).map((city) => [city.prefix, zonesOf(city.prefix)]));
const arrivals = Object.fromEntries(Object.values(CITIES).map((city) => [city.prefix, arrivalsOf(city.prefix)]));
const arrivalNamed = Object.fromEntries(Object.values(arrivals).flat().map((a) => [a.name, a]));

const svg = [];
const rect = (x, y, w, h, fill, opacity) =>
  `<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(w, 0.7))}" height="${r(Math.max(h, 0.7))}" fill="${fill}" fill-opacity="${opacity}"/>`;
const outline = (x, y, w, h, stroke, opacity, width = 1.1) =>
  `<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(w, 0.7))}" height="${r(Math.max(h, 0.7))}" fill="${stroke}" fill-opacity="0.055" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}"/>`;

// ---- side elevation ---------------------------------------------------------------------------------------
{
  const pad = 260;
  const x0 = world.min[0] - pad;
  const width = world.max[0] - world.min[0] + pad * 2;
  const top = world.max[2];
  const height = world.max[2] - world.min[2];
  const y = (z) => top - z;
  svg.push(`<svg viewBox="${r(x0)} ${r(-60)} ${r(width)} ${r(height + 140)}" role="img" aria-label="Side elevation">`);
  const labels = [];
  for (const [key, city] of Object.entries(CITIES)) {
    const band = boxes[key];
    svg.push(rect(band.min[0], y(band.max[2]), band.max[0] - band.min[0], band.max[2] - band.min[2], city.colour, 0.045));
    const labelZ = (band.min[2] + band.max[2]) / 2;
    labels.push(`<text x="${r(world.min[0] - pad + 30)}" y="${r(y(labelZ))}" fill="${city.colour}" font-size="120" font-family="Segoe UI, sans-serif" dominant-baseline="middle" paint-order="stroke" stroke="#07080c" stroke-width="16" stroke-linejoin="round">${esc(city.name)}</text>`);
    labels.push(`<text x="${r(world.min[0] - pad + 30)}" y="${r(y(labelZ) + 120)}" fill="#8b93a7" font-size="88" font-family="Segoe UI, sans-serif" dominant-baseline="middle" paint-order="stroke" stroke="#07080c" stroke-width="14" stroke-linejoin="round">z ${Math.round(band.min[2])} .. ${Math.round(band.max[2])}</text>`);
  }
  for (const [key, city] of Object.entries(CITIES))
    for (const b of brushes[key]) svg.push(rect(b.min[0], y(b.max[2]), b.max[0] - b.min[0], b.max[2] - b.min[2], city.colour, 0.22));
  // the travel zones, at their own heights
  const zoneLabels = [];
  for (const [prefix, list] of Object.entries(zones))
    for (const zone of list) {
      svg.push(`<circle cx="${r(zone.x)}" cy="${r(y(zone.z))}" r="55" fill="none" stroke="#ffffff" stroke-width="16"/>`);
      zoneLabels.push(`<text x="${r(zone.x + 80)}" y="${r(y(zone.z) - 40)}" fill="#ffffff" font-size="86" font-family="Segoe UI, sans-serif" paint-order="stroke" stroke="#07080c" stroke-width="12" stroke-linejoin="round">${esc(byPrefix[prefix].name)} to ${esc(byPrefix[zone.to].name)}</text>`);
    }
  svg.push(...labels, ...zoneLabels);
  svg.push(`</svg>`);
}
const side = svg.join("");

// ---- one plan per city ------------------------------------------------------------------------------------
function plan(key) {
  const city = CITIES[key];
  const band = boxes[key];
  const pad = 40;
  const width = band.max[0] - band.min[0] + pad * 2;
  const height = band.max[1] - band.min[1] + pad * 2;
  const y = (worldY) => band.max[1] - worldY + pad;
  const x = (worldX) => worldX - band.min[0] + pad;
  const out = [`<svg viewBox="0 0 ${r(width)} ${r(height)}" role="img" aria-label="${esc(city.name)} plan">`];
  for (const b of brushes[key]) out.push(outline(x(b.min[0]), y(b.max[1]), b.max[0] - b.min[0], b.max[1] - b.min[1], city.colour, 0.3));
  for (const zone of zones[city.prefix]) {
    out.push(`<rect x="${r(x(zone.x) - 24)}" y="${r(y(zone.y) - 24)}" width="48" height="48" fill="#ff5d7a" fill-opacity="0.8" stroke="#ffd2da" stroke-width="4"/>`);
    out.push(`<text x="${r(x(zone.x) + 40)}" y="${r(y(zone.y) + 12)}" fill="#ffd2da" font-size="34" font-family="Segoe UI, sans-serif">to ${esc(byPrefix[zone.to].name)}</text>`);
  }
  for (const arrival of arrivals[city.prefix]) {
    out.push(`<circle cx="${r(x(arrival.x))}" cy="${r(y(arrival.y))}" r="40" fill="none" stroke="#ffffff" stroke-width="8"/>`);
    out.push(`<circle cx="${r(x(arrival.x))}" cy="${r(y(arrival.y))}" r="10" fill="#ffffff"/>`);
    out.push(`<text x="${r(x(arrival.x) + 54)}" y="${r(y(arrival.y) - 38)}" fill="#ffffff" font-size="34" font-family="Segoe UI, sans-serif">from ${esc(byPrefix[arrival.from].name)}</text>`);
  }
  // the waypoints: each path inside the city, then a dot at each waypoint (a teleport's path leaves the city)
  if (route) {
    const here = (waypoint) => SPAN(waypoint.origin[2] - 36) === key;
    for (const waypoint of route.waypoints) {
      if (!here(waypoint) || waypoint.flags & TELEPORT) continue;
      for (const to of waypoint.paths) {
        const other = route.waypoints[to];
        if (!here(other)) continue;
        out.push(`<line x1="${r(x(waypoint.origin[0]))}" y1="${r(y(waypoint.origin[1]))}" x2="${r(x(other.origin[0]))}" y2="${r(y(other.origin[1]))}" stroke="#3ad17a" stroke-opacity="0.35" stroke-width="3"/>`);
      }
    }
    for (const waypoint of route.waypoints) {
      if (!here(waypoint)) continue;
      const teleport = waypoint.flags & TELEPORT;
      out.push(`<circle cx="${r(x(waypoint.origin[0]))}" cy="${r(y(waypoint.origin[1]))}" r="${teleport ? 16 : 6}" fill="${teleport ? "#ff5df0" : "#d6ffe4"}" fill-opacity="0.85"/>`);
    }
  }
  const mine = spawns.filter((s) => SPAN(s.z - 36) === key);
  for (const s of mine)
    out.push(`<circle cx="${r(x(s.x))}" cy="${r(y(s.y))}" r="13" fill="${s.team === 1 ? "#ff6b6b" : "#56a8ff"}" stroke="#0b0d12" stroke-width="3"/>`);
  out.push(`</svg>`);
  return out.join("");
}

// ---- the page ---------------------------------------------------------------------------------------------
const count = (team) => spawns.filter((s) => s.team === team).length;
const cityRows = Object.entries(CITIES).map(([key, city]) => {
  const band = boxes[key];
  return `<tr><td><span class="dot" style="background:${city.colour}"></span>${esc(city.name)}</td>
    <td class="num">${brushes[key].length.toLocaleString()}</td>
    <td class="num">${Math.round(band.min[2])} .. ${Math.round(band.max[2])}</td>
    <td class="num">${spawns.filter((s) => SPAN(s.z - 36) === key).length}</td></tr>`;
}).join("");
const place = (point) => [point.x, point.y, point.z].map(Math.round).join(" ");
const zoneRows = Object.entries(zones).flatMap(([prefix, list]) => list.map((zone) => {
  const from = byPrefix[prefix];
  const to = byPrefix[zone.to];
  const lands = arrivalNamed[zone.lands];
  return `<tr><td><span class="dot" style="background:${from.colour}"></span>${esc(from.name)}</td>
    <td class="num">${place(zone)}</td>
    <td><span class="dot" style="background:${to.colour}"></span>${esc(to.name)}</td>
    <td class="num">${lands ? place(lands) : `no ${esc(zone.lands)}`}</td></tr>`;
})).join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>h9_tsrp_hive — preview</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #07080c; color: #dbe1ee; font: 15px/1.55 "Segoe UI", system-ui, sans-serif; }
  main { max-width: 1400px; margin: 0 auto; padding: 30px 28px 60px; }
  header { border-bottom: 1px solid #1c2130; padding-bottom: 22px; margin-bottom: 26px; }
  h1 { margin: 0 0 4px; font-size: 30px; letter-spacing: .2px; }
  h1 span { color: #7aa5ff; }
  h2 { margin: 0 0 12px; font-size: 15px; text-transform: uppercase; letter-spacing: 1.4px; color: #9aa4ba; font-weight: 600; }
  p { margin: 0 0 10px; color: #a9b2c6; }
  .lede { max-width: 920px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
  .stat { background: #0e1119; border: 1px solid #1d2333; border-radius: 8px; padding: 10px 14px; min-width: 130px; }
  .stat b { display: block; font-size: 20px; color: #f2f5fb; font-weight: 600; }
  .stat span { font-size: 12px; color: #808aa0; text-transform: uppercase; letter-spacing: .8px; }
  .panel { background: #0b0e15; border: 1px solid #1a2030; border-radius: 10px; padding: 18px; margin-bottom: 20px; }
  .panel svg { display: block; width: 100%; height: auto; background: #080a10; border-radius: 6px; }
  .split { display: grid; grid-template-columns: minmax(0, 1.9fr) minmax(320px, 1fr); gap: 20px; align-items: start; }
  .plans { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
  .plans .panel { margin: 0; }
  .cap { font-size: 13px; color: #7e889e; margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #171d2a; vertical-align: top; }
  th { color: #7e889e; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; }
  .legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: #9aa4ba; margin-top: 10px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: .3px; }
  .badge.ok { background: #123a2c; color: #6ff2c8; }
  .badge.warn { background: #3a2412; color: #ffb057; }
  .badge.info { background: #17233a; color: #7aa5ff; }
  ul.checks { margin: 8px 0 0; padding-left: 20px; color: #a9b2c6; }
  ul.checks li { margin: 4px 0; }
  code { background: #121722; border: 1px solid #1e2637; border-radius: 4px; padding: 1px 6px; font-size: 13px; }
  .foot { color: #69738a; font-size: 12px; margin-top: 8px; }
  @media (max-width: 1050px) { .split { grid-template-columns: 1fr; } .plans { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>h9_tsrp_hive <span>— three cities, one map</span></h1>
    <p class="lede">Paradise City, Alexandria and Xenon City stacked on separate shelves and joined by three two-way
    travel-zone links. This page is drawn from <code>out/h9_tsrp_hive.map</code> (the compiler input), not from a
    compiled <code>.bsp</code>.</p>
    <div class="stats">
      <div class="stat"><b>18,236</b><span>world brushes</span></div>
      <div class="stat"><b>1,706</b><span>entities</span></div>
      <div class="stat"><b>122,142</b><span>faces</span></div>
      <div class="stat"><b>48</b><span>spawns (${count(1)} / ${count(2)})</span></div>
      <div class="stat"><b>7760 × 8076 × 8080</b><span>units (w × d × h)</span></div>
      <div class="stat"><b>±4096</b><span>fits the engine box</span></div>
    </div>
  </header>

  <div class="split">
    <section class="panel">
      <h2>Side elevation — x / z</h2>
      ${side}
      <div class="legend">
        <span><i style="background:#7aa5ff"></i>Alexandria</span>
        <span><i style="background:#ffb057"></i>Paradise City</span>
        <span><i style="background:#6ff2c8"></i>Xenon City</span>
        <span><i style="background:#ffffff;border-radius:50%"></i>travel zone</span>
      </div>
      <p class="cap">Each city fills the ±4096 footprint on its own, so they cannot sit beside one another.
      Alexandria's dead 2.4 km rock slab was cut at z = -1600 (its own coordinates) and capped with invisible
      NULL, which is what brings the whole stack inside the engine's box.</p>
    </section>

    <section class="panel">
      <h2>Travel zones — three two-way links</h2>
      <svg viewBox="0 0 560 480" role="img" aria-label="Teleport links">
        <defs>
          <marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff5d7a"></path>
          </marker>
        </defs>
        <line x1="280" y1="88" x2="148" y2="366" stroke="#ff5d7a" stroke-width="4" marker-start="url(#head)" marker-end="url(#head)"></line>
        <line x1="280" y1="88" x2="412" y2="366" stroke="#ff5d7a" stroke-width="4" marker-start="url(#head)" marker-end="url(#head)"></line>
        <line x1="192" y1="398" x2="368" y2="398" stroke="#ff5d7a" stroke-width="4" marker-start="url(#head)" marker-end="url(#head)"></line>
        <circle cx="280" cy="88" r="62" fill="#0e1119" stroke="#ffb057" stroke-width="4"></circle>
        <circle cx="148" cy="398" r="62" fill="#0e1119" stroke="#7aa5ff" stroke-width="4"></circle>
        <circle cx="412" cy="398" r="62" fill="#0e1119" stroke="#6ff2c8" stroke-width="4"></circle>
        <text x="280" y="82" text-anchor="middle" fill="#ffb057" font-size="17" font-family="Segoe UI, sans-serif">Paradise</text>
        <text x="280" y="102" text-anchor="middle" fill="#8b93a7" font-size="12" font-family="Segoe UI, sans-serif">pc_</text>
        <text x="148" y="392" text-anchor="middle" fill="#7aa5ff" font-size="15" font-family="Segoe UI, sans-serif">Alexandria</text>
        <text x="148" y="412" text-anchor="middle" fill="#8b93a7" font-size="12" font-family="Segoe UI, sans-serif">al_</text>
        <text x="412" y="392" text-anchor="middle" fill="#6ff2c8" font-size="15" font-family="Segoe UI, sans-serif">Xenon</text>
        <text x="412" y="412" text-anchor="middle" fill="#8b93a7" font-size="12" font-family="Segoe UI, sans-serif">xe_</text>
        <text x="214" y="210" text-anchor="middle" fill="#8b93a7" font-size="11" font-family="Segoe UI, sans-serif" transform="rotate(57 214 210)">a zone each way</text>
        <text x="352" y="214" text-anchor="middle" fill="#8b93a7" font-size="11" font-family="Segoe UI, sans-serif" transform="rotate(-55 352 214)">a zone each way</text>
      </svg>
      <p class="cap">Names are prefixed per city (<code>pc_</code>, <code>al_</code>, <code>xe_</code>), including
      <code>multi_manager</code> keys, so no city fires another city's entities. Over each zone turns a portal in
      the colour of the city it leads to, and a zone lands you 80 units in front of the zone that leads back, so
      arriving never sends you straight back out.</p>
    </section>
  </div>

  <div class="plans">
    ${Object.entries(CITIES).map(([key, city]) => `<section class="panel">
      <h2>${esc(city.name)} — x / y</h2>
      ${plan(key)}
      <div class="legend">
        <span><i style="background:#ffffff;border-radius:50%"></i>arrival</span>
        <span><i style="background:#ff5d7a"></i>travel zone</span>
        <span><i style="background:#ff6b6b;border-radius:50%"></i>team 1 spawn</span>
        <span><i style="background:#56a8ff;border-radius:50%"></i>team 2 spawn</span>
        ${route ? `<span><i style="background:#d6ffe4;border-radius:50%"></i>waypoint</span>
        <span><i style="background:#3ad17a"></i>path</span>
        <span><i style="background:#ff5df0;border-radius:50%"></i>teleport waypoint</span>` : ""}
      </div>
    </section>`).join("")}
  </div>

  <section class="panel" style="margin-top:20px">
    <h2>The stack</h2>
    <table>
      <tr><th>city</th><th>brushes</th><th>z range</th><th>spawns</th></tr>
      ${cityRows}
    </table>
  </section>

  <section class="panel">
    <h2>Travel zones</h2>
    <table>
      <tr><th>in</th><th>zone</th><th>leads to</th><th>lands at</th></tr>
      ${zoneRows}
    </table>
  </section>

  <section class="panel">
    <h2>Build state</h2>
    <p><span class="badge ok">hlcsg passes</span> &nbsp; 25.8 s, 21.18 MB of textures from 14 wads.</p>
    <p><span class="badge warn">hlbsp stops</span> &nbsp; <code>Exceeded MAX_MAP_VERTS</code> — BSP29 allows
    65,535 vertices and this map has 122,142 faces. SDHLT v1.2.0 has no BSP2 switch; the final <code>.bsp</code>
    needs the raised-limit/BSP2 compiler.</p>
    <p><span class="badge info">leak sealed</span> &nbsp; every city is enclosed in an invisible 4-unit NULL shell
    just inside its own bounds, and all ${map.entities.filter((e) => !e.brushes?.length).length} point entities are
    inside one of the three boxes. The kit's flood finds no way out to the void.</p>
    <ul class="checks">
      <li><code>out/h9_tsrp_hive.map</code> — 14.17 MB, ready for the big-limit compiler.</li>
      <li><code>out/tsm_spawns_h9_tsrp_hive.cfg</code> — ${spawns.length} lines, ${count(1)} team 1 and ${count(2)} team 2, eight per team per city.</li>
      <li>Nothing has been copied into the game folder.</li>
    </ul>
    <p class="foot">Preview drawn ${new Date().toISOString().slice(0, 10)} by <code>preview.mjs</code> from the .map's brush planes and the merged entity lump.</p>
  </section>
</main>
</body>
</html>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT}  (${(Buffer.byteLength(html) / 1e6).toFixed(2)} MB)`);
for (const [key, city] of Object.entries(CITIES)) console.log(`  ${city.name.padEnd(14)} ${brushes[key].length} brushes, ${spawns.filter((s) => SPAN(s.z - 36) === key).length} spawns`);
