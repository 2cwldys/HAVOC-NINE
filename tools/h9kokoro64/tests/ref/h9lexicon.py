"""Word-level pronunciation logic of misaki's English Lexicon, ported to run on the compact H9LX file.

This is the part of misaki/en.py (Apache-2.0, hexgrad) that turns ONE word into phonemes given a part-of-speech tag and
the context of the next word; the logic is the same, the data comes from h9lexfile.H9Lex instead of two JSON dicts, and
numbers are named by num_en instead of num2words. It is written with plain string operations on purpose, so that the C++
version is a line-by-line translation (strings of symbols become arrays of vocabulary ids).

Differences from misaki, all deliberate:
  * 'and' is never spoken inside numbers (misaki drops it unless a markup flag is set; the game never sets one).
  * numbers of 15 digits or more are read digit by digit (num2words would read them or fail).
  * the lexicon returns the symbol string without a rating; callers that want a rating use Port.last_src.
"""
import json
import re

import h9lexfile as hx
import num_en

import os  # noqa: E402

VOCAB = json.load(open(os.environ["H9_KOKORO_VOCAB_JSON"], encoding="utf-8"))["vocab"]  # Kokoro-82M-v1.0 config.json
ID2SYM = {v: k for k, v in VOCAB.items()}

STRESSES = "\u02cc\u02c8"
PRIMARY_STRESS = STRESSES[1]
SECONDARY_STRESS = STRESSES[0]
VOWELS = frozenset("AIOQWYaiu\u00e6\u0251\u0252\u0254\u0259\u025b\u025c\u026a\u028a\u028c\u1d7b")
CONSONANTS = frozenset("bdfhjklmnpstvwz\u00f0\u014b\u0261\u0279\u027e\u0283\u0292\u02a4\u02a7\u03b8")
US_TAUS = frozenset("AIOWYiu\u00e6\u0251\u0259\u025b\u026a\u0279\u028a\u028c")
DIPHTHONGS = frozenset("AIOQWY\u02a4\u02a7")
LEXICON_ORDS = frozenset([39, 45, *range(65, 91), *range(97, 123)])
SYMBOLS = {"%": "percent", "&": "and", "+": "plus", "@": "at"}
ADD_SYMBOLS = {".": "dot", "/": "slash"}
CURRENCIES = {"$": ("dollar", "cent"), "\u00a3": ("pound", "pence"), "\u20ac": ("euro", "cent")}
ORDINALS = frozenset(["st", "nd", "rd", "th"])
NON_QUOTE_PUNCTS = frozenset(";:,.!?\u2014\u2026")


def stress_weight(ps):
    return sum(2 if c in DIPHTHONGS else 1 for c in ps) if ps else 0


def apply_stress(ps, stress):
    def restress(ps):
        ips = list(enumerate(ps))
        stresses = {i: next(j for j, v in ips[i:] if v in VOWELS) for i, p in ips if p in STRESSES}
        for i, j in stresses.items():
            _, s = ips[i]
            ips[i] = (j - 0.5, s)
        return "".join([p for _, p in sorted(ips)])

    if stress is None:
        return ps
    elif stress < -1:
        return ps.replace(PRIMARY_STRESS, "").replace(SECONDARY_STRESS, "")
    elif stress == -1 or (stress in (0, -0.5) and PRIMARY_STRESS in ps):
        return ps.replace(SECONDARY_STRESS, "").replace(PRIMARY_STRESS, SECONDARY_STRESS)
    elif stress in (0, 0.5, 1) and all(s not in ps for s in STRESSES):
        if all(v not in ps for v in VOWELS):
            return ps
        return restress(SECONDARY_STRESS + ps)
    elif stress >= 1 and PRIMARY_STRESS not in ps and SECONDARY_STRESS in ps:
        return ps.replace(SECONDARY_STRESS, PRIMARY_STRESS)
    elif stress > 1 and all(s not in ps for s in STRESSES):
        if all(v not in ps for v in VOWELS):
            return ps
        return restress(PRIMARY_STRESS + ps)
    return ps


def is_digit(text):
    return bool(re.match(r"^[0-9]+$", text))


class Ctx:
    __slots__ = ("future_vowel", "future_to")

    def __init__(self, future_vowel=None, future_to=False):
        self.future_vowel = future_vowel
        self.future_to = future_to


def _sym(b):
    return "".join(ID2SYM[i] for i in b)


def _val(v):
    """H9Lex value (bytes | dict | None) -> str | dict | None"""
    if v is None:
        return None
    if isinstance(v, dict):
        return {t: (None if s is None else _sym(s)) for t, s in v.items()}
    return _sym(v)


