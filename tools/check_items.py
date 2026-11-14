#!/usr/bin/env python3
"""check_items.py -- is docs\\ARP_ITEMS.txt true?

    python check_items.py [--root D:\\Downloads\\TSM] [--docs DIR] [--capture-dir DIR] [--itemlist FILE ...] [--verbose]

Reads only. Exit 1 when a check fails. What it compares (gen_items.py must be in the same folder):
  sources    docs\\ARP_ITEMS.txt is exactly what gen_items.py writes from the plugins' sources and the two npcs.ini files now;
  tables     its list tables number the items 1..N (and 1..M with arp_h9_restraints 0) without a gap, in the plugin order, and say the counts the text says;
  content    its shop roles sell what docs\\ARP_CONTENT.txt, section 5, says they sell (item by item, price by price), the counts by plugin and the "not sold by any NPC" list agree,
             and the four docs that point to it (ARP_CONTENT, ARP_COMMANDS, ARP_ADMINS, APOLLO_RP) do;
  itemlist   every capture of arp_itemlist given with --itemlist (the text of the game's console, one or more pages in any order, or the rig's capture) numbers, names, disposable flags and
             descriptions the way the doc's list tables do: a capture of 95 items against the NO column, one of 92 against the R0 column;
  rig        with --capture-dir (default: the folder capture\\ beside this script, when it exists): the rig's captures of both settings and both maps (arp_itemlist_r<R>_<map>.txt,
             items_dump_r<R>_<map>.txt, shops_dump_r<R>_<map>.txt, extras_r1.txt): the same comparison, the plugin and handler of every item against the sources, what ARP_NPCs held
             after it read each npcs.ini against what the generator reads from it, and which names arp_createitems refuses.
A capture of the game's own console is the only thing here that needs a game: save the pages of arp_itemlist, arp_itemlist 30, 60 and 90 and give the file with --itemlist.
"""
import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_items as G  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--root", default=G.DEFAULT_ROOT)
ap.add_argument("--docs", help="the folder of the docs (default: docs\\ of the root): ARP_ITEMS.txt, ARP_CONTENT.txt, ARP_COMMANDS.txt, ARP_ADMINS.txt, APOLLO_RP.txt")
ap.add_argument("--doc", help="the catalogue (default: ARP_ITEMS.txt of the docs folder)")
ap.add_argument("--itemlist", action="append", default=[], help="a capture of arp_itemlist (the game's console text); may be given more than once")
ap.add_argument("--capture-dir", help="the rig's captures (default: capture\\ beside this script)")
ap.add_argument("--verbose", action="store_true")
args = ap.parse_args()

fails = []
passes = 0


def check(ok, what, detail=""):
    global passes
    if ok:
        passes += 1
        if args.verbose:
            print("PASS  " + what)
    else:
        fails.append(what)
        print("FAIL  " + what + (": " + str(detail) if detail else ""))
    return ok


def rd(path):
    return G.read_text(path)


DOCS = args.docs or os.path.join(args.root, "docs")
DOC_PATH = args.doc or os.path.join(DOCS, "ARP_ITEMS.txt")
doc = rd(DOC_PATH)
doc_lines = doc.split("\n")

try:
    cat = G.build(args.root)
except G.GenError as e:
    print("FAIL  gen_items.py cannot read the sources: %s" % e)
    sys.exit(1)
items = cat["items"]
by_no = {it["no"]: it for it in items}
by_r0 = {it["no_r0"]: it for it in items if it["no_r0"] is not None}

# ---------------------------------------------------------------------------------------------------------------------------------------------------- sources
want = G.render_doc(cat)
ok = doc == want
detail = ""
if not ok:
    a, b = doc.split("\n"), want.split("\n")
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else "<end of file>"
        y = b[i] if i < len(b) else "<end of output>"
        if x != y:
            detail = "first difference at line %d:\n    file: %s\n    made: %s" % (i + 1, x[:150], y[:150])
            break
check(ok, "sources: docs\\ARP_ITEMS.txt is what gen_items.py writes now (rerun: python gen_items.py --doc docs\\ARP_ITEMS.txt)", detail)
raw = open(DOC_PATH, "rb").read()
check(b"\r\n" in raw and raw.count(b"\n") == raw.count(b"\r\n") and all(c < 128 for c in raw), "the file is ASCII with CRLF line ends")
check(max(len(ln) for ln in doc_lines) < 200, "no line of 200 characters or more", max(len(ln) for ln in doc_lines))
bad_facts, nfacts = G.check_facts(cat["S"])
check(not bad_facts, "the %d facts the 'what it does' lines rest on hold in the plugins (python gen_items.py --facts)" % nfacts, "; ".join(bad_facts[:3]))
for w in cat["warnings"]:
    print("note  the generator says: " + w)


