// Edit the class model pools in ts_matchmode.cfg, with the limits checked for you.
//
// Driven by models.bat -- run that rather than this.
//
// WHY THIS EXISTS. Changing which models a class uses is a one-word edit that has taken
// the server down twice, because the limits that matter are invisible in the file:
//
//   * a model name over 22 characters is FATAL. TS builds "models/player/<n>/<n>.mdl"
//     into a 64-byte buffer without checking, so a long name is truncated and the server
//     dies on Mod_NumForName with nothing in the AMXX log.
//   * the class line is read into fixed buffers. Over them the list is silently cut off
//     mid-name, and the class quietly falls back to the default model -- no error at all.
//
// So every edit here is checked against both before it is written, and a change that
// would break either is refused with the number that broke it.
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = join(HERE, "ts_matchmode.cfg");
const SMA = join(HERE, "ts_matchmode.sma");

// Where the models actually live, so a name can be checked against what is installed.
const GAME = process.env.TS_MODELS
  || "D:/SteamLibrary/steamapps/common/Half-Life/ts/models/player";

/*
 * The limits are READ OUT OF THE PLUGIN rather than copied here.
 *
 * They have been raised four times. A second copy of them in this file would be correct
 * on the day it was written and wrong by the next time the buffers move, and it would be
 * wrong SILENTLY -- which is the exact failure this tool exists to prevent.
 */
const DEFAULTS = { TSM_MODELLIST: 224, TSM_MODELFIELD: 344, TSM_LINE: 384, TSM_MAXMODELS: 12 };
const LIMITS = { ...DEFAULTS };
if (existsSync(SMA)) {
  const sma = readFileSync(SMA, "utf8");
  for (const k of Object.keys(DEFAULTS)) {
    const m = sma.match(new RegExp(`^#define\\s+${k}\\s+(\\d+)`, "m"));
    if (m) LIMITS[k] = Number(m[1]);
  }
}

// TS truncates the whole path at 63 characters, and the name appears in it twice.
const NAME_MAX = 22;
const PATH_OF = (n) => `models/player/${n}/${n}.mdl`;

const SIDES = { msr: 0, ins: 1 };
const SIDE_NAME = ["MSR", "insurgent"];

