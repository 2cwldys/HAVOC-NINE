#!/usr/bin/env python3
"""check_arp_docs.py -- is the documentation of H9's changes to Apollo RP complete and in step with the sources?

    python tools\\check_arp_docs.py [--root D:\\Downloads\\TSM] [--verbose]

Reads only. Exit 1 when a check fails. What it checks (CONTEXT.md: "every H9 addition has a server switch with a stock off", documented in docs\\APOLLO_RP.txt 10):
  cvars      every arp_h9_* cvar (and the few H9 cvars without the prefix) that an ARP plugin registers has a line in configs\\arp\\arp.cfg, an entry in COMMANDS.txt, and a mention in
             docs\\APOLLO_RP.txt and docs\\ARP_COMMANDS.txt;
  commands   every arp_h9_* console command and every chat command (/name) that an H9-only ARP plugin registers is in COMMANDS.txt and docs\\ARP_COMMANDS.txt;
  patches    every apollo-rp\\H9*.patch note is named in apollo-rp\\ORIGIN.txt and in the index of docs\\APOLLO_RP.txt (7. WHERE THINGS ARE);
  origin     the items of apollo-rp\\ORIGIN.txt are numbered 1..N with no gap, and the index says "items 1 to N";
  plugins    every ARP_*.sma of the masters is named in docs\\APOLLO_RP.txt or ORIGIN.txt;
  links      every docs\\<file>, apollo-rp\\<file> and tools\\<file> that the ARP docs name exists.
"""
import argparse
import os
import re
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--root", default=r"D:\Downloads\TSM")
ap.add_argument("--verbose", action="store_true")
args = ap.parse_args()
R = args.root


def rd(rel):
    p = os.path.join(R, rel)
    return open(p, "rb").read().decode("latin-1").replace("\r\n", "\n")


SCRIPTING = os.path.join(R, "apollo-rp", "base", "addons", "amxmodx", "scripting")
fails = []
passes = 0


def check(ok, what, detail=""):
    global passes
    if ok:
        passes += 1
        if args.verbose:
            print("PASS  " + what)
    else:
        fails.append(what + (": " + detail if detail else ""))
        print("FAIL  " + what + (": " + detail if detail else ""))


# ---- sources ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
H9_ONLY_PLUGINS = {"ARP_PropertyTax.sma", "ARP_Inventory.sma", "ARP_H9Menu.sma", "ARP_PayScale.sma", "ARP_PropClip.sma", "ARP_H9Ctx.sma"}
src = {}
for fn in sorted(os.listdir(SCRIPTING)):
    if fn.startswith("ARP_") and fn.endswith(".sma"):
        src[fn] = open(os.path.join(SCRIPTING, fn), "rb").read().decode("latin-1")

cvars = {}
for fn, t in src.items():
    for m in re.finditer(r'register_cvar\(\s*"([a-z0-9_]+)"', t):
        cvars.setdefault(m.group(1), fn)
EXTRA_H9_CVARS = {"arp_teamplay", "arp_teamplay_on", "arp_thirst_enabled", "arp_mapsql_autoload", "arp_account_wait", "arp_hunger_enabled"}
INTERNAL = {"arp_teamplay_on"}          # set by a plugin for another plugin to read: not a setting
h9cvars = {c: f for c, f in cvars.items() if c.startswith("arp_h9_") or c in EXTRA_H9_CVARS}

cmds = {}
for fn, t in src.items():
    for m in re.finditer(r'(?:ARP_AddCommand|register_concmd|register_srvcmd|register_clcmd|ARP_RegisterCmd)\(\s*"(arp_h9_[a-z0-9_]+)"', t):
        cmds.setdefault(m.group(1), fn)
    if fn in H9_ONLY_PLUGINS:
        for m in re.finditer(r'ARP_RegisterChat\(\s*"(/[a-z0-9_]+)"', t):
            cmds.setdefault(m.group(1), fn)
        for m in re.finditer(r'(?:register_concmd|register_srvcmd|register_clcmd)\(\s*"([a-z0-9_]+)"', t):
            if m.group(1).startswith("arp_"):
                cmds.setdefault(m.group(1), fn)

arpcfg = rd(r"apollo-rp\base\addons\amxmodx\configs\arp\arp.cfg")
commands_txt = rd("COMMANDS.txt")
apollo = rd(r"docs\APOLLO_RP.txt")
arpcmds = rd(r"docs\ARP_COMMANDS.txt")
origin = rd(r"apollo-rp\ORIGIN.txt")