# ---------------------------------------------------------------------------------------------------------------------------------------------------- the doc's list tables
def parse_tables(lines):
    """the list tables of the doc: rows of (no, r0, name, disp, cut, description, note), found by their rule line under a header that starts with NO and R0"""
    rows = []
    i = 0
    while i < len(lines) - 2:
        head = lines[i]
        if re.match(r"^\s+NO\s+R0\s+NAME\s+DISP\s+CUT\s+DESCRIPTION\s+NOTE\s*$", head) and set(lines[i + 1].strip()) <= set("- "):
            spans = [(m.start(), m.end()) for m in re.finditer(r"-+", lines[i + 1])]
            j = i + 2
            while j < len(lines) and lines[j].strip():
                ln = lines[j]
                cells = [ln[a:b].strip() if a < len(ln) else "" for a, b in spans[:-1]] + [ln[spans[-1][0]:].strip()]
                if cells[0]:
                    rows.append(tuple(cells))
                j += 1
            i = j
        else:
            i += 1
    return rows


rows = parse_tables(doc_lines)
check(len(rows) == cat["total_r1"], "tables: %d items in the list tables" % cat["total_r1"], len(rows))
nos = [int(r[0]) for r in rows]
check(nos == list(range(1, len(rows) + 1)), "tables: the NO column runs 1..%d in order, across the plugin sections" % len(rows))
r0s = [int(r[1]) for r in rows if r[1] != "-"]
check(r0s == list(range(1, cat["total_r0"] + 1)), "tables: the R0 column runs 1..%d in order ('-' for the %d items arp_h9_restraints 0 removes)" % (cat["total_r0"], len(rows) - len(r0s)))
doc_item = {int(r[0]): dict(no=int(r[0]), r0=None if r[1] == "-" else int(r[1]), name=r[2], disp=r[3], cut=r[4], desc=r[5], note=r[6]) for r in rows}
check(all(doc_item[no]["name"] == by_no[no]["name"] for no in doc_item if no in by_no), "tables: the names are the sources' names, in the sources' order")

# ---------------------------------------------------------------------------------------------------------------------------------------------------- arp_itemlist
LINE = re.compile(r"^#(\d+)   (.+?)   (Yes|No)(?:   (.*))?$")


def parse_itemlist(text):
    """the items of a capture of the game's console: number -> (name, Yes/No, description), and the problems found (a number twice with different text)"""
    out, bad = {}, []
    for ln in text.replace("\r", "").split("\n"):
        m = LINE.match(ln.rstrip())
        if not m:
            continue
        no = int(m.group(1))
        rec = (m.group(2), m.group(3), (m.group(4) or "").rstrip())
        if no in out and out[no] != rec:
            bad.append("#%d twice, differently" % no)
        out[no] = rec
    return out, bad


def check_itemlist(label, text):
    got, bad = parse_itemlist(text)
    check(bool(got), "%s: it holds arp_itemlist lines (#<n>   <name>   Yes|No   <description>)" % label)
    if not got:
        return None
    n = len(got)
    check(not bad, "%s: no number is printed twice differently" % label, bad)
    check(sorted(got) == list(range(1, n + 1)), "%s: the numbers run 1..%d without a gap (all pages were captured)" % (label, n), sorted(set(range(1, n + 1)) - set(got))[:10])
    if n == cat["total_r1"]:
        mode, table = "NO (arp_h9_restraints 1)", {no: by_no[no] for no in by_no}
        docrow = lambda no: doc_item.get(no)  # noqa: E731
    elif n == cat["total_r0"]:
        mode, table = "R0 (arp_h9_restraints 0)", by_r0
        r0map = {d["r0"]: d for d in doc_item.values() if d["r0"] is not None}
        docrow = lambda no: r0map.get(no)  # noqa: E731
    else:
        check(False, "%s: %d items is neither the doc's %d nor its %d" % (label, n, cat["total_r1"], cat["total_r0"]))
        return None
    check(True, "%s: %d items, compared with the doc's %s column" % (label, n, mode))
    diffs = []
    for no, (name, disp, desc) in sorted(got.items()):
        d = docrow(no)
        if d is None:
            diffs.append("#%d is not in the doc" % no)
            continue
        if d["name"] != name:
            diffs.append("#%d name: game %r, doc %r" % (no, name, d["name"]))
        if d["disp"] != disp:
            diffs.append("#%d disposable: game %s, doc %s" % (no, disp, d["disp"]))
        if d["desc"] != desc:
            diffs.append("#%d description: game %r, doc %r" % (no, desc, d["desc"]))
        if d["cut"] == "cut" and len(desc) != G.DESC_LEN:
            diffs.append("#%d is marked cut but the game's description is %d characters, not %d" % (no, len(desc), G.DESC_LEN))
    check(not diffs, "%s: every name, disposable flag and description is the doc's (%d items)" % (label, n), "; ".join(diffs[:5]) + (" ..." if len(diffs) > 5 else ""))
    return n