// ── reading ────────────────────────────────────────────────────────────────
function load() {
  const text = readFileSync(CFG, "utf8");
  const lines = text.split(/\r?\n/);
  const classes = [];
  lines.forEach((ln, i) => {
    const m = ln.match(/^(tsm_class(\d+))\s+"(.*)"\s*$/);
    if (!m) return;
    const fields = m[3].split(";");
    const [msr, ins] = ((fields[3] ?? "") + "|").split("|");
    classes.push({
      line: i,
      cvar: m[1],
      n: Number(m[2]),
      name: fields[0] ?? "",
      fields,
      pools: [
        msr.split(",").filter((x) => x.trim()).map((x) => x.trim()),
        ins.split(",").filter((x) => x.trim()).map((x) => x.trim()),
      ],
    });
  });
  return { text, lines, classes, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

const render = (c) => {
  const f = [...c.fields];
  f[3] = `${c.pools[0].join(",")}|${c.pools[1].join(",")}`;
  return `${c.cvar} "${f.join(";")}"`;
};

// ── checking ───────────────────────────────────────────────────────────────
function problems(c) {
  const bad = [], warn = [];
  const line = render(c);
  const field = `${c.pools[0].join(",")}|${c.pools[1].join(",")}`;

  for (const [s, pool] of c.pools.entries()) {
    for (const n of pool) {
      if (n.length > NAME_MAX) {
        bad.push(`"${n}" is ${n.length} characters: over ${NAME_MAX} the server dies on Mod_NumForName`);
      } else if (PATH_OF(n).length > 63) {
        bad.push(`"${n}" makes a ${PATH_OF(n).length} character path and TS truncates at 63`);
      }
      if (existsSync(GAME) && !existsSync(join(GAME, n, `${n}.mdl`))) {
        warn.push(`${SIDE_NAME[s]} "${n}" is not installed at ${join(GAME, n, `${n}.mdl`)}`);
      }
    }
    if (pool.length > LIMITS.TSM_MAXMODELS) {
      bad.push(`${SIDE_NAME[s]} has ${pool.length} models, over TSM_MAXMODELS ${LIMITS.TSM_MAXMODELS}`);
    }
    const len = pool.join(",").length;
    if (len > LIMITS.TSM_MODELLIST) {
      bad.push(`${SIDE_NAME[s]} list is ${len} characters, over TSM_MODELLIST ${LIMITS.TSM_MODELLIST}`);
    }
  }
  if (field.length > LIMITS.TSM_MODELFIELD) {
    bad.push(`the model field is ${field.length} characters, over TSM_MODELFIELD ${LIMITS.TSM_MODELFIELD}`);
  }
  if (line.length > LIMITS.TSM_LINE) {
    bad.push(`the whole line is ${line.length} characters, over TSM_LINE ${LIMITS.TSM_LINE}`);
  }
  return { bad, warn, line, field };
}

function show(st) {
  console.log(`  limits from ts_matchmode.sma: `
    + Object.entries(LIMITS).map(([k, v]) => `${k} ${v}`).join("  ") + `  name <= ${NAME_MAX}\n`);
  for (const c of st.classes) {
    const { bad, warn, line, field } = problems(c);
    console.log(`  ${c.cvar}  ${c.name}`);
    for (const [s, pool] of c.pools.entries()) {
      const len = pool.join(",").length;
      console.log(`      ${SIDE_NAME[s].padEnd(9)} ${String(len).padStart(3)}/${LIMITS.TSM_MODELLIST}  `
        + (pool.length ? pool.join(", ") : "(none -- the model is left alone)"));
    }
    console.log(`      line ${line.length}/${LIMITS.TSM_LINE}, field ${field.length}/${LIMITS.TSM_MODELFIELD}`);
    for (const w of warn) console.log(`      [warn]  ${w}`);
    for (const b of bad) console.log(`      [FAIL]  ${b}`);
    console.log("");
  }
}

// ── writing ────────────────────────────────────────────────────────────────
function save(st, touched) {
  // Everything is checked BEFORE anything is written, so a refusal leaves the file as it
  // was rather than half edited.
  let stop = false;
  for (const c of st.classes) {
    const { bad } = problems(c);
    for (const b of bad) { console.log(`  [FAIL] ${c.cvar}: ${b}`); stop = true; }
  }
  if (stop) {
    console.log("\n  Nothing was written.");
    process.exit(1);
  }

  const lines = [...st.lines];
  for (const c of touched) lines[c.line] = render(c);

  // Through a temporary file and a backup: this is the file the whole match reads, and a
  // half written one is a server that will not start.
  const body = lines.join(st.eol);
  writeFileSync(`${CFG}.bak`, readFileSync(CFG));
  writeFileSync(`${CFG}.tmp`, body);
  renameSync(`${CFG}.tmp`, CFG);
  for (const c of touched) console.log(`  ${render(c)}`);
  console.log(`\n  written. The previous file is at ts_matchmode.cfg.bak`);
  console.log(`  Restart the server (or amx_tsm_reload) for it to take effect.`);
}

function pick(st, which) {
  const n = Number(which);
  const c = st.classes.find((x) => x.n === n)
    || st.classes.find((x) => x.name.toLowerCase() === String(which).toLowerCase());
  if (!c) {
    console.log(`  No class "${which}". There are: `
      + st.classes.map((x) => `${x.n}=${x.name}`).join(", "));
    process.exit(1);
  }
  return c;
}

function sideOf(s) {
  const k = String(s).toLowerCase();
  if (k in SIDES) return SIDES[k];
  console.log(`  Side must be msr or ins, not "${s}".`);
  process.exit(1);
}

// ── the commands ───────────────────────────────────────────────────────────
const [cmd = "list", a, b, c] = process.argv.slice(2);
const st = load();

switch (cmd.toLowerCase()) {
  case "list":
  case "check":
    show(st);
    break;

  case "set": {
    const cls = pick(st, a), side = sideOf(b);
    cls.pools[side] = String(c ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    save(st, [cls]);
    break;
  }

  case "add": {
    const cls = pick(st, a), side = sideOf(b);
    for (const n of String(c ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (cls.pools[side].includes(n)) { console.log(`  ${n} is already there.`); continue; }
      cls.pools[side].push(n);
    }
    save(st, [cls]);
    break;
  }

  case "rm":
  case "remove": {
    const cls = pick(st, a), side = sideOf(b);
    const want = String(c ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const before = cls.pools[side].length;
    cls.pools[side] = cls.pools[side].filter((n) => !want.includes(n));
    if (cls.pools[side].length === before) console.log(`  Nothing matched; the pool is unchanged.`);
    save(st, [cls]);
    break;
  }

  case "installed": {
    if (!existsSync(GAME)) { console.log(`  ${GAME} is not there.`); break; }
    const used = new Set(st.classes.flatMap((x) => [...x.pools[0], ...x.pools[1]]));
    const all = readdirSync(GAME, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(GAME, e.name, `${e.name}.mdl`)))
      .map((e) => e.name).sort();
    console.log(`  ${all.length} models installed in ${GAME}:\n`);
    for (const n of all) {
      const flag = n.length > NAME_MAX ? "  TOO LONG" : used.has(n) ? "  (in use)" : "";
      console.log(`    ${n.padEnd(26)} ${String(n.length).padStart(2)} chars${flag}`);
    }
    break;
  }

  default:
    console.log(`  Unknown command "${cmd}". Run models.bat with no arguments for the help.`);
    process.exit(1);
}
