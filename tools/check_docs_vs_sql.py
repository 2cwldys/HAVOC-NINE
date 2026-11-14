#!/usr/bin/env python
"""check_docs_vs_sql.py -- the hive's data against its docs.

    python check_docs_vs_sql.py --root D:\\Downloads\\TSM [--bsp <h9_tsrp_hive.bsp>] [--base-sql <the .sql before the scale>]

Recomputes, from the .sql (and the compiled map), the counts, the tiers, every price, the for-sale / state / open / sealed partition, the
door table, the descriptions, the list of doors left out and the migration file's price lines, and fails (exit 1) if docs\\ARP_CONTENT.txt,
docs\\APOLLO_RP.txt, docs\\ARP_TAX_CHECKS.txt or price_migration.txt say anything else. The rule is written out again here: it shares no
code with gen_prices.py, only the three numbers it reads from the top of that file (PRICE_MULTIPLIER, CULT_GATE_PRICE, RECT_POD_FACTOR) and,
as the last check, its --check run (the files are what it would write).
"""
import argparse
import json
import math
import os
import re
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REL = dict(
    sql=r"apollo-rp\base\addons\amxmodx\configs\arp\maps\h9_tsrp_hive\h9_tsrp_hive.sql",
    mig=r"apollo-rp\base\addons\amxmodx\configs\arp\maps\h9_tsrp_hive\price_migration.txt",
    npcs=r"apollo-rp\base\addons\amxmodx\configs\arp\maps\h9_tsrp_hive\npcs.ini",
    cfg=r"apollo-rp\base\addons\amxmodx\configs\arp\arp.cfg",
    content=r"docs\ARP_CONTENT.txt",
    apollo=r"docs\APOLLO_RP.txt",
    tax=r"docs\ARP_TAX_CHECKS.txt",
    origin=r"apollo-rp\ORIGIN.txt",
)
results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok)))
    print("%s  %s%s" % ("PASS" if ok else "FAIL", label, ("  -- " + detail) if (detail and not ok) else ""))
    return bool(ok)


def lines_of(path):
    b = open(path, "rb").read()
    return b.decode("ascii"), b


def L(path):
    return lines_of(path)[0].replace("\r", "").split("\n")