for path in args.itemlist:
    check_itemlist("capture " + os.path.basename(path), rd(path))

# ---------------------------------------------------------------------------------------------------------------------------------------------------- docs\ARP_CONTENT.txt, section 5
content = rd(os.path.join(DOCS, "ARP_CONTENT.txt"))
m = re.search(r"\n5\. ITEMS AND THE SHOPS\n-+\n(.*?)\n6\. THE NPCs", content, re.S)
check(m is not None, "content: docs\\ARP_CONTENT.txt has section 5 (ITEMS AND THE SHOPS) before section 6")
sec5 = m.group(1) if m else ""
sec5_lines = sec5.split("\n")

mm = re.search(r"There are (\d+), all registered in code", sec5)
check(mm is not None and int(mm.group(1)) == cat["total_r1"], "content: section 5 says there are %d items" % cat["total_r1"], mm.group(1) if mm else "no such sentence")
want_counts = {p: n for p, n in cat["counts"].items()}
got_counts = {mx.group(2): int(mx.group(1)) for mx in re.finditer(r"^\s+(\d+)\s+(ARP_\w+)\b", sec5, re.M)}
check(got_counts == want_counts, "content: the counts by plugin are %s" % ", ".join("%s %d" % kv for kv in want_counts.items()), got_counts)
mm = re.search(r"with 0 there are (\d+)", sec5)
check(mm is not None and int(mm.group(1)) == cat["total_r0"], "content: it says %d items with arp_h9_restraints 0" % cat["total_r0"], mm.group(1) if mm else "no such sentence")
nguns = sum(1 for it in items if it.get("gun"))
nammo = sum(1 for it in items if it.get("ammo"))
check(re.search(r"%d\s+ARP_TS \(%d guns, two of them H9's own, and %d ammunition kinds\)" % (cat["counts"]["ARP_TS"], nguns, nammo), sec5) is not None, "content: ARP_TS is %d guns (two of them H9's own) and %d ammunition kinds" % (nguns, nammo))


def resolve(text):
    """the item a sell or addgun line means by this text: ARP takes the shortest name that holds it (section 5 says Skorpion for vz. 61 "Skorpion")"""
    hit = G.find_ids(items, text, "no")
    return hit[0]["name"] if hit else text


def entries_of(text, resolved=False):
    """'Name price, Name price' -> [(name, price)]"""
    out = []
    for part in re.split(r",\s+", re.sub(r"\s+", " ", text.strip().rstrip(",."))):
        mt = re.match(r"^(.*\S)\s+\$?(\d+)$", part.strip())
        if mt:
            out.append((resolve(mt.group(1)) if resolved else mt.group(1), int(mt.group(2))))
    return out


def roles_of_content(lines):
    roles, i = {}, 0
    while i < len(lines):
        ln = lines[i]
        mh = re.match(r"^  (\S.*?) \((shop|doctor|gunshop|bank|atm)\b[^)]*\)(?::\s*(.*))?$", ln)
        if not mh:
            i += 1
            continue
        role, kind, rest = mh.group(1), mh.group(2), mh.group(3) or ""
        j = i + 1
        block = []
        while j < len(lines) and lines[j].strip():
            block.append(lines[j])
            j += 1
        if kind == "shop":
            roles[role] = dict(kind=kind, sells=entries_of(" ".join(block), True))
        elif kind == "doctor":
            text = " ".join([rest] + block)
            hm = re.search(r"Heal Me \$(\d+)", text)
            tail = text.split(", then", 1)[1] if ", then" in text else ""
            roles[role] = dict(kind=kind, heal=int(hm.group(1)) if hm else None, sells=entries_of(tail, True))
        elif kind == "gunshop":
            menus, cur = {}, None
            for b in block:
                lm = re.match(r"^\s+(Permitted|Restricted|Licenses)\b.*:\s*$", b)
                if lm:
                    cur = lm.group(1)
                    menus[cur] = ""
                elif cur:
                    menus[cur] += " " + b.strip()
            roles[role] = dict(kind=kind, guns={k: entries_of(v, True) for k, v in menus.items()})
        i = j
    return roles