# ---- cvars -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
for c in sorted(h9cvars):
    if c in INTERNAL:
        continue
    check(re.search(r'^\s*' + re.escape(c) + r'\s+"', arpcfg, re.M) is not None, "cvar %s (%s): a line in arp.cfg" % (c, h9cvars[c]))
    check(re.search(r"^\s+" + re.escape(c) + r"\s+\(", commands_txt, re.M) is not None or c in commands_txt, "cvar %s: an entry in COMMANDS.txt" % c)
    check(c in apollo, "cvar %s: named in docs\\APOLLO_RP.txt" % c)
    check(c in arpcmds, "cvar %s: named in docs\\ARP_COMMANDS.txt" % c)

# ---- commands --------------------------------------------------------------------------------------------------------------------------------------------------------------------
for c in sorted(cmds):
    check(c in commands_txt, "command %s (%s): in COMMANDS.txt" % (c, cmds[c]))
    check(c in arpcmds, "command %s: in docs\\ARP_COMMANDS.txt" % c)

# ---- patch notes -----------------------------------------------------------------------------------------------------------------------------------------------------------------
idx_start = apollo.find("7. WHERE THINGS ARE")
idx_end = apollo.find("8. JOBS AND SETUP BY MAP")
index = apollo[idx_start:idx_end] if idx_start >= 0 and idx_end > idx_start else ""
check(bool(index), "docs\\APOLLO_RP.txt has the index '7. WHERE THINGS ARE'")
for fn in sorted(os.listdir(os.path.join(R, "apollo-rp"))):
    if re.match(r"H9.*\.patch$", fn):
        check(fn in origin, "patch note %s: named in apollo-rp\\ORIGIN.txt" % fn)
        check(fn in index, "patch note %s: named in the index of docs\\APOLLO_RP.txt" % fn)

# ---- ORIGIN items ----------------------------------------------------------------------------------------------------------------------------------------------------------------
nums = [int(m.group(1)) for m in re.finditer(r"^(\d+)\. ", origin, re.M)]
if nums:
    n = max(nums)
    missing = [i for i in range(1, n + 1) if i not in nums]
    check(not missing, "ORIGIN items run 1..%d without a gap" % n, "missing %s" % missing)
    m = re.search(r"ORIGIN\.txt\s+what H9 changed, items 1 to (\d+)", index)
    check(m is not None and int(m.group(1)) == n, "the index says 'items 1 to %d'" % n, "it says %s" % (m.group(1) if m else "nothing"))

# ---- plugins ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
for fn in sorted(src):
    base = fn[:-4]
    if base in ("ARP_BCompat", "ARP_CS", "ARP_TFC"):
        continue        # other games' plugins: they do not run on H9's server
    check(base in apollo or base in origin, "plugin %s: named in docs\\APOLLO_RP.txt or ORIGIN.txt" % base)

# ---- links -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
LINK = re.compile(r"\b((?:docs|apollo-rp|tools|modelling)[\\/][A-Za-z0-9_.\\/-]+\.(?:txt|md|py|mjs|patch|ps1|cfg|sql|ini))")
seen = set()
for name, text in (("docs\\APOLLO_RP.txt", apollo), ("docs\\ARP_COMMANDS.txt", arpcmds), ("apollo-rp\\ORIGIN.txt", origin), ("docs\\ARP_CONTENT.txt", rd(r"docs\ARP_CONTENT.txt")),
                   ("docs\\ARP_ADMINS.txt", rd(r"docs\ARP_ADMINS.txt")), ("docs\\ARP_TAX_CHECKS.txt", rd(r"docs\ARP_TAX_CHECKS.txt"))):
    for m in LINK.finditer(text):
        ref = m.group(1).rstrip(".,;:)")
        if (name, ref) in seen:
            continue
        seen.add((name, ref))
        path = os.path.join(R, ref.replace("\\", os.sep).replace("/", os.sep))
        ok = os.path.exists(path) or any(os.path.exists(os.path.join(R, d, os.path.basename(path))) for d in ("docs", "apollo-rp", "tools"))
        check(ok, "%s names %s: it exists" % (name, ref))

print("\n%d checks, %d failed" % (passes + len(fails), len(fails)))
sys.exit(1 if fails else 0)
