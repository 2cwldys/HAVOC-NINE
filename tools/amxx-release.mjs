// amxx-release.mjs -- the release a compiled plugin carries.
//
// h9_presence registers the cvar h9_plugin_release with the release it was compiled with (include/h9_release.inc, written by build.bat from the
// overlay's h9_release.txt) and the join gate holds joiners to it. A bump that stops between writing the release files and compiling leaves the plugin
// that still carries the old one, and nothing else notices: the text files all agree. An .amxx is a header of 24 bytes and a zlib image; the image's
// data holds string literals as cells of 4 bytes (one character each, little endian, a zero cell at the end), and the literal that follows
// "h9_plugin_release" (register_cvar( "h9_plugin_release", H9_RELEASE, ... )) is the release in the binary.
import fs from "node:fs";
import zlib from "node:zlib";

const NAME = "h9_plugin_release";

function cells(s) {
  const b = Buffer.alloc((s.length + 1) * 4);
  for (let i = 0; i < s.length; i++) b[i * 4] = s.charCodeAt(i);
  return b;
}

/** The release the compiled plugin carries: its text; "" when it holds no h9_plugin_release (another plugin); null when it cannot be read as an .amxx. */
export function amxxRelease(buf) {
  let image;
  try { image = zlib.inflateSync(buf.subarray(24)); } catch { return null; }
  const at = image.indexOf(cells(NAME));
  if (at < 0) return "";
  let p = at + (NAME.length + 1) * 4;
  let s = "";
  while (p + 4 <= image.length) {
    const c = image.readUInt32LE(p);
    if (c === 0) break;
    if (c < 32 || c > 126 || s.length > 40) return null;
    s += String.fromCharCode(c);
    p += 4;
  }
  return s;
}

export function amxxReleaseOfFile(file) {
  try { return amxxRelease(fs.readFileSync(file)); } catch { return null; }
}