def roles_of_doc(lines):
    start = next(i for i, ln in enumerate(lines) if re.match(r"^\d+\. WHAT EACH SHOP ROLE SELLS$", ln))
    end = next(i for i, ln in enumerate(lines) if i > start and re.match(r"^\d+\. NOT SOLD BY ANY NPC$", ln))
    sub = []
    for ln in lines[start:end]:
        if re.match(r"^    (hive|New Byzantium): ", ln):
            continue
        sub.append(ln)
    roles, i = {}, 0
    while i < len(sub):
        mh = re.match(r"^  (\S.*?) \((shop|doctor|gunshop|bank|atm)\)$", sub[i])
        if not mh:
            i += 1
            continue
        role, kind = mh.group(1), mh.group(2)
        j = i + 1
        block = []
        while j < len(sub) and sub[j].strip():
            block.append(sub[j])
            j += 1
        if kind == "shop":
            roles[role] = dict(kind=kind, sells=entries_of(" ".join(block)))
        elif kind == "doctor":
            hm = re.search(r"Heal Me \$(\d+)", " ".join(block))
            roles[role] = dict(kind=kind, heal=int(hm.group(1)) if hm else None, sells=entries_of(" ".join(b for b in block if not b.strip().startswith("Heal Me") and "then" not in b)))
        elif kind == "gunshop":
            menus, cur = {}, None
            for b in block:
                lm = re.match(r"^    (Permitted|Restricted|Licenses)\b.*:\s*$", b)
                if lm:
                    cur = lm.group(1)
                    menus[cur] = ""
                elif cur:
                    menus[cur] += " " + b.strip()
            roles[role] = dict(kind=kind, guns={k: entries_of(v) for k, v in menus.items()})
        elif kind == "bank":
            roles[role] = dict(kind=kind, sells=entries_of(" ".join(b for b in block if not b.strip().startswith("Withdraw"))))
        elif kind == "atm":
            roles[role] = dict(kind=kind)
        i = j
    return roles


croles = roles_of_content(sec5_lines)
droles = roles_of_doc(doc_lines)
check(len(droles) == len(cat["shops"]), "content: the doc's shop section has the %d roles of the sources" % len(cat["shops"]), sorted(droles))
for role in G.ROLE_ORDER:
    r = cat["shops"].get(role)
    if not r:
        continue
    d = droles.get(role)
    if r["type"] in ("shop", "doctor"):
        want = [(n, p) for n, p in r["sells"]]
        check(d is not None and d.get("sells") == want, "doc: %s sells %s" % (role, ", ".join("%s %d" % x for x in want[:3]) + (" ..." if len(want) > 3 else "")), d)
        if r["type"] == "doctor":
            check(d is not None and d.get("heal") == r["heal"], "doc: %s heals for $%s" % (role, r["heal"]))
        c = croles.get(role)
        check(c is not None, "content: section 5 has the role %s" % role)
        if c is not None:
            check(c.get("sells") == want, "content: section 5 says %s sells the same list, price by price" % role, "doc %s / content %s" % (want, c.get("sells")))
            if r["type"] == "doctor":
                check(c.get("heal") == r["heal"], "content: section 5 says %s heals for $%s" % (role, r["heal"]), c.get("heal"))
    elif r["type"] == "gunshop":
        want = {G.GUN_MENU[k]: [(n, p) for n, p in r["guns"][k]] for k in (0, 1, 2)}
        check(d is not None and d.get("guns") == want, "doc: %s sells the three menus of its sources" % role)
        c = croles.get(role)
        check(c is not None and c.get("guns") == want, "content: section 5 has the same three menus for %s, price by price" % role, c)
    elif r["type"] == "bank":
        check(d is not None and d.get("sells") == [(n, p) for n, p in r["bank"]], "doc: the bank menu sells %s" % ", ".join("%s %d" % x for x in r["bank"]), d)
        check(re.search(r"Buy ATM Card \$%d, Buy Debit Card \$%d" % (r["bank"][0][1], r["bank"][1][1]), re.sub(r"\s+", " ", sec5)) is not None, "content: section 5 says Buy ATM Card $%d, Buy Debit Card $%d" % (r["bank"][0][1], r["bank"][1][1]))
    elif r["type"] == "atm":
        check(d is not None and "ATM Droid" in droles, "doc: the ATM Droid role is there")

