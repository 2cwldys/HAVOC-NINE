// The forum's text: how a post, a title or a reason is cleaned when it comes in, and the
// renderer for the small formatting subset a post may use (README.txt, section 15).
//
// What a post may use:
//   a blank line           a new paragraph; a single line break stays a line break
//   **bold**  *italic*     at the edges of words only, so 5*3*2 and snake*case stay as typed
//   `code`                 inline code (``with a ` inside`` takes a longer run of backticks)
//   ```                    a line of three backticks opens a code block, the next such line closes it
//   > text                 a quote; "> >" nests, up to 4 deep
//   https://...            a link, as written
//   [words](https://...)   a link with its own words
//   \* \` \_ \[ \] \( \) \> \\    the character itself, never markup
// Nothing else is markup: <tags>, &entities; and every other character are plain text.
//
// parse() never makes HTML. It returns plain data, a list of blocks:
//   { t: "p", c: inline[] }    { t: "pre", text }    { t: "quote", c: block[] }
// where each inline item is one of
//   "text" (a "\n" in it is a line break)    { t: "b", c: inline[] }    { t: "i", c: inline[] }
//   { t: "code", text }    { t: "a", href, text }
// The forum's pages build elements from that with createElement and textContent, never with
// innerHTML. toHtml() writes the same tree as HTML, for the tests and for anything else that
// needs HTML: every piece of text is escaped first, and only fixed tags go around it.
// A link's href is always http: or https:, in the form the WHATWG URL parser gives it (host in
// punycode; spaces, quotes and angle brackets percent-encoded), with no user name or password.
//
// The parser runs in time linear in the text (a post is at most a few tens of KiB): every
// scan ahead is either bounded or consumes what it scanned.

const ESCAPABLE = "\\`*_[]()>";
const MAX_QUOTE_DEPTH = 4;
const MAX_URL = 2048;
const MAX_LINK_TEXT = 300;
export const LINK_REL = "nofollow ugc noopener noreferrer";

// Never kept: C0 controls but tab and newline; DEL and the C1 controls; the bidi embedding,
// override and isolate controls (U+202A-U+202E, U+2066-U+2069), which make text display in an
// order other than the one it is stored in; and invisible characters with no use in a post
// (zero width space, word joiner and the invisible operators, the Hangul fillers, the byte
// order mark, the interlinear annotation controls).
const STRIP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u115f\u1160\u180e\u200b\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\ufff9-\ufffb]/g;
// More than 4 combining marks on one character (stacked "zalgo" text) keep the first 4.
const MARK_PILE = /(\p{M}{4})\p{M}+/gu;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;
const URL_STOP = /[\s<>"`]/u;

// A post body: well-formed UTF-16 (a lone surrogate becomes U+FFFD), "\n" line ends, the
// characters above removed, NFC, no blank lines before the text and no white space after it.
export function cleanText(value) {
  return String(value)
    .toWellFormed()
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(STRIP, "")
    .normalize("NFC")
    .replace(MARK_PILE, "$1")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

// A title, a category's name or a report's reason: cleanText, on one line, every run of white
// space one space.
export function cleanLine(value) {
  return cleanText(value).replace(/\s+/g, " ").trim();
}

// The href a link may have, or null: http or https only, nothing the URL parser refuses, no
// credentials, at most MAX_URL characters.
export function safeUrl(raw) {
  if (typeof raw !== "string" || raw.length > MAX_URL || !/^https?:\/\/[^\s]/i.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
  return u.href;
}

export function parse(text) {
  return blocks(String(text).split("\n"), 0);
}

const FENCE_OPEN = /^ {0,3}```[^`]*$/;
const FENCE_CLOSE = /^ {0,3}```\s*$/;
const QUOTE = /^ {0,3}>/;
const QUOTE_MARK = /^ {0,3}> ?/;
const BLANK = /^\s*$/;

function blocks(lines, depth) {
  const out = [];
  const quoting = depth < MAX_QUOTE_DEPTH;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK.test(line)) {
      i++;
      continue;
    }
    if (FENCE_OPEN.test(line)) {
      const code = [];
      for (i++; i < lines.length && !FENCE_CLOSE.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push({ t: "pre", text: code.join("\n") });
      continue;
    }
    if (quoting && QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(QUOTE_MARK, ""));
      const c = blocks(inner, depth + 1);
      if (c.length) out.push({ t: "quote", c });
      continue;
    }
    const para = [];
    for (; i < lines.length && !BLANK.test(lines[i]) && !FENCE_OPEN.test(lines[i]) && !(quoting && QUOTE.test(lines[i])); i++) {
      para.push(lines[i]);
    }
    out.push({ t: "p", c: inline(para.join("\n")) });
  }
  return out;
}

// Where each run of backticks starts, by its length, so a code span finds its closing run
// without scanning the rest of the paragraph again for every opening one.
function backtickRuns(s) {
  const byLength = new Map();
  for (let i = 0; i < s.length;) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let e = i;
    while (e < s.length && s[e] === "`") e++;
    let r = byLength.get(e - i);
    if (!r) byLength.set(e - i, (r = { at: [], k: 0 }));
    r.at.push(i);
    i = e;
  }
  return {
    // the first run of exactly this length starting at or after from (from only grows)
    next(length, from) {
      const r = byLength.get(length);
      if (!r) return -1;
      while (r.k < r.at.length && r.at[r.k] < from) r.k++;
      return r.k < r.at.length ? r.at[r.k] : -1;
    },
  };
}

