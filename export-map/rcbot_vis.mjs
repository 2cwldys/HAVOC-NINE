// rcbot_vis.mjs: RCBot's waypoint visibility file, worked out here so RCBot never works it out at map load.
//
// THE FILE (rcbot-patch src\waypoint.cpp, CWaypointVisibilityTable::SaveToFile and ReadFromFile):
//   rcbot\visibility\<mod>\<map>.rcv2, no header: the table packed count x count, row by row, where count
//   is the .rcw's number of waypoints. Bit i * count + j (byte (i * count + j) >> 3, bit (i * count + j) & 7,
//   the lowest bit first) is "waypoint j is seen from waypoint i". The file is exactly
//   ceil(count * count / 8) bytes; any other size is refused, and RCBot works the table out again.
// THE .rcw HEADER: bit 0 of the int at byte 12 (W_FILE_FL_READ_VISIBILITY) tells RCBot its table is out
//   of date. WaypointLoad works the table out (a line traced between every two waypoints, all of it before
//   the map goes on loading: minutes for a few thousand waypoints, a listen server frozen) when that bit is
//   set, or when the .rcv2 is missing or the wrong size. So a .rcw goes out with the bit cleared and its
//   .rcv2 beside it, never alone.
// THE TABLE, as WorkOutVisibilityTable makes it: every waypoint sees itself; two further apart than
//   BOT_VIEW_DISTANCE (2048) do not see each other; any other pair does when a point line from the first
//   waypoint's origin to 16 over the second's touches nothing solid (UTIL_TraceLine, ignore_monsters).
//   Here the line is asked of SMAK's space of the map's source, with its doors shut as the map starts. Glass
//   counts as solid here (the game's trace passes it), so a few pairs that see each other through glass read
//   as not seeing: the only use RCBot makes of the table is to find cover (GetCoverWaypoint), and a waypoint
//   behind glass taken for cover does no harm.
// It is a heavy job (a line for each pair of waypoints within 2048: about a minute and a half for 3,400), so it
// runs only under the heavy-job lock: D:\temp\HEAVY-JOB.lock free, and no compiler or build tool running.
//
//   node rcbot_vis.mjs check <map>.rcw <map>.rcv2     the read-back check a deploy makes, alone
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { M } from "./lib.mjs";

/** RCBot's BOT_VIEW_DISTANCE: no line is traced between two waypoints further apart. */
export const VIEW_DISTANCE = 2048;
/** How far over the second waypoint's origin RCBot's line ends. */
export const TARGET_LIFT = 16;
/** W_FILE_FL_READ_VISIBILITY, and where the .rcw keeps its flags. */
export const READ_VISIBILITY = 1;
const FLAGS_AT = 12;

export const HEAVY_JOB_LOCK = "D:\\temp\\HEAVY-JOB.lock";
/** What counts as another heavy job already running: compilers, build tools, encoders. */
const HEAVY_PROCESSES = /^(sd)?hl(csg|bsp|vis|rad)(_x64)?\.exe$|^(msbuild|cl|link|clang|clang-cl|lld-link|emcc|ffmpeg|ninja|cmake)\.exe$/i;

/** The size of a count's .rcv2, in bytes. */
export const rcv2Size = (count) => Math.ceil((count * count) / 8);

/** Whether bit (i, j) is set in a packed table of `count` waypoints. */
export const seesIn = (table, count, i, j) => ((table[(i * count + j) >> 3] >> ((i * count + j) & 7)) & 1) === 1;

/**
 * The table of a set of waypoint origins, as RCBot works it out, packed as its .rcv2 holds it. `sees(from, to)`
 * says whether a point line touches nothing solid. `progress(done, of)` is told now and then.
 */
export function visibilityTable(origins, sees, { progress = () => {} } = {}) {
  const count = origins.length;
  const table = new Uint8Array(rcv2Size(count));
  const set = (i, j) => {
    const bit = i * count + j;
    table[bit >> 3] |= 1 << (bit & 7);
  };
  for (let i = 0; i < count; i++) {
    const a = origins[i];
    for (let j = 0; j < count; j++) {
      if (i === j) {
        set(i, j);
        continue;
      }
      const b = origins[j];
      if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > VIEW_DISTANCE) continue;
      if (sees(a, [b[0], b[1], b[2] + TARGET_LIFT])) set(i, j);
    }
    if (i % 256 === 255) progress(i + 1, count);
  }
  return table;
}

/** A .rcw's bytes with W_FILE_FL_READ_VISIBILITY cleared: its .rcv2 is up to date. */
export function rcwWithTable(rcw) {
  const bytes = Buffer.from(rcw);
  bytes.writeInt32LE(bytes.readInt32LE(FLAGS_AT) & ~READ_VISIBILITY, FLAGS_AT);
  return bytes;
}

/**
 * The read-back check of a .rcw and its .rcv2 (their bytes): the .rcw reads as RCBot's, its flag is clear, the
 * .rcv2 is exactly the size RCBot's ReadFromFile wants for the .rcw's count, every waypoint sees itself, and
 * (given) the table is the one worked out. Each failure is a sentence; none: they may go out together.
 */