# not sold
ns = cat["not_sold"]
m = re.search(r"^\s+Not sold by any NPC:(.*)$", sec5, re.M)
sentence = re.sub(r"\s+", " ", m.group(1)) if m else ""
check(bool(sentence), "content: section 5 has a 'Not sold by any NPC' sentence")
missing = [n for n in ns if n.lower() not in sentence.lower()]
# a gun may be named in the sentence by its short name (AK-47 for Kalashnikova AK-47): its description's own words are tried too
short = {"Kalashnikova AK-47": "AK-47", "U.S. Ordnance M60E3": "M60E3", "Sawed-Off Shotgun": "sawed-off", "G2 Contender": "Contender"}
missing = [n for n in missing if short.get(n, "\0").lower() not in sentence.lower()]
check(not missing, "content: its 'Not sold by any NPC' sentence names all %d items the sources say no NPC sells" % len(ns), "missing: %s" % ", ".join(missing))
lead = [x.strip() for x in re.split(r",| and ", sentence.split("(")[0].replace("the six", ",")) if x.strip().rstrip(".")]
extra = [x.rstrip(".") for x in lead if x.rstrip(".") and x.rstrip(".").lower() not in " ".join(ns).lower() and not x.lower().startswith("prohibited") and "gun" not in x.lower() and "above" not in x.lower()]
check(not extra, "content: nothing in that sentence is sold by an NPC", ", ".join(extra))
ND = [ln for ln in doc_lines if re.match(r"^    (Drugs|Other|Guns \(Prohibited\)|Their ammunition)\s", ln)]
doc_ns = []
for ln in ND:
    doc_ns += [x.strip() for x in re.sub(r"^\s+\S.*?\s{2,}", "", ln).split(", ")]
check(sorted(doc_ns) == sorted(ns), "doc: its 'not sold' section lists the %d items the sources leave out" % len(ns), sorted(set(doc_ns) ^ set(ns)))

# pointers
for name in ("ARP_CONTENT.txt", "ARP_COMMANDS.txt", "ARP_ADMINS.txt", "APOLLO_RP.txt"):
    t = rd(os.path.join(DOCS, name))
    check("ARP_ITEMS.txt" in t, "pointer: docs\\%s names docs\\ARP_ITEMS.txt" % name)

