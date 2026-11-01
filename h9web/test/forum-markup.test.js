import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, toHtml, render, cleanText, cleanLine, safeUrl, escapeHtml } from "../modules/forum/markup.js";

const ch = (...codes) => String.fromCodePoint(...codes);
const REL = "nofollow ugc noopener noreferrer";

// Every tag in the HTML is one of the renderer's own, every link is http(s) with the fixed rel,
// and the text between tags has nothing that could start markup or end an attribute.
function assertSafeHtml(html, label = html) {
  const tags = html.match(/<[^>]*>/g) || [];
  for (const tag of tags) {
    const ok = /^<\/?(p|strong|em|code|pre|blockquote)>$/.test(tag) || tag === "<br>" || tag === "</a>"
      || new RegExp("^<a href=\"https?://[^\"<>\\s]*\" rel=\"" + REL + "\">$").test(tag);
    assert.ok(ok, "unexpected tag " + tag + " in " + label);
  }
  const text = html.replace(/<[^>]*>/g, "");
  assert.ok(!/[<>"]/.test(text), "raw < > or quote in the text of " + label);
  assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(text), "a bare & in " + label);
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    assert.match(m[1], /^https?:\/\//, "href " + m[1]);
    assert.ok(!/javascript:|data:|vbscript:/i.test(m[1]), "href " + m[1]);
  }
}

test("markup: paragraphs, line breaks, bold, italic, code", () => {
  assert.equal(render("a\nb\n\n\n\nc"), "<p>a<br>b</p><p>c</p>");
  assert.equal(render("**b** *i* `c`"), "<p><strong>b</strong> <em>i</em> <code>c</code></p>");
  assert.equal(render("**bold *in* it** and *it **in** it*"), "<p><strong>bold <em>in</em> it</strong> and <em>it <strong>in</strong> it</em></p>");
  assert.equal(render("5*3*2 and snake*case*here and a * b * c"), "<p>5*3*2 and snake*case*here and a * b * c</p>", "stars inside words or between spaces stay");
  assert.equal(render("**not closed and *not either"), "<p>**not closed and *not either</p>");
  assert.equal(render("***three***"), "<p>***three***</p>");
  assert.equal(render("``a ` b`` and `open"), "<p><code>a ` b</code> and `open</p>");
  assert.equal(render("\\*plain\\* \\`plain\\` \\[x](https://a.org) a\\\\b"), "<p>*plain* `plain` [x](<a href=\"https://a.org/\" rel=\"" + REL + "\">https://a.org</a>) a\\b</p>");
  assert.equal(render("`**not bold** <b>`"), "<p><code>**not bold** &lt;b&gt;</code></p>");
});

test("markup: code blocks keep their text, quotes nest to a limit", () => {
  assert.equal(render("```js\n<b>x</b>\n  **y**\n```\nafter"), "<pre><code>&lt;b&gt;x&lt;/b&gt;\n  **y**</code></pre><p>after</p>");
  assert.equal(render("```\nnever closed\n> not a quote"), "<pre><code>never closed\n&gt; not a quote</code></pre>");
  assert.equal(render("> a\n> > b\n>\n> c\nd"), "<blockquote><p>a</p><blockquote><p>b</p></blockquote><p>c</p></blockquote><p>d</p>");
  assert.equal(render("> ```\n> code in a quote\n> ```"), "<blockquote><pre><code>code in a quote</code></pre></blockquote>");
  const deep = render("> > > > > > deep");
  assert.equal((deep.match(/<blockquote>/g) || []).length, 4);
  assert.match(deep, /&gt; &gt; deep/);
  const huge = render("> ".repeat(5000) + "x");
  assert.equal((huge.match(/<blockquote>/g) || []).length, 4, "no deep recursion");
});

test("markup: links, as written and with words", () => {
  assert.equal(render("see https://example.com/a_(b). and (https://x.org/y) end"),
    "<p>see <a href=\"https://example.com/a_(b)\" rel=\"" + REL + "\">https://example.com/a_(b)</a>. and (<a href=\"https://x.org/y\" rel=\"" + REL + "\">https://x.org/y</a>) end</p>");
  assert.equal(render("[the site](https://havoc9.org/forum/)"), "<p><a href=\"https://havoc9.org/forum/\" rel=\"" + REL + "\">the site</a></p>");
  assert.equal(render("[](http://a.org)"), "<p><a href=\"http://a.org/\" rel=\"" + REL + "\">http://a.org</a></p>");
  assert.equal(render("xhttps://a.org"), "<p>xhttps://a.org</p>", "an address must start a word");
  assert.equal(render("https://user:pw@evil.example/"), "<p>https://user:pw@evil.example/</p>", "no credentials in a link");
  assert.equal(safeUrl("https://a.org/x y"), "https://a.org/x%20y");
  assert.equal(safeUrl("ftp://a.org/"), null);
  assert.equal(safeUrl("https://" + "a".repeat(3000)), null);
  const tree = parse("https://a.org/x");
  assert.deepEqual(tree, [{ t: "p", c: [{ t: "a", href: "https://a.org/x", text: "https://a.org/x" }] }]);
});

test("XSS: tags, events and scripts are text", () => {
  for (const input of [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg onload=alert(1)>",
    "<iframe src=\"javascript:alert(1)\"></iframe>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "</p><script>alert(1)</script><p>",
    "&lt;script&gt; &#60;script&#62; &amp;",
    "<!-- comment --> <![CDATA[x]]> <style>*{}</style>",
    "**<b onmouseover=alert(1)>bold</b>**",
    "`<script>`\n```\n</code></pre><script>alert(1)</script>\n```",
    "> <script>alert(1)</script>",
  ]) {
    const html = render(input);
    assertSafeHtml(html, input);
    assert.ok(!/<(script|img|svg|iframe|style|!--)/i.test(html), "no such tag survives: " + input);
  }
  assert.equal(render("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(render("&lt;b&gt;"), "<p>&amp;lt;b&amp;gt;</p>", "entities are text too, never decoded");
});

test("XSS: javascript:, data: and other schemes never become links", () => {
  for (const input of [
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](java\tscript:alert(1))",
    "[x]( javascript:alert(1))",
    "[x](javascript&colon;alert(1))",
    "[x](jav&#x09;ascript:alert(1))",
    "[x](%6Aavascript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox(1))",
    "[x](//evil.example/)",
    "[x](/relative/path)",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "[x](https:alert(1))",
  ]) {
    const html = render(input);
    assertSafeHtml(html, input);
    assert.ok(!html.includes("href"), input + " -> " + html);
  }
  // a hand-made tree with a bad href is checked again on the way out
  assert.equal(toHtml([{ t: "p", c: [{ t: "a", href: "javascript:alert(1)", text: "x" }] }]), "<p>x</p>");
  assert.equal(toHtml([{ t: "p", c: [{ t: "script", text: "x" }, { t: "a", href: "https://a.org/\"><b>", text: "y" }] }]),
    "<p><a href=\"https://a.org/%22%3E%3Cb%3E\" rel=\"" + REL + "\">y</a></p>");
});

test("XSS: attribute breakouts in links", () => {
  for (const input of [
    "[x](https://a.org/\"onmouseover=\"alert(1))",
    "[x](https://a.org/\" onmouseover=\"alert(1))",
    "https://a.org/\"onmouseover=alert(1)//",
    "https://a.org/'onmouseover='alert(1)'",
    "[a\"><script>alert(1)</script>](https://a.org/)",
    "[x](https://a.org/<script>)",
    "https://a.org/`x`",
    "[x](https://a.org/?q=\"><svg/onload=alert(1)>)",
  ]) {
    assertSafeHtml(render(input), input);
  }
  assert.equal(render("[a\"><b>](https://a.org/)"), "<p><a href=\"https://a.org/\" rel=\"" + REL + "\">a&quot;&gt;&lt;b&gt;</a></p>");
  assert.match(render("https://a.org/'x'y"), /href="https:\/\/a\.org\/&#39;x&#39;y"/);
});

test("XSS: unicode tricks", () => {
  const fullwidth = ch(0xff1c) + "script" + ch(0xff1e) + "alert(1)" + ch(0xff1c) + "/script" + ch(0xff1e);
  const out = render(fullwidth);
  assertSafeHtml(out, "fullwidth");
  assert.ok(out.includes(ch(0xff1c)), "fullwidth brackets stay fullwidth (no compatibility folding)");
  const rlo = "abc" + ch(0x202e) + "txt.exe" + ch(0x2066) + ch(0x2069);
  assert.equal(cleanText(rlo), "abctxt.exe", "bidi overrides and isolates are removed");
  assert.equal(cleanText("a" + ch(0) + "b" + ch(0x7f) + "c" + ch(0x85) + "d" + ch(0x200b) + "e" + ch(0xfeff) + "f"), "abcdef");
  assert.equal(cleanText("x" + ch(0x3164) + ch(0x115f) + ch(0xffa0) + "y"), "xy", "invisible fillers go");
  assert.equal(cleanText("a\r\nb\rc" + ch(0x2028) + "d"), "a\nb\nc\nd");
  assert.equal(cleanText("bad " + String.fromCharCode(0xd800) + " surrogate"), "bad " + ch(0xfffd) + " surrogate");
  assert.equal(cleanText("x" + ch(0x301, 0x302, 0x303, 0x304, 0x305, 0x306, 0x307)), "x" + ch(0x301, 0x302, 0x303, 0x304), "at most 4 combining marks");
  assert.equal(cleanText("e" + ch(0x301)), ch(0xe9), "NFC");
  for (const input of [
    "[x](java" + ch(0x200b) + "script:alert(1))",
    ch(0xff4a, 0xff41, 0xff56, 0xff41) + "script:alert(1)",
    "[x](" + ch(0xff48) + "ttps://a.org)",
    "[x](https://a.org/" + ch(0x202e) + "gpj.exe)",
  ]) {
    assertSafeHtml(render(input), JSON.stringify(input));
  }
  const homograph = render("https://" + ch(0x430) + "pple.com/");
  assert.match(homograph, /href="https:\/\/xn--pple-43d\.com\/"/, "a look-alike host is punycode in the href");
  assert.equal(render("https://exa" + ch(0x200b) + "mple.com"), "<p><a href=\"https://example.com/\" rel=\"" + REL + "\">https://example.com</a></p>", "the zero width space is gone before parsing");
  assert.equal(cleanLine("  a \n\t b " + ch(0x3000) + " c "), "a b c");
  assert.equal(cleanLine(ch(0x202e, 0x200b, 0xfeff)), "", "a title of invisible characters is empty");
  assert.equal(escapeHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
});

test("markup: hostile input stays fast and flat", () => {
  const inputs = [
    "*a".repeat(5000), "[".repeat(10000), "`".repeat(10000), "[a](".repeat(2500), "http://".repeat(1400),
    "*a ".repeat(3300), "` ``".repeat(2500), "**".repeat(5000), "(".repeat(5000) + "https://a.org" + ")".repeat(5000),
    "*a **b *c **d ".repeat(700), "> ```\n".repeat(1600), "\\".repeat(10000), "[x](https://a.org/" + "(".repeat(4000) + ")",
  ];
  for (const input of inputs) {
    const start = process.hrtime.bigint();
    const html = render(input);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 250, input.slice(0, 12) + " took " + ms.toFixed(1) + " ms");
    assertSafeHtml(html, input.slice(0, 12));
    const depth = Math.max(0, ...[...html.matchAll(/(<(strong|em)>)+/g)].map((m) => (m[0].match(/</g) || []).length));
    assert.ok(depth <= 2, "emphasis nests at most two deep");
  }
});
