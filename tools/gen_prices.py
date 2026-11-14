#!/usr/bin/env python
"""gen_prices.py -- prices of the hive's properties, from ONE number.

Change PRICE_MULTIPLIER below and run again; every price and every number the docs derive from the prices is rewritten from it:

    python gen_prices.py --root D:\\Downloads\\TSM            (writes the files under that root)
    python gen_prices.py --root D:\\Downloads\\TSM --check    (writes nothing; says which files differ from what it would write; exit 1 if any)

What it reads (under --root unless noted):
  apollo-rp\\base\\addons\\amxmodx\\configs\\arp\\maps\\h9_tsrp_hive\\h9_tsrp_hive.sql   the properties, their doors, the jobs' pay; a property with price 0 is state
                                                                                      property, one with a price is for sale (its price is rewritten)
  docs\\ARP_CONTENT.txt, section 9, the tier table                                     the kind and the floor area of each for-sale property (NEW_SPEC below holds
                                                                                      the ones the table does not have yet)
  base_h9_tsrp_hive.sql beside this script                                             the prices BEFORE the scale (the "was" column)
  the compiled map (--bsp, default D:\\Downloads\\TSM\\H9XASH\\ts\\maps\\h9_tsrp_hive.bsp)  the door entities (the count in the text)
What it writes: the price field of every property row of the .sql; price_migration.txt (whole); in docs\\ARP_CONTENT.txt the PRICES paragraph, the tier
table, the counts, the door table and the per-property descriptions (those two from the .sql); in docs\\ARP_TAX_CHECKS.txt the cost examples of C and D.
The rule: price = round to two significant figures of (the price the first scale gave the tier, 1,200 * 2^tier rounded to two figures, times PRICE_MULTIPLIER),
except the Cult Gate (CULT_GATE_PRICE) and the rectangular pods (RECT_POD_FACTOR times a tier 0 price of the scale).
Verify the result with check_docs_vs_sql.py.
"""
import argparse
import math
import os
import re
import struct
import sys
import textwrap
from decimal import Decimal, ROUND_HALF_UP

# ====================================== THE NUMBERS ======================================
PRICE_MULTIPLIER = 3      # every price of the first scale (1,200 2,400 4,800 9,600 19,000 38,000) times this, to two significant figures
CULT_GATE_PRICE = 15000   # the owner's number for h9_al_cult_gate, whatever the multiplier is
RECT_POD_FACTOR = 2       # a rectangular pod costs this many times a pod of the scale (the hex pods stay on the scale)
# What the tax of the same prices costs: configs\arp\arp.cfg (arp_h9_tax_percent, arp_h9_tax_minutes); check_docs_vs_sql.py compares them with the file.
TAX_PERCENT = 0.1
TAX_MINUTES = 15
PAYDAY_SECONDS = 60       # a job's salary is paid every 60 seconds (docs\ARP_CONTENT.txt, 3)
EVICT_TOLLS = 288         # arp_h9_tax_evict_tolls as arp.cfg ships it (72 hours at 15 minutes; the plugin's own default is 96)

# The kind and area of the for-sale properties that the doc's tier table does not have yet (the table wins when it has a row).
NEW_SPEC = {
    "h9_pc_org_hq": ("workroom", 198),        # complexes 153 + 154 + 97 of rooms_complexes.json: 53.8k + 25.3k + 118.8k, three doors
    "h9_pc_bar_paradise": ("business", 4),    # the room behind pc_resident4: 3.8k, one door
}
# A property made from a row of the first file under another name: new name -> the old row its "was" is read from.
RENAMED_FROM = {"h9_pc_bar_paradise": "h9_pc_flat_res4", "h9_pc_flat_res4": "h9_pc_flat_res4a"}
# Properties the owner priced by hand (marked * in the table): name or prefix -> function of (M, tier price list)
HAND_PRICED_PREFIX = ("h9_xe_rect_pod",)
HAND_PRICED_NAMES = ("h9_al_cult_gate",)

REL_SQL = r"apollo-rp\base\addons\amxmodx\configs\arp\maps\h9_tsrp_hive\h9_tsrp_hive.sql"
REL_MIG = r"apollo-rp\base\addons\amxmodx\configs\arp\maps\h9_tsrp_hive\price_migration.txt"
REL_DOC = r"docs\ARP_CONTENT.txt"
REL_TAX = r"docs\ARP_TAX_CHECKS.txt"
DEFAULT_BSP = r"D:\Downloads\TSM\H9XASH\ts\maps\h9_tsrp_hive.bsp"
HERE = os.path.dirname(os.path.abspath(__file__))
BASE_SQL = os.path.join(HERE, "base_h9_tsrp_hive.sql")

