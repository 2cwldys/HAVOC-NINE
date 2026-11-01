// Username rules. The username is also the display name, shown as it was typed.
//
//   3 to 20 characters: letters, digits and . _ -
//   starts and ends with a letter or a digit, no two of . _ - in a row, at least one letter
//   unique without regard to case ("Neo" and "neo" are one name)
//   unique by look-alike skeleton too ("Ne0", "N_eo" and "neo" are one name), so nobody can
//   pass for another player, or for staff, with a near copy of a name
//   names that read as staff or as the project itself are reserved (see RESERVED_*)

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

// Folds case, drops separators and maps the usual look-alikes to one letter.
export function skeleton(name) {
  return String(name)
    .toLowerCase()
    .replace(/[._-]/g, "")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[0-9]/g, (d) => ({ 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b" })[d] ?? d)
    .replace(/[i|]/g, "l");
}

// reserved wherever they appear in the skeleton
const RESERVED_ANYWHERE = ["admin", "moderator", "havoc9", "havocnine", "official", "staff", "sysop", "webmaster", "h9team", "h9staff"];
// reserved as the whole name
const RESERVED_EXACT = ["havoc", "mod", "mods", "root", "system", "server", "console", "owner", "support", "dev",
  "developer", "gm", "null", "undefined", "anonymous", "everyone", "here", "guest", "unknown", "deleted", "player", "msr"];
// reserved at the start of the name
const RESERVED_PREFIX = ["msr", "h9"];

const FOLDED = {
  anywhere: RESERVED_ANYWHERE.map(skeleton),
  exact: new Set(RESERVED_EXACT.map(skeleton)),
  prefix: RESERVED_PREFIX.map(skeleton),
};

export function isReserved(name) {
  const s = skeleton(name);
  return FOLDED.exact.has(s) || FOLDED.anywhere.some((w) => s.includes(w)) || FOLDED.prefix.some((w) => s.startsWith(w));
}

// { ok: true, username, key, skeleton } or { ok: false, message }
export function checkUsername(raw) {
  if (typeof raw !== "string") return { ok: false, message: "Type a username." };
  const name = raw.trim();
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return { ok: false, message: "Use " + USERNAME_MIN + " to " + USERNAME_MAX + " characters." };
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return { ok: false, message: "Use letters, digits and . _ - only." };
  if (!/^[A-Za-z0-9]/.test(name) || !/[A-Za-z0-9]$/.test(name)) return { ok: false, message: "Start and end with a letter or a digit." };
  if (/[._-]{2}/.test(name)) return { ok: false, message: "No two of . _ - in a row." };
  if (!/[A-Za-z]/.test(name)) return { ok: false, message: "Use at least one letter." };
  if (isReserved(name)) return { ok: false, message: "That name is reserved." };
  return { ok: true, username: name, key: name.toLowerCase(), skeleton: skeleton(name) };
}

// The key a sign-in looks the account up by.
export function usernameKey(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}
