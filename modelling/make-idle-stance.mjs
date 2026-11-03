// repuheavy's idle stance, put on the models that were built without it.
//
//     node make-idle-stance.mjs                 -- the usual list
//     node make-idle-stance.mjs ins_proletarian -- just these
//
// TS's own default idle is a kung-fu guard: feet apart, hands up. Every model that ships
// with TS carries its own, and the repu and XCCP models carry one where the arms hang at
// the sides -- which is what a soldier standing about looks like, and what the rest of
// these should match. The models built here inherited their donors' idle, so the ones cut
// from TS's own stock still stand like martial artists.
//
// WHY THIS IS SAFE, which is worth stating because replacing animation data usually is
// not. replaceSequence writes every animation of the file again, so it fails outright on
// a model holding any of them in a separate file; that is checked per model and a failure
// is named and skipped rather than written badly.
//
// THE BONES ARE MATCHED BY NAME, and that turned out to be the whole job. Frames are
// indexed BY BONE NUMBER, and these models do not carry repuheavy's 22 bones: proletarian
// and the two insurgents carry 34, with finger bones from "Bip01 Dito mano SX0" onwards,
// and ins_medic_belt carries 40 including a row of dummies. Copied straight across, bone
// 18 would have taken his right clavicle's motion onto a finger and the model would have
// folded inside out -- with check() reporting nothing wrong, because nothing is.
//
// So each bone takes the motion of HIS bone of the same name, and a bone he does not have
// -- every finger, every dummy -- keeps the motion it already had. The 22 that carry the
// pose are the 22 they share.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { K, load, POSE } from "./lib.mjs";
const { isEngineLayout } = await import("file:///D:/Downloads/TSM/smak/src/layout.mjs");

const OUT = join(process.cwd(), "..", "export-mdl");
const EXPORT = join(process.cwd(), "..", "export", "ts", "models", "player");
const LIVE = "D:/SteamLibrary/steamapps/common/Half-Life/ts/models/player";

/*
 * The ones that need it: everything built here off a TS stock model rather than off
 * repuheavy. The repuheavy_* variants, the ghillie and the female pair are left out
 * because they already stand his way -- they were cut from him.
 */
const USUAL = [
  "ins_proletarian",
  "ins_prole_helm",
  "ins_medic_belt",
  "proletarian",
  "proletarian_dirty",
  "proletarian_healthy",
];

const want = process.argv.length > 2 ? process.argv.slice(2) : USUAL;

const donor = load("repuheavy");
const donorBones = K.bones(donor).map((b) => b.name);
const donorSeqs = K.sequences(donor);
const IDLE = /idle/i;

console.log(`  donor repuheavy: ${donorSeqs.length} sequences, `
  + `${donorSeqs.filter((s) => IDLE.test(s.name)).length} of them idles\n`);

let done = 0, skipped = 0;
for (const name of want) {
  let src;
  try {
    src = load(name);
  } catch (e) {
    console.log(`  ${name.padEnd(22)} SKIPPED -- cannot be read: ${e.message}`);
    skipped++;
    continue;
  }

  // 1. which of its bones he has, by name. Anything he lacks keeps its own motion.
  const bones = K.bones(src).map((b) => b.name);
  const fromDonor = bones.map((b) => donorBones.indexOf(b));
  const shared = fromDonor.filter((i) => i >= 0).length;
  if (shared < donorBones.length) {
    console.log(`  ${name.padEnd(22)} SKIPPED -- it is missing ${donorBones.length - shared} `
      + `of his bones, so his pose cannot be put on it whole`);
    skipped++;
    continue;
  }

  // 2. nothing held in a separate file, or the write fails for the whole model.
  const seqs = K.sequences(src);
  const outside = seqs.filter((s) => s.group !== 0);
  if (outside.length) {
    console.log(`  ${name.padEnd(22)} SKIPPED -- ${outside.length} of its animations live in another file`);
    skipped++;
    continue;
  }

  let built = src, copied = 0, missing = 0;
  for (const [i, sq] of seqs.entries()) {
    if (!IDLE.test(sq.name)) continue;
    const j = K.sequenceAt(donor, sq.name);
    if (j < 0) { missing++; continue; }
    // Every blend, not just the first: a sequence with two is aimed by the engine between
    // them, and replacing one of a pair leaves it aiming with the old one.
    const blends = [];
    for (let b = 0; b < Math.max(1, sq.blends ?? 1); b++) {
      const his = K.readSequence(donor, j, b).frames;
      const mine = K.readSequence(src, i, b).frames;
      // His frame count wins, since the animation becomes his. A bone he does not have
      // holds whatever it was doing, clamped to the last frame this model actually has.
      blends.push(his.map((hf, f) => bones.map((_, bi) => {
        const dj = fromDonor[bi];
        return dj >= 0 ? hf[dj] : mine[Math.min(f, mine.length - 1)][bi];
      })));
    }
    built = K.replaceSequence(built, i, blends.length > 1 ? { frames: blends[0], blends } : { frames: blends[0] });
    copied++;
  }

  const r = K.check(built, "goldsrc");
  const lay = isEngineLayout(built);
  if (r.errors?.length) {
    console.log(`  ${name.padEnd(22)} SKIPPED -- came out unsound: ${r.errors[0]}`);
    skipped++;
    continue;
  }
  if (!lay) {
    console.log(`  ${name.padEnd(22)} SKIPPED -- not in engine layout, a dedicated server would die on it`);
    skipped++;
    continue;
  }

  mkdirSync(join(OUT, name), { recursive: true });
  writeFileSync(join(OUT, name, `${name}.mdl`), built);
  for (const dir of [EXPORT, LIVE]) {
    if (!existsSync(dir)) continue;
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, `${name}.mdl`), built);
  }
  console.log(`  ${name.padEnd(22)} ${copied} idles copied`
    + (missing ? `, ${missing} the donor does not have` : "")
    + `  check 0 errors  engineLayout true  -- written to export-mdl, export and the game`);
  done++;
}

console.log(`\n  ${done} model(s) given his stance, ${skipped} skipped`);

// A picture of one, standing, so the change is visible rather than merely reported.
if (done) {
  const first = want.find((n) => existsSync(join(OUT, n, `${n}.mdl`)));
  if (first) {
    const shots = [
      K.render(load("repuheavy"), { ...POSE, seq: "standard_idle", frame: 0, yaw: 35, zoom: 1.6, width: 260, height: 420 }),
      K.render(readFileSync(join(OUT, first, `${first}.mdl`)), { ...POSE, seq: "standard_idle", frame: 0, yaw: 35, zoom: 1.6, width: 260, height: 420 }),
    ];
    const img = K.tile(shots, 2, ["repuheavy", first]);
    writeFileSync(join(OUT, "idle_stance.png"), K.png(img.width, img.height, img.rgba));
    console.log("  wrote export-mdl/idle_stance.png");
  }
}
