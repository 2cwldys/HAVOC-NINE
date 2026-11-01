// The master server the relay plays for the browser engine (Find Servers in the game's menu).
//
// The engine's query (xash3d-fwgs engine/common/masterlist.c, NET_BuildMasterServerScanRequest):
//     '1'  region byte  seed address "0.0.0.0:0"  NUL  infostring  NUL
// with no FF FF FF FF in front. For a master added without "gs" the infostring carries
// \gamedir\ \clver\ \nat\ \commit\ \branch\ \os\ \arch\ \buildnum\ \key\ (FWGS's form); for a
// "gs" master only \gamedir\ and the menu's own filters (the GoldSrc form).
//
// The reply (engine/client/cl_main.c, CL_ServerList):
//     FF FF FF FF 'f' '\n'
//     FWGS form only: 7F, a 4-byte key, a reserved byte. The engine reads one byte here for a
//         non-gs master whatever it is, so the block is not optional for that form.
//     6 bytes per server: IPv4, then port, both in network order
//     00 00 00 00 00 00 after the last server
// The reply must come from the master's own address (the engine checks NET_IsMasterAdr).
// One datagram holds MAX_PER_REPLY servers; a longer list goes as several datagrams, each with
// the full header, and only the last one ends with the zero entry.

export const MAX_PER_REPLY = 200;

// { seed, info: Map } or null when this is not a master query.
export function parseMasterQuery(payload) {
  if (!payload || payload.length < 3 || payload[0] !== 0x31) return null;
  let i = 2;
  let end = payload.indexOf(0, i);
  if (end < 0 || end - i > 64) return null;
  const seed = payload.subarray(i, end).toString("latin1");
  i = end + 1;
  end = payload.indexOf(0, i);
  if (end < 0) end = payload.length;
  const text = payload.subarray(i, Math.min(end, i + 2048)).toString("latin1");
  const info = new Map();
  const parts = text.split("\\");
  for (let k = 1; k + 1 < parts.length; k += 2) {
    if (parts[k]) info.set(parts[k].toLowerCase(), parts[k + 1]);
  }
  return { seed, info, fwgs: info.has("clver") || info.has("key") };
}

// servers: [{ bytes: Buffer(4), port }]. Returns the reply datagrams.
export function buildMasterReplies(servers, { fwgs = true, key = 0, seed = "0.0.0.0:0" } = {}) {
  let list = servers;
  if (seed && seed !== "0.0.0.0:0") {
    const at = list.findIndex((s) => s.key === seed);
    if (at >= 0) list = list.slice(at + 1);
  }
  const header = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x66, 0x0a]);
  const ext = Buffer.alloc(6);
  ext[0] = 0x7f;
  ext.writeUInt32LE(key >>> 0, 1);
  const out = [];
  for (let start = 0; start === 0 || start < list.length; start += MAX_PER_REPLY) {
    const chunk = list.slice(start, start + MAX_PER_REPLY);
    const last = start + MAX_PER_REPLY >= list.length;
    const parts = [header];
    if (fwgs) parts.push(ext);
    for (const s of chunk) {
      const entry = Buffer.alloc(6);
      Buffer.from(s.bytes).copy(entry, 0);
      entry.writeUInt16BE(s.port, 4);
      parts.push(entry);
    }
    if (last) parts.push(Buffer.alloc(6));
    out.push(Buffer.concat(parts));
    if (last) break;
  }
  return out;
}

// The engine's side of it, for tests: reads a reply the way CL_ServerList does.
export function readMasterReply(datagram, { fwgs = true } = {}) {
  if (datagram.readInt32LE(0) !== -1) return null;
  let i = 4;
  let line = "";
  while (i < datagram.length && datagram[i] !== 0x0a && datagram[i] !== 0) line += String.fromCharCode(datagram[i++]);
  i++;
  if (line !== "f") return null;
  if (fwgs) {
    const b = datagram[i++];
    if (b === 0x7f) i += 5;
  }
  const servers = [];
  while ((datagram.length - i) * 8 > 8) {
    const ip = Array.from(datagram.subarray(i, i + 4)).join(".");
    const port = datagram.readUInt16BE(i + 4);
    i += 6;
    if (!port) break;
    servers.push(ip + ":" + port);
  }
  return servers;
}
