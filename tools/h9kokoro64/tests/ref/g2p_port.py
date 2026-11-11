"""Reference implementation of the helper's English G2P: text (UTF-8, at most 160 bytes) -> Kokoro phoneme string -> token ids.

The C++ in tools/h9kokoro64/src (g2p_text.h, g2p_core.h) is written from this, function by function, and checked against it by g2p_parity.py. It follows misaki 0.9.4 (Apache-2.0, hexgrad):
fold_text (ASCII), chunk/peel/tokenize (what spaCy's tokenizer and tagger give misaki, reduced to rules), retokenize, the reverse
group loop, resolve_tokens, merge_tokens, the final flap/glottal rewrite and KPipeline's 510-symbol chunking. The word level logic is
h9lexicon.Port (differentially tested against misaki.Lexicon), the number words are num_en (tested against num2words).
Differences from misaki, all deliberate: no spaCy (rule tokenizer and a tiny POS guess for the words the lexicon makes
tag-dependent), no espeak (the out-of-dictionary chain in oov_chain.py), a sub-token that cannot be resolved goes to the out-of-dictionary
chain alone instead of the whole group going to espeak.
"""
import sys

import os  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import g2p_scan as sc  # noqa: E402
import h9lexfile as hx  # noqa: E402
import h9lexicon as hl  # noqa: E402

EMDASH = chr(0x2014)
ELLIPSIS = chr(0x2026)
LQ = chr(0x201C)
RQ = chr(0x201D)
FLAP = chr(0x27E)
GLOTTAL = chr(0x294)
PUNCTS = frozenset(";:,.!?" + EMDASH + ELLIPSIS + '"' + LQ + RQ)
NON_QUOTE = hl.NON_QUOTE_PUNCTS
JUNK = frozenset("',-._/")
CURRENCY_SYMBOLS = frozenset("$" + chr(0xA3) + chr(0x20AC))

# characters peeled from the front / back of a whitespace-separated piece (spaCy's prefix and suffix rules, reduced)
PREFIX_PEEL = frozenset('([{"<*~|#')
SUFFIX_PEEL = frozenset(')]}>",;:!?*~|')
INNER_SPLIT = frozenset(',;!?()[]{}"<>|~*#')
DROPPED_PUNCT = frozenset("[]{}<>*#~|^\\")

DETERMINERS = frozenset("the a an this that these those my your his her its our their some any no each every another both all which".split())
VERB_CUES = frozenset("to can could will would should must may might shall do does did dont doesnt didnt wont cant cannot lets let please i you we they he she it who just then and".split())
ADJ_BEFORE_NOUN = frozenset("good bad new old big small next last first other same own".split())
CLAUSE_STARTERS = frozenset("i you he she it we they was is were are will would can could has had have did does do the a an all just not then there here my your his her our their".split())
SAY_VERBS = frozenset("said say says think thinks thought know knows knew hope believe means mean decided decreed guess bet heard".split())


class Tok:
    __slots__ = ("text", "tag", "ws", "ps", "rating", "head", "alias", "stress", "currency", "prespace")

    def __init__(self, text, tag="NN", ws="", ps=None, rating=None):
        self.text = text
        self.tag = tag
        self.ws = ws
        self.ps = ps
        self.rating = rating
        self.head = True
        self.alias = None
        self.stress = None
        self.currency = None
        self.prespace = False

    def copy(self):
        t = Tok(self.text, self.tag, self.ws, self.ps, self.rating)
        t.head, t.alias, t.stress, t.currency, t.prespace = self.head, self.alias, self.stress, self.currency, self.prespace
        return t


def merge_tokens(toks, unk=None):
    stress = {t.stress for t in toks if t.stress is not None}
    currency = {t.currency for t in toks if t.currency is not None}
    rating = {t.rating for t in toks}
    ps = None
    if unk is not None:
        ps = ""
        for t in toks:
            if t.prespace and ps and not ps[-1].isspace() and t.ps:
                ps += " "
            ps += unk if t.ps is None else t.ps
    best = max(toks, key=lambda t: sum(1 if c == c.lower() else 2 for c in t.text))
    m = Tok("".join(t.text + t.ws for t in toks[:-1]) + toks[-1].text, best.tag, toks[-1].ws, ps, None if None in rating else min(rating))
    m.head = toks[0].head
    m.stress = list(stress)[0] if len(stress) == 1 else None
    m.currency = max(currency) if currency else None
    m.prespace = toks[0].prespace
    return m