class Port:
    def __init__(self, lex, british=False):
        self.lex = lex
        self.british = british
        self.cap_stresses = (0.5, 2)
        self._gcache = {}
        self._scache = {}
        self.last_src = None

    # ---- dictionary access (the grown gold and silver dictionaries) ----
    def golds(self, w):
        if w not in self._gcache:
            self._gcache[w] = _val(self.lex.gold_get(w))
        return self._gcache[w]

    def silvers(self, w):
        if w not in self._scache:
            self._scache[w] = _val(self.lex.silver_get(w))
        return self._scache[w]

    def in_golds(self, w):
        return self.golds(w) is not None

    def in_silvers(self, w):
        return self.silvers(w) is not None

    # ---- misaki Lexicon ----
    def get_NNP(self, word):
        ps = [self.golds(c.upper()) for c in word if c.isalpha()]
        if None in ps:
            return None, None
        ps = apply_stress("".join(ps), 0)
        ps = ps.rsplit(SECONDARY_STRESS, 1)
        return PRIMARY_STRESS.join(ps), 3

    def get_special_case(self, word, tag, stress, ctx):
        if tag == "ADD" and word in ADD_SYMBOLS:
            return self.lookup(ADD_SYMBOLS[word], None, -0.5, ctx)
        elif word in SYMBOLS:
            return self.lookup(SYMBOLS[word], None, None, ctx)
        elif "." in word.strip(".") and word.replace(".", "").isalpha() and len(max(word.split("."), key=len)) < 3:
            return self.get_NNP(word)
        elif word in ("a", "A"):
            return "\u0250" if tag == "DT" else "\u02c8A", 4
        elif word in ("am", "Am", "AM"):
            if tag.startswith("NN"):
                return self.get_NNP(word)
            elif ctx.future_vowel is None or word != "am" or stress and stress > 0:
                return self.golds("am"), 4
            return "\u0250m", 4
        elif word in ("an", "An", "AN"):
            if word == "AN" and tag.startswith("NN"):
                return self.get_NNP(word)
            return "\u0250n", 4
        elif word == "I" and tag == "PRP":
            return "%sI" % SECONDARY_STRESS, 4
        elif word in ("by", "By", "BY") and self.get_parent_tag(tag) == "ADV":
            return "b\u02c8I", 4
        elif word in ("to", "To") or (word == "TO" and tag in ("TO", "IN")):
            return {None: self.golds("to"), False: "t\u0259", True: "t\u028a"}[ctx.future_vowel], 4
        elif word in ("in", "In") or (word == "IN" and tag != "NNP"):
            stress = PRIMARY_STRESS if ctx.future_vowel is None or tag != "IN" else ""
            return stress + "\u026an", 4
        elif word in ("the", "The") or (word == "THE" and tag == "DT"):
            return "\u00f0i" if ctx.future_vowel == True else "\u00f0\u0259", 4  # noqa: E712
        elif tag == "IN" and re.match(r"(?i)vs\.?$", word):
            return self.lookup("versus", None, None, ctx)
        elif word in ("used", "Used", "USED"):
            if tag in ("VBD", "JJ") and ctx.future_to:
                return self.golds("used")["VBD"], 4
            return self.golds("used")["DEFAULT"], 4
        return None, None

    @staticmethod
    def get_parent_tag(tag):
        if tag is None:
            return tag
        elif tag.startswith("VB"):
            return "VERB"
        elif tag.startswith("NN"):
            return "NOUN"
        elif tag.startswith("ADV") or tag.startswith("RB"):
            return "ADV"
        elif tag.startswith("ADJ") or tag.startswith("JJ"):
            return "ADJ"
        return tag

    def is_known(self, word, tag):
        if self.in_golds(word) or word in SYMBOLS or self.in_silvers(word):
            return True
        elif not word.isalpha() or not all(ord(c) in LEXICON_ORDS for c in word):
            return False
        elif len(word) == 1:
            return True
        elif word == word.upper() and self.in_golds(word.lower()):
            return True
        return word[1:] == word[1:].upper()

    def lookup(self, word, tag, stress, ctx):
        is_NNP = None
        if word == word.upper() and not self.in_golds(word):
            word = word.lower()
            is_NNP = tag == "NNP"
        ps, rating = self.golds(word), 4
        if ps is None and not is_NNP:
            ps, rating = self.silvers(word), 3
        if isinstance(ps, dict):
            if ctx and ctx.future_vowel is None and "None" in ps:
                tag = "None"
            elif tag not in ps:
                tag = self.get_parent_tag(tag)
            ps = ps.get(tag, ps["DEFAULT"])
        if ps is None or (is_NNP and PRIMARY_STRESS not in ps):
            ps, rating = self.get_NNP(word)
            if ps is not None:
                return ps, rating
        return apply_stress(ps, stress), rating

    def _s(self, stem):
        if not stem:
            return None
        elif stem[-1] in "ptkf\u03b8":
            return stem + "s"
        elif stem[-1] in "sz\u0283\u0292\u02a7\u02a4":
            return stem + ("\u026a" if self.british else "\u1d7b") + "z"
        return stem + "z"

    def stem_s(self, word, tag, stress, ctx):
        if len(word) < 3 or not word.endswith("s"):
            return None, None
        if not word.endswith("ss") and self.is_known(word[:-1], tag):
            stem = word[:-1]
        elif (word.endswith("'s") or (len(word) > 4 and word.endswith("es") and not word.endswith("ies"))) and self.is_known(word[:-2], tag):
            stem = word[:-2]
        elif len(word) > 4 and word.endswith("ies") and self.is_known(word[:-3] + "y", tag):
            stem = word[:-3] + "y"
        else:
            return None, None
        stem, rating = self.lookup(stem, tag, stress, ctx)
        return self._s(stem), rating

    def _ed(self, stem):
        if not stem:
            return None
        elif stem[-1] in "pkf\u03b8\u0283s\u02a7":
            return stem + "t"
        elif stem[-1] == "d":
            return stem + ("\u026a" if self.british else "\u1d7b") + "d"
        elif stem[-1] != "t":
            return stem + "d"
        elif self.british or len(stem) < 2:
            return stem + "\u026ad"
        elif stem[-2] in US_TAUS:
            return stem[:-1] + "\u027e\u1d7bd"
        return stem + "\u1d7bd"

    def stem_ed(self, word, tag, stress, ctx):
        if len(word) < 4 or not word.endswith("d"):
            return None, None
        if not word.endswith("dd") and self.is_known(word[:-1], tag):
            stem = word[:-1]
        elif len(word) > 4 and word.endswith("ed") and not word.endswith("eed") and self.is_known(word[:-2], tag):
            stem = word[:-2]
        else:
            return None, None
        stem, rating = self.lookup(stem, tag, stress, ctx)
        return self._ed(stem), rating

    def _ing(self, stem):
        if not stem:
            return None
        elif self.british:
            if stem[-1] in "\u0259\u02d0":
                return None
        elif len(stem) > 1 and stem[-1] == "t" and stem[-2] in US_TAUS:
            return stem[:-1] + "\u027e\u026a\u014b"
        return stem + "\u026a\u014b"

    def stem_ing(self, word, tag, stress, ctx):
        if len(word) < 5 or not word.endswith("ing"):
            return None, None
        if len(word) > 5 and self.is_known(word[:-3], tag):
            stem = word[:-3]
        elif self.is_known(word[:-3] + "e", tag):
            stem = word[:-3] + "e"
        elif len(word) > 5 and re.search(r"([bcdgklmnprstvxz])\1ing$|cking$", word) and self.is_known(word[:-4], tag):
            stem = word[:-4]
        else:
            return None, None
        stem, rating = self.lookup(stem, tag, stress, ctx)
        return self._ing(stem), rating

    def get_word(self, word, tag, stress, ctx):
        ps, rating = self.get_special_case(word, tag, stress, ctx)
        if ps is not None:
            return ps, rating
        wl = word.lower()
        if len(word) > 1 and word.replace("'", "").isalpha() and word != word.lower() and (
            tag != "NNP" or len(word) > 7
        ) and not self.in_golds(word) and not self.in_silvers(word) and (
            word == word.upper() or word[1:] == word[1:].lower()
        ) and (
            self.in_golds(wl) or self.in_silvers(wl) or any(
                fn(wl, tag, stress, ctx)[0] for fn in (self.stem_s, self.stem_ed, self.stem_ing)
            )
        ):
            word = wl
        if self.is_known(word, tag):
            return self.lookup(word, tag, stress, ctx)
        elif word.endswith("s'") and self.is_known(word[:-2] + "'s", tag):
            return self.lookup(word[:-2] + "'s", tag, stress, ctx)
        elif word.endswith("'") and self.is_known(word[:-1], tag):
            return self.lookup(word[:-1], tag, stress, ctx)
        _s, rating = self.stem_s(word, tag, stress, ctx)
        if _s is not None:
            return _s, rating
        _ed, rating = self.stem_ed(word, tag, stress, ctx)
        if _ed is not None:
            return _ed, rating
        _ing, rating = self.stem_ing(word, tag, 0.5 if stress is None else stress, ctx)
        if _ing is not None:
            return _ing, rating
        return None, None

    @staticmethod
    def is_currency(word):
        if "." not in word:
            return True
        elif word.count(".") > 1:
            return False
        cents = word.split(".")[1]
        return len(cents) < 3 or set(cents) == {0}

    # ---- numbers ----
    def _words_of(self, n, mode):
        """number -> list of words; mode 'c' cardinal 'o' ordinal 'y' year"""
        if n >= num_en.MAX_CARDINAL:
            return num_en.digit_words(str(n))
        if mode == "o":
            return num_en.ordinal(n)
        if mode == "y":
            return num_en.year(n)
        return num_en.cardinal(n)

    def get_number(self, word, currency, is_head, num_flags=""):
        suffix = re.search(r"[a-z']+$", word)
        suffix = suffix.group() if suffix else None
        word = word[:-len(suffix)] if suffix else word
        result = []
        if word.startswith("-"):
            result.append(self.lookup("minus", None, None, None))
            word = word[1:]

        def add_words(ws):
            for w in ws:
                result.append(self.lookup(w, None, -2 if w == "point" else None, None))

        def extend_num(num, first=True, mode="c"):
            add_words(self._words_of(int(num), mode))

        if is_digit(word) and suffix in ORDINALS:
            extend_num(word, mode="o")
        elif not result and len(word) == 4 and currency not in CURRENCIES and is_digit(word):
            extend_num(word, mode="y")
        elif not is_head and "." not in word:
            num = word.replace(",", "")
            if num[0] == "0" or len(num) > 3:
                for n in num:
                    extend_num(n, first=False)
            elif len(num) == 3 and not num.endswith("00"):
                extend_num(num[0])
                if num[1] == "0":
                    result.append(self.lookup("O", None, -2, None))
                    extend_num(num[2], first=False)
                else:
                    extend_num(num[1:], first=False)
            else:
                extend_num(num)
        elif word.count(".") > 1 or not is_head:
            first = True
            for num in word.replace(",", "").split("."):
                if not num:
                    pass
                elif num[0] == "0" or (len(num) != 2 and any(n != "0" for n in num[1:])):
                    for n in num:
                        extend_num(n, first=False)
                else:
                    extend_num(num, first=first)
                first = False
        elif currency in CURRENCIES and self.is_currency(word):
            pairs = [(int(num) if num else 0, unit) for num, unit in zip(word.replace(",", "").split("."), CURRENCIES[currency])]
            if len(pairs) > 1:
                if pairs[1][0] == 0:
                    pairs = pairs[:1]
                elif pairs[0][0] == 0:
                    pairs = pairs[1:]
            for i, (num, unit) in enumerate(pairs):
                if i > 0:
                    result.append(self.lookup("and", None, None, None))
                extend_num(num, first=i == 0)
                result.append(self.stem_s(unit + "s", None, None, None) if abs(num) != 1 and unit != "pence" else self.lookup(unit, None, None, None))
        else:
            if is_digit(word):
                add_words(self._words_of(int(word), "c"))
            elif "." not in word:
                add_words(self._words_of(int(word.replace(",", "")), "o" if suffix in ORDINALS else "c"))
            else:
                word = word.replace(",", "")
                if word[0] == ".":
                    add_words(["point"] + num_en.digit_words(word[1:]))
                else:
                    ip, fp = word.split(".", 1)
                    add_words(num_en.decimal_words(ip, fp) if len(ip) + len(fp) <= 15 else num_en.digit_words(ip) + ["point"] + num_en.digit_words(fp))
        if not result:
            return None, None
        result, rating = " ".join(p for p, _ in result), min(r for _, r in result)
        if suffix in ("s", "'s"):
            return self._s(result), rating
        elif suffix in ("ed", "'d"):
            return self._ed(result), rating
        elif suffix == "ing":
            return self._ing(result), rating
        return result, rating

    def append_currency(self, ps, currency):
        if not currency:
            return ps
        currency = CURRENCIES.get(currency)
        currency = self.stem_s(currency[0] + "s", None, None, None)[0] if currency else None
        return "%s %s" % (ps, currency) if currency else ps

    @staticmethod
    def is_number(word, is_head):
        if all(not is_digit(c) for c in word):
            return False
        suffixes = ("ing", "'d", "ed", "'s", *ORDINALS, "s")
        for s in suffixes:
            if word.endswith(s):
                word = word[:-len(s)]
                break
        return all(is_digit(c) or c in ",." or (is_head and i == 0 and c == "-") for i, c in enumerate(word))

    def call(self, text, tag, ctx, stress_override=None, currency=None, is_head=True, num_flags=""):
        """misaki Lexicon.__call__ for a token of ASCII text (curly quotes and NFKC already done by the caller)."""
        word = text
        stress = None if word == word.lower() else self.cap_stresses[int(word == word.upper())]
        ps, rating = self.get_word(word, tag, stress, ctx)
        if ps is not None:
            return apply_stress(self.append_currency(ps, currency), stress_override), rating
        elif self.is_number(word, is_head):
            ps, rating = self.get_number(word, currency, is_head, num_flags)
            return apply_stress(ps, stress_override), rating
        elif not all(ord(c) in LEXICON_ORDS for c in word):
            return None, None
        return None, None
