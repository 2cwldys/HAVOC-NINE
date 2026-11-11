"""Hand-written text scanners for the G2P port (no regex library): ASCII folding and misaki's subtokenize().

subtokenize(s) is a transcription of the alternation (in this order, leftmost match, first alternative that matches wins)
    1  ^[']+                                  leading apostrophes (only at index 0)
    2  \\p{Lu}(?=\\p{Lu}\\p{Ll})               an upper-case letter followed by Upper+lower
    3  (?:^-)?(?:\\d?[,.]?\\d)+                 a number; a leading '-' only at index 0
    4  [-_]+
    5  [']{2,}
    6  \\p{L}*?(?:[']\\p{L})*?\\p{Ll}(?=\\p{Lu})   camelCase cut
    7  \\p{L}+(?:[']\\p{L})*                   a word with inner apostrophes
    8  [^-_\\p{L}'\\d]                         any other single character
    9  [']+$                                  trailing apostrophes
over ASCII text (the apostrophe set is ' only: misaki lists ' and the two typographic apostrophes, which fold_text folds to '). Characters that match
no alternative (an apostrophe in the middle that is not between letters) are skipped, as regex.findall skips them.
test_scan.py compares it with misaki's regex version.
"""

APOS = "'"
SEPS = ",."


def is_upper(c):
    return "A" <= c <= "Z"


def is_lower(c):
    return "a" <= c <= "z"


def is_letter(c):
    return is_upper(c) or is_lower(c)


def is_digit(c):
    return "0" <= c <= "9"


# Latin-1 / Latin Extended-A letters folded to ASCII; typographic punctuation folded; everything else is dropped.
_FOLD = {}


def _add(chars, to):
    for c in chars:
        _FOLD[c] = to


_add("\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u0100\u0102\u0104", "A")
_add("\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u0101\u0103\u0105", "a")
_add("\u00c7\u0106\u0108\u010a\u010c", "C")
_add("\u00e7\u0107\u0109\u010b\u010d", "c")
_add("\u010e\u0110\u00d0", "D")
_add("\u010f\u0111\u00f0", "d")
_add("\u00c8\u00c9\u00ca\u00cb\u0112\u0114\u0116\u0118\u011a", "E")
_add("\u00e8\u00e9\u00ea\u00eb\u0113\u0115\u0117\u0119\u011b", "e")
_add("\u011c\u011e\u0120\u0122", "G")
_add("\u011d\u011f\u0121\u0123", "g")
_add("\u00cc\u00cd\u00ce\u00cf\u0128\u012a\u012c\u012e\u0130", "I")
_add("\u00ec\u00ed\u00ee\u00ef\u0129\u012b\u012d\u012f\u0131", "i")
_add("\u0141", "L")
_add("\u0142", "l")
_add("\u00d1\u0143\u0145\u0147", "N")
_add("\u00f1\u0144\u0146\u0148", "n")
_add("\u00d2\u00d3\u00d4\u00d5\u00d6\u00d8\u014c\u014e\u0150", "O")
_add("\u00f2\u00f3\u00f4\u00f5\u00f6\u00f8\u014d\u014f\u0151", "o")
_add("\u0154\u0156\u0158", "R")
_add("\u0155\u0157\u0159", "r")
_add("\u015a\u015c\u015e\u0160", "S")
_add("\u015b\u015d\u015f\u0161", "s")
_add("\u0162\u0164", "T")
_add("\u0163\u0165", "t")
_add("\u00d9\u00da\u00db\u00dc\u0168\u016a\u016c\u016e\u0170\u0172", "U")
_add("\u00f9\u00fa\u00fb\u00fc\u0169\u016b\u016d\u016f\u0171\u0173", "u")
_add("\u00dd\u0176\u0178", "Y")
_add("\u00fd\u00ff\u0177", "y")
_add("\u0179\u017b\u017d", "Z")
_add("\u017a\u017c\u017e", "z")
_add("\u00df", "ss")
_add("\u00c6", "AE")
_add("\u00e6", "ae")
_add("\u0152", "OE")
_add("\u0153", "oe")
_add("\u2018\u2019\u201b\u02bc\u00b4", "'")
_add("\u201c\u201d\u201e\u00ab\u00bb", '"')
_add("\u2013\u2014\u2212", "-")
_add("\u2026", "...")
_add("\u00a0\u2002\u2003\u2009\u200a\u202f\u3000", " ")
_add("\u00a3", "\u00a3")
_add("\u20ac", "\u20ac")
for _i in range(0xFF01, 0xFF5F):
    _FOLD[chr(_i)] = chr(_i - 0xFEE0)