def _is_number_like(core):
    return any(c.isdigit() for c in core) and all(c.isdigit() or c in ",.-+" for c in core.rstrip("stndrhS'"))


class G2P:
    def __init__(self, lex_bytes, oov=None):
        """lex_bytes: contents of an .h9lex file; oov: callable(text) -> phoneme string or None (see oov_chain.py)."""
        self.lex = hx.H9Lex(lex_bytes)
        self.port = hl.Port(self.lex, british=False)
        self.oov = oov

    # ---------------------------------------------------------------- lexicon helpers
    def known(self, word):
        return self.port.in_golds(word) or self.port.in_silvers(word)

    # ---------------------------------------------------------------- 1. text -> tokens
    def tokenize(self, text):
        """Whitespace pieces -> peeled punctuation tokens and core words; returns a list of Tok with ws set."""
        s = sc.fold_text(text).strip()
        self._q_open = False
        pieces = s.split()
        toks = []
        for pi, piece in enumerate(pieces):
            last_piece = pi == len(pieces) - 1
            ws = "" if last_piece else " "
            prefix, suffix, core = [], [], piece
            # prefix punctuation
            while core and len(core) > 0:
                ch = core[0]
                if ch in CURRENCY_SYMBOLS and len(core) > 1:
                    prefix.append(Tok(ch, "$", ""))
                    core = core[1:]
                elif ch in PREFIX_PEEL:
                    opening = True
                    if len(core) == 1 and ch == '"':
                        opening = self._quote_state(True)
                    prefix.append(self._punct_token(ch, opening=opening))
                    core = core[1:]
                elif ch == "'" and len(core) > 1 and not self.known(core) and core.lower() not in EXC_APOS:
                    prefix.append(self._punct_token("'", opening=True))
                    core = core[1:]
                elif core.startswith("..") and len(core) > 2 and core.lstrip(".") != "":
                    run = len(core) - len(core.lstrip("."))
                    prefix.append(Tok(core[:run], "NFP", "", core[:run], 4))
                    core = core[run:]
                else:
                    break
            # suffix punctuation (a run of periods is an ellipsis token)
            while core:
                ch = core[-1]
                if ch == "." and len(core) > 1:
                    if core in KEEP_DOT or _is_abbrev(core):
                        break
                    run = len(core) - len(core.rstrip("."))
                    if run >= 2 and run < len(core):
                        suffix.append(Tok(core[-run:], "NFP", "", core[-run:], 4))
                        core = core[:-run]
                    else:
                        suffix.append(self._punct_token(".", opening=False))
                        core = core[:-1]
                elif ch in SUFFIX_PEEL and len(core) > 1:
                    suffix.append(self._punct_token(ch, opening=False))
                    core = core[:-1]
                elif ch == "'" and len(core) > 2 and core[-2] != "s" and core[-2] != "S" and not self.known(core) and self.known(core[:-1]):
                    suffix.append(self._punct_token("'", opening=False))
                    core = core[:-1]
                else:
                    break
            suffix.reverse()
            # a piece made only of punctuation / a lone dash
            out = list(prefix)
            if core:
                if _is_emoticon(core):
                    pass
                elif core == "-":
                    out.append(Tok("-", ":", "", EMDASH, 3))
                elif core in ("...", "..", "....") or (set(core) == {"."}):
                    out.append(Tok(core, "NFP", "", core, 4))
                elif all(c in PUNCT_ONLY for c in core) and len(core) <= 3 and core not in ("&", "+", "=", "@", "%", "/"):
                    for c in core:
                        out.append(self._punct_token(c, opening=not out))
                else:
                    ct = self._core_tokens(core)
                    if _looks_like_url(core):
                        for t in ct:
                            if t.ps is None:
                                t.tag = "ADD"
                    out.extend(ct)
            out.extend(suffix)
            if out:
                out[-1].ws = ws
            toks.extend(out)
        if toks:
            toks[-1].ws = ""
        return toks

    def _quote_state(self, lone):
        if lone:
            self._q_open = not self._q_open
            return self._q_open
        return None

    def _punct_token(self, ch, opening):
        if ch == '"' or ch == "'":
            return Tok(ch, "``" if opening else "''", "", LQ if opening else RQ, 4)
        if ch in ".,!?:;":
            return Tok(ch, ch if ch in ".," else ".", "", ch, 4)
        if ch == "(":
            return Tok(ch, "-LRB-", "", "(", 4)
        if ch == ")":
            return Tok(ch, "-RRB-", "", ")", 4)
        return Tok(ch, "NFP", "", "", 4)

    def _core_tokens(self, core):
        """Core word of a piece: split at inner punctuation; every segment becomes a Tok with a tag guess (set later)."""
        segs = []
        cur = ""
        for ci, ch in enumerate(core):
            if ch == "," and 0 < ci < len(core) - 1 and core[ci - 1].isdigit() and core[ci + 1].isdigit():
                cur += ch
            elif ch in INNER_SPLIT:
                if cur:
                    segs.append(("w", cur))
                    cur = ""
                segs.append(("p", ch))
            else:
                cur += ch
        if cur:
            segs.append(("w", cur))
        out = []
        for kind, v in segs:
            if kind == "p":
                out.append(self._punct_token(v, opening=not out))
            else:
                t = Tok(v, "NN")
                if v in SYMBOL_ALIAS:
                    t.alias = SYMBOL_ALIAS[v]
                out.append(t)
        return out

    # ---------------------------------------------------------------- 2. tags (the few that matter)
    def tag_tokens(self, toks):
        """A few-rule stand-in for spaCy's tagger. Only what the lexicon looks at: PRP for I, DT for a / that, TO, IN for the
        prepositions it special-cases, CD, NNP for Capitalized words inside a sentence, and for words with part-of-speech
        dependent entries NN after a determiner, VB at the start of a clause or after a verb cue, else the neutral tag XX."""
        words = [i for i, t in enumerate(toks) if t.ps is None]
        for k, i in enumerate(words):
            t = toks[i]
            prev = toks[words[k - 1]].text.lower() if k > 0 else ""
            nxt = toks[words[k + 1]].text.lower() if k + 1 < len(words) else ""
            lw = t.text.lower()
            if lw.endswith(".") and len(lw) > 2 and lw[:-1] == "vs":
                lw = "vs"
            adj_prev_punct = i > 0 and toks[i - 1].ps is not None and toks[i - 1].ps in (".", "!", "?", ",", ":", ";")
            adj_next_punct = i + 1 < len(toks) and toks[i + 1].ps is not None and toks[i + 1].ps in (".", "!", "?", ",", ":", ";", "...")
            clause_start = k == 0 or adj_prev_punct
            if t.tag in ("ADD", "$"):
                continue
            if _is_number_like(t.text):
                t.tag = "CD"
            elif t.text == "I":
                t.tag = "PRP"
            elif lw == "a":
                t.tag = "DT"
            elif lw in ("that", "that's", "thats"):
                end_next = adj_next_punct or k + 1 == len(words)
                if lw != "that":
                    t.tag = "DT"
                elif prev == "roger":
                    t.tag = "IN"
                elif k == 0 or end_next:
                    t.tag = "DT"
                elif nxt in CLAUSE_STARTERS or prev in SAY_VERBS:
                    t.tag = "IN"
                else:
                    t.tag = "DT"
            elif lw in ("in", "on", "at", "of", "for", "with", "from", "by", "than", "vs", "about", "into", "over", "under", "after", "before"):
                t.tag = "IN"
            elif lw == "to":
                t.tag = "TO"
            elif lw == "am":
                t.tag = "NN" if (prev and _is_number_like(prev)) else "VBP"
            elif lw == "used":
                t.tag = "VBD"
            elif lw in DETERMINERS:
                t.tag = "DT"
            elif t.text[:1].isupper() and len(t.text) > 1 and t.text[1:] == t.text[1:].lower() and not clause_start:
                t.tag = "NNP"
            else:
                pos = self.port.golds(lw)
                if isinstance(pos, dict):
                    if lw == "read" and prev in ("i", "you", "we", "they"):
                        t.tag = "VBD"
                    elif prev in DETERMINERS or prev in ADJ_BEFORE_NOUN:
                        t.tag = "NN"
                    elif prev in VERB_CUES or clause_start:
                        t.tag = "VB"
                    else:
                        t.tag = "XX"
                elif lw.endswith("ly"):
                    t.tag = "RB"
                else:
                    t.tag = "XX"
        return toks

    # ---------------------------------------------------------------- 3. retokenize (misaki G2P.retokenize)
    def retokenize(self, toks):
        words = []
        currency = None
        for i, token in enumerate(toks):
            if token.alias is None and token.ps is None:
                subs = []
                parts = sc.subtokenize(token.text)
                for p in parts:
                    n = Tok(p, token.tag, "")
                    n.stress = token.stress
                    subs.append(n)
                if not subs:
                    continue
            else:
                subs = [token]
            subs[-1].ws = token.ws
            for j, tk in enumerate(subs):
                if tk.alias is not None or tk.ps is not None:
                    pass
                elif tk.tag == "$" and tk.text in CURRENCY_SYMBOLS:
                    currency = tk.text
                    tk.ps = ""
                    tk.rating = 4
                elif currency is not None:
                    if tk.tag != "CD":
                        currency = None
                    elif j + 1 == len(subs) and (i + 1 == len(toks) or toks[i + 1].tag != "CD"):
                        tk.currency = currency
                elif 0 < j < len(subs) - 1 and tk.text == "2" and (subs[j - 1].text[-1] + subs[j + 1].text[0]).isalpha():
                    tk.alias = "to"
                if tk.alias is not None or tk.ps is not None:
                    words.append(tk)
                elif words and isinstance(words[-1], list) and not words[-1][-1].ws:
                    tk.head = False
                    words[-1].append(tk)
                else:
                    words.append(tk if tk.ws else [tk])
        return [w[0] if isinstance(w, list) and len(w) == 1 else w for w in words]

    @staticmethod
    def token_context(ctx, ps, token):
        vowel = ctx.future_vowel
        if ps:
            for c in ps:
                if c in hl.VOWELS or c in hl.CONSONANTS or c in NON_QUOTE:
                    vowel = None if c in NON_QUOTE else (c in hl.VOWELS)
                    break
        future_to = token.text in ("to", "To") or (token.text == "TO" and token.tag in ("TO", "IN"))
        return hl.Ctx(vowel, future_to)

    @staticmethod
    def resolve_tokens(tokens):
        text = "".join(t.text + t.ws for t in tokens[:-1]) + tokens[-1].text
        kinds = set()
        for c in text:
            if c in JUNK:
                continue
            kinds.add(0 if c.isalpha() else (1 if c.isdigit() else 2))
        prespace = " " in text or "/" in text or len(kinds) > 1
        for i, tk in enumerate(tokens):
            if tk.ps is None:
                if i == len(tokens) - 1 and tk.text in NON_QUOTE:
                    tk.ps = tk.text
                    tk.rating = 3
                elif all(c in JUNK for c in tk.text):
                    tk.ps = ""
                    tk.rating = 3
            elif i > 0:
                tk.prespace = prespace
        if prespace:
            return
        indices = [(hl.PRIMARY_STRESS in tk.ps, hl.stress_weight(tk.ps), i) for i, tk in enumerate(tokens) if tk.ps]
        if len(indices) == 2 and len(tokens[indices[0][2]].text) == 1:
            i = indices[1][2]
            tokens[i].ps = hl.apply_stress(tokens[i].ps, -0.5)
            return
        elif len(indices) < 2 or sum(b for b, _, _ in indices) <= (len(indices) + 1) // 2:
            return
        indices = sorted(indices)[: len(indices) // 2]
        for _, _, i in indices:
            tokens[i].ps = hl.apply_stress(tokens[i].ps, -0.5)

    # ---------------------------------------------------------------- 4. the reverse loop
    def lexicon(self, tk, ctx):
        word = tk.text if tk.alias is None else tk.alias
        return self.port.call(word, tk.tag, ctx, tk.stress, tk.currency, tk.head, "")

    def phonemize(self, text, trace=None):
        toks = self.tag_tokens(self.tokenize(text))
        words = self.retokenize(toks)
        ctx = hl.Ctx()
        for i in range(len(words) - 1, -1, -1):
            w = words[i]
            if not isinstance(w, list):
                if w.ps is None:
                    w.ps, w.rating = self.lexicon(w, ctx)
                if w.ps is None:
                    w.ps = self._fallback(w.text, trace)
                    w.rating = 2
                ctx = self.token_context(ctx, w.ps, w)
                continue
            left, right = 0, len(w)
            while left < right:
                if any(t.alias is not None or t.ps is not None for t in w[left:right]):
                    tk = None
                else:
                    tk = merge_tokens(w[left:right])
                ps, rating = (None, None) if tk is None else self.lexicon(tk, ctx)
                if ps is not None:
                    w[left].ps = ps
                    w[left].rating = rating
                    for x in w[left + 1:right]:
                        x.ps = ""
                        x.rating = rating
                    ctx = self.token_context(ctx, ps, tk)
                    right = left
                    left = 0
                elif left + 1 < right:
                    left += 1
                else:
                    right -= 1
                    tk = w[right]
                    if tk.ps is None:
                        if all(c in JUNK for c in tk.text):
                            tk.ps = ""
                            tk.rating = 3
                        elif len(tk.text) == 1 and tk.text in NON_QUOTE:
                            tk.ps = tk.text
                            tk.rating = 3
                        else:
                            tk.ps = self._fallback(tk.text, trace)
                            tk.rating = 2
                            ctx = self.token_context(ctx, tk.ps, tk)
                    left = 0
            self.resolve_tokens(w)
        flat = [merge_tokens(w, unk="") if isinstance(w, list) else w for w in words]
        for t in flat:
            if t.ps:
                t.ps = t.ps.replace(FLAP, "T").replace(GLOTTAL, "t")
        return "".join(("" if t.ps is None else t.ps) + t.ws for t in flat)

    def _fallback(self, text, trace):
        if self.oov is None:
            return ""
        ps = self.oov(text)
        if trace is not None:
            trace.append((text, ps))
        return ps or ""


EXC_APOS = frozenset(["'bout", "'cause", "'em", "'cos", "'coz", "'cuz", "'til", "'till", "'n'"])
KEEP_DOT = frozenset(["Mr.", "Mrs.", "Ms.", "Dr.", "vs.", "Vs."])
URL_ENDINGS = (".com", ".org", ".net", ".gg", ".io", ".tv", ".us", ".uk", ".de", ".fr", ".co", ".me", ".info", ".edu", ".gov")
SYMBOL_ALIAS = {"=": "equals", "/": "slash", "<3": "heart"}
PUNCT_ONLY = frozenset(".,;:!?-_'\"()[]{}<>*#~|^\\/=+&%@$")


def _is_emoticon(core):
    if len(core) < 2 or len(core) > 3:
        return False
    if core[0] in ":;=8" and core[-1] in ")(DPpOo/|*3\\" and (len(core) == 2 or core[1] in "-^o'"):
        return True
    return core in ("<3", "xD", "XD", "^^", "^_^", "-_-", "o_O", "O_o", "T_T", ">:(", ":'(")


def _looks_like_url(core):
    lc_ = core.lower()
    return "@" in core or lc_.startswith("http") or lc_.startswith("www.") or any(lc_.endswith(e) or (e + "/") in lc_ for e in URL_ENDINGS)


def _is_abbrev(core):
    """U.S.A. / e.g. / a.m. : letters separated by single periods."""
    if len(core) < 3 or core[-1] != ".":
        return False
    body = core[:-1]
    parts = body.split(".")
    return len(parts) >= 2 and all(len(p) == 1 and p.isalpha() for p in parts)


# ---------------------------------------------------------------- KPipeline.en_tokenize (510 symbol chunks) and ids
def chunk_text(ps):
    """The reference splits long token lists at punctuation; for the port a phoneme string is cut at the last '!.?...' then ':;'
    then ',-' before 510 symbols (same waterfall), else at the last space, else hard."""
    if len(ps) <= 510:
        return [ps]
    out = []
    while len(ps) > 510:
        cut = -1
        for group in ("!.?" + ELLIPSIS, ":;", "," + EMDASH):
            k = max(ps.rfind(c, 0, 510) for c in group)
            if k >= 0:
                cut = k + 1
                break
        if cut < 0:
            cut = ps.rfind(" ", 0, 510) + 1 or 510
        out.append(ps[:cut].strip())
        ps = ps[cut:].strip()
    if ps:
        out.append(ps)
    return out


def to_ids(ps, vocab):
    return [0] + [vocab[c] for c in ps if c in vocab] + [0]