# ----------------------------------------------------------------------------- the rule, written out again
def sig2_exact(n):
    """round half up to two significant figures of a whole number, without floats"""
    n = int(n)
    if n < 100:
        return n
    digits = len(str(n))
    q = 10 ** (digits - 2)
    return ((n + q // 2) // q) * q


def tier_of(kind, area, doors):
    if kind in ("stall", "pod"):
        return 0
    if kind == "public":
        return 5
    base = {"residence": 1, "workroom": 1, "luxury": 2, "business": 2}[kind]
    step = 1 if area is None else (0 if area < 60 else 1 if area < 150 else 2 if area < 250 else 3)
    return min(5, base + step + (1 if doors >= 4 else 0))


def read_const(name):
    src = open(os.path.join(HERE, "gen_prices.py"), encoding="ascii").read()
    return float(re.search(r"^%s\s*=\s*([0-9.]+)" % name, src, re.M).group(1))


# ----------------------------------------------------------------------------- parse the .sql
PROP = re.compile(r"^INSERT OR IGNORE INTO arp_property VALUES \('([^']*)','((?:[^']|'')*)','([^']*)','([^']*)',(\d+),(\d+),'([^']*)',(\d+)\);$")
DOOR = re.compile(r"^INSERT OR IGNORE INTO arp_doors VALUES \('t\|([^']*)','([^']*)'\);$")
JOB = re.compile(r"^INSERT OR IGNORE INTO arp_jobs VALUES \('([^']*)',(\d+),'([^']*)'\);$")


def parse_sql(path):
    text, raw = lines_of(path)
    ls = text.replace("\r", "").split("\n")
    if ls and ls[-1] == "":
        ls.pop()
    d = dict(raw=raw, lines=ls, props={}, order=[], doors={}, door_owner={}, jobs={}, bad=[])
    for i, ln in enumerate(ls):
        m = PROP.match(ln)
        if m:
            g = m.groups()
            d["props"][g[0]] = dict(heading=g[1].replace("''", "'"), owner=g[2], auth=g[3], price=int(g[4]), locked=int(g[5]), access=g[6], profit=int(g[7]),
                                    comment=(ls[i - 1][3:] if i and ls[i - 1].startswith("-- ") else ""))
            d["order"].append(g[0])
            continue
        m = DOOR.match(ln)
        if m:
            d["doors"].setdefault(m.group(2), []).append(m.group(1))
            d["door_owner"].setdefault(m.group(1).lower(), []).append(m.group(2))
            continue
        m = JOB.match(ln)
        if m:
            d["jobs"][m.group(1)] = int(m.group(2))
            continue
        if ln.startswith("INSERT"):
            d["bad"].append((i + 1, ln[:60]))
    return d


# ----------------------------------------------------------------------------- the map
def bsp_doors(path):
    data = open(path, "rb").read()
    ofs, ln = struct.unpack_from("<ii", data, 4)
    text = data[ofs:ofs + ln].split(b"\x00")[0].decode("latin-1")
    names = {}
    cur = None
    for line in text.splitlines():
        s = line.strip()
        if s == "{":
            cur = {}
        elif s == "}":
            if cur and cur.get("classname", "") in ("func_door", "func_door_rotating") and cur.get("targetname"):
                names.setdefault(cur["targetname"].lower(), []).append(cur["targetname"])
            cur = None
        elif cur is not None and s.startswith('"'):
            mm = re.match(r'^"([^"]*)"\s+"([^"]*)"', s)
            if mm:
                cur[mm.group(1)] = mm.group(2)
    return names


# ----------------------------------------------------------------------------- the doc
def block_after(lines, first, stop=lambda l: l.strip() == ""):
    i = next((k for k, l in enumerate(lines) if first(l)), None)
    if i is None:
        return None, []
    j = next((k for k in range(i + 1, len(lines)) if stop(lines[k])), len(lines))
    return i, lines[i:j]


def join_paragraph(lines, start_pred, end_pred):
    i = next((k for k, l in enumerate(lines) if start_pred(l)), None)
    if i is None:
        return ""
    j = next((k for k in range(i, len(lines)) if end_pred(lines[k])), len(lines) - 1)
    return re.sub(r"\s+", " ", " ".join(x.strip() for x in lines[i:j + 1]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--bsp", default=r"D:\Downloads\TSM\H9XASH\ts\maps\h9_tsrp_hive.bsp")
    ap.add_argument("--base-sql", default=os.path.join(HERE, "base_h9_tsrp_hive.sql"))
    a = ap.parse_args()
    P = {k: os.path.join(a.root, v) for k, v in REL.items()}
    M = int(read_const("PRICE_MULTIPLIER")) if float(read_const("PRICE_MULTIPLIER")).is_integer() else read_const("PRICE_MULTIPLIER")
    CULT = int(read_const("CULT_GATE_PRICE"))
    RECT = int(read_const("RECT_POD_FACTOR"))
    TAXP = read_const("TAX_PERCENT")
    TAXM = int(read_const("TAX_MINUTES"))
    sql = parse_sql(P["sql"])
    base = parse_sql(a.base_sql)
    content = L(P["content"])
    apollo = L(P["apollo"])
    tax = L(P["tax"])
    props, order = sql["props"], sql["order"]
    print("multiplier %s, cult gate %d, rectangular pod factor %d, tax %g percent every %d minutes" % (M, CULT, RECT, TAXP, TAXM))

    # ---- the .sql itself
    check("sql: ASCII, CRLF, no line over 1000 characters", all(b < 128 for b in sql["raw"]) and sql["raw"].count(b"\n") == sql["raw"].count(b"\r\n") and max(len(x) for x in sql["lines"]) <= 1000)
    check("sql: every INSERT line is one the loader takes", not sql["bad"], str(sql["bad"][:3]))
    dup_p = len(order) - len(set(order))
    check("sql: no property name twice", dup_p == 0, str(dup_p))
    dup_d = [d for d, v in sql["door_owner"].items() if len(v) > 1]
    check("sql: no door name in two properties (or twice)", not dup_d, str(dup_d[:5]))
    check("sql: every door row names a property of the file", all(p in props for p in sql["doors"]), str([p for p in sql["doors"] if p not in props]))
    check("sql: every property has a door", all(p in sql["doors"] for p in order), str([p for p in order if p not in sql["doors"]]))
    check("sql: external names at most 32 characters", all(len(props[p]["heading"]) <= 32 for p in order))
    check("sql: no owner, no profit in any row", all(not props[p]["owner"] and not props[p]["auth"] and props[p]["profit"] == 0 for p in order))
    check("sql: access letters are a, b or g only", all(set(props[p]["access"]) <= set("abg") for p in order))

    # ---- the map
    names = bsp_doors(a.bsp) if os.path.exists(a.bsp) else None
    if names is None:
        check("map: the compiled BSP is there (%s)" % a.bsp, False)
    else:
        bound = {d.lower() for v in sql["doors"].values() for d in v}
        check("map: every bound door name is a func_door or func_door_rotating of the compiled map", bound <= set(names), str(sorted(bound - set(names))[:5]))
        ents = sum(len(names[d]) for d in bound if d in names)
        jail = {"al_jail1act", "al_jail2act", "al_jail3act", "al_jail4act"}
        left_out = sorted(set(names) - bound - jail)
        print("      %d door names in the map, %d bound (%d entities), %d jail wall panels, %d left out" % (len(names), len(bound), ents, len(jail & set(names)), len(left_out)))

    # ---- counts
    ndoor = len(sql["door_owner"])
    forsale = [p for p in order if props[p]["price"] > 0]
    state = [p for p in order if props[p]["price"] == 0]

    # ---- the tier table of the doc
    i, tbl = block_after(content, lambda l: l.startswith("  property                  kind       area   doors  tier  price"))
    rows = {}
    seq = []
    row_re = re.compile(r"^  (h9_\w+)\s+(\w+)\s+(-|\d+k)\s+(\d+)\s+(\d)\s+(\d+)(\*?)\s+(\d+|new)\s*$")
    for l in tbl[2:]:
        m = row_re.match(l)
        if m:
            n, kind, area, doors, tier, price, star, was = m.groups()
            rows[n] = dict(kind=kind, area=None if area == "-" else int(area[:-1]), doors=int(doors), tier=int(tier), price=int(price), star=bool(star), was=was)
            seq.append(n)
    check("table: one row for each for-sale property and no other", set(rows) == set(forsale), "missing %s extra %s" % (sorted(set(forsale) - set(rows))[:4], sorted(set(rows) - set(forsale))[:4]))
    check("table: doors column is the number of door names of the .sql", all(rows[n]["doors"] == len(sql["doors"].get(n, [])) for n in rows if n in props))
    check("table: tier is the rule's (kind base, area step, 4 or more doors, at most 5)", all(rows[n]["tier"] == tier_of(rows[n]["kind"], rows[n]["area"], rows[n]["doors"]) for n in rows),
          str([n for n in rows if rows[n]["tier"] != tier_of(rows[n]["kind"], rows[n]["area"], rows[n]["doors"])][:5]))
    scale = [sig2_exact(sig2_exact(1200 * 2 ** t) * M) for t in range(6)]
    pod_price = sig2_exact(RECT * M * sig2_exact(1200))
    exp = {}
    for n in forsale:
        if n == "h9_al_cult_gate":
            exp[n] = CULT
        elif n.startswith("h9_xe_rect_pod"):
            exp[n] = pod_price
        elif n in rows:
            exp[n] = scale[rows[n]["tier"]]
    check("prices: every for-sale price in the .sql is the scale of its tier (the cult gate and the rectangular pods by hand)", all(props[n]["price"] == exp.get(n) for n in forsale),
          str([(n, props[n]["price"], exp.get(n)) for n in forsale if props[n]["price"] != exp.get(n)][:5]))
    check("table: price column equals the .sql (the hand-priced marked *)", all(rows[n]["price"] == props[n]["price"] and rows[n]["star"] == (n == "h9_al_cult_gate" or n.startswith("h9_xe_rect_pod")) for n in rows if n in props))
    town = lambda n: {"h9_pc_": 0, "h9_xe_": 1, "h9_al_": 2}.get(n[:6], 9)
    check("table: sorted by tier, town (pc, xe, al), name", seq == sorted(seq, key=lambda n: (rows[n]["tier"], town(n), n)))
    wrong_was = []
    for n in rows:
        src = {"h9_pc_bar_paradise": "h9_pc_flat_res4", "h9_pc_flat_res4": "h9_pc_flat_res4a"}.get(n, n)
        want = str(base["props"][src]["price"]) if src in base["props"] and base["props"][src]["price"] > 0 else "new"
        if rows[n]["was"] != want:
            wrong_was.append((n, rows[n]["was"], want))
    check("table: the 'was' column is the price in the .sql before the scale (base_h9_tsrp_hive.sql)", not wrong_was, str(wrong_was[:4]))
    tiers = [sum(1 for n in rows if rows[n]["tier"] == t) for t in range(6)]

    # ---- the partition
    sale_p = [props[n] for n in forsale]
    n_open = sum(1 for p in sale_p if p["locked"] == 0)
    n_letter = sum(1 for p in sale_p if p["locked"] == 1 and p["access"])
    n_plain = sum(1 for p in sale_p if p["locked"] == 1 and not p["access"])
    st_open = sum(1 for n in state if props[n]["locked"] == 0)
    st_letter = sum(1 for n in state if props[n]["locked"] == 1)
    print("      %d properties: %d for sale (tiers %s; open %d, letter %d, sealed until bought %d), %d state (sealed to a letter %d, open %d); %d door names" % (
        len(order), len(forsale), tiers, n_open, n_letter, n_plain, len(state), st_letter, st_open, ndoor))
    check("state: every state property has a letter or is open to everyone (locked 0 and no letter)", all((props[n]["locked"] == 1 and props[n]["access"]) or (props[n]["locked"] == 0 and not props[n]["access"]) for n in state))

    # ---- the counts paragraph
    para = join_paragraph(content, lambda l: re.match(r"^  \d+ of the \d+ properties are for sale until somebody has one", l) is not None, lambda l: l.startswith("  A property with an owner keeps"))
    m = re.match(r"^(\d+) of the (\d+) properties are for sale until somebody has one: tier 0 (\d+), tier 1 (\d+), tier 2 (\d+), tier 3 (\d+), tier 4 (\d+), tier 5 (\d+) ", para)
    ok = bool(m) and [int(x) for x in m.groups()] == [len(forsale), len(order)] + tiers
    check("doc counts: '%s of the %s properties are for sale: tier 0 ... tier 5'" % (len(forsale), len(order)), ok, para[:140])
    m = re.search(r"The other (\d+) are state property, which nobody can buy: no owner, price 0\. (\d+) are sealed to a letter.*?; (\d+) stand open to everyone", para)
    check("doc counts: the state properties (%d: %d sealed to a letter, %d open)" % (len(state), st_letter, st_open), bool(m) and [int(x) for x in m.groups()] == [len(state), st_letter, st_open], para[300:520])
    nmig_doc = re.search(r"price_migration\.txt beside the \.sql file: (\d+) lines", para)
    mig_text = L(P["mig"])
    mig_lines = [l for l in mig_text if l.startswith("arp_query ")]
    check("doc counts: the migration file has the %s lines the doc says" % (nmig_doc.group(1) if nmig_doc else "?"), bool(nmig_doc) and int(nmig_doc.group(1)) == len(mig_lines), "file has %d" % len(mig_lines))
    hand = re.search(r"the (\d+) rectangular pods count in tier 0 and the Cult Gate in tier 1, the tiers their kinds give them, but the owner priced them by hand: ([\d,]+) each and ([\d,]+), marked", para)
    npods = sum(1 for n in forsale if n.startswith("h9_xe_rect_pod"))
    check("doc counts: the hand-priced rows (%d pods at %d, the cult gate at %d)" % (npods, pod_price, CULT),
          bool(hand) and int(hand.group(1)) == npods and int(hand.group(2).replace(",", "")) == pod_price and int(hand.group(3).replace(",", "")) == CULT and rows.get("h9_al_cult_gate", {}).get("tier") == 1 and all(rows[n]["tier"] == 0 for n in rows if n.startswith("h9_xe_rect_pod")))
    para2 = join_paragraph(content, lambda l: re.match(r"^  h9_tsrp_hive: \d+ properties, \d+ door names", l) is not None, lambda l: l.startswith("  The other") and "state property:" in l)
    m = re.match(r"^h9_tsrp_hive: (\d+) properties, (\d+) door names \((\d+) entities; .*? (\d+) are for sale until somebody has one: (\d+) stand open to anyone until then \(.*?\), (\d+) are sealed to the Medical Division and keyholders \(.*?\), and (\d+) are homes and businesses sealed until bought\. The other (\d+) are state property: (\d+) sealed to the Ministry's guards \(.*?\) and (\d+) open to everyone", para2)
    got = [int(x) for x in m.groups()] if m else None
    want = [len(order), ndoor, ents if names else None, len(forsale), n_open, n_letter, n_plain, len(state), st_letter, st_open]
    check("doc counts: the partition paragraph of the door table", got == want, "doc %s computed %s" % (got, want))
    check("doc counts: section 9's first paragraph (%d properties with %d door names)" % (len(order), ndoor), any(("the hive %d properties with %d door names" % (len(order), ndoor)) in re.sub(r"\s+", " ", l + " " + content[k + 1]) for k, l in enumerate(content[:-1])))

    # ---- the PRICES paragraph
    pp = join_paragraph(content, lambda l: l.startswith("  PRICES are one geometric scale"), lambda l: l.rstrip().endswith("at most 5:"))
    pay = {k: sql["jobs"][k] * 3600 // 60 for k in ("Citizen", "Merchant", "Legate", "Lord Minister")}
    perhour = TAXP * 60.0 / TAXM
    taxh = [int(math.ceil(p * TAXP / 100.0)) * (60 // TAXM) for p in scale]
    exp_list = "  ".join("{:,}".format(p) for p in scale)
    check("doc prices: the six tier prices (%s) and the multiplier" % ", ".join("{:,}".format(p) for p in scale), ("times %g, to two" % M) in pp and exp_list.replace("  ", " ") in re.sub(r"\s+", " ", pp), pp[:200])
    def h(x):
        v = round(x * 10) / 10.0
        return ("%d" % v) if v == int(v) else ("%.1f" % v)
    need =["The base, {:,}, is {} hours of a Citizen's pay".format(scale[0], h(scale[0] / pay["Citizen"])),
            "The dearest, {:,}, is {} hours of a Lord Minister's pay".format(scale[5], h(scale[5] / pay["Lord Minister"])),
            "and {} of a Legate's".format(h(scale[5] / pay["Legate"])),
            "a Citizen needs {} hours of pay".format(int(round(scale[5] / float(pay["Citizen"])))),
            "tier 0 costs {:,} an hour ({} percent of a Citizen's pay)".format(taxh[0], int(round(100.0 * taxh[0] / pay["Citizen"]))),
            "tier 3 ({:,}) {:,} ({} percent of a Merchant's)".format(scale[3], taxh[3], int(round(100.0 * taxh[3] / pay["Merchant"]))),
            "tier 5 {:,} ({} percent of a Lord Minister's)".format(taxh[5], int(round(100.0 * taxh[5] / pay["Lord Minister"]))),
            "(%g percent an hour" % perhour, "costs the owner %g percent of the price every %d minutes" % (TAXP, TAXM)]
    miss = [x for x in need if x not in pp]
    check("doc prices: hours of pay and the tax per hour of each tier", not miss, str(miss[:3]))
    if os.path.exists(P["cfg"]):
        cfg = open(P["cfg"], encoding="ascii", errors="replace").read()
        mp = re.search(r'^arp_h9_tax_percent\s+"([\d.]+)"', cfg, re.M)
        mm = re.search(r'^arp_h9_tax_minutes\s+"(\d+)"', cfg, re.M)
        check("cfg: arp_h9_tax_percent and arp_h9_tax_minutes are what the prices' tax numbers assume (%g, %d)" % (TAXP, TAXM), bool(mp and mm) and float(mp.group(1)) == TAXP and int(mm.group(1)) == TAXM)

    # ---- the door table
    i, dt = block_after(content, lambda l: l.startswith("  property                  plaque heading"))
    drows = []
    for l in dt[2:]:
        if re.match(r"^  h9_", l):
            drows.append([l[2:26].strip(), l[28:57].strip(), l[59:133].strip(), l[135:141].strip(), l[143:149].strip(), l[151:].strip()])
        elif drows:
            drows[-1][2] += " " + l.strip()
    ok_rows = []
    for n, heading, dlist, price, locked, access in drows:
        p = props.get(n)
        good = p is not None and heading == p["heading"] and [x.strip() for x in dlist.split(",")] == sql["doors"].get(n) and price == ("-" if p["price"] == 0 else str(p["price"])) \
            and locked == ("yes" if p["locked"] else "no") and access == (p["access"] or "-")
        if not good:
            ok_rows.append(n)
    check("door table: every row (heading, doors, price, locked, access) is the .sql's", not ok_rows and {r[0] for r in drows} == set(order) and len(drows) == len(order), str(ok_rows[:5]))

    # ---- the descriptions
    i, wy = block_after(content, lambda l: l.startswith("  Why each"))
    ent = {}
    cur = None
    for l in wy[1:]:
        m = re.match(r"^    (h9_\w+): (.*)$", l)
        if m:
            cur = m.group(1)
            ent[cur] = m.group(2)
        elif cur:
            ent[cur] += " " + l.strip()
    bad = []
    for n in order:
        c = props[n]["comment"]
        body = (c.split(": ", 1)[1] if ": " in c else c) + "."
        if re.sub(r"\s+", " ", ent.get(n, "")) != re.sub(r"\s+", " ", body):
            bad.append(n)
    check("descriptions: one line for each property, the .sql comment's text", not bad and set(ent) == set(order), str(bad[:5]))

    # ---- the towns
    towns = {"al": sum(1 for n in order if n.startswith("h9_al_")), "pc": sum(1 for n in order if n.startswith("h9_pc_")), "xe": sum(1 for n in order if n.startswith("h9_xe_"))}
    check("towns: every property name has one of the three prefixes", sum(towns.values()) == len(order))
    ct = join_paragraph(content, lambda l: "Of the hive's 131 property names" in l or re.search(r"Of the hive's \d+ property names", l) is not None, lambda l: "jailmod.ini); no name of the file" in l)
    m = re.search(r"Of the hive's (\d+) property names \(the file's (\d+),.*? (\d+) are Alexandria's, (\d+) Paradise City's and (\d+) Xenon City's", ct)
    check("towns: ARP_CONTENT paragraph says %s" % towns, bool(m) and [int(x) for x in m.groups()] == [len(order) + 1, len(order), towns["al"], towns["pc"], towns["xe"]], ct[:200])
    t_al = re.search(r"h9_al_\* \((\d+) of the file\) and h9_jail", "\n".join(content))
    t_pc = re.search(r"h9_pc_\* \((\d+)\)", "\n".join(content))
    t_xe = re.search(r"h9_xe_\* \((\d+)\)", "\n".join(content))
    check("towns: ARP_CONTENT table says %s" % towns, bool(t_al and t_pc and t_xe) and (int(t_al.group(1)), int(t_pc.group(1)), int(t_xe.group(1))) == (towns["al"], towns["pc"], towns["xe"]))
    ap_txt = re.sub(r"\s+", " ", " ".join(apollo))
    m = re.search(r"h9_al_, Alexandria, (\d+) properties of the file and the jail's h9_jail; pc: h9_pc_, Paradise City, (\d+); xe: h9_xe_, Xenon City, (\d+)\)", ap_txt)
    check("towns: APOLLO_RP section 11 says %s" % towns, bool(m) and [int(x) for x in m.groups()] == [towns["al"], towns["pc"], towns["xe"]])

    # ---- the log line
    nstat = len(sql["jobs"]) + len(order) + ndoor
    m = re.search(r"\[ARP\] map SQL: (\d+) statements, 0 errors, jobs now (\d+), properties now (\d+), doors now (\d+)\" for the start \(the file's (\d+) jobs, (\d+) properties and (\d+) doors", ap_txt)
    check("log line: APOLLO_RP section 6 (%d statements, %d jobs, %d properties, %d doors)" % (nstat, len(sql["jobs"]), len(order) + 1, ndoor + 4),
          bool(m) and [int(x) for x in m.groups()] == [nstat, len(sql["jobs"]), len(order) + 1, ndoor + 4, len(sql["jobs"]), len(order), ndoor])
    c_txt = re.sub(r"\s+", " ", " ".join(content))
    m = re.search(r"\(the hive: (\d+), (\d+) and (\d+) on a database that has", c_txt)
    check("log line: ARP_CONTENT section 2 (%d, %d and %d)" % (nstat, len(order) + 1, ndoor + 4), bool(m) and [int(x) for x in m.groups()] == [nstat, len(order) + 1, ndoor + 4])

    # ---- the doors left out
    if names is not None:
        nl = join_paragraph(content, lambda l: l.startswith("  NOT IN ANY PROPERTY."), lambda l: l.strip() == "")
        m = re.search(r"The hive has (\d+) door names; (\d+) are bound above, the jails' four wall panels are h9_jail's, and the other (\d+) are left out", nl)
        check("left out: the header (%d names, %d bound, %d left out)" % (len(names), len(bound), len(left_out)), bool(m) and [int(x) for x in m.groups()] == [len(names), len(bound), len(left_out)], nl[:160])
        i = next(k for k, l in enumerate(content) if l.startswith("  NOT IN ANY PROPERTY."))
        j = next(k for k in range(i, len(content)) if content[k].startswith("    The clandestine armory's vent grille"))
        sect = content[i:j]
        cats = []
        k = 0
        while k < len(sect):
            mc = re.match(r"^    ([A-Z][A-Z' ,\.]+?)(?:, [a-z][^(]*?)? \((\d+)\)", sect[k]) if sect[k].startswith("    ") and not sect[k].startswith("      ") else None
            if mc:
                cats.append([mc.group(1), int(mc.group(2)), []])
                k += 1
                continue
            ml = re.match(r"^      \((.*)", sect[k])
            if ml and cats:
                buf = ml.group(1)
                while not buf.rstrip().endswith(")") and k + 1 < len(sect):
                    k += 1
                    buf += " " + sect[k].strip()
                cats[-1][2] += [x.strip() for x in buf.rstrip()[:-1].split(",")]
            k += 1
        listed = [n for c in cats for n in c[2]]
        check("left out: the categories' counts are the lengths of their lists", all(c[1] == len(c[2]) for c in cats) and len(cats) >= 6, str([(c[0], c[1], len(c[2])) for c in cats]))
        check("left out: the listed names are exactly the %d the map has and the .sql does not bind (and each once)" % len(left_out), sorted(x.lower() for x in listed) == left_out and len(listed) == len(set(listed)),
              "missing %s extra %s" % (sorted(set(left_out) - {x.lower() for x in listed})[:6], sorted({x.lower() for x in listed} - set(left_out))[:6]))

    # ---- the migration file
    prices_in_mig = {}
    for l in mig_lines:
        m = re.match(r"^arp_query UPDATE arp_property_h9_tsrp_hive SET price=(\d+) WHERE internalname='([^']+)' AND ownerauth=''$", l)
        if m:
            prices_in_mig[m.group(2)] = int(m.group(1))
    want = {n: props[n]["price"] for n in order if props[n]["price"] > 0 or (n in base["props"] and base["props"][n]["price"] > 0)}
    check("migration: one price line for each for-sale property and each one that became state property, with the .sql's price", prices_in_mig == want,
          "missing %s wrong %s" % (sorted(set(want) - set(prices_in_mig))[:4], [(n, prices_in_mig[n], want[n]) for n in prices_in_mig if n in want and prices_in_mig[n] != want[n]][:4]))
    check("migration: every line is a comment or one arp_query of at most 255 characters (a console line), and each acts on a named row with a guard (ownerauth, a door or a name that is free)",
          all((l.startswith("--") or l.strip() == "" or (l.startswith("arp_query ") and len(l) <= 255)) for l in mig_text) and all("ownerauth" in l or "targetname=" in l or " NOT IN " in l for l in mig_lines),
          "longest %d" % max(len(l) for l in mig_lines))
    check("migration: ASCII and CRLF", all(b < 128 for b in open(P["mig"], "rb").read()))
    said = []
    for key in ("content", "apollo", "origin"):
        for mm in re.finditer(r"price_migration\.txt \((\d+) lines", re.sub(r"\s+", " ", " ".join(L(P[key])))):
            said.append((key, int(mm.group(1))))
    check("migration: every doc that says how many lines price_migration.txt has says %d (%s)" % (len(mig_lines), said), bool(said) and all(n == len(mig_lines) for k, n in said))
    gone = ["h9_al_midgar_kiosk", "h9_al_shores_cells", "h9_pc_flat_res4a"]
    check("migration: the deleted and renamed rows are handled (delete lines for the kiosk and the cells, the bar and flat 4 renames and headings, six pod headings)",
          sum(1 for l in mig_lines if "DELETE FROM" in l and any(("internalname='%s'" % g) in l for g in gone[:2])) == 2 and
          sum(1 for l in mig_lines if "SET externalname='Rectangular Pod" in l) == 6 and
          any("SET internalname='h9_pc_bar_paradise' WHERE internalname='h9_pc_flat_res4'" in l for l in mig_lines) and
          any("SET externalname='Paradise Bar' WHERE internalname='h9_pc_bar_paradise'" in l for l in mig_lines) and
          any("SET internalname='h9_pc_flat_res4' WHERE internalname='h9_pc_flat_res4a'" in l for l in mig_lines) and
          any("SET externalname='Paradise Flat 4' WHERE internalname='h9_pc_flat_res4'" in l for l in mig_lines) and
          sum(1 for l in mig_lines if "SET internalname='h9_al_midgar_office' WHERE targetname=" in l) == 3)

    # ---- stale names in the data and the generated blocks
    stale = [("h9_al_midgar_kiosk", "Midgar Kiosk"), ("h9_al_shores_cells", "Shores Detention"), ("h9_pc_flat_res4a", "Paradise Flat 4A"), ("Rect Pod", "a rect pod")]
    sql_text = "\n".join(sql["lines"])
    gen_blocks = "\n".join(tbl + dt + wy)
    hits = [s for grp in stale for s in grp if s in sql_text or s in gen_blocks]
    check("stale names: none of the deleted headings or names is in the .sql, the tier table, the door table or the descriptions", not hits, str(hits))
    other = []
    for key in ("content", "apollo", "tax", "origin"):
        for k, l in enumerate(L(P[key]), 1):
            for s in [x for grp in stale for x in grp]:
                if s in l and not ("price_migration" in l or "migration" in l or "now" in l or "gone" in l):
                    other.append("%s:%d %s" % (key, k, s))
    print("      other mentions of the old names (for review, not a failure): %s" % (other[:8] if other else "none"))

    # ---- ARP_TAX_CHECKS: the cost examples are the new flat 4's
    f4 = props["h9_pc_flat_res4"]["price"]
    toll = int(math.ceil(f4 * TAXP / 100.0))
    t_txt = re.sub(r"\s+", " ", " ".join(tax))
    need = ["Paradise Flat 4 is %d) and say /buy" % f4, "\"Property tax: $%d at each toll" % toll, "You cannot pay the $%d that Paradise Flat 4" % (2 * toll), "Paradise Flat 4 owes $%d." % (3 * toll),
            "the plaque says FOR SALE at %d and" % f4, "property tax took $%d from your bank (2 tolls on 1 property)" % (2 * toll), "Tax a toll: $%d; Owes: $%d (1 toll)" % (toll, toll)]
    miss = [x for x in need if x not in t_txt]
    check("tax checks: the examples use Paradise Flat 4 at %d (a toll %d)" % (f4, toll), not miss, str(miss[:3]))
    bankm = re.search(r"arp_createbank <player> (\d+)", t_txt)
    check("tax checks: the bank of the test can pay the flat and a few tolls", bool(bankm) and int(bankm.group(1)) >= f4 + 10 * toll)

    # ---- the NPC links
    if os.path.exists(P["npcs"]):
        linked = []
        for ln in L(P["npcs"]):
            if ln.startswith(";") or not ln.strip():
                continue
            if "property" in ln.lower() and not any(w in ln.lower() for w in ("name", "type", "model", "angle", "origin", "sell", "heal", "addgun", "zone")):
                mm = re.search(r'"([^"]+)"', ln)
                if mm:
                    linked.append(mm.group(1))
        check("npcs: every property an NPC block names is a property of the .sql (%d links, %d properties)" % (len(linked), len(set(linked))), all(x in props for x in linked), str([x for x in linked if x not in props]))

    # ---- the generator says nothing to change
    gp = os.path.join(HERE, "gen_prices.py")
    if os.path.exists(gp) and names is not None:
        r = subprocess.run([sys.executable, "-I", gp, "--root", a.root, "--check", "--bsp", a.bsp, "--base-sql", a.base_sql], capture_output=True, text=True)
        check("generator: gen_prices.py --check finds nothing to change", r.returncode == 0, (r.stdout + r.stderr)[-300:])

    fails = [x for x, ok in results if not ok]
    print("\n%d checks, %d failed" % (len(results), len(fails)))
    for f in fails:
        print("  FAILED: " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