KIND_BASE = {"stall": 0, "pod": 0, "residence": 1, "workroom": 1, "luxury": 2, "business": 2, "public": 5}
FIXED_TIER = {"stall": 0, "pod": 0, "public": 5}
TOWN_RANK = {"h9_pc_": 0, "h9_xe_": 1, "h9_al_": 2}


# ------------------------------------------------------------------------------ small helpers
def sig2(x):
    """x rounded half up to two significant figures, as an int."""
    d = Decimal(str(x))
    if d == 0:
        return 0
    e = d.adjusted()
    q = Decimal(1).scaleb(e - 1)
    return int((d / q).quantize(Decimal(1), rounding=ROUND_HALF_UP) * q)


def commas(n):
    return "{:,}".format(int(n))


def read_lines(path):
    b = open(path, "rb").read()
    eol = "\r\n" if b"\r\n" in b else "\n"
    text = b.decode("ascii")
    lines = text.split(eol)
    if lines and lines[-1] == "":
        lines.pop()
    return lines, eol


def join_lines(lines, eol):
    return (eol.join(lines) + eol).encode("ascii")


def town_rank(name):
    for p, r in TOWN_RANK.items():
        if name.startswith(p):
            return r
    return 9


def town_key(name):
    return name[3:5]


TIER_PRICES = [sig2(1200 * 2 ** t) for t in range(6)]             # the first scale: 1,200 ... 38,000


def scale_prices():
    return [sig2(p * PRICE_MULTIPLIER) for p in TIER_PRICES]


def area_step(a):
    if a is None:
        return 1
    if a < 60:
        return 0
    if a < 150:
        return 1
    if a < 250:
        return 2
    return 3


def tier_of(kind, area, ndoors):
    if kind in FIXED_TIER:
        return FIXED_TIER[kind]
    return min(5, KIND_BASE[kind] + area_step(area) + (1 if ndoors >= 4 else 0))


def is_hand_priced(name):
    return name in HAND_PRICED_NAMES or name.startswith(HAND_PRICED_PREFIX)


def price_of(name, tier):
    if name in HAND_PRICED_NAMES:
        return CULT_GATE_PRICE
    if name.startswith(HAND_PRICED_PREFIX):
        return sig2(RECT_POD_FACTOR * PRICE_MULTIPLIER * TIER_PRICES[0])
    return sig2(TIER_PRICES[tier] * PRICE_MULTIPLIER)


# ------------------------------------------------------------------------------ the .sql
PROP_RE = re.compile(r"^INSERT OR IGNORE INTO arp_property VALUES \('([^']*)','((?:[^']|'')*)','([^']*)','([^']*)',(\d+),(\d+),'([^']*)',(\d+)\);$")
DOOR_RE = re.compile(r"^INSERT OR IGNORE INTO arp_doors VALUES \('t\|([^']*)','([^']*)'\);$")
JOB_RE = re.compile(r"^INSERT OR IGNORE INTO arp_jobs VALUES \('([^']*)',(\d+),'([^']*)'\);$")


class Sql:
    def __init__(self, lines):
        self.lines = lines
        self.props = {}      # internal -> dict
        self.order = []
        self.doors = {}      # internal -> [door names in file order]
        self.jobs = {}
        for i, ln in enumerate(lines):
            m = PROP_RE.match(ln)
            if m:
                g = m.groups()
                comment = lines[i - 1][3:] if i > 0 and lines[i - 1].startswith("-- ") else ""
                self.props[g[0]] = dict(internal=g[0], heading=g[1].replace("''", "'"), owner=g[2], auth=g[3], price=int(g[4]), locked=int(g[5]),
                                        access=g[6], profit=int(g[7]), line=i, comment=comment)
                self.order.append(g[0])
                continue
            m = DOOR_RE.match(ln)
            if m:
                self.doors.setdefault(m.group(2), []).append(m.group(1))
                continue
            m = JOB_RE.match(ln)
            if m:
                self.jobs[m.group(1)] = int(m.group(2))


def load_sql(path):
    lines, eol = read_lines(path)
    return Sql(lines), eol


# ------------------------------------------------------------------------------ the doc
TABLE_HEAD = "  property                  kind       area   doors  tier  price"
TABLE_ROW = re.compile(r"^  (h9_\w+)\s+(\w+)\s+(-|\d+k)\s+(\d+)\s+(\d)\s+(\d+)(\*?)\s+(\d+|new)\s*$")
DOORS_HEAD = "  property                  plaque heading"


