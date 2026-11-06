// What a server is playing, named the way the engine's Discord card names it (CL_H9_ModeName in
// engine/client/cl_presence.c, which the in-game server browser's Mode column uses as well;
// docs/RICH_PRESENCE.txt section 1), so the website, the card and the browser agree. h9_presence.sma works the mode out itself, the same way, and sends it in its reports;
// modeFor() is for a server the module knows only through the status poller (a web client player
// on a server without the plugin), and for the tests that hold the two lists together.
//
// In order:
//   1. what an H9 server says it runs (tsm_pres_mode, or the siege progress tsm_pres_siege);
//   2. the map's name: an h9_<mode>_ prefix, then rp_ / tsrp_ at the start or _rp_ / _tsrp_
//      anywhere for Roleplay, then ctb_ / ctf_ at the start or _ctb_ / _ctf_ anywhere for TS's
//      own capture game (its flag is the briefcase, so both play the same; the name only
//      decides what the card says: Capture the Briefcase or Capture the Flag);
//   3. "match" on any other map: Match Mode;
//   4. anything else, a stock ts_ map among them: Deathmatch.

const KEYS = new Map([
  ["siege", "Siege"],
  ["uplink", "Capture the Uplink"],
  ["survival", "Wave Survival"],
  ["mechwarrior", "Mech Warrior"],
  ["assault", "Assault"],
  ["ctf", "Capture the Flag"],
]);

const MAP_PREFIXES = [
  ["h9_te_", "Team Elimination"],
  ["h9_siege_", "Siege"],
  ["h9_up_", "Capture the Uplink"],
  ["h9_mw_", "Mech Warrior"],
  ["h9_ws_", "Wave Survival"],
  ["h9_as_", "Assault"],
  ["h9_dm_", "Deathmatch"],
  ["h9_tdm_", "Team Deathmatch"],
  ["h9_ctb_", "Capture the Briefcase"],
  ["h9_ctf_", "Capture the Flag"],
];

// A roleplay map, as ts_matchmode's roleplay_map() has it: rp_ or tsrp_ at the start, _rp_ or
// _tsrp_ inside, in any case.
export function roleplayMap(map) {
  const name = String(map || "").toLowerCase();
  return name.startsWith("rp_") || name.startsWith("tsrp_") || name.includes("_rp_") || name.includes("_tsrp_");
}

export function modeFor(map, key = "", siege = "") {
  if (siege) return "Siege";
  const k = String(key || "").toLowerCase();
  if (KEYS.has(k)) return KEYS.get(k);
  const name = String(map || "").toLowerCase();
  for (const [prefix, mode] of MAP_PREFIXES) if (name.startsWith(prefix)) return mode;
  if (roleplayMap(name)) return "Roleplay";
  if (name.startsWith("ctb_") || name.includes("_ctb_")) return "Capture the Briefcase";
  if (name.startsWith("ctf_") || name.includes("_ctf_")) return "Capture the Flag";
  if (k === "match") return "Match Mode";
  return "Deathmatch";
}

// The mode key behind a server browser game description, as ts_matchmode and the mode plugins
// set it (tsm_gamedesc "Match Mode", tsm_gamedesc_siege "Siege" or "Siege 2/5", and the modes'
// own names). "" when the description is not one of H9's.
export function keyFromDescription(text) {
  const d = String(text || "").trim().toLowerCase();
  if (d === "match mode") return "match";
  if (d === "siege" || d.startsWith("siege ")) return "siege";
  for (const [key, name] of KEYS) if (d === name.toLowerCase()) return key;
  return "";
}

// A map name as the site may use it: lowercase, the characters a .bsp name has, or null.
export function cleanMap(value) {
  const m = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_][a-z0-9_.+-]{0,63}$/.test(m) && !m.includes("..") ? m : null;
}

// The bidirectional embedding, override and isolate controls (U+202A to U+202E, U+2066 to
// U+2069), which can make a name read as something else. Built from char codes so this file
// stays ASCII.
const BIDI = new RegExp("[" + String.fromCharCode(0x202a) + "-" + String.fromCharCode(0x202e) +
  String.fromCharCode(0x2066) + "-" + String.fromCharCode(0x2069) + "]", "g");

// One line of display text: control characters out, white space collapsed, at most max
// characters (whole code points).
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const t = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(BIDI, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join("").trim() : t;
}
