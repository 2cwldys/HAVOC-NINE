"""H9LX: the compact lexicon file (reader and writer), written the way the C++ reader will work.

Contents: the misaki gold and silver lexicons of one accent, keyed by the LOWER-CASE word, with the case variants that
misaki's grow_dictionary() makes (lower, Capitalized, UPPER) folded into one entry, plus a small table for keys whose case
is none of these ("Afro-American", "'Merica"). Values are strings of Kokoro vocabulary ids, one byte per symbol.

Layout (little endian)
  0   char[4] "H9LX"
  4   u16 version (1)          6  u16 accent (0 US, 1 GB)
  8   u32 nKeys                12 u32 blockSize (keys per block)
  16  u32 nBlocks              20 u32 offBlockIndex   (u32[nBlocks]: file offset of the first byte of each block)
  24  u32 nMixed               28 u32 offMixed
  32  u32 fileSize             36 u32 crc32 of bytes [40, fileSize)
  40  data
Block = blockSize entries (the last block fewer), each
  u8 shared, u8 slen, u8 suffix[slen]   key = previous key[:shared] + suffix   (the first entry of a block has shared 0)
  u8 flags
  values in this order, each present when its flag bit is set:
      GL (gold, key as typed in lower case), GC (gold, Capitalized, own value), GU (gold, UPPER, own value), SL (silver)
  flags: bit0 GL present   bit1 GC present and equal to GL   bit2 GC own value   bit3 GU own value   bit4 SL present
         bit5 GL is a POS record   bit6 GC own value is a POS record   bit7 GU own value is a POS record
  value = u8 len, u8 symbols[len]                      (plain)
        = u8 nTags, then nTags x (u8 tagId, u8 len or 0xFF for null, symbols)     (POS record; the first tag is DEFAULT)
  The Capitalized form of a silver word has the silver value (grow_dictionary does that); there is no silver UPPER.
Mixed table = nMixed x (u8 klen, key bytes, u8 isPOS, value) in sorted key order, exact-case match only.
"""
import struct
import zlib

MAGIC = b"H9LX"
POS_TAGS = ["DEFAULT", "NOUN", "VERB", "ADJ", "None", "VBD", "ADV", "VBN", "VBP", "DT"]
POS_ID = {t: i for i, t in enumerate(POS_TAGS)}
NULL_LEN = 0xFF
F_GL, F_GC_SAME, F_GC_OWN, F_GU_OWN, F_SL, F_GL_POS, F_GC_POS, F_GU_POS = 1, 2, 4, 8, 16, 32, 64, 128


def _enc_value(v, to_id):
    """v: str, or dict tag -> str|None. Returns (bytes, is_pos)."""
    if isinstance(v, str):
        b = bytes(to_id[c] for c in v)
        assert len(b) < NULL_LEN
        return bytes([len(b)]) + b, False
    out = bytearray([len(v)])
    items = sorted(v.items(), key=lambda kv: POS_ID[kv[0]])
    assert items[0][0] == "DEFAULT"
    for tag, s in items:
        out.append(POS_ID[tag])
        if s is None:
            out.append(NULL_LEN)
        else:
            b = bytes(to_id[c] for c in s)
            assert len(b) < NULL_LEN
            out.append(len(b))
            out += b
    return bytes(out), True


def grow(d):
    """misaki Lexicon.grow_dictionary, verbatim semantics."""
    e = {}
    for k, v in d.items():
        if len(k) < 2:
            continue
        if k == k.lower():
            if k != k.capitalize():
                e[k.capitalize()] = v
        elif k == k.lower().capitalize():
            e[k.lower()] = v
    return {**e, **d}