def find_line(lines, pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i
    return -1


def parse_table_specs(lines):
    i = find_line(lines, lambda l: l.startswith(TABLE_HEAD))
    specs = {}
    if i < 0:
        return specs
    for l in lines[i + 2:]:
        m = TABLE_ROW.match(l)
        if m:
            n, kind, area, doors, tier, price, star, was = m.groups()
            specs[n] = (kind, None if area == "-" else int(area[:-1]))
        elif l.strip() == "":
            break
    return specs


# ------------------------------------------------------------------------------ the model
class Model:
    pass


def build_model(sql, doc_lines, base_sql, bsp_entities):
    m = Model()
    m.sql = sql
    specs = dict(NEW_SPEC)
    specs.update(parse_table_specs(doc_lines))
    m.specs = specs
    m.rows = []     # for-sale rows
    m.state = []
    for n in sql.order:
        p = sql.props[n]
        nd = len(sql.doors.get(n, []))
        if p["price"] == 0:
            m.state.append(n)
            continue
        if n not in specs:
            raise SystemExit("no kind and area for the for-sale property %s: add it to the tier table or to NEW_SPEC" % n)
        kind, area = specs[n]
        tier = tier_of(kind, area, nd)
        price = price_of(n, tier)
        src = RENAMED_FROM.get(n, n)
        was = base_sql.props[src]["price"] if src in base_sql.props and base_sql.props[src]["price"] > 0 else None
        m.rows.append(dict(name=n, kind=kind, area=area, doors=nd, tier=tier, price=price, hand=is_hand_priced(n), was=was))
    m.rows.sort(key=lambda r: (r["tier"], town_rank(r["name"]), r["name"]))
    m.price = {r["name"]: r["price"] for r in m.rows}
    m.price.update({n: 0 for n in m.state})
    m.entities = bsp_entities
    return m


def counts(m):
    sql = m.sql
    c = Model()
    c.total = len(sql.order)
    c.sale = len(m.rows)
    c.state = len(m.state)
    c.tier = [sum(1 for r in m.rows if r["tier"] == t) for t in range(6)]
    c.hand = [r["name"] for r in m.rows if r["hand"]]
    sale = [sql.props[r["name"]] for r in m.rows]
    c.open = sum(1 for p in sale if p["locked"] == 0)
    c.letter = sum(1 for p in sale if p["locked"] == 1 and p["access"])
    c.plain = sum(1 for p in sale if p["locked"] == 1 and not p["access"])
    c.sale_letters = sorted({ch for p in sale for ch in p["access"]})
    st = [sql.props[n] for n in m.state]
    c.state_open = sum(1 for p in st if p["locked"] == 0)
    c.state_letter = sum(1 for p in st if p["locked"] == 1)
    c.doors = sum(len(v) for v in sql.doors.values())
    c.jobs = len(sql.jobs)
    c.statements = c.jobs + c.total + c.doors
    c.towns = {}
    for n in sql.order:
        c.towns[town_key(n)] = c.towns.get(town_key(n), 0) + 1
    return c


# ------------------------------------------------------------------------------ the pieces of text
def hours(n):
    h = round(n * 10) / 10.0
    return ("%d" % h) if h == int(h) else ("%.1f" % h)


def prices_paragraph(m):
    sp = scale_prices()
    pay = {"Citizen": m.sql.jobs["Citizen"], "Merchant": m.sql.jobs["Merchant"], "Legate": m.sql.jobs["Legate"], "Lord Minister": m.sql.jobs["Lord Minister"]}
    hour = {k: v * 3600 // PAYDAY_SECONDS for k, v in pay.items()}
    per_hour = TAX_PERCENT * 60.0 / TAX_MINUTES
    tax = [int(math.ceil(p * TAX_PERCENT / 100.0)) * (60 // TAX_MINUTES) for p in sp]
    pct = lambda a, b: int(round(100.0 * a / b))
    scale = ("PRICES are one geometric scale, the scale of the first file (round(1200 * 2^tier), to two significant figures) times %s, to two significant figures again "
             "(PRICE_MULTIPLIER in tools\\gen_prices.py), tier 0 to 5: %s. Every tier is twice the one before, within the rounding. The base, %s, is %s hours of a Citizen's pay "
             "(docs\\ARP_CONTENT.txt, section 3: a Citizen %d a minute, paid every %d seconds, so %s an hour; a Merchant's hour is %s) and is what the smallest property costs. "
             "The dearest, %s, is %s hours of a Lord Minister's pay (%d a minute, %s an hour) and %s of a Legate's (%d a minute): a rank that has served a while can buy it; "
             "a Citizen needs %d hours of pay. The property tax costs the owner %s percent of the price every %d minutes (%s percent an hour, arp_h9_tax_percent; he pays it by hand "
             "with /renew, or it is taken from his bank with arp_h9_tax_manual 0): tier 0 costs %s an hour (%d percent of a Citizen's pay), tier 3 (%s) %s (%d percent of a "
             "Merchant's), tier 5 %s (%d percent of a Lord Minister's). A property's tier is its kind's base plus a step for its floor area, plus 1 when it has four or more "
             "doors, at most 5:") % (
        ("%g" % PRICE_MULTIPLIER), "  ".join(commas(p) for p in sp), commas(sp[0]), hours(sp[0] / float(hour["Citizen"])), pay["Citizen"], PAYDAY_SECONDS, commas(hour["Citizen"]),
        commas(hour["Merchant"]), commas(sp[5]), hours(sp[5] / float(hour["Lord Minister"])), pay["Lord Minister"], commas(hour["Lord Minister"]),
        hours(sp[5] / float(hour["Legate"])), pay["Legate"], int(round(sp[5] / float(hour["Citizen"]))), ("%g" % TAX_PERCENT), TAX_MINUTES, ("%g" % per_hour),
        commas(tax[0]), pct(tax[0], hour["Citizen"]), commas(sp[3]), commas(tax[3]), pct(tax[3], hour["Merchant"]), commas(tax[5]), pct(tax[5], hour["Lord Minister"]))
    return wrap_block(scale, 200)


def wrap_block(text, width):
    return textwrap.wrap(text, width=width - 2, initial_indent="  ", subsequent_indent="  ", break_long_words=False, break_on_hyphens=False)


def table_lines(m):
    legend = ("(was: the price before the x%g scale, new: a property the file did not have before it, * priced by hand: the owner's number for the Cult Gate, "
              "twice the scale for the rectangular pods)") % PRICE_MULTIPLIER
    out = [TABLE_HEAD + "   " + legend]
    out.append("  ------------------------  ---------  -----  -----  ----  ------  ------")
    for r in m.rows:
        area = ("%dk" % r["area"]) if r["area"] is not None else "-"
        price = ("%d" % r["price"]) + ("*" if r["hand"] else "")
        out.append("  %-24s  %-9s  %5s  %5d  %4d  %6s  %s" % (r["name"], r["kind"], area, r["doors"], r["tier"], price, ("%d" % r["was"]) if r["was"] else "new"))
    return out


def tier_list_text(c):
    return ", ".join("tier %d %d" % (t, c.tier[t]) for t in range(6))


def join_and(items):
    if not items:
        return "none"
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def open_state_text(m):
    """The state properties that stand open to everyone, by heading (the ways through that a whole city uses)."""
    return join_and([m.sql.props[n]["heading"] for n in m.sql.order if n in m.state and m.sql.props[n]["locked"] == 0])


def open_sale_text(m):
    """What the for-sale properties that stand open are: the public fronts of the shops, the bank's glass doors when they are for sale, the clinic's gate."""
    items = ["the public fronts of the shops"]
    if "h9_pc_bank" in m.price and m.price["h9_pc_bank"] > 0 and m.sql.props["h9_pc_bank"]["locked"] == 0:
        items.append("the bank's glass doors")
    if m.price.get("h9_xe_clinic_gate", 0) > 0 and m.sql.props["h9_xe_clinic_gate"]["locked"] == 0:
        items.append("the clinic's gate")
    return join_and(items)


def counts_paragraphs(m, c, nmig):
    sp = scale_prices()
    hand_note = ("the %d rectangular pods count in tier 0 and the Cult Gate in tier 1, the tiers their kinds give them, but the owner priced them by hand: %s each and %s, marked * in the table"
                 % (sum(1 for n in c.hand if n.startswith(HAND_PRICED_PREFIX)), commas(price_of("h9_xe_rect_pod1", 0)), commas(CULT_GATE_PRICE)))
    t1 = ("%d of the %d properties are for sale until somebody has one: %s (%s). The other %d are state property, which nobody can buy: no owner, price 0. "
          "%d are sealed to a letter: the guard posts and the Lord Minister's throne room (the Ministry's and Civil Protection's posts, armouries, barracks, control room, cells and "
          "detention blocks), the Ministry of Defense's own buildings of Xenon City and Alexandria (the cyber lab, the data center, generator station 5, the lab control room, the "
          "Aurora laboratories, map room and annex) and the MSR gate; %d stand open to everyone, so that no owner's lock can ever shut them (%s: the ways through that a whole city uses). "
          "A shop front stays open to anyone until it is bought, and a property sealed to the Medical Division keeps that letter after a sale. "
          "INSERT OR IGNORE does not change a row a database already has, so a hive database that loaded an earlier file takes the new prices, headings, names and doors from "
          "price_migration.txt beside the .sql file: %d lines, which an ARP admin runs in the order given, one at a time in the console, before the map restarts with the new file "
          "(the loader makes the new rows at that start). The first lines rename Paradise Flat 4 (now the Paradise Bar) and Paradise Flat 4A (now Paradise Flat 4), move the Midgar "
          "kiosk's and the Shores cells' doors to the Midgar Office and delete the two properties that emptied, and give the six pods their new headings; the others set one price "
          "each, for the properties that are for sale and for those that became state property (0):") % (
        c.sale, c.total, tier_list_text(c), hand_note, c.state, c.state_letter, c.state_open, open_state_text(m), nmig)
    out = wrap_block(t1, 200)
    out.append("    arp_query UPDATE arp_property_h9_tsrp_hive SET price=<price> WHERE internalname='<internal>' AND ownerauth=''")
    out.extend(wrap_block("A property with an owner keeps what its owner set: it is not renamed, deleted or repriced (a Midgar Office that has an owner still receives the doors of an unowned kiosk and unowned cells), "
                          "and an admin settles the rest by hand. The prices apply at the next map start.", 200))
    return out


def partition_paragraphs(m, c):
    t = ("h9_tsrp_hive: %d properties, %d door names (%d entities; the jails' four wall panels, al_jail1act to 4act, are h9_jail's and are not in the file)\n"
         "%d are for sale until somebody has one: %d stand open to anyone until then (%s), "
         "%d are sealed to the Medical Division and keyholders (its letter keeps opening the doors after a sale), and %d are homes and businesses sealed until bought.\n"
         "The other %d are state property: %d sealed to the Ministry's guards (the police letter a, or the Lord Minister's g) and %d open to everyone.") % (
        c.total, c.doors, m.entities, c.sale, c.open, open_sale_text(m), c.letter, c.plain, c.state, c.state_letter, c.state_open)
    out = []
    for para in t.split("\n"):
        out.extend(wrap_block(para, 200))
    return out


def wrap_doors(names, width=74):
    out, cur = [], ""
    for i, n in enumerate(names):
        piece = n + ("," if i < len(names) - 1 else "")
        if not cur:
            cur = piece
        elif len(cur) + 1 + len(piece) <= width:
            cur += " " + piece
        else:
            out.append(cur)
            cur = piece
    out.append(cur)
    return out


def doc_order_of(lines):
    """The properties of the door table, in the doc's order (the doc keeps the dead-door blocks after the others)."""
    i = find_line(lines, lambda l: l.startswith(DOORS_HEAD))
    out = []
    if i < 0:
        return out
    for l in lines[i + 2:]:
        if l.strip() == "":
            break
        mm = re.match(r"^  (h9_\w+)\s", l)
        if mm:
            out.append(mm.group(1))
    return out


def merged_order(sql_order, doc_order):
    """The doc's order for the properties it has; a new property goes right after the property that precedes it in the .sql."""
    keep = set(sql_order)
    placed = [n for n in doc_order if n in keep]
    for k, n in enumerate(sql_order):
        if n in placed:
            continue
        prev = sql_order[k - 1] if k > 0 else None
        if prev in placed:
            placed.insert(placed.index(prev) + 1, n)
        else:
            placed.append(n)
    return placed


def door_table_lines(m):
    out = ["  %-24s  %-29s  %-74s  %-6s  %-6s  %s" % ("property", "plaque heading", "doors (targetnames)", "price", "locked", "access"),
           "  %s  %s  %s  %s  %s  %s" % ("-" * 24, "-" * 29, "-" * 74, "-" * 6, "-" * 6, "-" * 6)]
    for n in m.order:
        p = m.sql.props[n]
        price = "-" if m.price[n] == 0 else str(m.price[n])
        dl = wrap_doors(m.sql.doors[n])
        out.append("  %-24s  %-29s  %-74s  %6s  %-6s  %s" % (n, p["heading"], dl[0], price, "yes" if p["locked"] else "no", p["access"] or "-"))
        for extra in dl[1:]:
            out.append("  %-24s  %-29s  %s" % ("", "", extra))
    return out


def why_lines(m, old_block):
    """One entry for each property, from the .sql comment above it: the text after 'Heading: ', ending with a period. An entry whose text is
    the one the doc already holds keeps the doc's line breaks."""
    old = {}
    cur = None
    for l in old_block:
        mm = re.match(r"^    (h9_\w+): (.*)$", l)
        if mm:
            cur = mm.group(1)
            old[cur] = [l]
        elif cur and l.startswith("    "):
            old[cur].append(l)
    out = []
    for n in m.order:
        c = m.sql.props[n]["comment"]
        body = c.split(": ", 1)[1] if ": " in c else c
        s = "    %s: %s." % (n, body)
        if n in old and re.sub(r"\s+", " ", " ".join(x.strip() for x in old[n])) == re.sub(r"\s+", " ", s.strip()):
            out.extend(old[n])
        else:
            out.extend(textwrap.wrap(s, width=149, subsequent_indent="    ", break_long_words=False, break_on_hyphens=False))
    return out


# ------------------------------------------------------------------------------ the migration file
def migration_lines(m, base_sql):
    P = "arp_property_h9_tsrp_hive"
    D = "arp_doors_h9_tsrp_hive"
    out = [
        "-- price migration for a hive database that loaded an earlier h9_tsrp_hive.sql: INSERT OR IGNORE keeps the old rows, so each unowned property takes its new name, doors and price here.",
        "-- Run as an ARP admin in the console, one line at a time, in the order given and BEFORE the map restarts with the new .sql (arp_query takes one statement; the map's tables are "
        + P + " and " + D + "). Every line leaves a property that has an owner alone, and a line that finds nothing to change changes nothing.",
        "-- Paradise Flat 4 becomes the Paradise Bar and Paradise Flat 4A becomes Paradise Flat 4; the doors of the Midgar kiosk and of the Shores cells go to the Midgar Office and the two properties that emptied are deleted; the six rectangular pods change heading; then one price for each property that is for sale and a price 0 for each that became state property. It applies at the next map start.",
    ]
    L = []
    # Every line is short (a console input line is 256 characters) and acts only on the row it names; a door follows its property only when the property row has moved.
    # Paradise Flat 4 is the Paradise Bar; Flat 4A is Flat 4. The doorless row of the new name is what the loader makes when the new .sql was loaded first: it goes.
    L.append("arp_query DELETE FROM %s WHERE internalname='h9_pc_bar_paradise' AND ownerauth='' AND internalname NOT IN (SELECT internalname FROM %s)" % (P, D))
    L.append("arp_query UPDATE %s SET internalname='h9_pc_bar_paradise' WHERE internalname='h9_pc_flat_res4' AND ownerauth='' AND internalname IN (SELECT internalname FROM %s WHERE targetname='t|pc_resident4')" % (P, D))
    L.append("arp_query UPDATE %s SET internalname='h9_pc_bar_paradise' WHERE targetname='t|pc_resident4' AND internalname='h9_pc_flat_res4' AND EXISTS (SELECT 1 FROM %s WHERE internalname='h9_pc_bar_paradise')" % (D, P))
    L.append("arp_query UPDATE %s SET externalname='Paradise Bar' WHERE internalname='h9_pc_bar_paradise' AND ownerauth='' AND externalname='Paradise Flat 4'" % P)
    L.append("arp_query UPDATE %s SET internalname='h9_pc_flat_res4' WHERE internalname='h9_pc_flat_res4a' AND ownerauth='' AND 'h9_pc_flat_res4' NOT IN (SELECT internalname FROM %s)" % (P, P))
    L.append("arp_query UPDATE %s SET externalname='Paradise Flat 4' WHERE internalname='h9_pc_flat_res4' AND ownerauth='' AND externalname='Paradise Flat 4A'" % P)
    L.append("arp_query UPDATE %s SET internalname='h9_pc_flat_res4' WHERE targetname='t|pc_resident4a' AND internalname='h9_pc_flat_res4a' AND 'h9_pc_flat_res4a' NOT IN (SELECT internalname FROM %s)" % (D, P))
    # Midgar: the doors of the unowned kiosk and Shores cells go to the office, then the two emptied properties go
    for door, src in (("al_midgarkiosk", "h9_al_midgar_kiosk"), ("al_shorescell", "h9_al_shores_cells"), ("al_shorestwoc", "h9_al_shores_cells")):
        L.append("arp_query UPDATE %s SET internalname='h9_al_midgar_office' WHERE targetname='t|%s' AND internalname IN (SELECT internalname FROM %s WHERE internalname='%s' AND ownerauth='')" % (D, door, P, src))
    for src in ("h9_al_midgar_kiosk", "h9_al_shores_cells"):
        L.append("arp_query DELETE FROM %s WHERE internalname='%s' AND ownerauth='' AND internalname NOT IN (SELECT internalname FROM %s)" % (P, src, D))
    # headings of the rectangular pods
    for n in range(1, 7):
        L.append("arp_query UPDATE %s SET externalname='Rectangular Pod %d' WHERE internalname='h9_xe_rect_pod%d' AND ownerauth=''" % (P, n, n))
    nstruct = len(L)
    # prices: every property that is for sale, and every one that was for sale in the first file and is state property now
    names = set(m.price)
    pr = []
    for n in sorted(names):
        was = base_sql.props.get(n)
        if m.price[n] == 0 and not (was and was["price"] > 0):
            continue
        pr.append("arp_query UPDATE %s SET price=%d WHERE internalname='%s' AND ownerauth=''" % (P, m.price[n], n))
    return out, L, pr


# ------------------------------------------------------------------------------ the tax checks
def tax_checks_update(text_lines, flat4_price):
    toll = int(math.ceil(flat4_price * TAX_PERCENT / 100.0))
    bank = int(math.ceil((flat4_price + 20 * toll) / 5000.0)) * 5000
    wallet = 500 if 2 * toll - 10 <= 500 else int(math.ceil((2 * toll) / 500.0)) * 500
    text = "\n".join(text_lines)
    subs = [
        (r"(arp_createbank <player> )\d+", r"\g<1>%d" % bank),
        (r"(Paradise Flat 4 is )\d+(\) and say /buy)", r"\g<1>%d\2" % flat4_price),
        (r'("Property tax: )\$\d+( at each toll)', r"\g<1>$%d\2" % toll),
        (r'("Paradise Flat 4: )\$\d+( a toll)', r"\g<1>$%d\2" % toll),
        (r"(Property tax owed: Paradise Flat 4 )\$\d+( \(about 2 hours left\)\. You must pay it: say$)", r"\g<1>$%d\2" % toll),
        (r'("owes )\$\d+( \(1 toll\), pays by hand)', r"\g<1>$%d\2" % toll),
        (r"(Tax a toll: )\$\d+(; Owes: )\$\d+( \(1 toll\))", r"\g<1>$%d\2$%d\3" % (toll, toll)),
        (r"(      )\$\d+(; Wallet: \$\.\.\.; 1\. Pay )\$\d+( now)", r"\g<1>$%d\2$%d\3" % (bank, toll)),
        (r"(Press 1: the bank is )\$\d+( lower)", r"\g<1>$%d\2" % toll),
        (r"(Property tax paid: )\$\d+( taken from your bank for Paradise Flat 4\.)", r"\g<1>$%d\2" % toll),
        (r"(You cannot pay the )\$\d+( that Paradise Flat 4)", r"\g<1>$%d\2" % (2 * toll)),
        (r'(With bank 10 and wallet )\d+(: "\$10 taken from your bank and )\$\d+( from your wallet)', r"\g<1>%d\2$%d\3" % (wallet, 2 * toll - 10)),
        (r"(Automatic payment in the game: ON, bank )\$\d+", r"\g<1>$%d" % bank),
        (r"(Property tax: Paradise Flat 4 owes )\$\d+", r"\g<1>$%d" % (3 * toll)),
        (r"(the plaque says FOR SALE at )\d+( and the door is as it was before he bought it)", r"\g<1>%d\2" % flat4_price),
        (r"(  Paradise Flat 4 )\$\d+( \(about 2 hours left\)\. You must pay it: say /renew at the door\.\")", r"\g<1>$%d\2" % (3 * toll)),
        (r"(property tax took )\$\d+( from your bank \(2 tolls on 1 property\))", r"\g<1>$%d\2" % (2 * toll)),
    ]
    for pat, rep in subs:
        text, n = re.subn(pat, rep, text, flags=re.M)
        if n != 1:
            raise SystemExit("ARP_TAX_CHECKS.txt: the pattern %r matched %d times, expected 1" % (pat, n))
    return text.split("\n")


# ------------------------------------------------------------------------------ the doc
def replace_block(lines, start, end, new):
    return lines[:start] + new + lines[end:]


def find_block(lines, first_pred, last_pred, what):
    i = find_line(lines, first_pred)
    if i < 0:
        raise SystemExit("ARP_CONTENT.txt: cannot find the start of " + what)
    j = find_line(lines, last_pred, i)
    if j < 0:
        raise SystemExit("ARP_CONTENT.txt: cannot find the end of " + what)
    return i, j


def update_doc(lines, m, c, nmig):
    m.order = merged_order(m.sql.order, doc_order_of(lines))
    # 1. the PRICES paragraph (to the line that ends it)
    i, j = find_block(lines, lambda l: l.startswith("  PRICES are one geometric scale"), lambda l: l.rstrip().endswith("at most 5:"), "the PRICES paragraph")
    lines = replace_block(lines, i, j + 1, prices_paragraph(m))
    # 2. the tier table and 3. the counts paragraph
    i, j = find_block(lines, lambda l: l.startswith(TABLE_HEAD), lambda l: re.match(r"^  \d+ of the \d+ properties are for sale until somebody has one", l) is not None, "the tier table")
    tbl = table_lines(m)
    k = find_line(lines, lambda l: l.startswith("  A property with an owner keeps"), j)
    if k < 0:
        raise SystemExit("ARP_CONTENT.txt: cannot find the end of the counts paragraph")
    k = find_line(lines, lambda l: l.strip() == "", k)          # the paragraph runs to the next blank line
    lines = replace_block(lines, i, k, tbl + [""] + counts_paragraphs(m, c, nmig))
    # 4. the partition paragraph (from the h9_tsrp_hive line to the line before the blank that precedes the door table)
    i, j = find_block(lines, lambda l: re.match(r"^  h9_tsrp_hive: \d+ properties, \d+ door names", l) is not None, lambda l: l.startswith(DOORS_HEAD), "the partition paragraph")
    lines = replace_block(lines, i, j - 1, partition_paragraphs(m, c))
    # 5. the door table
    i, j = find_block(lines, lambda l: l.startswith(DOORS_HEAD), lambda l: l.strip() == "", "the door table")
    lines = replace_block(lines, i, j, door_table_lines(m))
    # 6. the per-property descriptions
    i = find_line(lines, lambda l: l.startswith("  Why each (each door's box"))
    if i < 0:
        raise SystemExit("ARP_CONTENT.txt: cannot find the descriptions")
    j = find_line(lines, lambda l: l.strip() == "", i)
    lines = replace_block(lines, i + 1, j, why_lines(m, lines[i + 1:j]))
    return lines


# ------------------------------------------------------------------------------ the map
def bsp_door_entities(path, names):
    data = open(path, "rb").read()
    base = 4
    ofs, ln = struct.unpack_from("<ii", data, base)
    text = data[ofs:ofs + ln].split(b"\x00")[0].decode("latin-1")
    n = 0
    cur = None
    for line in text.splitlines():
        s = line.strip()
        if s == "{":
            cur = {}
        elif s == "}":
            if cur and cur.get("classname", "").startswith("func_door") and cur.get("targetname", "").lower() in names:
                n += 1
            cur = None
        elif cur is not None and s.startswith('"'):
            mm = re.match(r'^"([^"]*)"\s+"([^"]*)"', s)
            if mm:
                cur[mm.group(1)] = mm.group(2)
    return n


# ------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description="Prices of the hive's properties from PRICE_MULTIPLIER (see the top of this file).")
    ap.add_argument("--root", required=True, help="the folder the files live under (D:\\Downloads\\TSM, or a copy of it)")
    ap.add_argument("--check", action="store_true", help="write nothing; exit 1 if a file differs from what would be written")
    ap.add_argument("--base-sql", default=BASE_SQL, help="the .sql before the scale (default: base_h9_tsrp_hive.sql beside this script)")
    ap.add_argument("--bsp", default=DEFAULT_BSP, help="the compiled hive map (to count door entities)")
    ap.add_argument("--multiplier", type=float, default=None, help="try another multiplier without editing the file (the file's constant is still what a later run uses)")
    a = ap.parse_args()
    global PRICE_MULTIPLIER
    if a.multiplier is not None:
        PRICE_MULTIPLIER = int(a.multiplier) if float(a.multiplier).is_integer() else a.multiplier
    p_sql, p_mig, p_doc, p_tax = [os.path.join(a.root, r) for r in (REL_SQL, REL_MIG, REL_DOC, REL_TAX)]
    sql, sql_eol = load_sql(p_sql)
    base_sql, _ = load_sql(a.base_sql)
    doc_lines, doc_eol = read_lines(p_doc)
    tax_lines, tax_eol = read_lines(p_tax)
    names = {d.lower() for v in sql.doors.values() for d in v}
    entities = bsp_door_entities(a.bsp, names) if os.path.exists(a.bsp) else None
    if entities is None:
        raise SystemExit("the compiled map %s is needed to count door entities (--bsp)" % a.bsp)
    m = build_model(sql, doc_lines, base_sql, entities)
    c = counts(m)
    # the .sql: the price field of each property row
    new_sql = list(sql.lines)
    for n, p in sql.props.items():
        ln = new_sql[p["line"]]
        mm = PROP_RE.match(ln)
        g = list(mm.groups())
        g[4] = str(m.price[n])
        new_sql[p["line"]] = "INSERT OR IGNORE INTO arp_property VALUES ('%s','%s','%s','%s',%s,%s,'%s',%s);" % tuple(g)
    head, struct_lines, price_lines = migration_lines(m, base_sql)
    nmig = len(struct_lines) + len(price_lines)
    new_mig = head + struct_lines + price_lines
    new_doc = update_doc(doc_lines, m, c, nmig)
    new_tax = tax_checks_update(tax_lines, m.price["h9_pc_flat_res4"])
    outputs = [(p_sql, new_sql, sql_eol), (p_mig, new_mig, sql_eol), (p_doc, new_doc, doc_eol), (p_tax, new_tax, tax_eol)]
    differs = []
    for path, lines, eol in outputs:
        old = open(path, "rb").read() if os.path.exists(path) else b""
        new = join_lines(lines, eol)
        if old != new:
            differs.append(path)
            if not a.check:
                open(path, "wb").write(new)
    sp = scale_prices()
    print("PRICE_MULTIPLIER %s: tier prices %s" % (PRICE_MULTIPLIER, ", ".join(commas(p) for p in sp)))
    print("rectangular pods %s each, Cult Gate %s; %d properties: %d for sale (%s), %d state; migration lines %d (%d structural, %d prices)" % (
        commas(price_of("h9_xe_rect_pod1", 0)), commas(CULT_GATE_PRICE), c.total, c.sale, tier_list_text(c), c.state, nmig, len(struct_lines), len(price_lines)))
    for path in differs:
        print(("would change " if a.check else "wrote ") + path)
    if not differs:
        print("nothing to change: the files already say what this number gives")
    return 1 if (a.check and differs) else 0


if __name__ == "__main__":
    sys.exit(main())
