// Scratch: bisect why the panel zones come out black.
import { K } from "./lib.mjs";
const W = K.workshop;
const S = W.sheet(64, 64);
S.zone({ x: 4, y: 4, w: 24, h: 24 }, (u, v) => W.steel(u / 6, v / 6, 1.0, 11, -0.25));
S.zone({ x: 32, y: 4, w: 24, h: 24 }, (u, v) => W.times(W.steel(u / 6, v / 6, 1.0, 11, -0.25), [0.84, 0.93, 1.14]));
S.zone({ x: 4, y: 32, w: 24, h: 24 }, (u, v) => W.times(W.steel(u / 6, v / 6, 1.0, 11, -0.25), 0.9));
const img = S.image();
const at = (u, v) => { const i = (v * img.width + u) * 3; return [img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]].join(","); };
console.log("plain steel:   ", at(16, 16));
console.log("times [array]: ", at(44, 16));
console.log("times scalar:  ", at(16, 44));