_add("\u00b2", "2")
_add("\u00b3", "3")
_add("\u00b9", "1")
_add("\u00bd", "1/2")
_add("\u00bc", "1/4")
_add("\u00be", "3/4")
_add("\u00d7", "x")
_add("\u00b0", "")


def fold_text(text):
    """UTF-8 text -> ASCII (plus the pound and euro signs, which the number rules know). Control characters become spaces."""
    out = []
    for ch in text:
        o = ord(ch)
        if o < 128:
            if o < 32 or o == 127:
                out.append(" ")
            else:
                out.append(ch)
        else:
            m = _FOLD.get(ch)
            if m is not None:
                out.append(m)
    return "".join(out)


def _unit_at(s, k, n):
    """Length (1 or 2 or 3) of one (\\d?[,.]?\\d) unit starting at k, 0 if none."""
    if k < n and is_digit(s[k]):
        if k + 2 < n and s[k + 1] in SEPS and is_digit(s[k + 2]):
            return 3
        if k + 1 < n and is_digit(s[k + 1]):
            return 2
        return 1
    if k + 1 < n and s[k] in SEPS and is_digit(s[k + 1]):
        return 2
    return 0


def _alt6_end(s, i, n):
    """End index of alternative 6 (camelCase cut) starting at i, or -1."""
    for e in range(i + 1, n):
        # s[i:e] must be  letters* ('+letter)* and its last char a lower-case letter, s[e] an upper-case letter
        if not (is_lower(s[e - 1]) and is_upper(s[e])):
            continue
        body = s[i:e - 1]
        k = 0
        m = len(body)
        while k < m and is_letter(body[k]):
            k += 1
        while k < m:
            if body[k] in APOS and k + 1 < m and is_letter(body[k + 1]):
                k += 2
            else:
                break
        if k == m:
            return e
    return -1


def subtokenize(s):
    out = []
    n = len(s)
    i = 0
    while i < n:
        c = s[i]
        # 1
        if i == 0 and c in APOS:
            j = i
            while j < n and s[j] in APOS:
                j += 1
            out.append(s[i:j])
            i = j
            continue
        # 2
        if is_upper(c) and i + 2 < n and is_upper(s[i + 1]) and is_lower(s[i + 2]):
            out.append(c)
            i += 1
            continue
        # 3
        j = i
        if i == 0 and c == "-" and _unit_at(s, 1, n) > 0:
            j = 1
        u = _unit_at(s, j, n)
        if u > 0:
            while u > 0:
                j += u
                u = _unit_at(s, j, n)
            out.append(s[i:j])
            i = j
            continue
        # 4
        if c in "-_":
            j = i
            while j < n and s[j] in "-_":
                j += 1
            out.append(s[i:j])
            i = j
            continue
        # 5
        if c in APOS and i + 1 < n and s[i + 1] in APOS:
            j = i
            while j < n and s[j] in APOS:
                j += 1
            out.append(s[i:j])
            i = j
            continue
        # 6 (may start with an apostrophe that is followed by a letter)
        if is_letter(c) or (c in APOS and i + 1 < n and is_letter(s[i + 1])):
            e = _alt6_end(s, i, n)
            if e > 0:
                out.append(s[i:e])
                i = e
                continue
        # 7
        if is_letter(c):
            j = i
            while j < n and is_letter(s[j]):
                j += 1
            while j + 1 < n and s[j] in APOS and is_letter(s[j + 1]):
                j += 2
            out.append(s[i:j])
            i = j
            continue
        # 8
        if c not in "-_'" and not is_letter(c) and not is_digit(c):
            out.append(c)
            i += 1
            continue
        # 9
        if c in APOS:
            j = i
            while j < n and s[j] in APOS:
                j += 1
            if j == n:
                out.append(s[i:j])
                i = j
                continue
        i += 1  # matches nothing: skipped
    return out
