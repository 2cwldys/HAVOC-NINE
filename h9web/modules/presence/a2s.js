// A2S_RULES over UDP: a game server's FCVAR_SERVER cvars, the way a server browser asks for them.
// Enrollment uses it to prove that the server at an address is the one that asked for a key: the
// plugin publishes a code in h9_presence_enroll, and only the server answering at that address can
// show it.
//
//   ask        FF FF FF FF 'V' <int32 challenge, -1 to ask for one>
//   challenge  FF FF FF FF 'A' <int32>                  (both FWGS and HLDS want this step)
//   rules      FF FF FF FF 'E' <int16 count> then count pairs of zero-ended name and value
// FWGS answers in one datagram (engine/server/sv_query.c). HLDS may split a long answer: each part
// starts FE FF FF FF <int32 id> <byte: part number in the high 4 bits, part count in the low 4>,
// and the parts put together are one answer starting FF FF FF FF 'E'. A server rate-limits these
// queries per address (FWGS: sv_query_rate_limit), so an unanswered ask is repeated once.

import dgram from "node:dgram";

const ASK = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x56]);

function readString(buf, at) {
  const end = buf.indexOf(0, at.i);
  if (end < 0) throw new Error("short");
  const s = buf.subarray(at.i, end).toString("utf8");
  at.i = end + 1;
  return s;
}

// The rules in an 'E' answer as a Map, or null.
export function parseRules(buf) {
  if (buf.length < 7 || buf.readInt32LE(0) !== -1 || buf[4] !== 0x45) return null;
  const count = buf.readUInt16LE(5);
  const at = { i: 7 };
  const rules = new Map();
  try {
    for (let n = 0; n < count && at.i < buf.length; n++) {
      const name = readString(buf, at);
      const value = readString(buf, at);
      if (rules.size < 1024) rules.set(name, value);
    }
  } catch (e) {
    // a cut-off answer still gives what it holds
  }
  return rules;
}

// Asks ip:port for its rules. Resolves to a Map, or null when nothing usable came back in time.
export function queryRules(ip, port, { timeoutMs = 2500, retries = 1, bindAddress } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let done = false;
    let tries = 0;
    let timer = null;
    const parts = new Map(); // split answers: id -> { total, got: Map(index -> payload) }
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch (e) { /* closed */ }
      resolve(value);
    };
    const send = (challenge) => {
      const msg = Buffer.alloc(9);
      ASK.copy(msg, 0);
      msg.writeInt32LE(challenge, 5);
      socket.send(msg, port, ip, () => {});
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (tries++ < retries) {
          send(-1);
          arm();
        } else {
          finish(null);
        }
      }, timeoutMs);
    };
    const answer = (buf) => {
      if (buf.length >= 9 && buf.readInt32LE(0) === -1 && buf[4] === 0x41) {
        send(buf.readInt32LE(5));
        arm();
        return;
      }
      const rules = parseRules(buf);
      if (rules) finish(rules);
    };
    socket.on("error", () => finish(null));
    socket.on("message", (msg, rinfo) => {
      if (rinfo.address !== ip || rinfo.port !== port) return;
      if (msg.length >= 9 && msg.readInt32LE(0) === -2) {
        const id = msg.readInt32LE(4);
        const index = msg[8] >> 4;
        const total = msg[8] & 15;
        if (!total || index >= total) return;
        let p = parts.get(id);
        if (!p) {
          if (parts.size > 8) return;
          p = { total, got: new Map() };
          parts.set(id, p);
        }
        p.got.set(index, msg.subarray(9));
        if (p.got.size === p.total) {
          const whole = Buffer.concat([...Array(p.total).keys()].map((i) => p.got.get(i) || Buffer.alloc(0)));
          parts.delete(id);
          answer(whole);
        }
        return;
      }
      answer(msg);
    });
    socket.bind({ port: 0, address: bindAddress }, () => {
      send(-1);
      arm();
    });
  });
}