def build(gold, silver, to_id, accent, block_size=16):
    """gold, silver: raw misaki dicts. Returns the file bytes."""
    gg, sg = grow(gold), grow(silver)
    lks = sorted({k.lower() for k in gg} | {k.lower() for k in sg}, key=lambda s: s.encode("ascii"))
    mixed = {}
    entries = []
    covered = set()
    for lk in lks:
        cap, up = lk.capitalize(), lk.upper()
        forms = [lk]
        if cap not in forms:
            forms.append(cap)
        if up not in forms:
            forms.append(up)
        flags = 0
        blobs = []
        gl = gg.get(lk)
        gc = gg.get(cap) if cap != lk else None
        gu = gg.get(up) if (up != lk and up != cap) else None
        for f in forms:
            covered.add(f)
        if gl is not None:
            b, pos = _enc_value(gl, to_id)
            flags |= F_GL | (F_GL_POS if pos else 0)
            blobs.append(b)
        if gc is not None:
            if gl is not None and gc == gl:
                flags |= F_GC_SAME
            else:
                b, pos = _enc_value(gc, to_id)
                flags |= F_GC_OWN | (F_GC_POS if pos else 0)
                blobs.append(b)
        if gu is not None:
            b, pos = _enc_value(gu, to_id)
            flags |= F_GU_OWN | (F_GU_POS if pos else 0)
            blobs.append(b)
        sl = sg.get(lk)
        if sl is not None:
            b, _ = _enc_value(sl, to_id)
            flags |= F_SL
            blobs.append(b)
            sc = sg.get(cap) if cap != lk else sl
            assert sc == sl, (lk, sl, sc)
        elif cap != lk:
            assert sg.get(cap) is None
        if flags == 0:
            continue
        entries.append((lk, flags, b"".join(blobs)))
    # raw/grown keys that are not one of the three forms of their lower-case key
    for src in (gg, sg):
        for k, v in src.items():
            lk = k.lower()
            if k not in (lk, lk.capitalize(), lk.upper()):
                mixed.setdefault(k, {})["g" if src is gg else "s"] = v
    # silver mixed: none expected
    assert all("s" not in m for m in mixed.values()), "silver has a mixed-case key"
    # data
    data = bytearray()
    block_offsets = []
    prev = b""
    for i, (lk, flags, blob) in enumerate(entries):
        kb = lk.encode("ascii")
        if i % block_size == 0:
            block_offsets.append(len(data))
            prev = b""
        shared = 0
        while shared < len(prev) and shared < len(kb) and prev[shared] == kb[shared] and shared < 255:
            shared += 1
        data.append(shared)
        data.append(len(kb) - shared)
        data += kb[shared:]
        data.append(flags)
        data += blob
        prev = kb
    mixed_bytes = bytearray()
    for k in sorted(mixed, key=lambda s: s.encode("ascii")):
        kb = k.encode("ascii")
        b, pos = _enc_value(mixed[k]["g"], to_id)
        mixed_bytes.append(len(kb))
        mixed_bytes += kb
        mixed_bytes.append(1 if pos else 0)
        mixed_bytes += b
    header_size = 40
    off_index = header_size + len(data)
    index = b"".join(struct.pack("<I", header_size + o) for o in block_offsets)
    off_mixed = off_index + len(index)
    total = off_mixed + len(mixed_bytes)
    body = bytes(data) + index + bytes(mixed_bytes)
    head = struct.pack("<4sHHIIIIIIII", MAGIC, 1, accent, len(entries), block_size, len(block_offsets), off_index, len(mixed), off_mixed, total, zlib.crc32(body) & 0xFFFFFFFF)
    assert len(head) == header_size
    return head + body, {"entries": len(entries), "blocks": len(block_offsets), "mixed": len(mixed), "data": len(data), "index": len(index), "mixed_bytes": len(mixed_bytes), "total": total}


