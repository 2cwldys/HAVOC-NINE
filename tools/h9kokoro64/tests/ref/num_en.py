"""English number words, written from scratch (the standard way numbers are named), no 'and', no commas.

cardinal(n) -> list of words, for 0 <= n < 10**15 ; ordinal(n) ; year(n) for 0 <= n <= 9999 ; decimal_digits(str)
The words are the ones misaki looks up in its lexicon after num2words has named a number, with the word 'and' removed
(misaki drops 'and' unless a markup flag asks for it, which the game never sets).
"""

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
SCALES = ["", "thousand", "million", "billion", "trillion"]
MAX_CARDINAL = 10 ** 15  # exclusive; larger numbers are read digit by digit by the caller

ORD_IRREGULAR = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
                 "nine": "ninth", "twelve": "twelfth"}


def _below1000(n):
    out = []
    h, r = divmod(n, 100)
    if h:
        out += [ONES[h], "hundred"]
    if r:
        if r < 20:
            out.append(ONES[r])
        else:
            out.append(TENS[r // 10])
            if r % 10:
                out.append(ONES[r % 10])
    return out


def cardinal(n):
    """0 <= n < 10**15. Returns a list of lower-case words."""
    if n == 0:
        return ["zero"]
    groups = []
    while n:
        n, g = divmod(n, 1000)
        groups.append(g)
    out = []
    for i in range(len(groups) - 1, -1, -1):
        if groups[i]:
            out += _below1000(groups[i])
            if SCALES[i]:
                out.append(SCALES[i])
    return out


def ordinal_word(w):
    if w in ORD_IRREGULAR:
        return ORD_IRREGULAR[w]
    if w.endswith("y"):
        return w[:-1] + "ieth"
    return w + "th"


def ordinal(n):
    ws = cardinal(n)
    ws[-1] = ordinal_word(ws[-1])
    return ws


def year(n):
    """0 <= n <= 9999, the way years are read: 1999 nineteen ninety nine, 1905 nineteen oh five, 2000 two thousand."""
    high, low = divmod(n, 100)
    if high == 0 or (high % 10 == 0 and low < 10) or high >= 100:
        return cardinal(n)
    out = cardinal(high)
    if low == 0:
        out.append("hundred")
    elif low < 10:
        out += ["oh", ONES[low]]
    else:
        out += cardinal(low)
    return out


def decimal_words(int_part, frac_digits):
    """'3', '14' -> three point one four.  Trailing zeros of the fraction are dropped; an all-zero fraction is not read
    at all (5.0 is 'five', as for a float that holds a whole number)."""
    f = frac_digits.rstrip("0")
    if not f:
        return cardinal(int(int_part))
    return cardinal(int(int_part)) + ["point"] + [ONES[int(c)] for c in f]


def digit_words(s):
    return [ONES[int(c)] for c in s]