// One paragraph's text: first the pieces that are never split (escapes, code spans, links)
// and the runs of stars, then the stars paired up into bold and italic.
function inline(s) {
  const n = s.length;
  const runs = backtickRuns(s);
  const nextStop = stopFinder(s);
  const toks = [];
  let text = "";
  const flush = () => {
    if (text) {
      toks.push({ k: "text", v: text });
      text = "";
    }
  };
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < n && ESCAPABLE.includes(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let e = i;
      while (e < n && s[e] === "`") e++;
      const close = runs.next(e - i, e);
      if (close < 0) {
        text += s.slice(i, e);
        i = e;
        continue;
      }
      let code = s.slice(e, close).replace(/\n/g, " ");
      if (code.length > 1 && code[0] === " " && code[code.length - 1] === " " && code.trim()) code = code.slice(1, -1);
      flush();
      toks.push({ k: "node", v: { t: "code", text: code } });
      i = close + (e - i);
      continue;
    }
    if (ch === "*") {
      let e = i;
      while (e < n && s[e] === "*") e++;
      if (e - i > 2) {
        text += s.slice(i, e);
        i = e;
        continue;
      }
      const prev = i > 0 ? s[i - 1] : "";
      const next = e < n ? s[e] : "";
      flush();
      toks.push({
        k: "delim",
        len: e - i,
        v: s.slice(i, e),
        open: next !== "" && !SPACE.test(next) && !(prev !== "" && WORD.test(prev)),
        close: prev !== "" && !SPACE.test(prev) && !(next !== "" && WORD.test(next)),
      });
      i = e;
      continue;
    }
    if (ch === "[") {
      const link = bracketLink(s, i, nextStop);
      if (link) {
        flush();
        toks.push({ k: "node", v: link.node });
        i = link.end;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && !(i > 0 && WORD.test(s[i - 1]))) {
      const link = autoLink(s, i, nextStop);
      if (link) {
        flush();
        toks.push({ k: "node", v: link.node });
        i = link.end;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return emphasis(toks);
}

// The position of the next character that ends an address (white space, < > " `) at or after
// k. The last answer is kept, and the link scans move forward, so a paragraph is searched
// about once in all.
function stopFinder(s) {
  const re = new RegExp(URL_STOP.source, "gu");
  let from = -1;
  let at = -1;
  return (k) => {
    if (k >= from && k <= at) return at;
    re.lastIndex = k;
    const m = re.exec(s);
    from = k;
    at = m ? m.index : s.length;
    return at;
  };
}

// [words](https://...): the words on one line, at most MAX_LINK_TEXT long; the address with no
// white space, its parentheses balanced.
function bracketLink(s, i, nextStop) {
  const labelEnd = Math.min(s.length, i + 1 + MAX_LINK_TEXT);
  let label = "";
  let j = i + 1;
  for (; j < labelEnd; j++) {
    const c = s[j];
    if (c === "\\" && j + 1 < s.length && ESCAPABLE.includes(s[j + 1])) {
      label += s[++j];
      continue;
    }
    if (c === "]" || c === "[" || c === "\n") break;
    label += c;
  }
  if (j >= labelEnd || s[j] !== "]" || s[j + 1] !== "(") return null;
  const start = j + 2;
  const end = Math.min(nextStop(start), start + MAX_URL);
  let depth = 0;
  for (let k = start; k < end; k++) {
    const c = s.charCodeAt(k);
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth > 0) {
        depth--;
        continue;
      }
      const raw = s.slice(start, k);
      const href = safeUrl(raw);
      if (!href) return null;
      const words = label.replace(/\s+/g, " ").trim();
      return { node: { t: "a", href, text: words || raw }, end: k + 1 };
    }
  }
  return null;
}

// A bare http:// or https:// address, up to white space; punctuation at its end and a closing
// bracket with no opening one inside it belong to the sentence, not to the address.
function autoLink(s, i, nextStop) {
  if (!/^https?:\/\//i.test(s.slice(i, i + 8))) return null;
  let e = nextStop(i);
  if (e - i > MAX_URL) return null;
  let open = 0;
  let close = 0;
  let openSq = 0;
  let closeSq = 0;
  for (let k = i; k < e; k++) {
    const c = s.charCodeAt(k);
    if (c === 40) open++;
    else if (c === 41) close++;
    else if (c === 91) openSq++;
    else if (c === 93) closeSq++;
  }
  while (e > i) {
    const c = s[e - 1];
    if (".,:;!?'\"*_".includes(c)) e--;
    else if (c === ")" && close > open) {
      e--;
      close--;
    } else if (c === "]" && closeSq > openSq) {
      e--;
      closeSq--;
    } else break;
  }
  const raw = s.slice(i, e);
  const href = safeUrl(raw);
  return href ? { node: { t: "a", href, text: raw }, end: e } : null;
}

// Pairs runs of stars: ** with ** is bold, * with * is italic. One of each may be open at a
// time, so emphasis nests at most two deep (bold in italic, or italic in bold); a star that
// opens or closes nothing stays a star.
function emphasis(toks) {
  const out = [];
  const open = [-1, -1, -1];
  for (const tok of toks) {
    if (tok.k !== "delim") {
      out.push(tok);
      continue;
    }
    const len = tok.len;
    if (tok.close && open[len] >= 0) {
      const at = open[len];
      const inner = out.splice(at);
      inner.shift();
      if (open[3 - len] > at) open[3 - len] = -1;
      open[len] = -1;
      out.push({ k: "node", v: { t: len === 2 ? "b" : "i", c: finish(inner) } });
      continue;
    }
    if (tok.open && open[len] < 0) {
      open[len] = out.length;
      out.push(tok);
      continue;
    }
    out.push({ k: "text", v: tok.v });
  }
  return finish(out);
}

function finish(items) {
  const nodes = [];
  for (const it of items) {
    if (it.k === "node") nodes.push(it.v);
    else if (typeof nodes[nodes.length - 1] === "string") nodes[nodes.length - 1] += it.v;
    else nodes.push(it.v);
  }
  return nodes;
}

const ENTITY = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ENTITY[c]);
}

