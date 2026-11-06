import { readFileSync } from "node:fs";
import { sequences, events } from "file:///D:/Downloads/TSM/smak/src/index.mjs";
const src = readFileSync("D:/Downloads/TSM/H9XASH/ts/models/v_m4.mdl");
const seqs = sequences(src);
for (const i of [0, 1, 2, 3, 14, 15]) {
  const s = seqs[i];
  console.log(i, s.name, "frames", s.frames, "fps", s.fps, "=", (s.frames / s.fps).toFixed(2), "s", "events", JSON.stringify(events(src, i)));
}
