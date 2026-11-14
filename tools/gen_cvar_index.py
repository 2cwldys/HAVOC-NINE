#!/usr/bin/env python3
"""
gen_cvar_index.py -- writes CVARS.md at the repository root: every cvar HAVOC 9 adds, in three parts.

    1. The engine   the cvars the H9 engine patches register (xash3d-h9-patches/patches/*.patch), each with the
                    description its own code gives it.
    2. The module   the cvars H9 adds to the mod's own libraries, reTS: the server library (reTS/dlls) and the
                    client library (reTS/cl_dll).
    3. The plugins  the cvars of the AMX Mod X plugins: the game modes and everything H9 wrote around them
                    (src/*.sma) and the Apollo RP roleplay scripts (apollo-rp/).

Where a cvar's description comes from, first found wins: its own code (the engine's description string, a comment
on the line that registers it), the shipped config file's comment above it, a row of the form
"name  default  what it does" in docs/*.txt. A cvar none of them describes is listed with its default and the file
that registers it. TS's and Half-Life's own cvars are not listed: this is what H9 adds.

    python tools/gen_cvar_index.py            write CVARS.md
    python tools/gen_cvar_index.py --check    exit 1 when CVARS.md is not what the sources give (for CI)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "CVARS.md"

ASCII_FIX = {chr(0x2014): "--", chr(0x2013): "-", chr(0x2018): "'", chr(0x2019): "'", chr(0x201c): '"', chr(0x201d): '"', chr(0x2026): "...", chr(0xa0): " "}


def text_of(path):
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")


def plain(text):
    for bad, good in ASCII_FIX.items():
        text = text.replace(bad, good)
    return text.encode("ascii", "replace").decode("ascii")


def brief(text, limit=230):
    """One short plain sentence for a table cell."""
    text = " ".join(plain(text).split())
    text = text.replace("e.g.", "e_g_").replace("i.e.", "i_e_")
    found = re.search(r'(?<=[A-Za-z0-9\)"\'`])\.\s', text)
    if found and found.start() < limit:
        text = text[:found.start() + 1]
    text = text.replace("e_g_", "e.g.").replace("i_e_", "i.e.")
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + " ..."
    return text.replace("|", "/").strip()


def cell(text):
    return text.replace("|", "/").replace("<", "&lt;").replace(">", "&gt;")


# Descriptions written by hand where the docs and the code only give a fragment (a row shared by several cvars, a wrapped list).
OVERRIDES = {
    "cl_h9_tts_voice_man": "which of the voices in cl_h9_tts_voices a man's voice is; 0 leaves it to the game",
    "cl_h9_tts_voice_woman": "which of the voices in cl_h9_tts_voices a woman's voice is; 0 leaves it to the game",
    "cl_h9_tts_voice_mech": "which of the voices in cl_h9_tts_voices a Mech's voice is; 0 leaves it to the game",
    "cl_h9_tts_voice_bot": "which of the voices in cl_h9_tts_voices a bot's voice is; 0 leaves it to the game",
    "cl_h9_tts_voice_set": "1 once this player has a voice of their own, chosen or given at random the first time",
    "cl_h9_tts_maxvoices": "the most voices that speak at once",
    "cl_h9_tts_volume": "how loud the voices are, up to the ceiling the game sets",
    "cl_h9_vgui_r": "the red part (0 to 255) of the colour of H9's panels; 138 66 196 is the default purple",
    "cl_h9_vgui_g": "the green part (0 to 255) of the colour of H9's panels",
    "cl_h9_vgui_b": "the blue part (0 to 255) of the colour of H9's panels",
    "cl_h9_arphud_icon": "the picture of an item lying on the floor, above the notice that names it; 0 leaves the notice as text alone",
    "_h9arpvgui": "the userinfo key through which the server learns whether this game draws Apollo RP's menus as panels (set from cl_h9_arpvgui)",
}


def good(text):
    """Whether a harvested description reads as a whole thought: not a heading, not a fragment."""
    text = brief(text)
    letters = [c for c in text if c.isalpha()]
    if len(text) < 18 or not letters:
        return False
    if sum(c.isupper() for c in letters) > 0.6 * len(letters):
        return False
    if text.count("(") != text.count(")"):
        return False
    if re.search(r"(of|the|a|an|and|or|to|in|is|are|with|by|for|from|that)\s*(\.\.\.)?$", text):
        return False
    if re.match(r"^[a-z]*['\u2019]s|^_[a-z]", text):
        return False
    return True


def tracked(*patterns):
    out = []
    for pattern in patterns:
        out += sorted(ROOT.glob(pattern))
    return out


# ---- descriptions from docs\*.txt: "  name   default   what it does" ------------------------------------------
def doc_rows(names):
    """name -> text, from rows of the docs whose first word is a cvar this tool knows."""
    found = {}
    files = [ROOT / "docs" / "COMMANDS.txt"] + [p for p in sorted((ROOT / "docs").glob("*.txt")) if p.name != "COMMANDS.txt"]
    row = re.compile(r"^(\s{1,14})([a-z][a-z0-9_]{3,})\s+(\"[^\"]*\"|\S+)\s{2,}(\S.*)$")
    for path in files:
        lines = text_of(path).split("\n")
        for i, line in enumerate(lines):
            m = row.match(line)
            if not m or m.group(2) not in names or m.group(2) in found:
                continue
            body = m.group(4)
            indent = len(m.group(1))
            for follow in lines[i + 1:i + 4]:
                lead = len(follow) - len(follow.lstrip())
                if not follow.strip() or lead <= indent + 6 or row.match(follow):
                    break
                body += " " + follow.strip()
            found[m.group(2)] = body
    return found


# ---- descriptions from the shipped configs -------------------------------------------------------------------
def cfg_rows(path):
    """name -> (default, comment above or beside it) from a .cfg: the comment block directly over a line wins."""
    rows = {}
    block, previous = [], None
    for raw in text_of(path).split("\n"):
        s = raw.strip()
        if not s:
            block, previous = [], None
            continue
        if s.startswith("//"):
            body = s.lstrip("/").strip()
            if not body or re.match(r"^[-=_*#\s]{3,}", body):
                if re.match(r"^-{3,}", body):
                    block = []
                continue
            block.append(body)
            previous = None
            continue
        m = re.match(r"^([A-Za-z][A-Za-z0-9_]*)\s*(.*)$", s)
        if not m:
            continue
        name, rest = m.group(1), m.group(2)
        value, _, trailing = rest.partition("//")
        value = value.strip().strip('"')
        desc = " ".join(block) if block else (trailing.strip() or (previous or ""))
        if name not in rows:
            rows[name] = (value, desc)
        previous = desc if desc else previous
        block = []
    return rows


def code_comment(source, name):
    """A comment in the source that names the cvar and says what it is: '// name: what it does'."""
    m = re.search(r"//+\s*" + re.escape(name) + r"\b[:,\-]?\s*(\S[^\n]*)", source)
    return m.group(1) if m else ""


# ---- 1. the engine --------------------------------------------------------------------------------------------
def engine_cvars():
    rows = {}
    define = re.compile(r'^\+\s*(?:static\s+)?CVAR_DEFINE_AUTO\(\s*(\w+)\s*,\s*"([^"]*)"\s*,\s*([^,]+?)\s*,\s*"((?:[^"\\]|\\.)*)"')
    define2 = re.compile(r'^\+\s*(?:static\s+)?CVAR_DEFINE\(\s*\w+\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*([^,]+?)\s*,\s*"((?:[^"\\]|\\.)*)"')
    getter = re.compile(r'^\+\s*Cvar_Get\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*([^,]+?)\s*,\s*"((?:[^"\\]|\\.)*)"')
    for path in tracked("xash3d-h9-patches/patches/*.patch"):
        for line in text_of(path).split("\n"):
            m = define.match(line)
            if m:
                name, default, flags, desc = m.group(1), m.group(2), m.group(3), m.group(4)
            else:
                m = define2.match(line) or getter.match(line)
                if not m:
                    continue
                name, default, flags, desc = m.groups()
            rows.setdefault(name, dict(name=name, default=default, flags=flags, desc=desc, patch=path.name))
    return sorted(rows.values(), key=lambda r: r["name"])


# ---- 2. the module --------------------------------------------------------------------------------------------
def module_cvars():
    rows = {}
    server = re.compile(r'cvar_t\s+\w+\s*=\s*\{\s*"(h9[^"]*)"\s*,\s*"([^"]*)"')
    for path in tracked("reTS/dlls/*.cpp", "reTS/dlls/*.h"):
        source = text_of(path)
        for m in server.finditer(source):
            name = m.group(1)
            rows.setdefault(name, dict(name=name, default=m.group(2), where="server library", file=path.relative_to(ROOT).as_posix(),
                                       desc=code_comment(source, name)))
    create = re.compile(r'CVAR_CREATE\(\s*"([^"]+)"\s*,\s*([^,)]+?)\s*,\s*[^)]*\)\s*;?[ \t]*(?://+[ \t]*([^\n]*))?')
    indexed = re.compile(r'CVAR_CREATE\(\s*(\w+)\[\w+\]\s*,\s*"([^"]*)"')
    for path in tracked("reTS/cl_dll/*.cpp", "reTS/cl_dll/*.h"):
        source = text_of(path)
        rel = path.relative_to(ROOT).as_posix()
        for m in create.finditer(source):
            name, default, trailing = m.group(1), m.group(2).strip().strip('"'), m.group(3) or ""
            if "h9" not in name:
                continue
            rows.setdefault(name, dict(name=name, default=default, where="client library", file=rel,
                                       desc=trailing.strip() or code_comment(source, name)))
        for m in indexed.finditer(source):
            array = re.search(r"\b" + re.escape(m.group(1)) + r"\s*\[\s*\]\s*=\s*\{([^}]*)\}", source)
            for name in re.findall(r'"([^"]+)"', array.group(1)) if array else []:
                if "h9" in name:
                    rows.setdefault(name, dict(name=name, default=m.group(2), where="client library", file=rel,
                                               desc=code_comment(source, name)))
    return sorted(rows.values(), key=lambda r: r["name"])


# ---- 3. the plugins -------------------------------------------------------------------------------------------
REGISTER = re.compile(r'(?:register_cvar|create_cvar)\s*\(\s*"([^"]+)"\s*,\s*"([^"]*)"')
STOCK = {"admin", "adminchat", "admincmd", "adminhelp", "adminslots", "adminvote", "antiflood", "cmdmenu", "imessage", "mapchooser", "mapsmenu",
         "menufront", "multilingual", "nextmap", "pausecfg", "plmenu", "pluginmenu", "scrollmsg", "statscfg", "telemenu", "timeleft"}


def plugin_sources():
    """(group, plugin name, path): the H9 plugins in src/, then Apollo RP's base scripts and each extra's."""
    out = [("H9 plugins", p.stem, p) for p in tracked("src/*.sma") if p.stem not in STOCK]
    out += [("Apollo RP", p.stem, p) for p in tracked("apollo-rp/base/addons/amxmodx/scripting/*.sma")]
    for p in tracked("apollo-rp/extra/*/addons/amxmodx/scripting/*.sma", "apollo-rp/extra/*/scripting/*.sma"):
        out.append(("Apollo RP extras", p.stem, p))
    return out


def plugin_cvars():
    config_files = tracked("H9XASH/ts/addons/amxmodx/configs/*.cfg", "apollo-rp/base/addons/amxmodx/configs/arp/*.cfg",
                           "apollo-rp/extra/*/addons/amxmodx/configs/*.cfg", "apollo-rp/extra/*/addons/amxmodx/configs/arp/*.cfg")
    configs = {}
    for path in config_files:
        for name, (value, desc) in cfg_rows(path).items():
            configs.setdefault(name, (path.name, value, desc))
    plugins = []
    for group, plugin, path in plugin_sources():
        source = text_of(path)
        title = re.search(r'#define\s+PLUGIN\s+"([^"]+)"', source)
        found = {}
        for m in REGISTER.finditer(source):
            found.setdefault(m.group(1), m.group(2))
        if not found:
            continue
        rows = []
        for name, default in sorted(found.items()):
            cfg = configs.get(name)
            rows.append(dict(name=name, default=default, cfg=cfg[0] if cfg else "", cfgdesc=cfg[2] if cfg else "",
                             codedesc=code_comment(source, name)))
        plugins.append(dict(group=group, plugin=plugin, title=title.group(1) if title else plugin, file=path.relative_to(ROOT).as_posix(), rows=rows))
    return plugins


# ---- the page -------------------------------------------------------------------------------------------------
def md_table(head, rows):
    lines = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return lines


def build():
    engine = engine_cvars()
    module = module_cvars()
    plugins = plugin_cvars()
    known = {r["name"] for r in engine} | {r["name"] for r in module} | {r["name"] for p in plugins for r in p["rows"]}
    docs = doc_rows(known)

    def describe(name, *own):
        for text in (OVERRIDES.get(name, ""), docs.get(name, ""), *own):
            if text and text.strip() and (name in OVERRIDES and text == OVERRIDES[name] or good(text)):
                return brief(text)
        return "(no description yet)"

    out = ["# Cvar index", "",
           "Every cvar HAVOC 9 adds, in three parts: the **engine**, the **module** (the mod's own game and client libraries) and the",
           "**plugins** (the game modes and everything around them, and the Apollo RP roleplay scripts). TS's and Half-Life's own cvars",
           "are not listed. This file is written by [tools/gen_cvar_index.py](tools/gen_cvar_index.py) from the sources, so it is as",
           "current as the last time that was run.", "",
           "> [!IMPORTANT]",
           "> **Normal The Specialists 3.0 stays fully playable.** Everything below has a stock \"off\" or a default that leaves the game as",
           "> TS plays it: for example `h9_customweapons 0` gives TS 3.0's own weapons and `h9_customhands 0` gives its own hands. The game",
           "> modes run only on maps named for them, and any other map plays as TS plays it.", "",
           "**Where a cvar is set.** A plugin's cvars have their defaults in the plugin's own config file in `ts\\addons\\amxmodx\\configs\\`",
           "(`ts_matchmode.cfg`, `ts_assault.cfg`, ...), which also explains each one at length. A map can set them for itself in",
           "`ts\\mapconfigs\\<map>.cfg`, which runs after the map has loaded and wins for that map (see the README's presets and map configs).",
           "A preset swaps whole config files. The console and `rcon` set a cvar until the next map. Client cvars (`cl_h9_*`) are the",
           "player's own and are kept in their `config.cfg`.", "",
           "- [Part 1: the engine](#part-1-the-engine)",
           "- [Part 2: the module](#part-2-the-module-the-mods-own-libraries)",
           "- [Part 3: the plugins](#part-3-the-plugins)", ""]

    # 1. engine
    own = [r for r in engine if not (r["name"].startswith("_") or "READ_ONLY" in r["flags"])]
    internal = [r for r in engine if r not in own]
    out += ["## Part 1: the engine", "",
            "The Xash3D FWGS engine of H9XASH, with the H9 patch chain in `xash3d-h9-patches/`. Its description is the one its code gives it.", ""]
    out += md_table(["Cvar", "Default", "What it does", "Patch"],
                    [[f"`{r['name']}`", f"`{r['default']}`" if r["default"] != "" else "(empty)", cell(brief(r["desc"])), f"`{r['patch']}`"] for r in own])
    out += ["", "**Set by the engine itself.** These carry state between the engine and the menu or the plugins. Read them, do not set them.", ""]
    out += md_table(["Cvar", "Default", "What it holds", "Patch"],
                    [[f"`{r['name']}`", f"`{r['default']}`" if r["default"] != "" else "(empty)", cell(brief(r["desc"])), f"`{r['patch']}`"] for r in internal])
    out += [""]

    # 2. module
    out += ["## Part 2: the module (the mod's own libraries)", "",
            "reTS is the mod's game library (`mp.dll`) and client library (`client.dll`), rebuilt from the Half-Life SDK. These are the cvars H9 adds to them.", ""]
    out += md_table(["Cvar", "Default", "What it does", "In"],
                    [[f"`{r['name']}`", f"`{r['default']}`" if r["default"] != "" else "(empty)", cell(describe(r["name"], r["desc"])), r["where"]]
                     for r in module])
    out += [""]

    # 3. plugins
    out += ["## Part 3: the plugins", "",
            "AMX Mod X plugins. Each section is one plugin, with the config file that carries its defaults and comments.", ""]
    group = None
    for plugin in plugins:
        if plugin["group"] != group:
            group = plugin["group"]
            out += [f"### {group}", ""]
        cfgs = sorted({r["cfg"] for r in plugin["rows"] if r["cfg"]})
        where = f" Config: {', '.join('`' + c + '`' for c in cfgs)}." if cfgs else ""
        out += [f"#### {plugin['plugin']}", "", f"`{plugin['file']}`.{where} {len(plugin['rows'])} cvars.", ""]
        out += md_table(["Cvar", "Default", "What it does"],
                        [[f"`{r['name']}`", f"`{r['default']}`" if r["default"] != "" else "(empty)",
                          cell(describe(r["name"], r["cfgdesc"], r["codedesc"]))] for r in plugin["rows"]])
        out += [""]
    return plain("\n".join(out)) + "\n", engine, module, plugins, docs


def main():
    page, engine, module, plugins, docs = build()
    undescribed = sum(1 for p in plugins for r in p["rows"] if f"| `{r['name']}` |" in page and page.split(f"| `{r['name']}` |")[1].split("\n")[0].rstrip().endswith("| (no description yet) |"))
    summary = f"engine {len(engine)}, module {len(module)}, plugins {sum(len(p['rows']) for p in plugins)} in {len(plugins)} files; {undescribed} plugin rows without a description"
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8").replace("\r\n", "\n") if OUT.exists() else ""
        if current != page:
            print("CVARS.md is out of date: run python tools/gen_cvar_index.py")
            return 1
        print("CVARS.md is current (" + summary + ")")
        return 0
    OUT.write_text(page, encoding="utf-8", newline="\n")
    print("CVARS.md written: " + summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
