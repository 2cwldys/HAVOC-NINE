// The layout a dedicated server's engine needs of a studio model (HLDS and ReHLDS, Mod_LoadStudioModel): it copies
// the file up to texturedataindex as it is, then reads the textures one after another from there, in the table's
// order, and takes the table's place (textureindex) to be inside what it copied. The writer here adds textures and
// the table at the file's end, after the first textures: the table is then read from memory never written, which is
// zero on the first map and whatever was there on the next: the server dies on a change of level. Xash and the
// game's own client draw such a file without complaint, so nothing shows until a real server changes map.
// engineLayout moves every texture to the end, in the table's order, and closes the gaps. Pass a model through it
// last, before it is written; check() refuses one that was not.
const H = { length: 72, numseq: 164, seqindex: 168, numtextures: 180, textureindex: 184, texturedataindex: 188, numbodyparts: 204, bodypartindex: 208 };
const HEADER_OFFSETS = [144, 152, 160, 168, 176, 184, 200, 208, 216, 224, 232, 240]; // every ...index of the header but the textures'
const TEX = 80, BODYPART = 76, MODEL = 112, MESH = 20, SEQ = 176, PALETTE = 768;

const textures = (b) => Array.from({ length: b.readInt32LE(H.numtextures) }, (_, i) => {
  const at = b.readInt32LE(H.textureindex) + i * TEX;
  return { at, index: b.readInt32LE(at + 76), size: b.readInt32LE(at + 68) * b.readInt32LE(at + 72) + PALETTE };
});

/** Whether the texture table comes before the textures, and they follow one another in its order. */
export function isEngineLayout(b) {
  if (!b.readInt32LE(H.textureindex)) return true; // the textures are in another file
  let next = b.readInt32LE(H.texturedataindex);
  if (b.readInt32LE(H.textureindex) + b.readInt32LE(H.numtextures) * TEX > next) return false;
  for (const t of textures(b)) { if (t.index !== next) return false; next += t.size; }
  return next === b.length; // and nothing after them: what follows the textures is not where the engine looks for it
}

/** The same model with its textures moved to the end in the table's order. Returns src itself when it is already so. */
export function engineLayout(src) {
  if (isEngineLayout(src)) return src;
  const tex = textures(src);
  // the textures' bytes, merged where they touch; each gap is closed by a multiple of four so what follows stays aligned
  const spans = []; for (const t of [...tex].sort((a, c) => a.index - c.index)) { const last = spans[spans.length - 1]; if (last && t.index <= last.end) last.end = Math.max(last.end, t.index + t.size); else spans.push({ start: t.index, end: t.index + t.size }); }
  for (const s of spans) s.cut = (s.end - s.start) & ~3;
  const move = (off) => { let d = 0; for (const s of spans) { if (off >= s.end) d += s.cut; else if (off > s.start) throw new Error(`layout: ${off} points into a texture`); } return off - d; };

  const pieces = []; let at = 0;
  for (const s of spans) { pieces.push(src.subarray(at, s.start)); at = s.start + s.cut; }
  pieces.push(src.subarray(at));
  let body = Buffer.concat(pieces);
  if (body.length & 3) body = Buffer.concat([body, Buffer.alloc(4 - (body.length & 3))]);
  const out = Buffer.concat([body, ...tex.map((t) => src.subarray(t.index, t.index + t.size))]);

  const fix = (where) => { const v = src.readInt32LE(where); if (v) out.writeInt32LE(move(v), move(where)); };
  for (const o of HEADER_OFFSETS) fix(o);
  for (let i = 0; i < src.readInt32LE(H.numseq); i++) { const s = src.readInt32LE(H.seqindex) + i * SEQ; for (const o of [52, 64, 88, 92, 124]) fix(s + o); }
  for (let i = 0; i < src.readInt32LE(H.numbodyparts); i++) {
    const bp = src.readInt32LE(H.bodypartindex) + i * BODYPART; fix(bp + 72);
    for (let m = 0; m < src.readInt32LE(bp + 64); m++) {
      const mo = src.readInt32LE(bp + 72) + m * MODEL; for (const o of [76, 84, 88, 96, 100, 108]) fix(mo + o);
      for (let k = 0; k < src.readInt32LE(mo + 72); k++) { const me = src.readInt32LE(mo + 76) + k * MESH; fix(me + 4); fix(me + 16); }
    }
  }
  let next = body.length; out.writeInt32LE(next, H.texturedataindex);
  for (const t of tex) { out.writeInt32LE(next, move(t.at) + 76); next += t.size; }
  out.writeInt32LE(out.length, H.length);
  if (!isEngineLayout(out)) throw new Error("layout: the result is not laid out as the engine needs");
  return out;
}
