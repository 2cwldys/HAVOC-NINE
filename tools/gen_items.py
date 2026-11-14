#!/usr/bin/env python3
"""gen_items.py -- the catalogue of Apollo RP's items as H9 runs them, rebuilt from the sources: docs\\ARP_ITEMS.txt is written by it.

    python gen_items.py                         prints a summary (the plugin order, the counts, what no NPC sells, the oddities it found)
    python gen_items.py --doc FILE              writes the catalogue as docs\\ARP_ITEMS.txt (ASCII, CRLF)
    python gen_items.py --json FILE             writes the data (both numberings, the guns, every role's NPCs and stock) as JSON
    python gen_items.py --facts                 checks the facts the "what it does" lines rest on against the plugin sources (exit 1 when one no longer holds)
    python gen_items.py --root D:\\Downloads\\TSM   another checkout of the repository

Read only: it reads the sources, it runs no game and writes only the file you name. Sources (all under --root):
    H9XASH\\ts\\addons\\amxmodx\\configs\\plugins.ini                      the order the server loads the ARP plugins in (build.bat's ARP_TARGETS must agree)
    apollo-rp\\base\\addons\\amxmodx\\scripting\\ARP_HungerMod, ARP_Items, ARP_JailMod, ARP_TalkArea, ARP_TS .sma   ARP_RegisterItem calls, the gun and ammunition tables
    apollo-rp\\base\\addons\\amxmodx\\scripting\\ARP_NPCs.sma               how npcs.ini is read (the order of its keywords, the name -> item rule)
    apollo-rp\\base\\addons\\amxmodx\\configs\\arp\\maps\\<map>\\npcs.ini       the shops of h9_tsrp_hive and h9_tsrp_newbyzantium
    H9XASH\\ts\\addons\\amxmodx\\scripting\\include\\tsconst.inc              the names of TS's weapon numbers
    apollo-rp\\base\\addons\\amxmodx\\scripting\\include\\ApolloRP_TS.inc    the number of TS weapons
    build.bat                                                              ARP_TARGETS: the plugins it appends to plugins.ini that plugins.ini does not list yet

The item numbers are the ARP core's item ids: the order ARP_RegisterItem is called in, from 1. The core calls the forward ARP_RegisterItems in its precache and
AMX Mod X runs a forward in the order the plugins are loaded, so the number is the plugin order (plugins.ini) and, inside a plugin, the order of its calls.
ARP_Items and ARP_JailMod register Tape, Rope and Cuffs only while arp_h9_restraints is 1 (read from arp.cfg), so the catalogue has two numberings: R1 (the shipped
setting) and R0.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import textwrap

DEFAULT_ROOT = r"D:\Downloads\TSM"
SCRIPTING = os.path.join("apollo-rp", "base", "addons", "amxmodx", "scripting")
MAPDIR = os.path.join("apollo-rp", "base", "addons", "amxmodx", "configs", "arp", "maps")
MAPS = ("h9_tsrp_hive", "h9_tsrp_newbyzantium")
MAP_SHORT = {"h9_tsrp_hive": "hive", "h9_tsrp_newbyzantium": "NB"}
PLUGINS_INI = os.path.join("H9XASH", "ts", "addons", "amxmodx", "configs", "plugins.ini")
TSCONST = os.path.join("H9XASH", "ts", "addons", "amxmodx", "scripting", "include", "tsconst.inc")
BUILD_BAT = "build.bat"
DESC_LEN = 63          # the core keeps get_string(3, Description, 63)
NAME_LEN = 32          # and get_string(1, Name, 32)
ITEM_PLUGINS = ("ARP_HungerMod", "ARP_Items", "ARP_JailMod", "ARP_TalkArea", "ARP_TS")


class GenError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------------------------------------------------- reading
def read_text(path):
    with open(path, "rb") as f:
        return f.read().decode("latin-1").replace("\r\n", "\n")


def md5_of(path):
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def strip_source(text):
    """Pawn source without its comments (// and /* */) and without `#if 0 ... #endif` blocks; strings and character constants kept; every line break kept."""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "^" else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("\n" * text.count("\n", i, j))
            i = j
        else:
            out.append(c)
            i += 1
    lines = "".join(out).split("\n")
    keep, depth = [], 0
    for ln in lines:
        s = ln.strip()
        if depth:
            if s.startswith("#if"):
                depth += 1
            elif s.startswith("#endif"):
                depth -= 1
            keep.append("")
            continue
        if re.match(r"#if\s+0\b", s):
            depth = 1
            keep.append("")
            continue
        keep.append(ln)
    if depth:
        raise GenError("an unterminated #if 0")
    return "\n".join(keep)


def unescape(lit):
    """A Pawn string literal ("..." with ^ as the escape character) as text."""
    assert lit[0] == '"' and lit[-1] == '"', lit
    body = lit[1:-1]
    out, i = [], 0
    while i < len(body):
        c = body[i]
        if c == "^" and i + 1 < len(body):
            d = body[i + 1]
            out.append({"n": "\n", "t": "\t", "^": "^", '"': '"', "'": "'"}.get(d, d))
            i += 2
        else:
            out.append(c)
            i += 1
    s = "".join(out)
    if any(ord(ch) > 127 for ch in s):
        raise GenError("a non-ASCII character in a string: %r" % s)
    return s


def match_close(s, open_idx):
    """index of the bracket that closes the one at open_idx (strings and character constants skipped)"""
    pairs = {"(": ")", "{": "}", "[": "]"}
    stack = [pairs[s[open_idx]]]
    i = open_idx + 1
    while i < len(s):
        c = s[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < len(s) and s[j] != c:
                j += 2 if s[j] == "^" else 1
            i = j + 1
            continue
        if c in pairs:
            stack.append(pairs[c])
        elif c in ")}]":
            if c != stack[-1]:
                raise GenError("unbalanced brackets near %r" % s[max(0, i - 40):i + 10])
            stack.pop()
            if not stack:
                return i
        i += 1
    raise GenError("no closing bracket")


def split_args(s):
    args, depth, cur, i = [], 0, [], 0
    while i < len(s):
        c = s[i]
        if c == '"' or c == "'":
            j = i + 1
            while j < len(s) and s[j] != c:
                j += 2 if s[j] == "^" else 1
            cur.append(s[i:j + 1])
            i = j + 1
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "," and depth == 0:
            args.append("".join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    args.append("".join(cur).strip())
    return args


def func_body(src, header_re):
    m = re.search(header_re, src)
    if not m:
        raise GenError("no function matching %s" % header_re)
    j = src.find("{", m.end())
    if j < 0:
        raise GenError("no body after %s" % header_re)
    return src[j + 1:match_close(src, j)]


def int_table(src, name):
    """the integers of `new name[...] = { ... }` (comments already stripped), in order"""
    m = re.search(r"new\s+" + re.escape(name) + r"\s*\[[^\]]*\]\s*=\s*\{", src)
    if not m:
        raise GenError("no table " + name)
    j = src.find("{", m.start())
    body = src[j + 1:match_close(src, j)]
    return [int(x) for x in re.findall(r"-?\d+", body)]


# ---------------------------------------------------------------------------------------------------------------------------------------------------- sources
class Sources:
    def __init__(self, root):
        self.root = root
        self.raw = {}
        self.code = {}

    def path(self, rel):
        return os.path.join(self.root, rel)

    def plugin(self, name):
        if name not in self.raw:
            p = self.path(os.path.join(SCRIPTING, name + ".sma"))
            self.raw[name] = read_text(p)
            self.code[name] = strip_source(self.raw[name])
        return self.code[name]

    def file(self, rel):
        return read_text(self.path(rel))


def plugin_order(S):
    """the ARP plugins in the order the server loads them: the ones plugins.ini lists, in its order, then the ones of build.bat's ARP_TARGETS that plugins.ini does not list yet
    (build.bat appends a plugin to the end of plugins.ini when it deploys it). The listed plugins must come in the order of ARP_TARGETS. Returns (order, not_listed)."""
    listed = []
    for ln in S.file(PLUGINS_INI).split("\n"):
        s = ln.split(";")[0].strip()
        m = re.match(r"(ARP_\w+)\.amxx$", s)
        if m:
            listed.append(m.group(1))
    bat = S.file(BUILD_BAT)
    m = re.search(r'set "ARP_TARGETS=([^"]*)"', bat)
    if not m:
        raise GenError("no ARP_TARGETS in build.bat")
    targets = m.group(1).split()
    if [t for t in targets if t in listed] != listed:
        raise GenError("plugins.ini and build.bat's ARP_TARGETS disagree:\n  plugins.ini %s\n  build.bat   %s" % (listed, targets))
    not_listed = [t for t in targets if t not in listed]
    return listed + not_listed, not_listed


# ---------------------------------------------------------------------------------------------------------------------------------------------------- registrations
def parse_registrations(S, plugin):
    """ARP_RegisterItem calls of one plugin's ARP_RegisterItems, in order. A call under `if(h9_cfg_num("arp_h9_restraints",1))` carries cond 'arp_h9_restraints'; the table-driven
    registration of ARP_TS (TSWeaponNames) is expanded row by row."""
    src = S.code[plugin] if plugin in S.code else S.plugin(plugin)
    if not re.search(r"public\s+ARP_RegisterItems\s*\(\s*\)", src):
        return []
    body = func_body(src, r"public\s+ARP_RegisterItems\s*\(\s*\)")
    items = []
    cond_spans = []          # (start, end, cond) in body offsets
    for m in re.finditer(r'if\s*\(\s*h9_cfg_num\s*\(\s*"(arp_h9_restraints)"\s*,\s*1\s*\)\s*\)', body):
        k = m.end()
        while body[k] in " \t\r\n":
            k += 1
        if body[k] == "{":
            end = match_close(body, k)
        else:
            c = body.find("ARP_RegisterItem(", k)
            if c < 0:
                raise GenError("a condition with no registration after it")
            end = match_close(body, body.find("(", c))
        cond_spans.append((m.start(), end, m.group(1)))
    tables = {}
    for m in re.finditer(r"new\s+(\w+)\s*\[[^\]]*\]\s*\[\s*2\s*\]\s*\[\s*\]\s*=\s*\{", body):
        j = body.find("{", m.start())
        tbl = body[j + 1:match_close(body, j)]
        rows = []
        for row in re.finditer(r"\{\s*(\"(?:[^\"^]|\^.)*\")\s*,\s*(\"(?:[^\"^]|\^.)*\")\s*\}", tbl):
            rows.append((unescape(row.group(1)), unescape(row.group(2))))
        tables[m.group(1)] = rows
    pos = 0
    while True:
        m = re.compile(r"(\w+\s*=\s*)?ARP_RegisterItem\s*\(").search(body, pos)
        if not m:
            break
        op = body.find("(", m.start() + (len(m.group(1)) if m.group(1) else 0))
        cl = match_close(body, op)
        args = split_args(body[op + 1:cl])
        pos = cl + 1
        var = re.match(r"(\w+)", m.group(1)).group(1) if m.group(1) else None
        cond = None
        for a, b, c in cond_spans:
            if a <= m.start() <= b:
                cond = c
        if len(args) not in (3, 4):
            raise GenError("ARP_RegisterItem with %d arguments in %s" % (len(args), plugin))
        disp = 0
        if len(args) == 4:
            if not re.fullmatch(r"\d+", args[3]):
                raise GenError("the remove flag of a registration is not a number: %s" % args[3])
            disp = 1 if int(args[3]) else 0
        if args[0].startswith('"'):
            items.append(dict(plugin=plugin, name=unescape(args[0]), handler=unescape(args[1]), description=unescape(args[2]), disposable=disp, cond=cond, var=var, ts_weapon=None))
            continue
        mt = re.fullmatch(r"(\w+)\[Count\]\[0\]", args[0])
        if not mt or args[2] != mt.group(1) + "[Count][1]" or not args[1].startswith('"') or mt.group(1) not in tables:
            raise GenError("an ARP_RegisterItem form this generator does not read: %s" % ", ".join(args))
        guard = "if(%s[Count][0][0])" % mt.group(1)
        if guard.replace(" ", "") not in re.sub(r"\s+", "", body[max(0, m.start() - 200):m.start()]):
            raise GenError("the table registration of %s has no guard %s" % (mt.group(1), guard))
        for idx, (n, d) in enumerate(tables[mt.group(1)]):
            if n:
                items.append(dict(plugin=plugin, name=n, handler=unescape(args[1]), description=d, disposable=disp, cond=cond, var=var, ts_weapon=idx))
    return items


def collect_items(S, order):
    """every item in registration order, with both numberings"""
    items = []
    for p in order:
        if p in ITEM_PLUGINS or re.search(r"public\s+ARP_RegisterItems", S.plugin(p)):
            items.extend(parse_registrations(S, p))
    seen = {}
    for it in items:
        key = it["name"].lower()
        if key in seen:
            raise GenError("two items named %s (the core refuses the second)" % it["name"])
        seen[key] = True
    n1 = n0 = 0
    for it in items:
        n1 += 1
        it["no"] = n1
        if it["cond"] == "arp_h9_restraints":
            it["no_r0"] = None
        else:
            n0 += 1
            it["no_r0"] = n0
        it["name"] = it["name"][:NAME_LEN]
        it["desc_full"] = it["description"]
        it["description"] = it["description"][:DESC_LEN]
        it["truncated"] = len(it["desc_full"]) > DESC_LEN
        body_src = S.plugin(it["plugin"])
        it["handler_defined"] = re.search(r"(?m)^\s*(?:public\s+)?" + re.escape(it["handler"]) + r"\s*\(", body_src) is not None
    return items


def find_ids(items, text, mode):
    """ARP_FindItemId: every item whose name holds the text (case does not matter), the shortest name first, a tie to the lower number. mode 'no' or 'no_r0'."""
    hits = [(len(it["name"]), it[mode], it) for it in items if it[mode] is not None and text.lower() in it["name"].lower()]
    hits.sort(key=lambda t: (t[0], t[1]))
    return [t[2] for t in hits]


# ---------------------------------------------------------------------------------------------------------------------------------------------------- TS tables
def ts_weapon_names(S):
    src = strip_source(S.file(TSCONST))
    m = re.search(r"enum\s*\{(.*?)\}\s*;", src, re.S)
    names = []
    for tok in m.group(1).split(","):
        t = tok.strip()
        if not t:
            continue
        mm = re.match(r"(TSW_\w+)(?:\s*=\s*(\d+))?$", t)
        if not mm:
            raise GenError("tsconst.inc enum token %r" % t)
        if mm.group(2) is not None:
            assert int(mm.group(2)) == len(names)
        names.append(mm.group(1))
    return names


def ts_tables(S, items):
    src = S.plugin("ARP_TS")
    inc = strip_source(S.file(os.path.join(SCRIPTING, "include", "ApolloRP_TS.inc")))
    mx = int(re.search(r"#define\s+TS_MAX_WEAPONS\s+(\d+)", inc).group(1))
    j = src.find("{", re.search(r"new\s+g_GunStats\s*\[", src).start())
    gs = src[j + 1:match_close(src, j)]
    attach = []
    for row in re.finditer(r"\{\s*(\d+)\s*,\s*([A-Z_0-9|\s]+?)\s*\}", gs):
        flags = [f.strip() for f in row.group(2).split("|") if f.strip() != "0"]
        attach.append(flags)
    ammo_cap = int_table(src, "g_WeaponAmmo")
    ammo_type = int_table(src, "g_AmmoTypes")
    for nm, tb in (("g_GunStats", attach), ("g_WeaponAmmo", ammo_cap), ("g_AmmoTypes", ammo_type)):
        if len(tb) != mx:
            raise GenError("%s has %d rows, TS_MAX_WEAPONS is %d" % (nm, len(tb), mx))
    body = func_body(src, r"public\s+_Ammo\s*\(")
    mode_of = {}
    for m in re.finditer(r"ItemId\s*==\s*(g_\w+)\)\s*Mode\s*=\s*(\d+)", body):
        mode_of[m.group(1)] = int(m.group(2))
    kind_item = {}
    for it in items:
        if it["plugin"] == "ARP_TS" and it["handler"] == "_Ammo":
            if it["var"] not in mode_of:
                raise GenError("the ammunition item %s has no Mode in _Ammo" % it["name"])
            kind_item[mode_of[it["var"]]] = it["name"]
    if sorted(kind_item) != list(range(1, len(kind_item) + 1)):
        raise GenError("the ammunition kinds are not 1..N: %s" % sorted(kind_item))
    return dict(max=mx, attach=attach, cap=ammo_cap, type=ammo_type, kind_item=kind_item)


# ---------------------------------------------------------------------------------------------------------------------------------------------------- npcs.ini
def amx_parse(line):
    """AMX Mod X's parse(): the words of a line, a word in double quotes kept together (the quotes dropped)"""
    out, i, n = [], 0, len(line)
    while i < n:
        while i < n and line[i] in " \t\r":
            i += 1
        if i >= n:
            break
        if line[i] == '"':
            j = line.find('"', i + 1)
            j = n if j < 0 else j
            out.append(line[i + 1:j])
            i = j + 1
        else:
            j = i
            while j < n and line[j] not in " \t\r":
                j += 1
            out.append(line[i:j])
            i = j
    return out


def containi(hay, needle):
    return needle.lower() in hay.lower()


def str_to_num(s):
    """AMX Mod X's str_to_num(): the integer a string starts with, 0 when it starts with none"""
    m = re.match(r"\s*([+-]?\d+)", s)
    return int(m.group(1)) if m else 0


def parse_npcs(path, items, mode):
    """npcs.ini as ARP_NPCs reads it: a line is taken by the first of these keywords it holds (anywhere in it, in any case), in this order. mode: 'no' (R1) or 'no_r0' (R0)."""
    npcs, cur = [], None
    problems = []
    where = os.path.basename(os.path.dirname(path))

    def fresh():
        return dict(name="", type="shop", model="", sells=[], heal=None, guns={0: [], 1: [], 2: []}, property="", line=0, seen=set())

    cur = fresh()
    for lineno, raw in enumerate(read_text(path).split("\n"), 1):
        buf = raw.rstrip("\r")
        if len(buf) > 126:
            problems.append("%s:%d: a line of %d characters (ARP_NPCs reads 127 at a time and cuts a longer line in two)" % (where, lineno, len(buf)))
        if buf.startswith(";") or len(buf) == 0:
            continue
        if containi(buf, "[END]"):
            miss = [k for k in ("name", "type", "model", "origin") if k not in cur["seen"]]
            if miss:
                problems.append("%s:%d: the block lacks %s: ARP_NPCs would keep what the block before it set" % (where, lineno, ", ".join(miss)))
            if len(npcs) >= 50:
                problems.append("%s:%d: more than 50 NPCs (MAX_NPCS)" % (where, lineno))
            npcs.append(cur)
            cur = fresh()
            continue
        if not cur["line"]:
            cur["line"] = lineno
        if containi(buf, "name"):
            w = amx_parse(buf)
            cur["name"] = w[1][:NAME_LEN] if len(w) > 1 else ""
            cur["seen"].add("name")
        elif containi(buf, "type"):
            w = amx_parse(buf)
            cur["seen"].add("type")
            if len(w) > 1 and w[1] in ("shop", "bank", "doctor", "gunshop", "atm"):
                cur["type"] = w[1]
            else:
                problems.append("%s:%d: the type %r is none of the five: ARP_NPCs keeps the type of the block before" % (where, lineno, w[1] if len(w) > 1 else ""))
        elif containi(buf, "model"):
            w = amx_parse(buf)
            cur["model"] = w[1] if len(w) > 1 else ""
            cur["seen"].add("model")
        elif containi(buf, "angle") or containi(buf, "origin"):
            cur["seen"].add("origin" if containi(buf, "origin") else "angle")
        elif containi(buf, "sell"):
            w = amx_parse(buf)
            w2 = amx_parse(w[1]) if len(w) > 1 else []
            text = w2[0].replace("_", " ") if w2 else ""
            price = str_to_num(w2[1]) if len(w2) > 1 else 0
            if text == "0":
                continue                                    # the legacy robbery lines: skipped by the reader
            if re.fullmatch(r"-?\d+", text):                # a number is an item number
                hit = [it for it in items if it[mode] == int(text)]
            else:
                hit = find_ids(items, text, mode)
            cur["sells"].append(dict(text=text, price=price, item=hit[0]["name"] if hit else None))
        elif containi(buf, "heal"):
            w = amx_parse(buf)
            cur["heal"] = str_to_num(w[1]) if len(w) > 1 else 0
        elif containi(buf, "addgun"):
            w = amx_parse(buf)
            w2 = amx_parse(w[1]) if len(w) > 1 else []
            text = w2[0].replace("_", " ") if w2 else ""
            price = str_to_num(w2[1]) if len(w2) > 1 else 0
            lic = min(max(str_to_num(w2[2]), 0), 2) if len(w2) > 2 else 0
            hit = find_ids(items, text, mode)
            if hit:
                cur["guns"][lic].append(dict(text=text, price=price, item=hit[0]["name"]))
            else:
                problems.append("%s:%d: addgun %r names no item (ARP_NPCs logs 'does not exist' and skips it)" % (os.path.basename(os.path.dirname(path)), lineno, text))
        elif containi(buf, "zone"):
            pass
        elif containi(buf, "property"):
            w = amx_parse(buf)
            cur["property"] = w[1].strip() if len(w) > 1 else ""
    if cur["line"]:
        problems.append("%s: the last block has no [END]" % os.path.basename(os.path.dirname(path)))
    return npcs, problems


# ---------------------------------------------------------------------------------------------------------------------------------------------------- roles
# The shop roles of docs\ARP_CONTENT.txt, section 5 ("the same role sells the same list on both maps"), and the NPC names of the two maps that stand for each. A role is
# a stock list: every NPC of a role must hold the same one (the generator says so when one does not), and an NPC with no role here stops the generator.
ROLE_ORDER = ["General Store", "Cantina", "Tech Counter", "Black Market", "Ministry Quartermaster", "Ministry Licensing Clerk", "Pharmacy", "Hardware Counter",
              "Luxury Goods", "Ammunition Counter", "Medical Officer", "Licensed Arms Dealer", "Bank Teller", "ATM Droid"]
ROLE_OF = {
    # h9_tsrp_hive
    "Pawn Prawn Cantina": "Cantina", "Uncle Pikkys Pizzeria": "Cantina", "Green Dragon Cantina": "Cantina", "H&C Coffee Cantina": "Cantina", "Cafe Avalon Cantina": "Cantina",
    "Snack Archive General Store": "General Store", "Xenon City Gear General Store": "General Store", "K-Line Super Store": "General Store",
    "Amoeba Music Tech Counter": "Tech Counter", "Black Market": "Black Market",
    "XCCP Quartermaster": "Ministry Quartermaster", "XCCP Licensing Clerk": "Ministry Licensing Clerk",
    "Gear Guys Arms Dealer": "Licensed Arms Dealer", "Guns n Stuff Arms Dealer": "Licensed Arms Dealer",
    "Gear Guys Ammunition Counter": "Ammunition Counter", "Guns n Stuff Ammunition Counter": "Ammunition Counter",
    "Romagna Clinic Medical Officer": "Medical Officer", "Midgar Lab Medical Officer": "Medical Officer",
    "Paradise Bank Teller": "Bank Teller", "Bank Terminal": "Bank Teller",
    # h9_tsrp_newbyzantium
    "General Store": "General Store", "Uncle Pikkys General Store": "General Store", "Stacks General Store": "General Store",
    "Cantina": "Cantina", "Tech Counter": "Tech Counter",
    "Ministry Quartermaster": "Ministry Quartermaster", "Ministry Licensing Clerk": "Ministry Licensing Clerk",
    "Pharmacy": "Pharmacy", "Foundry Hardware Counter": "Hardware Counter", "Luxury Goods": "Luxury Goods",
    "Ammunition Counter": "Ammunition Counter", "Licensed Arms Dealer": "Licensed Arms Dealer",
    "Infirmary Medical Officer": "Medical Officer", "Medical Officer": "Medical Officer", "Street Medic": "Medical Officer", "Heights Medical Officer": "Medical Officer",
    "Exchange Bank Teller": "Bank Teller", "Bank Teller": "Bank Teller",
    "ATM Droid": "ATM Droid",
}
GUN_MENU = {0: "Permitted", 1: "Restricted", 2: "Licenses"}
GUN_MENU_NEEDS = {0: "Permitted License", 1: "Restricted License", 2: None}
# what a bank NPC's own menu sells: the prices are in ARP_NPCs (BankHandle, BankMenuHandle; --facts holds them), not in npcs.ini
BANK_MENU = [("ATM Card", 10), ("Debit Card", 100)]


def build_shops(S, items, mode, warnings):
    """roles -> stock, with the NPCs of each map that stand for the role. mode 'no' (R1) or 'no_r0' (R0)."""
    roles = {}
    for mp in MAPS:
        npcs, problems = parse_npcs(S.path(os.path.join(MAPDIR, mp, "npcs.ini")), items, mode)
        warnings.extend(problems)
        for n in npcs:
            if n["name"] not in ROLE_OF:
                raise GenError("the NPC %r of %s has no role in ROLE_OF" % (n["name"], mp))
            if n["model"] and not os.path.exists(S.path(os.path.join("H9XASH", "ts", n["model"].replace("/", os.sep)))):
                warnings.append("%s: the model %s of %r is not in H9XASH\\ts: ARP_NPCs would leave the NPC out" % (mp, n["model"], n["name"]))
            role = ROLE_OF[n["name"]]
            sig = (n["type"], n["heal"], tuple((s["item"] or "BAD ITEM ID: " + s["text"], s["price"]) for s in n["sells"]),
                   tuple(tuple((g["item"], g["price"]) for g in n["guns"][k]) for k in (0, 1, 2)))
            r = roles.setdefault(role, dict(role=role, sig=sig, type=n["type"], heal=n["heal"], sells=sig[2], guns=sig[3], bank=list(BANK_MENU) if n["type"] == "bank" else [],
                                            npcs={m: [] for m in MAPS}))
            if r["sig"] != sig:
                raise GenError("the NPC %r of %s does not hold the stock of its role %s" % (n["name"], mp, role))
            r["npcs"][mp].append(n["name"])
    for role in roles:
        if role not in ROLE_ORDER:
            raise GenError("role %s is not in ROLE_ORDER" % role)
    return roles


def role_maps(r):
    return [mp for mp in MAPS if r["npcs"][mp]]


def sold_by(roles, item_name):
    """[(role, price, menu or None)] of every role that sells the item (a shop's sell line, or a gun shop's addgun line: menu 0 Permitted, 1 Restricted, 2 Licenses)"""
    out = []
    for role in ROLE_ORDER:
        r = roles.get(role)
        if not r:
            continue
        for it, price in r["sells"]:
            if it == item_name:
                out.append((role, price, None))
        for it, price in r["bank"]:
            if it == item_name:
                out.append((role, price, "bank"))
        for k in (0, 1, 2):
            for it, price in r["guns"][k]:
                if it == item_name:
                    out.append((role, price, k))
    return out


# ---------------------------------------------------------------------------------------------------------------------------------------------------- the whole catalogue
def build(root=DEFAULT_ROOT):
    S = Sources(root)
    warnings = []
    order, not_listed = plugin_order(S)
    items = collect_items(S, order)
    by_name = {it["name"]: it for it in items}
    cat = dict(root=root, plugin_order=order, not_listed=not_listed, items=items, warnings=warnings)
    cat["register_order"] = [p for p in order if any(it["plugin"] == p for it in items)]
    cat["counts"] = {p: sum(1 for it in items if it["plugin"] == p) for p in cat["register_order"]}
    cat["total_r1"] = len(items)
    cat["total_r0"] = sum(1 for it in items if it["no_r0"] is not None)
    for it in items:
        if not it["handler_defined"]:
            warnings.append("item #%d %s: its handler %s is not defined in %s.sma (using it does nothing: the core finds no function to run)" % (it["no"], it["name"], it["handler"], it["plugin"]))
    # TS
    tsw = ts_weapon_names(S)
    inc = strip_source(S.file(TSCONST))
    alias = {}
    for m in re.finditer(r"#define\s+(TSW_\w+)\s+(TSW_\w+)", inc):
        alias[m.group(2)] = m.group(1)
    t = ts_tables(S, items)
    cat["ts"] = t
    cat["tsw"] = tsw
    cat["tsw_alias"] = alias
    gun_item = {it["ts_weapon"]: it for it in items if it["ts_weapon"] is not None}
    attach_name = {"SILENCER": "Suppressor", "LASERSIGHT": "Lasersight", "FLASHLIGHT": "Flashlight", "SCOPE": "Scope"}
    for it in items:
        if it["ts_weapon"] is None:
            continue
        w = it["ts_weapon"]
        parts = [p.strip() for p in it["desc_full"].split(";")]
        cls_raw = parts[1] if len(parts) > 1 else ""
        cls = "Non-Restricted" if cls_raw.lower().startswith("non-restric") else cls_raw
        kind = t["type"][w]
        order_att = ["FLASHLIGHT", "LASERSIGHT", "SCOPE", "SILENCER"]
        flags = [a.replace("TSA_", "") for a in t["attach"][w]]
        it["gun"] = dict(weapon=w, tsw=alias.get(tsw[w], tsw[w]), kind=parts[0], cls=cls, cls_raw=cls_raw, calibre=parts[2] if len(parts) > 2 else "",
                         ammo_kind=kind, ammo_item=t["kind_item"].get(kind) if kind else None, cap=t["cap"][w],
                         attach=[attach_name[a] for a in order_att if a in flags])
    for it in items:
        if it["handler"] == "_Ammo":
            kind = [k for k, n in t["kind_item"].items() if n == it["name"]][0]
            fits = []
            for w in range(t["max"]):
                if t["type"][w] == kind:
                    g = gun_item.get(w)
                    fits.append(dict(weapon=w, tsw=alias.get(tsw[w], tsw[w]), item=g["name"] if g else None, cap=t["cap"][w]))
            it["ammo"] = dict(kind=kind, fits=fits)
    cat["ts_no_item"] = [dict(weapon=w, tsw=alias.get(tsw[w], tsw[w])) for w in range(t["max"]) if w not in gun_item]
    # shops, in both numberings
    cat["shops"] = build_shops(S, items, "no", warnings)
    cat["shops_r0"] = build_shops(S, items, "no_r0", [])
    cat["bad_r0"] = sorted({(s[0].split(": ", 1)[1], role) for role, r in cat["shops_r0"].items() for s in r["sells"] if s[0].startswith("BAD ITEM ID")})
    for it in items:
        it["sold"] = sold_by(cat["shops"], it["name"])
    cat["not_sold"] = [it["name"] for it in items if not it["sold"]]
    # names that are part of another item's name: arp_createitems refuses them (it counts every item that holds the text)
    amb = {}
    for it in items:
        others = [o["name"] for o in items if o is not it and it["name"].lower() in o["name"].lower()]
        if others:
            amb[it["name"]] = others
    cat["ambiguous"] = amb
    # the gun shops' menus against the licence class in the gun's description
    for role, r in cat["shops"].items():
        for k in (0, 1, 2):
            for name, price in r["guns"][k]:
                it = by_name[name]
                if k in (0, 1) and "gun" in it:
                    want = {0: "Non-Restricted", 1: "Restricted"}[k]
                    if it["gun"]["cls"] != want:
                        warnings.append("%s sells %s in its %s menu but the description says %s" % (role, name, GUN_MENU[k], it["gun"]["cls"]))

    def lead(s):
        m = re.match(r"\s*(\.?\d+(?:\.\d+)?)", s)
        return m.group(1) if m else None
    for it in items:
        g = it.get("gun")
        if g and g["ammo_item"] and g["calibre"] and lead(g["calibre"]) != lead(g["ammo_item"]):
            g["calibre_note"] = "the description says %s, the table gives %s" % (g["calibre"], g["ammo_item"])
    cat["by_name"] = by_name
    cat["S"] = S
    describe(cat, S)
    cat["md5"] = {rel: md5_of(S.path(rel)) for rel in
                  [PLUGINS_INI, BUILD_BAT, TSCONST] + [os.path.join(SCRIPTING, p + ".sma") for p in cat["register_order"]] +
                  [os.path.join(SCRIPTING, "include", "ApolloRP_TS.inc")] + [os.path.join(MAPDIR, mp, "npcs.ini") for mp in MAPS]}
    return cat


# ---------------------------------------------------------------------------------------------------------------------------------------------------- what using an item does
def func_text(src, name):
    """one function of a plugin (comments already stripped), whitespace collapsed: from its header to the next declaration at column 0, so that a function with no braces is read too"""
    m = re.search(r"(?m)^(?:public\s+|stock\s+)?" + re.escape(name) + r"\s*\(", src)
    if not m:
        raise GenError("no function %s" % name)
    nl = src.find("\n", m.end())
    mm = re.compile(r"(?m)^[^\s{}]").search(src, nl + 1)
    return re.sub(r"\s+", " ", src[m.start():mm.start() if mm else len(src)])


# What the "what it does" lines rest on: (plugin, function, [regular expressions the function's text must hold]). gen_items.py --facts runs them; one that fails says the line needs a second look.
FACTS = [
    ("ARP_HungerMod", "_Food", [r"CurArray\[2\] = 5 Msg = \"drinking\"", r"You don't feel like %s this right now", r"ARP_SetUserSpeed\(id,Speed_Mul,0\.5\)", r"set_task\(1\.0,\"Eat\"",
                                r"ARP_GetUserHunger\(id\) < CurArray\[2\] && !\(get_pcvar_num\(p_ThirstEnabled\) && g_Thirst\[id\] > 0 && \(ItemId == g_Soda \|\| ItemId == g_Milk\)\)"]),
    ("ARP_HungerMod", "Eat", [r"Food > 5 && Hunger > 0", r"Food -= 5", r"ARP_SetUserHunger\(id,Hunger - 5\)", r"g_Thirst\[id\] = max\(g_Thirst\[id\] - 35,0\)", r"g_Thirst\[id\] = max\(g_Thirst\[id\] - 30,0\)"]),
    ("ARP_Items", "_License", [r"ItemId == g_Restricted \? \"restricted\" : \"non-restricted\""]),
    ("ARP_Items", "_Smoke", [r"g_Smoking\[id\]\[TIME\] = Time", r"You put a %s in your mouth"]),
    ("ARP_Items", "_Lighter", [r"You do not have any tobacco products in your mouth", r"Health <= 10\.0", r"EV_FL_health,Health - 10\.0", r"set_task\(1\.0,\"SmokeItem\",id\)"]),
    ("ARP_Items", "SmokeItem", [r"g_Smoking\[id\]\[TIME\]--", r"TE_SMOKE"]),
    ("ARP_Items", "_Flashlight", [r"g_Flashlight\[id\] = !g_Flashlight\[id\]"]),
    ("ARP_Items", "Flashlight", [r"!ARP_GetUserItemNum\(Player,g_FlashlightId\)", r"TE_DLIGHT", r"set_task\(0\.1,\"Flashlight\"\)"]),
    ("ARP_Items", "FlashlightAttempt", [r"You do not have a flashlight"]),
    ("ARP_Items", "_Spray", [r"client_cmd\(id,\"impulse 201\"\)"]),
    ("ARP_Items", "SprayAttempt", [r"You need a spray can to use your spray", r"ARP_SetUserItemNum\(id,g_Spray,Num - 1\)"]),
    ("ARP_Items", "_Flashbang", [r"get_players\(Players,Playersnum,\"ac\"\)", r"get_distance_f\(tOrigin,pOrigin\) > 600\.0", r"random_float\(-5000\.0,5000\.0\)"]),
    ("ARP_Items", "LockpickHandle", [r"You must be looking at a rotating door", r"get_user_aiming\(id,Index,Body,100\)", r"equali\(Classname,\"func_door_rotating\"\)"]),
    ("ARP_Items", "LockMenuHandle", [r"Key == random_num\(0,3\)", r"random_num\(1,6\) == 1", r"random_num\(1,30\) == 25", r"Your lock pick snapped", r"g_Pick\[id\] & \(1<<3\)"]),
    ("ARP_Items", "_ELockpick", [r"force_use\(id,Index\)", r"get_user_aiming\(id,Index,Body,100\)", r"You must be looking at a rotating door"]),
    ("ARP_Items", "_Tazer", [r"get_user_aiming\(id,Index,Body,200\)", r"Time - g_LastTazer\[id\] < 60\.0", r"ARP_IsCop\(Index\)", r"random_num\(0,100\) == 50", r"fakedamage\(Index,\"Tazer\",10\.0,DMG_SHOCK",
                         r"ARP_SetUserSpeed\(Index,Speed_Mul,0\.5\)", r"set_task\(5\.0,\"Clear\",Index\)", r"weapon_%d;drop"]),
    ("ARP_Items", "CmdSay", [r"equali\(Args,\"/tazer\",6\)"]),
    ("ARP_Items", "_Heal", [r"get_user_aiming\(id,Index,Body,200\)", r"Health > 99\.0", r"Health < 50\.0", r"Health \+ 15\.0\),100\)", r"ARP_SetUserItemNum\(id,ItemId,ARP_GetUserItemNum\(id,ItemId\) - 1\)"]),
    ("ARP_Items", "_Alcohol", [r"ItemId == g_Beer\) Alcohol = 5 \* ALCOHOL_MULTIPLE", r"ItemId == g_HawkMiller\) Alcohol = 80 \* ALCOHOL_MULTIPLE"]),
    ("ARP_Items", "AlcoholCheck", [r"g_Alcohol\[Player\] -= ALCOHOL_MULTIPLE", r"g_Alcohol\[Player\] / ALCOHOL_MULTIPLE > 100", r"g_Alcohol\[Player\] / ALCOHOL_MULTIPLE > 70"]),
    ("ARP_Items", "_Crack", [r"ARP_SetUserSpeed\(id,Speed_Mul,0\.5\)", r"set_pev\(id,pev_health,Health / 2\)", r"set_task\(12\.0,\"ClearEffects\""]),
    ("ARP_Items", "_Heroin", [r"set_pev\(id,pev_health,75\.0\)", r"ARP_SetUserSpeed\(id,Speed_Mul,2\.0\)", r"set_task\(12\.0,\"ClearEffects\""]),
    ("ARP_Items", "_PCP", [r"Health \+ 100\.0\),0,200\)", r"set_user_godmode\(id,1\)", r"ARP_SetUserSpeed\(id,Speed_Mul,2\.0\)", r"set_task\(12\.0,\"ClearEffects\""]),
    ("ARP_Items", "_Mushroom", [r"Health \+ 50\.0\),0,200\)", r"Count <= 25\.0", r"set_task\(26\.0,\"ClearEffects\"", r"ARP_SetUserSpeed\(id,Speed_Mul,2\.0\)"]),
    ("ARP_Items", "_Cocaine", [r"Health \+ 30\.0\),0,200\)", r"set_task\(7\.0,\"ClearEffects\"", r"ARP_SetUserSpeed\(id,Speed_Mul,0\.5\)"]),
    ("ARP_Items", "_Acid", [r"Health \+ 50\.0\),0,200\)", r"Count <= 180\.0", r"set_task\(181\.0,\"ClearEffects\"", r"ARP_SetUserSpeed\(id,Speed_Mul,2\.0\)"]),
    ("ARP_Items", "_DoorBreaker", [r"!ARP_IsCop\(id\)", r"You are not a cop", r"get_user_aiming\(id,Index,Body,100\)", r"containi\(Classname,\"door\"\) == -1 && containi\(Classname,\"breakable\"\) == -1",
                                   r"It has a 5 second fuse", r"set_task\(5\.0,\"DoorEffect\"", r"set_task\(10\.0,\"ReturnOrigin\""]),
    ("ARP_Items", "DoorEffect", [r"radius_damage\(Float:Params2,100,80\)", r"set_task\(5\.0,\"ReturnOrigin\""]),
    ("ARP_Items", "_Atm", [r"walk up to an ATM to use it"]),
    ("ARP_Items", "_Debit", [r"Say /withdraw to use this item"]),
    ("ARP_Items", "_Tape", [r"H9_RestraintTarget\(id,100\)", r"ARP_H9Gag\(Index,1\)", r"ARP_SetUserItemNum\(id,ItemId,ARP_GetUserItemNum\(id,ItemId\) - 1\)"]),
    ("ARP_Items", "H9_RemoveTape", [r"ARP_H9Gag\(Index,0\)"]),
    ("ARP_Items", "_Rope", [r"g_RopedBy\[Index\] = id", r"H9_Untie\(id\)", r"H9_RestraintTarget\(id,100\)"]),
    ("ARP_Items", "client_PreThink", [r"Distance > Length \* 4\.0", r"The rope snapped", r"get_pcvar_float\(p_RopeLength\)"]),
    ("ARP_Items", "_AssassinKnife", [r"g_AssassinKnife\[id\] = !g_AssassinKnife\[id\]"]),
    ("ARP_Items", "_Ham_TakeDamage", [r"vector_distance\(vOrigin,Origin\) > 100\.0", r"g_AssassinKnife\[Attacker\] = 0", r"is_in_viewcone\(id,Origin\)", r"SetHamParamFloat\(4,float\(get_user_health\(id\) \+ 1\)\)",
                                      r"Ham_TakeDamage on player is delivered here"]),
    ("ARP_JailMod", "SayCuff", [r"!ARP_IsCop\(id\)", r"get_user_aiming\(id,Index,Body,200\)", r"You cannot cuff other cops", r"You are not a cop, and you have no Cuffs"]),
    ("ARP_JailMod", "EventCuffed", [r"ARP_SetUserItemNum\(id,g_Cuffs,ARP_GetUserItemNum\(id,g_Cuffs\) - 1\)", r"ARP_SetUserItemNum\(id,g_Cuffs,ARP_GetUserItemNum\(id,g_Cuffs\) \+ 1\)", r"weapon_%d;drop", r"set_rendering\(Index,kRenderFxGlowShell,255,0,0,kRenderNormal,16\)"]),
    ("ARP_JailMod", "_Cuffs", [r"SayCuff\(id,0,\"\"\)"]),
    ("ARP_JailMod", "client_PreThink", [r"g_MaxSpeed\[id\] / 2", r"~IN_ATTACK", r"~IN_USE"]),
    ("ARP_JailMod", "ARP_Salary", [r"\|\| g_MaxSpeed\[id\]\) return PLUGIN_HANDLED"]),
    ("ARP_TalkArea", "_Phone", [r"ARP Phone Menu", r"g_StatusMenuItems\[Count\]"]),
    ("ARP_TalkArea", "StatusHandle", [r"GetPhonePlayers\(Players,Playersnum,id\)", r"There is no one else with a phone", r"ARP Phonebook"]),
    ("ARP_TalkArea", "GetPhonePlayers", [r"!ARP_GetUserItemNum\(id,g_Motorola\) && !ARP_GetUserItemNum\(id,g_Nokia\) && !ARP_GetUserItemNum\(id,g_Sony\)"]),
    ("ARP_TalkArea", "_Subscription", [r"This item cannot be used\. Use a phone, instead"]),
    ("ARP_TalkArea", "_Bug", [r"ARP_ItemDone\(id\)", r"get_user_aiming\(id,Index,Body,100\)", r"g_Bugged\[Index\]\[id\] = 1", r"You are not looking at any people to bug"]),
    ("ARP_TalkArea", "PrintBugMessage", [r"\[BUG\] %s"]),
    ("ARP_TalkArea", "_Scanner", [r"ARP_ItemDone\(id\)", r"get_user_aiming\(id,Index,Body,100\)", r"set_task\(5\.0,\"Scan\""]),
    ("ARP_TalkArea", "Scan", [r"arrayset\(g_Bugged\[Index\],0,sizeof g_Bugged\[\]\)", r"scanned you and found %d bugs, which were removed"]),
    ("ARP_TS", "_Weapon", [r"g_GunStats\[Count\]\[ITEMID\] == ItemId", r"if\(!g_GunStats\[Cell\]\[ATTACHMENTS\]\) \{ GiveWeapon\(id\)", r"arpvgui_show_menu\(id,Keys,Menu,-1,g_AttachMenu"]),
    ("ARP_TS", "GiveWeapon", [r"g_Cell\[id\] >= 39 && !\(cvar_exists\(\"h9_customweapons\"\) && get_cvar_num\(\"h9_customweapons\"\)\)", r"ARP_SetUserItemNum\(id,Item,ARP_GetUserItemNum\(id,Item\) \+ 1\)",
                              r"ts_giveweapon\(id,g_Cell\[id\],250,g_Attachments\[id\]\)"]),
    ("ARP_TS", "_Ammo", [r"Mode == g_AmmoTypes\[Wpn\] && ts_setuserammo\(id,Wpn,g_WeaponAmmo\[Wpn\]\)", r"You are not wielding any weapon with this ammo type", r"ARP_SetUserItemNum\(id,ItemId,ARP_GetUserItemNum\(id,ItemId\) \+ 1\)"]),
    ("ARP_NPCs", "BankHandle", [r"1\. Withdraw/Deposit\^n2\. Buy ATM Card \(\$10\)\^n3\. Buy Debit Card \(\$100\)"]),
    ("ARP_NPCs", "BankMenuHandle", [r"ARP_FindItemId\(\"ATM Card\",Results,1\)", r"Cash < 10\)", r"ARP_SetUserWallet\(id,Cash - 10\)", r"ARP_FindItemId\(\"Debit Card\",Results,1\)", r"Cash < 100\)", r"ARP_SetUserWallet\(id,Cash - 100\)"]),
    ("ARP_NPCs", "GunshopMenuHandle2", [r"ARP_FindItemId\(g_ModeNames\[Key\],Results,1\)", r"!ARP_GetUserItemNum\(id,ItemId\)", r"You do not have a %s license", r"case 2 : ItemId = -1"]),
    ("ARP_NPCs", "EdekaMenuHandle", [r"UserCash < g_Selling\[g_CurNpc\[id\]\]\[Item\]\[COST\]", r"ARP_SetUserWallet\(id,UserCash - g_Selling\[g_CurNpc\[id\]\]\[Item\]\[COST\]\)"]),
    ("ARP_NPCs", "DoctorMenuHandle", [r"get_user_health\(id\) >= 100", r"Cash < g_Heal\[g_CurNpc\[id\]\]"]),
    ("ARP_NPCs", "AtmHandle", [r"ARP_FindItemId\(\"ATM Card\",Results,1\)", r"You don't have an ATM card"]),
    ("ARP_NPCs", "CmdSay", [r"ARP_FindItemId\(\"Debit Card\",ItemIds,1\)", r"Mode == 1 && ARP_ValidItemId\(ItemIds\[0\]\) && ARP_GetUserItemNum\(id,ItemIds\[0\]\)"]),
    ("ARP_Commands", "CmdChangeItems", [r"is_str_num\(Arg\) \? \(ItemId = str_to_num\(Arg\)\) : \(Num = ARP_FindItemId\(Arg,Results,2\)\)", r"Num > 1", r"Found more than one item with that name"]),
]


def check_facts(S):
    """the facts of FACTS against the plugin sources: the list of those that no longer hold"""
    bad = []
    seen = {}
    for plugin, func, regs in FACTS:
        try:
            body = func_text(S.plugin(plugin), func)
        except GenError as e:
            bad.append("%s %s: %s" % (plugin, func, e))
            continue
        for rg in regs:
            seen[(plugin, func)] = seen.get((plugin, func), 0) + 1
            if not re.search(rg, body):
                bad.append("%s %s: not found: %s" % (plugin, func, rg))
    bad += check_unread(S)
    return bad, sum(seen.values()) + len(UNREAD)


# names that the doc says nothing reads: no plugin source or include of the masters may name them other than the registration (and the handler's definition) in the plugin that has them
UNREAD = [("Subscription", "ARP_TalkArea.sma", 3), ("Prepaid", "ARP_TalkArea.sma", 1)]


def check_unread(S):
    bad = []
    d = S.path(SCRIPTING)
    files = [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith(".sma")] + [os.path.join(d, "include", f) for f in sorted(os.listdir(os.path.join(d, "include"))) if f.endswith(".inc")]
    for word, home, nlines in UNREAD:
        found = {}
        for f in files:
            n = sum(1 for ln in strip_source(read_text(f)).split("\n") if word in ln)
            if n:
                found[os.path.basename(f)] = n
        if found != {home: nlines}:
            bad.append("something reads or names %r besides %s's %d line(s): %s" % (word, home, nlines, found))
    return bad


def thirty(s):
    return s


def food_facts(S, items):
    """item name -> (hunger, thirst, drink) from _Food and Eat"""
    by_var = {it["var"]: it["name"] for it in items if it["var"]}
    body = func_text(S.plugin("ARP_HungerMod"), "_Food")
    eat = func_text(S.plugin("ARP_HungerMod"), "Eat")
    out = {}
    for m in re.finditer(r"ItemId == (g_\w+)\) (?:\{ )?CurArray\[2\] = (\d+)( Msg = \"drinking\")?", body):
        out[by_var[m.group(1)]] = dict(hunger=int(m.group(2)), thirst=0, drink=bool(m.group(3)))
    for m in re.finditer(r"CurArray\[1\] == (g_\w+)\) g_Thirst\[id\] = max\(g_Thirst\[id\] - (\d+),0\)", eat):
        out[by_var[m.group(1)]]["thirst"] = int(m.group(2))
    return out


def alcohol_facts(S, items):
    by_var = {it["var"]: it["name"] for it in items if it["var"]}
    body = func_text(S.plugin("ARP_Items"), "_Alcohol")
    return {by_var[m.group(1)]: int(m.group(2)) for m in re.finditer(r"ItemId == (g_\w+)\) Alcohol = (\d+) \* ALCOHOL_MULTIPLE", body)}


def smoke_facts(S, items):
    by_var = {it["var"]: it["name"] for it in items if it["var"]}
    body = func_text(S.plugin("ARP_Items"), "_Smoke")
    return {by_var[m.group(1)]: int(m.group(2)) for m in re.finditer(r"ItemId == (g_\w+)\) Time = (\d+)", body)}


# the hand-written lines, by item name; the food, alcohol, tobacco, gun and ammunition lines are made from the sources below
DOES = {
    "Restricted License": "Only says \"This is a restricted firearms license.\" A gun shop's Restricted menu opens for a player who has one in /items.",
    "Permitted License": "Only says \"This is a non-restricted firearms license.\" A gun shop's Permitted menu opens for a player who has one in /items.",
    "Lighter": "Lights the tobacco in the user's mouth (use a smoke first): costs 10 health, needs more than 10, and puffs of smoke show for as many seconds as the tobacco lasts.",
    "Zippo Lighter": "The same as the Lighter: the two lighters share one handler.",
    "Flashlight": "Switches a light on or off that follows the point the user aims at (a white dynamic light, 10 times a second). The flashlight key (impulse 100) switches it too and says \"You do not have a flashlight\" without the item.",
    "Spray Can": "Sprays the player's logo (impulse 201). Each spray, by this item or by the key, uses up one can (\"You need a spray can to use your spray\"): the handler is not marked disposable, the spray is what takes it.",
    "Flashbang": "Flashes every player (bots excepted) within 600 units who has a clear line to the user: white screen, random view kick. Plays an explosion sound. Used up.",
    "Lockpick": "Lock picking on the rotating door (func_door_rotating) in view, within 100 units: a menu of Up, Down, Left, Right. A right key (1 in 4) adds a prong, a wrong one resets the lock 1 time in 6, and every try snaps the pick 1 time in 30 (one used up); with four prongs the menu offers Open Door. Sliding doors are refused.",
    "Electric Lockpick": "Opens the rotating door (func_door_rotating) in view, within 100 units, at once, and is not used up. Sliding doors are refused.",
    "Tazer": "Stuns the living player in view within 200 units: 10 shock damage, half speed for 5 seconds, his weapons dropped. 60 seconds to recharge; not against police; 1 use in 101 short-circuits and the Tazer is used up. /tazer does the same.",
    "First Aid Kit": "Heals the player in view within 200 units, or the user, by 15 health up to 100. Refused above 99 health and under 50 (\"too badly wounded, get to a doctor\"). One is used up by the handler.",
    "Crack": "Halves the user's health at once and his speed for 12 seconds; blue screen pulses.",
    "Heroin": "Sets the user's health to 75 at once and doubles his speed for 12 seconds; magenta screen pulses.",
    "PCP": "Adds 100 health at once (200 at most); for 12 seconds god mode, a glow and double speed; green screen pulses.",
    "Mushroom": "Adds 50 health at once (200 at most); for 25 seconds double speed, a blue glow and hallucinations.",
    "Cocaine": "Adds 30 health at once (200 at most); a white glow and half speed for 7 seconds.",
    "Acid": "Adds 50 health at once (200 at most); for 180 seconds double speed and hallucinations.",
    "Steel Axe": "Police only (\"You are not a cop\"): smashes the door or breakable in view within 100 units, which is gone for 10 seconds.",
    "Door C2": "Police only (\"You are not a cop\"): plants it on the door or breakable in view within 100 units; after 5 seconds it blows (an explosion that hurts players near it) and the door is gone for 5 seconds. Used up.",
    "ATM Card": "Cannot be used (\"walk up to an ATM to use it\"). An ATM droid opens its menu only for a player who has one in /items.",
    "Debit Card": "Only says \"Say /withdraw to use this item\". With one in /items, /withdraw works anywhere and not only facing a teller.",
    "Chlorofoam": "Nothing at all: ARP_Items names a handler _Chlorofoam and defines none, so the core finds no function to run, tells the player nothing and leaves the item in his hands (not used up).",
    "Tape": "Gags the living player in view within 100 units: he cannot talk in chat or team chat, nor (arp_voice 1) in voice, until /removetape. One roll is used up.",
    "Rope": "Ties the living player in view within 100 units to the user: he is pulled toward the user when further than arp_h9_rope_length (150) units, and the rope snaps at four times that. Used on a tied player it frees him; so does /untie. Not used up.",
    "Assassin Knife": "Equips or puts away the knife (not used up). While it is equipped the next hit on a player within 100 units is an instant kill when the victim is not looking at the attacker, and \"missed an assassination\" when he is; either way it is put away. Works only if Ham_TakeDamage reaches the plugin: the plugin logs \"[ARP] Items: Ham_TakeDamage on player is delivered here\" at the first hit of a map when it does.",
    "Cuffs": "Cuffs the player in view within 200 units: his weapons are dropped, he glows red, moves at half speed, cannot attack or use, and is paid no salary. Used on a cuffed player it frees him. Police need no Cuffs: /cuff. A civilian's cuffing uses up one Cuffs, which goes back to whoever frees him (not to police). A cop cannot be cuffed.",
    "Motorola RAZR": "Opens the phone menu: Status (On, Invisible, Off), Ring (Ring, Vibrate, Silent) and Place Call, a phonebook of the other living players who carry one of the three phones; the other answers or ignores. The three phones are the same.",
    "Sony Ericsson": "The same as the Motorola RAZR.",
    "Nokia 6820": "The same as the Motorola RAZR.",
    "Phone Subscription": "Cannot be used (\"Use a phone, instead\"). Nothing in any plugin reads it: calls need no subscription.",
    "Phone Prepaid Card": "Cannot be used (\"Use a phone, instead\"). Nothing in any plugin reads it: calls need no card.",
    "Bug": "Bugs the living player in view within 100 units: the user then reads what that player says ([BUG] lines in chat) until a Bug Scanner clears it, the bugged player dies, or either of them leaves. Used up even when nobody is in view.",
    "Bug Scanner": "Scans the player in view within 100 units, or the user, for 5 seconds, then finds and removes every bug on him and tells both. Not used up.",
}


def describe(cat, S):
    """fills it['does'] and it['note'] of every item"""
    items = cat["items"]
    food = food_facts(S, items)
    alc = alcohol_facts(S, items)
    smoke = smoke_facts(S, items)
    by = {it["name"]: it for it in items}
    for name in food:
        f = food[name]
        verb = "Drinks" if f["drink"] else "Eats"
        extra = (" It also takes %d off thirst (arp_thirst_enabled 1)." % f["thirst"]) if f["thirst"] else ""
        refuse = "Refused, item kept, while hunger is under %d%s." % (f["hunger"], " and thirst is 0" if f["drink"] else "")
        by[name]["does"] = "%s it: takes %d off hunger at 5 a second, moving at half speed meanwhile.%s %s" % (verb, f["hunger"], extra, refuse)
    for name, n in alc.items():
        by[name]["does"] = "Drinks it: adds %d blood alcohol (a HUD line), which falls 1 every 4 seconds. Above 70 the user stumbles about with a yellow glow; above 100 the screen fades to black." % n
    for name, t in smoke.items():
        by[name]["does"] = "Puts it in the mouth for %d seconds of smoke; a Lighter or Zippo Lighter lights it. Used up." % t
    for name, text in DOES.items():
        if name not in by:
            raise GenError("DOES names %s, which is no item" % name)
        by[name]["does"] = text
    for it in items:
        g = it.get("gun")
        if g:
            if g["attach"]:
                first = "Opens the attachment menu (%s), then gives TS weapon %d (%s)." % (", ".join(g["attach"]), g["weapon"], g["tsw"])
            else:
                first = "Gives TS weapon %d (%s) at once: it has no attachment menu." % (g["weapon"], g["tsw"])
            custom = ""
            if g["weapon"] >= 39:
                custom = " With h9_customweapons 0 the gun is not given: the item is put back and the player told."
            it["does"] = first + " Used up." + custom
        a = it.get("ammo")
        if a:
            parts = []
            for f in a["fits"]:
                parts.append("%s %d" % (f["item"] if f["item"] else f["tsw"] + " (no item)", f["cap"]))
            it["does"] = "Refills the gun in hand to its cap when it takes this ammunition: %s. With any other gun in hand the item is kept." % ", ".join(parts)
    for it in items:
        if "does" not in it:
            raise GenError("no 'what it does' line for %s" % it["name"])
    # the notes
    for it in items:
        notes = []
        if it["cond"] == "arp_h9_restraints":
            notes.append("only while arp_h9_restraints is 1")
        if it.get("gun") and it["gun"]["weapon"] >= 39:
            notes.append("the gun is given only while h9_customweapons is 1")
        if not it["handler_defined"]:
            notes.append("no handler: using it does nothing")
        if it["name"] in ("Phone Subscription", "Phone Prepaid Card"):
            notes.append("no code reads it")
        if it["name"] in ("Steel Axe", "Door C2"):
            notes.append("police only")
        if not it["sold"]:
            notes.append("not sold by any NPC")
        it["note"] = "; ".join(notes)


# ---------------------------------------------------------------------------------------------------------------------------------------------------- the document
MAPNAME = {"h9_tsrp_hive": "hive", "h9_tsrp_newbyzantium": "New Byzantium"}
LINE_MAX = 199


def wrap(text, width):
    return textwrap.wrap(text, width=width, break_long_words=True, break_on_hyphens=False) or [""]


def table(cols, rows, indent=2, sep="  "):
    """a plain text table: cols is [(title, width, 'l' or 'r')], rows are lists of cell texts; a cell is wrapped to its column's width and a row is as high as its tallest cell"""
    def cell(s, w, a):
        return s.rjust(w) if a == "r" else s.ljust(w)
    out = [(" " * indent + sep.join(cell(t, w, a) for t, w, a in cols)).rstrip(), " " * indent + sep.join("-" * w for t, w, a in cols)]
    for row in rows:
        cells = [wrap(c, w) for c, (t, w, a) in zip(row, cols)]
        for i in range(max(len(c) for c in cells)):
            out.append((" " * indent + sep.join(cell(c[i] if i < len(c) else "", w, a) for c, (t, w, a) in zip(cells, cols))).rstrip())
    return out


def para(text, indent=2, width=170):
    return [" " * indent + ln for ln in textwrap.wrap(text, width=width - indent, break_on_hyphens=False)]


def entries(pairs, indent, width=170):
    """'Name price' entries joined by ', ' and wrapped between entries, never inside one"""
    lines, cur = [], ""
    for i, (n, p) in enumerate(pairs):
        e = "%s %s" % (n, p) + ("," if i < len(pairs) - 1 else "")
        if cur and len(indent * " ") + len(cur) + 1 + len(e) > width:
            lines.append(" " * indent + cur)
            cur = e
        else:
            cur = (cur + " " + e) if cur else e
    if cur:
        lines.append(" " * indent + cur)
    return lines


def names_on(npcs):
    """NPC names with a count for a name that stands more than once on the map"""
    order, count = [], {}
    for n in npcs:
        if n not in count:
            order.append(n)
        count[n] = count.get(n, 0) + 1
    return ", ".join(n if count[n] == 1 else "%s (%d)" % (n, count[n]) for n in order)


def role_maps_tag(r):
    maps = role_maps(r)
    if len(maps) == 2:
        return ""
    return " [%s only]" % MAPNAME[maps[0]]


def sold_text(it, cat):
    if not it["sold"]:
        return "not sold by any NPC"
    out = []
    for role, price, menu in it["sold"]:
        r = cat["shops"][role]
        tag = role_maps_tag(r)
        if menu is None:
            out.append("%s %d%s" % (role, price, tag))
        elif menu == "bank":
            out.append("%s %d (the bank menu)%s" % (role, price, tag))
        else:
            need = GUN_MENU_NEEDS[menu]
            out.append("%s %d (%s menu: %s)%s" % (role, price, GUN_MENU[menu], ("needs a " + need) if need else "no licence needed", tag))
    return "; ".join(out)


PLUGIN_TITLE = {
    "ARP_HungerMod": "food",
    "ARP_Items": "licences, tobacco, lighters, tools, drinks, drugs, door breakers, cards, the tazer, chlorofoam, Tape and Rope, the Assassin Knife",
    "ARP_JailMod": "Cuffs",
    "ARP_TalkArea": "phones, subscriptions, bugs",
    "ARP_TS": "guns and ammunition",
}


def number_ranges(cat):
    """plugin -> (first, last) of its numbers with arp_h9_restraints 1, and the same with 0 (None when it has no item then)"""
    out = {}
    for p in cat["register_order"]:
        a = [it["no"] for it in cat["items"] if it["plugin"] == p]
        b = [it["no_r0"] for it in cat["items"] if it["plugin"] == p and it["no_r0"] is not None]
        out[p] = ((min(a), max(a)), (min(b), max(b)) if b else None)
    return out


def span(t):
    if t is None:
        return "none"
    return "%d" % t[0] if t[0] == t[1] else "%d to %d" % t


def section_items(cat, plugin):
    items = [it for it in cat["items"] if it["plugin"] == plugin]
    nw = max(len(it["name"]) for it in cat["items"])
    lines = []
    cols = [("NO", 3, "r"), ("R0", 3, "r"), ("NAME", nw, "l"), ("DISP", 4, "l"), ("CUT", 3, "l"), ("DESCRIPTION", DESC_LEN, "l"), ("NOTE", 50, "l")]
    rows = [[str(it["no"]), str(it["no_r0"]) if it["no_r0"] is not None else "-", it["name"], "Yes" if it["disposable"] else "No", "cut" if it["truncated"] else "", it["description"], it["note"]]
            for it in items]
    lines += table(cols, rows)
    lines.append("")
    cols = [("NO", 3, "r"), ("NAME", nw, "l"), ("WHAT USING IT DOES", 82, "l"), ("SOLD BY", 52, "l")]
    rows = []
    for it in items:
        does = it["does"]
        if it["truncated"]:
            does += " Full description: \"%s\"" % it["desc_full"]
        rows.append([str(it["no"]), it["name"], does, sold_text(it, cat)])
    lines += table(cols, rows)
    return lines


def section_guns(cat):
    guns = [it for it in cat["items"] if it.get("gun")]
    nw = max(len(it["name"]) for it in cat["items"])
    cols = [("NO", 3, "r"), ("NAME", nw, "l"), ("TS WEAPON", 18, "l"), ("CLASS", 14, "l"), ("AMMUNITION ITEM", 20, "l"), ("CAP", 3, "r"), ("ATTACHMENTS", 41, "l")]
    rows = []
    for it in guns:
        g = it["gun"]
        rows.append([str(it["no"]), it["name"], "%d %s" % (g["weapon"], g["tsw"]), g["cls"], g["ammo_item"] or "none", str(g["cap"]) if g["ammo_item"] else "-", ", ".join(g["attach"]) or "none"])
    return table(cols, rows)


def section_shops(cat):
    out = []
    for role in ROLE_ORDER:
        r = cat["shops"].get(role)
        if not r:
            continue
        kind = {"shop": "shop", "bank": "bank", "doctor": "doctor", "gunshop": "gunshop", "atm": "atm"}[r["type"]]
        head = "%s (%s)" % (role, kind)
        out.append("  " + head)
        for mp in MAPS:
            if r["npcs"][mp]:
                out.append("    %s: %s" % (MAPNAME[mp], names_on(r["npcs"][mp])))
        if r["type"] == "doctor":
            out.append("    Heal Me $%d (1 health a second until 100; the player cannot move meanwhile), then" % r["heal"])
        if r["type"] == "bank":
            out.append("    Withdraw/Deposit (say /withdraw <amount> or /deposit <amount> facing it, or /withdraw with a Debit Card anywhere), then")
            out.extend(entries(r["bank"], 4))
        if r["type"] == "atm":
            out.append("    needs an ATM Card in /items; withdraws or deposits 10, 20, 50, 100, 250, 500 or 1000")
        if r["sells"]:
            out.extend(entries([(n, p) for n, p in r["sells"]], 4))
        if r["type"] == "gunshop":
            out.append("    three menus; a menu opens only for a player who has the licence of its name in /items, and the Licenses menu opens for anyone")
            for k in (0, 1, 2):
                need = GUN_MENU_NEEDS[k]
                out.append("    %s%s:" % (GUN_MENU[k], (" (needs a %s)" % need) if need else " (no licence needed)"))
                out.extend(entries([(n, p) for n, p in r["guns"][k]], 6))
        out.append("")
    return out


NOT_SOLD_WHY = [
    ("the six drugs", ["Crack", "Heroin", "PCP", "Mushroom", "Cocaine", "Acid"]),
    ("the Assassin Knife", ["Assassin Knife"]),
    ("the six guns with the class Prohibited that no gun shop line names", None),
    ("the ammunition of three of those guns (the M60E3 takes 5.56mm NATO Ammo, which is sold)", None),
]


def oddities(cat):
    items = cat["items"]
    out = []
    for it in items:
        if not it["handler_defined"]:
            out.append("%s (%d) is sold%s and has no handler: ARP_Items registers \"%s\" and defines no function of that name, so using it does nothing at all: the core finds no function to run, tells the player "
                       "nothing and leaves the item in his hands."
                       % (it["name"], it["no"], " for $%s" % "/".join(str(p) for r, p, m in it["sold"]) if it["sold"] else "", it["handler"]))
    out.append("Phone Subscription (%d) and Phone Prepaid Card (%d) are never read: calls need neither, and a character with one has nothing more than one without."
               % (cat["by_name"]["Phone Subscription"]["no"], cat["by_name"]["Phone Prepaid Card"]["no"]))
    for it in items:
        g = it.get("gun")
        if g and g.get("calibre_note"):
            out.append("%s (%d): the description says %s, but the ammunition it takes is %s." % (it["name"], it["no"], g["calibre"], g["ammo_item"]))
    nokind = [it for it in items if it.get("gun") and it["gun"]["calibre"] and not it["gun"]["ammo_item"]]
    if nokind:
        out.append("%s: no ammunition item refills %s (their ammunition type in ARP_TS is 0)." % (" and ".join("%s (%d)" % (i["name"], i["no"]) for i in nokind), "it" if len(nokind) == 1 else "them"))
    typo = [it for it in items if it.get("gun") and it["gun"]["cls_raw"] != it["gun"]["cls"]]
    if typo:
        out.append("The description of %s spells the class \"Non-Restriced\"; the list prints it so." % " and ".join("%s (%d)" % (i["name"], i["no"]) for i in typo))
    for nm in ("First Aid Kit", "Spray Can", "Tape", "Cuffs", "Lockpick", "Tazer"):
        if nm in cat["by_name"] and cat["by_name"][nm]["disposable"]:
            raise GenError("%s is disposable: the DISP sentence is wrong" % nm)
    out.append("DISP says No for the First Aid Kit, the Spray Can, Tape and Cuffs, which the handler (or, for the Spray Can, the spray key) still takes away, and for the Lockpick (it can snap) and the Tazer "
               "(it can short-circuit): the column is only what the core does after the handler has run.")
    return out


def render_doc(cat):
    items = cat["items"]
    rng = number_ranges(cat)
    r1, r0 = cat["total_r1"], cat["total_r0"]
    L = []
    add = L.append
    add("ARP ITEMS: THE CATALOGUE OF H9'S APOLLO RP")
    add("=" * 42)
    add("")
    L += para("Every item a character can carry on H9's two roleplay maps (h9_tsrp_hive and h9_tsrp_newbyzantium): its number, its name, what the game's own list prints for it, what using it does, and which shop "
              "sells it for how much. There are %d (%d with arp_h9_restraints 0). docs\\ARP_CONTENT.txt, section 5, has the counts and the shops in prose; this file is the catalogue." % (r1, r0))
    L += para("The tables are written by tools\\gen_items.py from the plugins' sources and the two npcs.ini files, and tools\\check_items.py compares them with what the game prints (arp_itemlist) and with "
              "docs\\ARP_CONTENT.txt (section 12 says how to run both). Apollo RP's ARP_BCompat, ARP_CS and ARP_TFC register items for other games; H9 does not run them and they are not here.")
    add("")
    add("  CONTENTS")
    toc = ["Listing items in the game, and what the number is", "Giving an item (admins)", "How to read the tables"]
    secno = 4
    plug_secs = {}
    for p in cat["register_order"]:
        n = cat["counts"][p]
        toc.append("%s: %s (%d)" % (p, PLUGIN_TITLE[p], n) if p != "ARP_TS" else "ARP_TS: guns (%d) and ammunition (%d)" % (sum(1 for it in items if it.get("gun")), sum(1 for it in items if it.get("ammo"))))
        plug_secs[p] = secno
        secno += 1
    toc += ["What each shop role sells", "Not sold by any NPC", "Odd things the code does", "Keeping this file true"]
    for i, t in enumerate(toc, 1):
        add("    %d. %s" % (i, t))
    add("")
    add("")

    # 1
    add("1. LISTING ITEMS IN THE GAME, AND WHAT THE NUMBER IS")
    add("-" * 52)
    add("")
    add("  In the game's console (the ~ key) any player can type")
    add("")
    add("      arp_itemlist          items 1 to 30")
    add("      arp_itemlist 30       items 31 to 60")
    add("      arp_itemlist 60       items 61 to 90")
    add("      arp_itemlist 90       items 91 to the last")
    add("")
    L += para("It is a command of a player's own console: it prints there, and the server's console does not know it (\"Unknown command\"). A page is arp_items_per_page items (30). The number after the command is the "
              "last item of the page before, and every page that is not the last ends with the command for the next one. A number past the last item answers \"No jobs to display at this area.\" "
              "(the core reuses the job list's words). A line reads")
    add("")
    add("      #<number>   <name>   <Yes or No>   <description>")
    add("")
    L += para("Yes is the item's disposable flag. The description is cut to 63 characters, as the core stores it. A player's own items: say /items (an H9 client opens the inventory window).")
    add("")
    last = (", with %s last, where build.bat appends it" % ", ".join(cat["not_listed"])) if cat["not_listed"] else ""
    L += para("THE NUMBER is the item's id. The core counts the calls of ARP_RegisterItem from 1 each time a map loads: ARP_Core runs the forward ARP_RegisterItems once, in its precache, and AMX Mod X calls the "
              "plugins in the order of configs\\plugins.ini, so the number follows the plugin order and, inside a plugin, the order of its calls. The order this file uses is H9's (plugins.ini's%s):" % last)
    add("")
    L += para(", ".join(cat["plugin_order"]), indent=6)
    add("")
    L += para("Five of them register items (ARP_PayScale and the others do not): %s. Moving a plugin in plugins.ini, a new plugin that registers items or a new item in one renumbers what follows. A character's "
              "items are kept by name (the table arp_items holds \"<character key>|<item name>\"), so a renumbering moves nobody's things; but a number typed into arp_createitems, or noted down, then means another item."
              % ", ".join("%s %s" % (p, span(rng[p][0])) for p in cat["register_order"]))
    add("")
    gone = [it for it in items if it["no_r0"] is None]
    shifted = sorted({it["no"] - it["no_r0"] for it in items if it["no_r0"] is not None})
    first_shift = min(it["no"] for it in items if it["no_r0"] is not None and it["no"] != it["no_r0"])
    firsts = []
    for d in shifted:
        if d:
            f = [it for it in items if it["no_r0"] is not None and it["no"] - it["no_r0"] == d][0]
            firsts.append("from %s (%d) on, %d lower" % (f["name"], f["no"], d))
    L += para("arp_h9_restraints (configs\\arp\\arp.cfg, 1 as shipped) decides whether %s exist; ARP_Items and ARP_JailMod read it from arp.cfg when the items are registered, so a change needs a map change. "
              "With 0 there are %d items: those before %s (%d) keep their numbers, and a later one is lower by the number of those missing before it (%s). Both numbers are in the tables: NO is "
              "the number with the shipped 1, R0 the number with 0."
              % (", ".join("%s (%d)" % (it["name"], it["no"]) for it in gone[:-1]) + " and %s (%d)" % (gone[-1]["name"], gone[-1]["no"]), r0, [it for it in items if it["no"] == first_shift][0]["name"], first_shift,
                 "; ".join(firsts)))
    add("")
    add("")

    # 2
    add("2. GIVING AN ITEM (ADMINS)")
    add("-" * 26)
    add("")
    add("  An ARP admin (docs\\ARP_ADMINS.txt, section 8) gives items from the server's console or from his own:")
    add("")
    add("      arp_createitems \"<player>\" \"<item name or part of it>\" <n>")
    add("      arp_createitems \"<player>\" <number> <n>")
    add("")
    amb = cat["ambiguous"]
    L += para("The item is a number from this file or a part of a name, in any case. A part that fits two items is refused (\"Found more than one item with that name.\"): %s. So is any other part that "
              "two names hold, such as \"GLOCK\" or \"Ammo\"; say more of the name, or give the number. arp_removeitems and arp_setitems take the same arguments (docs\\ARP_COMMANDS.txt, 6)."
              % ", ".join("\"%s\" (it is in %s)" % (k, " and ".join("\"%s\"" % o for o in v)) for k, v in amb.items()))
    add("")
    add("")

    # 3
    add("3. HOW TO READ THE TABLES")
    add("-" * 25)
    add("")
    L += para("Each plugin has a list table (what the game prints, with the numbers) and a table of what its items do and where they are sold; the ARP_TS section has a third, of its guns.")
    add("")
    add("    NO            the number with arp_h9_restraints 1, as shipped.  R0: the number with 0; \"-\" for an item that does not exist then.")
    add("    NAME          as the list prints it.")
    add("    DISP          Yes: the core takes one away after the item's handler has run. No: it stays, unless the handler takes one itself (each line says).")
    add("    CUT           \"cut\" where the stored description is longer than the 63 characters the list prints; the whole text is in the next table.")
    add("    DESCRIPTION   as the list prints it, spelling and all.")
    add("    NOTE          what is special about the item.")
    add("    SOLD BY       the shop role and its price in credits. A role is one stock: every NPC of a role, on both maps, sells the same things at the same prices (section 9 names the NPCs).")
    add("                  \"not sold by any NPC\": no shop line, gun shop line or bank menu names the item. An admin gives it (arp_createitems), or players hand it on.")
    add("                  A gun shop's price comes with the licence its menu asks for; a shop (the Black Market too) asks for none.")
    add("")
    add("")

    # plugin sections
    for p in cat["register_order"]:
        n = cat["counts"][p]
        sec = plug_secs[p]
        title = "%d. %s: %s (%d)" % (sec, p, PLUGIN_TITLE[p], n)
        if p == "ARP_TS":
            title = "%d. ARP_TS: guns (%d) and ammunition (%d)" % (sec, sum(1 for it in items if it.get("gun")), sum(1 for it in items if it.get("ammo")))
        add(title)
        add("-" * len(title))
        add("")
        a, b = rng[p]
        L += para((("Number %s" if a[0] == a[1] else "Numbers %s") % span(a)) + ((" (with arp_h9_restraints 0: %s)." % span(b)) if b else " (with arp_h9_restraints 0 the item does not exist)."))
        add("")
        L += section_items(cat, p)
        add("")
        if p == "ARP_TS":
            L += para("The guns: the TS weapon number and name (H9's tsconst.inc; 39 and 40 are H9's own, of its reTS), the class the description gives, the ammunition item that refills the gun and the cap it refills to "
                      "(g_AmmoTypes and g_WeaponAmmo of ARP_TS), and the attachments the menu offers (g_GunStats).")
            add("")
            L += section_guns(cat)
            add("")
            L += para("TS weapons that have no item here: %s." % ", ".join("%d %s" % (w["weapon"], w["tsw"]) for w in cat["ts_no_item"]))
            add("")
        add("")

    # shops
    add("%d. WHAT EACH SHOP ROLE SELLS" % (secno))
    add("-" * len("%d. WHAT EACH SHOP ROLE SELLS" % (secno)))
    add("")
    L += para("Price in credits, as the npcs.ini lines say (an item by any part of its name: ARP takes the shortest name that holds the text). The same role sells the same list on both maps. Where a name has a "
              "number in brackets, that many NPCs of the map carry the name. With arp_h9_restraints 0 the sell lines for Tape, Rope and Cuffs name no item and the shop's menu shows "
              "\"BAD ITEM ID: Contact admin\" for each (%s)." % "; ".join("%s: %s" % (role, ", ".join(sorted(n for n, rr in cat["bad_r0"] if rr == role))) for role in ROLE_ORDER if any(rr == role for n, rr in cat["bad_r0"])))
    add("")
    L += section_shops(cat)
    secno += 1

    # not sold
    t = "%d. NOT SOLD BY ANY NPC" % secno
    add(t)
    add("-" * len(t))
    add("")
    ns = [it for it in items if not it["sold"]]
    L += para("%d items: no shop line, gun shop line or bank menu of either map names them." % len(ns))
    add("")
    drugs = [it["name"] for it in ns if it["handler"] in ("_Crack", "_Heroin", "_PCP", "_Mushroom", "_Cocaine", "_Acid")]
    other = [it["name"] for it in ns if it["handler"] == "_AssassinKnife"]
    pguns = [it["name"] for it in ns if it.get("gun")]
    pammo = [it["name"] for it in ns if it.get("ammo")]
    add("    Drugs               %s" % ", ".join(drugs))
    add("    Other               %s" % ", ".join(other))
    add("    Guns (Prohibited)   %s" % ", ".join(pguns))
    add("    Their ammunition    %s" % ", ".join(pammo))
    add("")
    secno += 1
    add("")

    # oddities
    t = "%d. ODD THINGS THE CODE DOES" % secno
    add(t)
    add("-" * len(t))
    add("")
    for o in oddities(cat):
        L += [ln for ln in textwrap.wrap(o, width=168, initial_indent="  - ", subsequent_indent="    ", break_on_hyphens=False)]
    add("")
    add("")
    secno += 1

    # keeping it true
    t = "%d. KEEPING THIS FILE TRUE" % secno
    add(t)
    add("-" * len(t))
    add("")
    L += para("The tables are not typed: tools\\gen_items.py rebuilds them from the plugins' sources (the five plugins above, ARP_NPCs, the two npcs.ini files, plugins.ini and build.bat for the order, "
              "tsconst.inc and ApolloRP_TS.inc for the TS weapons). After an item, a plugin's order, a shop line or a price changes (an NPC whose name no role knows stops the generator and says which: one line in ROLE_OF of gen_items.py gives it its role):")
    add("")
    add("      python tools\\gen_items.py --doc docs\\ARP_ITEMS.txt         writes this file again")
    add("      python tools\\gen_items.py --facts                           checks the facts the \"what it does\" lines rest on against the plugins (%d patterns); one that fails names the line to read again" % (sum(len(f[2]) for f in FACTS) + len(UNREAD)))
    add("      python tools\\check_items.py                                 this file against the sources, against docs\\ARP_CONTENT.txt (section 5) and against arp_itemlist")
    add("")
    L += para("check_items.py reads a capture of arp_itemlist: run arp_itemlist, arp_itemlist 30, arp_itemlist 60 and arp_itemlist 90 in a game's console, save the text (the pages may be pasted one after "
              "the other) and give the file with --itemlist. With the shipped arp_h9_restraints it must show %d items, and with 0, %d; every name, disposable flag and description must be the table's." % (r1, r0))
    for i, ln in enumerate(L):
        if len(ln) > LINE_MAX:
            raise GenError("a line of %d characters: %s" % (len(ln), ln[:80]))
        if any(ord(ch) > 127 for ch in ln):
            raise GenError("a non-ASCII character: %r" % ln)
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------------------------------------------------------------------------------------------- output
def summary(cat):
    out = []
    out.append("plugin order: %s" % ", ".join(cat["plugin_order"]))
    if cat["not_listed"]:
        out.append("in build.bat's ARP_TARGETS and not yet in plugins.ini (build.bat appends them): %s" % ", ".join(cat["not_listed"]))
    out.append("items: %d (arp_h9_restraints 1), %d (0): %s" % (cat["total_r1"], cat["total_r0"], ", ".join("%s %d" % (p, n) for p, n in cat["counts"].items())))
    out.append("guns: %d, ammunition kinds: %d, TS weapons with no item: %s" % (sum(1 for it in cat["items"] if it.get("gun")), len(cat["ts"]["kind_item"]), ", ".join("%d %s" % (w["weapon"], w["tsw"]) for w in cat["ts_no_item"])))
    out.append("not sold by any NPC (%d): %s" % (len(cat["not_sold"]), ", ".join(cat["not_sold"])))
    out.append("sell lines that name no item with arp_h9_restraints 0: %s" % ", ".join("%s at %s" % (n, r) for n, r in cat["bad_r0"]))
    out.append("names that are part of another item's name (arp_createitems refuses them): %s" % ", ".join("%s in %s" % (k, "/".join(v)) for k, v in cat["ambiguous"].items()))
    for role in ROLE_ORDER:
        r = cat["shops"].get(role)
        if r:
            out.append("role %-26s %-8s %s" % (role, r["type"], "; ".join("%s: %d NPC(s)" % (MAPNAME[m], len(r["npcs"][m])) for m in MAPS if r["npcs"][m])))
    for w in cat["warnings"]:
        out.append("WARNING: " + w)
    return "\n".join(out)


def to_json(cat):
    items = []
    for it in cat["items"]:
        d = {k: it[k] for k in ("no", "no_r0", "plugin", "name", "handler", "description", "desc_full", "truncated", "disposable", "cond", "does", "note", "handler_defined")}
        d["sold"] = [dict(role=r, price=p, menu=m, npcs={MAP_SHORT[mp]: cat["shops"][r]["npcs"][mp] for mp in MAPS if cat["shops"][r]["npcs"][mp]}) for r, p, m in it["sold"]]
        if it.get("gun"):
            d["gun"] = it["gun"]
        if it.get("ammo"):
            d["ammo"] = it["ammo"]
        items.append(d)
    shops = {}
    for role, r in cat["shops"].items():
        shops[role] = dict(type=r["type"], heal=r["heal"], npcs=r["npcs"], sells=[list(x) for x in r["sells"]], bank=r["bank"], guns={GUN_MENU[k]: [list(x) for x in r["guns"][k]] for k in (0, 1, 2)})
    return json.dumps(dict(plugin_order=cat["plugin_order"], total_r1=cat["total_r1"], total_r0=cat["total_r0"], items=items, shops=shops, not_sold=cat["not_sold"], warnings=cat["warnings"],
                           md5=cat["md5"]), indent=1, sort_keys=True)


def write_crlf_ascii(path, text):
    assert all(ord(c) < 128 for c in text)
    with open(path, "wb") as f:
        f.write(text.replace("\r\n", "\n").replace("\n", "\r\n").encode("ascii"))


def main(argv=None):
    ap = argparse.ArgumentParser(description="the catalogue of Apollo RP's items as H9 runs them, rebuilt from the sources")
    ap.add_argument("--root", default=DEFAULT_ROOT, help="the repository (default %s)" % DEFAULT_ROOT)
    ap.add_argument("--doc", metavar="FILE", help="write the catalogue as docs\\ARP_ITEMS.txt (ASCII, CRLF)")
    ap.add_argument("--json", metavar="FILE", help="write the data as JSON")
    ap.add_argument("--facts", action="store_true", help="check the facts the 'what it does' lines rest on against the plugins; exit 1 when one fails")
    a = ap.parse_args(argv)
    try:
        cat = build(a.root)
    except GenError as e:
        print("gen_items: " + str(e))
        return 2
    if a.facts:
        bad, n = check_facts(cat["S"])
        print("%d patterns checked, %d failed" % (n, len(bad)))
        for b in bad:
            print("  FAIL " + b)
        return 1 if bad else 0
    if a.doc:
        write_crlf_ascii(a.doc, render_doc(cat))
        print("wrote " + a.doc)
    if a.json:
        with open(a.json, "w", newline="\n") as f:
            f.write(to_json(cat) + "\n")
        print("wrote " + a.json)
    if not a.doc and not a.json:
        print(summary(cat))
    return 0


if __name__ == "__main__":
    sys.exit(main())