// The tree as HTML. Only the fixed tags below are ever written; every text and attribute value
// goes through escapeHtml before anything is added to it, and an href is checked again.
export function toHtml(list) {
  let html = "";
  for (const b of list || []) {
    if (!b || typeof b !== "object") continue;
    if (b.t === "p") html += "<p>" + inlineHtml(b.c) + "</p>";
    else if (b.t === "pre") html += "<pre><code>" + escapeHtml(b.text) + "</code></pre>";
    else if (b.t === "quote") html += "<blockquote>" + toHtml(b.c) + "</blockquote>";
  }
  return html;
}

function inlineHtml(nodes) {
  let html = "";
  for (const n of nodes || []) {
    if (typeof n === "string") html += escapeHtml(n).replace(/\n/g, "<br>");
    else if (!n || typeof n !== "object") continue;
    else if (n.t === "b") html += "<strong>" + inlineHtml(n.c) + "</strong>";
    else if (n.t === "i") html += "<em>" + inlineHtml(n.c) + "</em>";
    else if (n.t === "code") html += "<code>" + escapeHtml(n.text) + "</code>";
    else if (n.t === "a") {
      const href = safeUrl(n.href);
      html += href ? "<a href=\"" + escapeHtml(href) + "\" rel=\"" + LINK_REL + "\">" + escapeHtml(n.text) + "</a>" : escapeHtml(n.text);
    }
  }
  return html;
}

// A post's text straight to HTML: cleanText, parse, toHtml.
export function render(text) {
  return toHtml(parse(cleanText(text)));
}
