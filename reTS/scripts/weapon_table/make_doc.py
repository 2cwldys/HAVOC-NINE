r"""Writes docs\WEAPON_DAMAGES.txt from the weapon table the game builds and the ammo rows of the same source file.

  cmake -S reTS\scripts\weapon_table -B <build folder> -G "Visual Studio 18 2026" -A Win32
  cmake --build <build folder> --config Release
  <build folder>\Release\dump.exe > table.tsv        (links the real dlls\ts_weapon_info.cpp)
  py -3 reTS\scripts\weapon_table\make_doc.py table.tsv docs\WEAPON_DAMAGES.txt
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "dlls", "ts_weapon_info.cpp")
rows = [r.rstrip("\n").split("\t") for r in open(sys.argv[1], encoding="ascii")]
head, rows = rows[0], rows[1:]
col = {n: i for i, n in enumerate(head)}

CLASS = {
    0: "melee", 1: "pistol", 2: "pistol", 3: "SMG", 4: "shotgun", 5: "rifle", 6: "SMG", 7: "SMG", 8: "akimbo",
    9: "pistol", 10: "akimbo", 11: "shotgun", 12: "pistol", 13: "rifle", 14: "pistol", 15: "rifle", 16: "akimbo",
    17: "SMG", 18: "sniper", 19: "SMG", 20: "shotgun", 21: "akimbo", 22: "pistol", 23: "SMG", 24: "grenade",
    25: "melee", 26: "shotgun", 27: "rifle", 28: "pistol", 29: "objective", 30: "akimbo", 31: "pistol",
    32: "machine gun", 33: "shotgun", 34: "melee", 35: "melee", 36: "pistol", 37: "akimbo", 39: "SMG",
}
NOT_GUNS = {0, 24, 25, 29, 34, 35}
MODES = {0: "auto", 1: "semi", 2: "burst", 3: "pump", 4: "akimbo-alt", 5: "akimbo-both"}


def modes(mask):
    return ", ".join(MODES[b] for b in range(6) if mask & (1 << b)) or "-"


def g(x, digits=2):
    s = f"{x:.{digits}f}".rstrip("0").rstrip(".")
    return s if s else "0"


UMP = next(float(r[col["damage"]]) for r in rows if r[col["name"]] == "UMP")

# the ammo rows: set_ammo(cal, f0, price, kind, mag, pierce, range, speed, "name")
ammo = {}
for m in re.finditer(r'set_ammo\((\d+), ([\d.]+)f, (\d+), (\d), (\d+), ([\d.]+)f, (\d+), (\d+), "([^"]+)"\)', open(SRC, encoding="latin-1").read()):
    cal = int(m.group(1))
    ammo[cal] = dict(price=int(m.group(3)), mag=int(m.group(5)), pierce=float(m.group(6)), unit=int(m.group(7)), name=m.group(9))

L = []
add = L.append

add("WEAPON DAMAGES -- the damage of every weapon, as the game builds it")
add("=================================================================")
add("")
add("Every number here is read from the weapon table the game compiles (reTS dlls\\ts_weapon_info.cpp,")
add("built into both mp.dll and client.dll): 39 weapons, TS 3.0's 38 (ids 0 to 37) and the PPSh-41 (id 39).")
add("Id 38 is no game weapon: AMX Mod X's TSX uses it for the throwing knife (section 4), so the game's own")
add("table leaves it empty. The table's damage is the shipped 'Sparta' value for the 32 firearms, which")
add("overrides the figure in each weapon's own row; the melee, grenade and briefcase rows keep their own. A")
add("server can change any of them with a weapons file (the 'customweapons' cvar, written by 'saveweapons');")
add("this is the stock table.")
add("")
add("")
add("1. THE FIREARMS, BY ID")
add("----------------------")
add("")
add("  Damage     what one bullet (one pellet, for a shotgun) does to a body, before range, armor and the")
add("             whole-number cut below")
add("  Pellets    bullets a shot sends (8 for every shotgun)")
add("  Per shot   Damage x Pellets: the most one pull of the trigger does")
add("  Rate       seconds between shots, as the table has it (a gun cannot fire faster)")
add("  Dmg/s      Per shot / Rate: a ceiling, since spread, recoil, reloads and the trigger lower it")
add("  Head       one bullet to the head: x2, or x1.5 for a shotgun pellet")
add("  %UMP       Damage against the UMP's 31")
add("")
add("  ID  Weapon             Class        Damage Pellets Per shot  Rate  Dmg/s   Head  %UMP  Fire modes")
add("  --  -----------------  -----------  ------ ------- -------- ----- ------ ------ ----- ---------------------")
for r in rows:
    w = int(r[col["id"]])
    if w in NOT_GUNS or not r[col["name"]]:
        continue
    d = float(r[col["damage"]])
    n = int(r[col["pellets"]])
    rate = float(r[col["rate"]])
    per = d * n
    headx = 1.5 if int(r[col["mode1"]]) == 1 else 2.0
    add(f"  {w:>2}  {r[col['name']]:<17}  {CLASS[w]:<11}  {g(d):>6} {n:>7} {g(per):>8} {rate:>5.3f} {per / rate:>6.0f} {g(d * headx):>6} {d / UMP * 100:>4.0f}%  {modes(int(r[col['modes']]))}")
add("")
add("  Akimbo weapons list one barrel: Damage is a bullet of either gun, Rate the time between shots of the")
add("  weapon. 'Dmg/s' counts one bullet per shot.")
add("")
add("  The PPSh-41 does 85% of the UMP's damage (26.35, which lands as 26), with a 71-round drum, 900 rounds")
add("  a minute, and a toggle between full auto and single fire (the fire-mode key switches, as on the AK47")
add("  and the Uzi).")
add("")
add("")
add("2. RANGE, AND WHAT A BULLET GOES THROUGH")
add("---------------------------------------")
add("")
add("A bullet keeps all its damage out to about ten range units of its caliber, then loses it as the")
add("square root of the distance: it does 0.95 of its damage at 11 range units, 0.5 at 40 and 0.32 at 100")
add("(a range unit is the number in the table below, in game units). A hit's damage is cut to a whole")
add("number when it is taken.")
add("")
add("  Cal  Ammo            Range unit  Full to (units)  Half at (units)  Pierce decay  Rounds a buy")
add("  ---  --------------  ----------  ---------------  ---------------  ------------  ------------")
for cal in sorted(ammo):
    a = ammo[cal]
    add(f"  {cal:>3}  {a['name']:<14}  {a['unit']:>10}  {a['unit'] * 11:>15}  {a['unit'] * 40:>15}  {a['pierce']:>12}  {a['mag']:>12}")
add("")
add("A bullet that still has more than 5 damage after a hit goes on through up to 48 units of material")
add("and hits once more, as one bullet with its damage times the pierce decay (half again if it went")
add("through a player). A decay of 0 never goes through: every shotgun's shells, and the .32.")
add("")
add("")
add("3. WHAT CHANGES A HIT")
add("--------------------")
add("")
add("  Head                 x2 for a bullet, x1.5 for a shotgun pellet; a blade or a fist gets nothing")
add("  Chest, stomach, arms x1: there is no torso multiplier")
add("  Legs                 x0.5")
add("  Kevlar               x0.7875 (the server's armor_absorb, 0.2125) on the chest, stomach and arms")
add("                       for a bullet; the head and the legs are not covered, and neither is a blade,")
add("                       a fall or an explosion")
add("  Bullet time dodge    x0.7 for a bullet taken during the 0.55 second dodge")
add("  Stunt and slow-mo    x0.7 for a player in a stunt or slow-motion state")
add("  Spawn protection     no damage at all for one second after a spawn")
add("  Friendly fire        no damage between teammates while mp_friendlyfire is off")
add("")
add("They multiply. A pistol bullet to the head of a player in kevlar is a head hit, so the kevlar does")
add("not count; to the chest it is x0.7875; to a leg it is x0.5.")
add("")
add("")
add("4. MELEE, THROWN BLADES, THE GRENADE, THE BRIEFCASE")
add("---------------------------------------------------")
add("")
add("A knife or katana blow is scaled by the melee bar (0 to 100): x(bar x 0.5 + 50) / 100, so x1.0 at a")
add("full bar and x0.5 at an empty one (the kung-fu blows are flat). A fist or a blade gets no head bonus.")
add("")
add("  ID  Weapon          Blow                                      Damage (at a full melee bar)")
add("  --  --------------  ----------------------------------------  --------------------------------")
add("   0  Kung-fu         punch                                     35 (flat: not scaled by the bar)")
add("                      kick                                      45")
add("                      back kick                                 55")
add("  25  Combat Knife    slash                                     30 (20 while stunting)")
add("                      thrown, touching a player                 100")
add("  35  Seal Knife      slash                                     20")
add("                      thrown, touching a player                 50")
add("  34  Katana          slash, on the ground                      45")
add("                      slash, ducking                            65")
add("                      slash while moving backward               75, swung behind the player")
add("                      slash in the air                          speed x 2/13, from 35 to 55")
add("                      slash during a stunt                      35")
add("                      thrown, touching a player                 150")
add("  38  Throwing Knife  any thrown blade that touches a player; TSX's id for it, not a game weapon:")
add("                      a thrown Combat Knife                     100")
add("                      a thrown Seal Knife                       50")
add("                      a thrown Katana                           150")
add("                      a thrown blade in flight, on glass and    0.1 x its speed")
add("                      what it can kill (never a player)")
add("  24  M61 Grenade     explosion                                 110 to everything within 300 units,")
add("                                                                less out to nothing at 1024")
add("  29  Briefcase       (the capture the flag objective)          0")
add("")
add("A thrown blade or grenade in flight shatters what it crosses that it can kill (glass and the like,")
add("never a player), taking 0.1 x its speed as the damage.")
add("")
add("Weapon 38, the Throwing Knife, is how AMX Mod X's TSX names any thrown blade: a kill or a hit made with one")
add("reaches plugins (client_death, client_damage) as weapon 38, whichever knife was thrown, and a kill with it")
add("is worth 2 points, as a kung-fu kill is (every other weapon's is worth 1). It is not a game weapon: the")
add("game's own ids are 0 to 37, and the PPSh-41's 39, so ts_giveweapon never takes 38.")
add("")
add("")
add("5. THE FIREARMS, BY DAMAGE")
add("-------------------------")
add("")
add("  Damage per bullet, largest first (a shotgun's is one pellet of eight):")
add("")
gun_rows = [r for r in rows if int(r[col["id"]]) not in NOT_GUNS and r[col["name"]]]
gun_rows.sort(key=lambda r: (-float(r[col["damage"]]), int(r[col["id"]])))
for r in gun_rows:
    w = int(r[col["id"]])
    d = float(r[col["damage"]])
    bar = "#" * max(1, round(d / 185.0 * 40))
    add(f"  {r[col['name']]:<17} {g(d):>6}  {bar}")
add("")
add("")
add("6. WHERE THE NUMBERS LIVE")
add("-------------------------")
add("")
add("  reTS\\dlls\\ts_weapon_info.cpp   the table: each weapon's row (Write), its combat feel (Sparta())")
add("                                 and the ammo (set_ammo); shared by mp.dll and client.dll")
add("  reTS\\dlls\\TS_combat.cpp        the range falloff and the pierce (ShootBulletsPlayer)")
add("  reTS\\dlls\\player.cpp           the hit-location multipliers, kevlar and the dodge (TraceAttack,")
add("                                 TakeDamage)")
add("  reTS\\dlls\\ts_gun.cpp           the melee blows (KnifeFire, KatanaFire, CCombatAttack)")
add("  reTS\\dlls\\ts_grenades.cpp      the grenade and the thrown blades")
add("")

text = "\r\n".join(L) + "\r\n"
text.encode("ascii")
open(sys.argv[2], "wb").write(text.encode("ascii"))
print("lines", len(L), "widest", max(len(x) for x in L))