# ---------------------------------------------------------------------------------------------------------------------------------------------------- the rig's captures
capdir = args.capture_dir or os.path.join(HERE, "capture")
MAPS = ("h9_tsrp_hive", "h9_tsrp_newbyzantium")
if os.path.isdir(capdir):
    for R in ("1", "0"):
        counts = {}
        for mp in MAPS:
            p = os.path.join(capdir, "arp_itemlist_r%s_%s.txt" % (R, mp))
            if os.path.exists(p):
                n = check_itemlist("rig arp_itemlist, arp_h9_restraints %s, %s" % (R, mp), rd(p))
                want_n = cat["total_r1"] if R == "1" else cat["total_r0"]
                check(n == want_n, "rig arp_itemlist, arp_h9_restraints %s, %s: %d items" % (R, mp, want_n), n)
                counts[mp] = n
            else:
                check(False, "rig: %s is there" % os.path.basename(p))
        # the core's own table: plugin file and handler of each item
        for mp in MAPS:
            p = os.path.join(capdir, "items_dump_r%s_%s.txt" % (R, mp))
            if not os.path.exists(p):
                continue
            recs = {}
            for ln in rd(p).split("\n"):
                if ln.startswith("ITEM|"):
                    f = ln.split("|")
                    recs[int(f[1])] = dict(name=f[2], disp="Yes" if f[3] == "1" else "No", plugin=f[4], handler=f[5], desc="|".join(f[6:]))
            table = by_no if R == "1" else by_r0
            diffs = []
            for no, it in table.items():
                r = recs.get(no)
                if not r:
                    diffs.append("#%d missing" % no)
                    continue
                if (r["name"], r["plugin"], r["handler"], r["desc"].rstrip(), r["disp"]) != (it["name"], it["plugin"] + ".amxx", it["handler"], it["description"].rstrip(), "Yes" if it["disposable"] else "No"):
                    diffs.append("#%d: core %s vs sources %s" % (no, (r["name"], r["plugin"], r["handler"]), (it["name"], it["plugin"] + ".amxx", it["handler"])))
            check(len(recs) == len(table) and not diffs, "rig items dump, arp_h9_restraints %s, %s: the core holds %d items, each with the sources' name, plugin, handler, description and flag" % (R, mp, len(table)), "; ".join(diffs[:4]) or len(recs))
        # what ARP_NPCs held
        for mp in MAPS:
            p = os.path.join(capdir, "shops_dump_r%s_%s.txt" % (R, mp))
            if not os.path.exists(p):
                continue
            mode = "no" if R == "1" else "no_r0"
            npcs, _ = G.parse_npcs(os.path.join(args.root, G.MAPDIR, mp, "npcs.ini"), items, mode)
            kept = [n for n in npcs if not n["model"] or os.path.exists(os.path.join(args.root, "H9XASH", "ts", n["model"].replace("/", os.sep)))]
            dump = {"npc": [], "sell": {}, "gun": {}}
            for ln in rd(p).split("\n"):
                f = ln.split("|")
                if f[0] == "NPC":
                    dump["npc"].append((f[2], int(f[3].split("=")[1])))
                elif f[0] == "SELL":
                    dump["sell"].setdefault(int(f[1]), []).append((int(f[3]), f[5], int(f[6])))
                elif f[0] == "GUN":
                    dump["gun"].setdefault((int(f[1]), int(f[2])), []).append((int(f[4]), f[5], int(f[7 - 1])))
            diffs = []
            if [n["name"] for n in kept] != [x[0] for x in dump["npc"]]:
                diffs.append("the NPCs differ: sources %d, plugin %d" % (len(kept), len(dump["npc"])))
            else:
                num = lambda nm: next((it[mode] for it in items if it["name"] == nm), 0)  # noqa: E731
                for idx, n in enumerate(kept):
                    if (n["heal"] if n["heal"] is not None else -1) != dump["npc"][idx][1]:
                        diffs.append("%s heal" % n["name"])
                    want_s = [(num(s["item"]) if s["item"] else 0, s["item"] or "", s["price"]) for s in n["sells"]]
                    if want_s != dump["sell"].get(idx, []):
                        diffs.append("%s sells" % n["name"])
                    for k in (0, 1, 2):
                        want_g = [(num(g["item"]), g["item"], g["price"]) for g in n["guns"][k]]
                        if want_g != dump["gun"].get((idx, k), []):
                            diffs.append("%s menu %d" % (n["name"], k))
            check(not diffs, "rig shops dump, arp_h9_restraints %s, %s: ARP_NPCs holds what gen_items.py reads from npcs.ini (%d NPCs: every sell line, price, heal and gun menu)" % (R, mp, len(kept)), "; ".join(diffs[:5]))
    p = os.path.join(capdir, "extras_r1.txt")
    if os.path.exists(p):
        ex = rd(p)
        refused = sorted(re.findall(r"^FIND\|([^|]*)\|REFUSED\|", ex.split("== h9i_find:")[0], re.M))
        check(refused == sorted(cat["ambiguous"]), "rig: arp_createitems refuses exactly the names a part of which is in another name: %s" % ", ".join(sorted(cat["ambiguous"])), refused)
        ids = {}
        for mt in re.finditer(r"^FIND\|([^|]*)\|(\d+)\|(.*)$", ex.split("== h9i_find:")[0], re.M):
            ids[mt.group(1)] = int(mt.group(2))
        okids = all(ids.get(it["name"]) == it["no"] for it in items if it["name"] not in cat["ambiguous"])
        check(okids, "rig: every other item's own name finds that item (and no other) by arp_createitems' lookup")
        mu = re.search(r"USING \d+ Chlorofoam: the slot holds (\d+)\nRETURNED \d+: the slot holds (\d+)", ex)
        check(mu is not None and mu.group(1) == mu.group(2), "rig: using Chlorofoam (the core's own ItemUse) leaves the item's count as it was", mu.groups() if mu else "no such lines")
        check(re.search(r"no-such-handler: forward=-1", ex) is not None, "rig: AMX Mod X finds no function _Chlorofoam in ARP_Items to make a forward of")
else:
    print("note  no rig captures (%s): the checks of the rig's captures were not run" % capdir)

print("\n%d checks, %d failed" % (passes + len(fails), len(fails)))
sys.exit(1 if fails else 0)