class H9Lex:
    """Reader. Works on a bytes object exactly like the C++ one works on a memory block (no dicts, no caches)."""

    def __init__(self, blob):
        self.b = blob
        magic, ver, acc, n, bs, nb, oi, nm, om, tot, crc = struct.unpack_from("<4sHHIIIIIIII", blob, 0)
        assert magic == MAGIC and ver == 1 and tot == len(blob)
        assert zlib.crc32(blob[40:]) & 0xFFFFFFFF == crc
        self.accent, self.n, self.bs, self.nb, self.oi, self.nm, self.om = acc, n, bs, nb, oi, nm, om

    # -- value decoding --
    def _read_value(self, p, pos):
        b = self.b
        if not pos:
            ln = b[p]
            return bytes(b[p + 1:p + 1 + ln]), p + 1 + ln
        nt = b[p]
        p += 1
        out = {}
        for _ in range(nt):
            tid = b[p]
            ln = b[p + 1]
            p += 2
            if ln == NULL_LEN:
                out[POS_TAGS[tid]] = None
            else:
                out[POS_TAGS[tid]] = bytes(b[p:p + ln])
                p += ln
        return out, p

    def _skip_value(self, p, pos):
        b = self.b
        if not pos:
            return p + 1 + b[p]
        nt = b[p]
        p += 1
        for _ in range(nt):
            ln = b[p + 1]
            p += 2
            if ln != NULL_LEN:
                p += ln
        return p

    def _block_first_key(self, bi):
        p = struct.unpack_from("<I", self.b, self.oi + 4 * bi)[0]
        slen = self.b[p + 1]
        return bytes(self.b[p + 2:p + 2 + slen])

    def _find(self, lk):
        """lk: bytes (lower-case). Returns (flags, p_values) or None."""
        b = self.b
        lo, hi = 0, self.nb - 1
        while lo < hi:  # last block whose first key <= lk
            mid = (lo + hi + 1) // 2
            if self._block_first_key(mid) <= lk:
                lo = mid
            else:
                hi = mid - 1
        bi = lo
        p = struct.unpack_from("<I", b, self.oi + 4 * bi)[0]
        end_count = min(self.bs, self.n - bi * self.bs)
        key = b""
        for _ in range(end_count):
            shared = b[p]
            slen = b[p + 1]
            key = key[:shared] + bytes(b[p + 2:p + 2 + slen])
            p += 2 + slen
            flags = b[p]
            p += 1
            if key == lk:
                return flags, p
            if key > lk:
                return None
            # skip the values of this entry
            if flags & F_GL:
                p = self._skip_value(p, bool(flags & F_GL_POS))
            if flags & F_GC_OWN:
                p = self._skip_value(p, bool(flags & F_GC_POS))
            if flags & F_GU_OWN:
                p = self._skip_value(p, bool(flags & F_GU_POS))
            if flags & F_SL:
                p = self._skip_value(p, False)
        return None

    def _entry(self, lk):
        r = self._find(lk)
        if r is None:
            return None
        flags, p = r
        e = {"flags": flags}
        if flags & F_GL:
            e["GL"], p = self._read_value(p, bool(flags & F_GL_POS))
        if flags & F_GC_OWN:
            e["GC"], p = self._read_value(p, bool(flags & F_GC_POS))
        if flags & F_GU_OWN:
            e["GU"], p = self._read_value(p, bool(flags & F_GU_POS))
        if flags & F_SL:
            e["SL"], p = self._read_value(p, False)
        return e

    def _mixed(self, key):
        b = self.b
        p = self.om
        for _ in range(self.nm):
            kl = b[p]
            k = bytes(b[p + 1:p + 1 + kl])
            p += 1 + kl
            pos = b[p]
            p += 1
            if k == key:
                v, _ = self._read_value(p, bool(pos))
                return v
            p = self._skip_value(p, bool(pos))
        return None

    def gold_get(self, word):
        """word: str (ASCII). Returns bytes / dict / None like misaki's grown gold dictionary .get(word)."""
        w = word.encode("ascii", "replace")
        lk = w.lower()
        cap = lk.capitalize()
        up = lk.upper()
        if w == lk or w == cap or w == up:
            e = self._entry(lk)
            if e is None:
                return None
            fl = e["flags"]
            if w == lk:
                return e.get("GL")
            if w == cap:
                if fl & F_GC_SAME:
                    return e.get("GL")
                return e.get("GC")
            return e.get("GU")
        return self._mixed(w)

    def silver_get(self, word):
        w = word.encode("ascii", "replace")
        lk = w.lower()
        if w != lk and w != lk.capitalize():
            return None
        e = self._entry(lk)
        if e is None:
            return None
        return e.get("SL")
