// Scratch: what does workshop.steel/iron actually return under these params?
import { K } from "./lib.mjs";
const W = K.workshop;
console.log("keys:", Object.keys(W).filter((k) => /steel|iron|rust|skin|paint|panel|sheet/i.test(k)).join(", "));
for (const args of [
  [10, 20, 1.0, 11, -0.25],
  [10, 20, 0.96, 97, -0.1],
  [2, 3, 0.9, 41, 0.55],
]) {
  const c = W.steel(...args);
  console.log(`steel(${args.join(", ")}) =`, JSON.stringify(c));
}
console.log("iron:", JSON.stringify(W.iron(10, 20, 1.0, 11, -0.25)));
console.log("rust:", JSON.stringify(W.rust(10, 20, 11)));
