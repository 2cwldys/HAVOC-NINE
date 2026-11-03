import { readFileSync, existsSync } from "node:fs";
const i32=(b,o)=>b.readInt32LE(o);
const T = "D:/SteamLibrary/steamapps/common/Half-Life/ts/models/player";
const names = ["merc","repuheavy","XCCPsgts","XCCPRurik","scda_Spy02","XCCPmutant","reputengu"];
console.log("  model            file      numtex  texdata starts  last tex ends   geometry after textures?");
for (const n of names) {
  const p = `${T}/${n}/${n}.mdl`;
  if (!existsSync(p)) continue;
  const b = readFileSync(p);
  if (b.toString("latin1",0,4) !== "IDST") continue;
  const nt=i32(b,180), ti=i32(b,184), tdi=i32(b,188);
  if (nt === 0) { console.log(`  ${n.padEnd(16)} ${String(b.length).padStart(8)}   0 (external texture file)`); continue; }
  let end=0;
  for (let i=0;i<nt;i++){ const o=ti+i*80; const w=i32(b,o+68),h=i32(b,o+72),ix=i32(b,o+76); end=Math.max(end, ix+w*h+768); }
  const after = b.length - end;
  console.log(`  ${n.padEnd(16)} ${String(b.length).padStart(8)}  ${String(nt).padStart(3)}    ${String(tdi).padStart(9)}      ${String(end).padStart(9)}   ${after === 0 ? "NO -- textures are last" : "YES, " + after + " bytes"}`);
}