export function checkPair(rcw, rcv2, table) {
  const problems = [];
  let count = 0;
  try {
    const read = M.readRcw(rcw);
    count = read.waypoints.length;
    if (read.fileFlags & READ_VISIBILITY) problems.push("the .rcw still asks RCBot to work its visibility out at load (W_FILE_FL_READ_VISIBILITY set)");
  } catch (error) {
    return [`the .rcw does not read: ${error.message}`];
  }
  if (!rcv2) return [...problems, "no .rcv2 beside the .rcw"];
  if (count < 1) problems.push("the .rcw has no waypoints");
  if (rcv2.length !== rcv2Size(count)) problems.push(`the .rcv2 is ${rcv2.length} bytes, not the ${rcv2Size(count)} RCBot reads for ${count} waypoints`);
  else {
    for (let i = 0; i < count; i++)
      if (!seesIn(rcv2, count, i, i)) {
        problems.push(`waypoint ${i} does not see itself in the .rcv2`);
        break;
      }
    if (table && Buffer.compare(Buffer.from(rcv2), Buffer.from(table)) !== 0) problems.push("the .rcv2 on disk is not the table worked out");
  }
  return problems;
}

/** Other heavy jobs running now, by their process names (tasklist). */
export function heavyJobsRunning() {
  let listed = "";
  try {
    listed = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "latin1", windowsHide: true });
  } catch {
    return ["(tasklist did not answer)"];
  }
  const names = listed.split(/\r?\n/).map((line) => line.split('","')[0].replace(/^"/, "")).filter(Boolean);
  return [...new Set(names.filter((name) => HEAVY_PROCESSES.test(name)))];
}

/**
 * Runs `work` under the heavy-job lock: refused while D:\temp\HEAVY-JOB.lock exists or another heavy job runs;
 * otherwise the lock is made (only if it is still not there) and taken away again when `work` ends.
 */
export function withHeavyJobLock(job, work) {
  if (existsSync(HEAVY_JOB_LOCK)) {
    const held = readFileSync(HEAVY_JOB_LOCK, "latin1").split(/\r?\n/)[0];
    throw new Error(`the heavy-job lock is held (${HEAVY_JOB_LOCK}: ${held}); run again once it is free`);
  }
  const running = heavyJobsRunning();
  if (running.length) throw new Error(`another heavy job is running (${running.join(", ")}); run again once it is done`);
  const mine = `${job}\r\npid ${process.pid}\r\nsince ${new Date().toISOString()}\r\n`;
  writeFileSync(HEAVY_JOB_LOCK, mine, { flag: "wx" });
  try {
    return work();
  } finally {
    if (existsSync(HEAVY_JOB_LOCK) && readFileSync(HEAVY_JOB_LOCK, "latin1") === mine) unlinkSync(HEAVY_JOB_LOCK);
  }
}

/**
 * Writes a .rcw and its .rcv2 together: the table of `origins` worked out against `map` (brush source) under
 * the heavy-job lock, the .rcw (its bytes, `rcw`) with its flag cleared at `rcwFile`, the .rcv2 at `rcv2File`;
 * then both read back from disk and checked (checkPair). Nothing is written when the table cannot be worked
 * out, so a .rcw is never left without its .rcv2. It returns { rcv2Bytes, seconds, seen } (seen: the pairs
 * of different waypoints that see each other).
 */
export function writeWithVisibility({ rcw, origins, map, rcwFile, rcv2File, job = "rcbot visibility table", log = console.log }) {
  const started = Date.now();
  const table = withHeavyJobLock(job, () => {
    const space = M.spaceOf(map, { doors: "closed" });
    return visibilityTable(origins, (from, to) => space.sees(from, to), {
      progress: (done, of) => log(`     visibility: ${done} of ${of} waypoints (${Math.round((Date.now() - started) / 1000)} s)`),
    });
  });
  const bytes = rcwWithTable(rcw);
  writeFileSync(rcv2File, table);
  writeFileSync(rcwFile, bytes);
  const problems = checkPair(readFileSync(rcwFile), readFileSync(rcv2File), table);
  if (problems.length) {
    unlinkSync(rcwFile);
    throw new Error(`the .rcw and .rcv2 do not read back (the .rcw is taken away): ${problems.join("; ")}`);
  }
  let seen = 0;
  for (const byte of table) for (let b = byte; b; b &= b - 1) seen++;
  return { rcv2Bytes: table, seconds: Math.round((Date.now() - started) / 1000), seen: seen - origins.length };
}

/**
 * The files a bot folder gets: the .rcw at waypoints\<mod>\<map>.rcw and the .rcv2 at visibility\<mod>\<map>.rcv2,
 * refused together unless the pair passes checkPair as it is on disk now. It returns the sentences of what is
 * wrong (none: ready to copy).
 */
export function pairReady(rcwFile, rcv2File) {
  if (!existsSync(rcwFile)) return [`no ${rcwFile}`];
  if (!existsSync(rcv2File)) return [`no ${rcv2File}: a .rcw never goes out without its .rcv2`];
  return checkPair(readFileSync(rcwFile), readFileSync(rcv2File));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [what, rcwFile, rcv2File] = process.argv.slice(2);
  if (what !== "check" || !rcwFile || !rcv2File) {
    console.log("  node rcbot_vis.mjs check <map>.rcw <map>.rcv2");
    process.exit(2);
  }
  const problems = pairReady(rcwFile, rcv2File);
  console.log(problems.length ? `  REFUSED: ${problems.join("; ")}` : `  ok: ${rcwFile} and ${rcv2File} read back as RCBot reads them`);
  process.exit(problems.length ? 1 : 0);
}
