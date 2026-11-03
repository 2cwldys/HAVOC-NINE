import pefile, struct, hashlib

ORIG = 'mp.dll.original'   # reTS mp.dll as shipped; ts\dlls\mp.dll is the deployed patched copy
OUT = 'mp_patched_slots.dll'
PATCH_TXT = 'mp_patched_slots.dll.patch'

EXPECTED_MD5 = '00b12524dcc913a3cd80d74449670df4'

pe = pefile.PE(ORIG)
base = pe.OPTIONAL_HEADER.ImageBase
data = bytearray(open(ORIG, 'rb').read())

print('original md5', hashlib.md5(data).hexdigest())
assert hashlib.md5(data).hexdigest() == EXPECTED_MD5, 'mp.dll is not the expected reTS build'

# The weapon inventory's add routine (RVA 0x622d0) sums the weight of everything carried, adds
# the new weapon's and refuses past a fixed 81:
#   0x62415  cmp ebx, 0x51
#   0x62418  jg  0x62493        (return false)
# The jg becomes two NOPs. The player-level check its only caller (RVA 0x567a0) runs first
# still applies, and that one counts the room ts_setuserslots grants.
SITE_RVA = 0x62415
SITE_ORIG = bytes.fromhex('83fb517f79')
JG_RVA = SITE_RVA + 3
JG_PATCH = bytes.fromhex('9090')

site_off = pe.get_offset_from_rva(SITE_RVA)
jg_off = pe.get_offset_from_rva(JG_RVA)
assert bytes(data[site_off:site_off+5]) == SITE_ORIG, \
    f'unexpected bytes at the cap: {bytes(data[site_off:site_off+5]).hex()}'

# Nothing the loader rewrites may live in the two bytes replaced.
pe.parse_data_directories()
for entry in pe.DIRECTORY_ENTRY_BASERELOC:
    for rel in entry.entries:
        if rel.type and JG_RVA <= rel.rva < JG_RVA + 2:
            raise SystemExit(f'unexpected relocation at {hex(rel.rva)} inside the patch')
print('no relocation entries inside the patch')

# The add routine must be reached only through the player-level check.
text = [s for s in pe.sections if s.Name.startswith(b'.text')][0]
tva = text.VirtualAddress
tb = bytes(data[text.PointerToRawData:text.PointerToRawData + text.SizeOfRawData])
ADD_RVA, GIVE_RVA, CALL_RVA = 0x622d0, 0x567a0, 0x56845
callers = [tva + o for o in range(len(tb) - 5)
           if tb[o] == 0xE8 and tva + o + 5 + struct.unpack_from('<i', tb, o + 1)[0] == ADD_RVA]
assert callers == [CALL_RVA], f'unexpected callers of the add routine: {[hex(c) for c in callers]}'
assert data.count(struct.pack('<I', base + ADD_RVA)) == 0, 'the add routine has an absolute reference'
print('add routine called once, from', hex(CALL_RVA), 'inside', hex(GIVE_RVA))

data[jg_off:jg_off+2] = JG_PATCH

open(OUT, 'wb').write(data)
patched_md5 = hashlib.md5(data).hexdigest()
print('wrote', OUT, len(data), 'bytes')
print('patched md5', patched_md5)

try:
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    def lines(buf, rva):
        return '\n'.join('    %08x  %-12s %s %s' % (i.address, i.bytes.hex(), i.mnemonic, i.op_str)
                         for i in md.disasm(buf, base + rva))
    before = lines(bytes(open(ORIG, 'rb').read()[site_off-16:site_off+9]), SITE_RVA - 16)
    after = lines(bytes(data[site_off-16:site_off+9]), SITE_RVA - 16)
except Exception as e:
    before = after = f'(capstone unavailable: {e})'

patch_doc = rf"""TSM mp.dll patch -- the weapon inventory's fixed 81-slot ceiling
===================================================================

What this is: a 2-byte binary patch to reTS's server DLL (ts\dlls\mp.dll) so the room
ts_setuserslots grants a player is the only slot limit that player has.

reTS checks a weapon give twice. The player check (RVA 0x567a0, free slots from RVA 0x61460)
counts the bonus ts_setuserslots stores at player+0xc0c, so a player given 999 passes it. The
weapon inventory's own add routine (RVA 0x622d0) then sums the weight of everything carried,
adds the new weapon's, and refuses past a fixed 81 -- ignoring that bonus. The Heavy's kit is
M60E3 70 + Glock-20C 10 + M61 grenade 7 = 87, so one piece of it was always refused, however
much room the plugin gave him. No other class's kit passes 81 (the Marksman's 80 is closest).

This patch removes that second cap. The player check stays the only gate.

Original file : {ORIG} (reTS mp.dll)
Patched file  : {OUT}
Original MD5  : {EXPECTED_MD5}
Patched MD5   : {patched_md5}
Size          : {len(data)} bytes (unchanged)

1. The patch
-------------------------------------------------------------

    file offset 0x{jg_off:x} (RVA 0x{JG_RVA:x}):
      original: 7f 79   (jg 0x10062493 -- return false)
      patched:  90 90   (nop; nop)

Before:

{before}

After:

{after}

ebx is reloaded at 0x6241a, so nothing downstream reads the compare.

2. Why stock behaviour is unchanged
-------------------------------------------------------------

The add routine has one caller (RVA 0x56845, inside 0x567a0), and that caller has already
refused any weapon heavier than the player's free slots:

    free = min(max(81 - carried - item penalties, 0), 81) + bonus

With no bonus -- every player ts_setuserslots never touched -- that is at least as strict as the
removed check (81 - carried), so the result is the same. Only a player with a bonus can now carry
past 81, and that is the point. reTS clears the bonus on every spawn (RVA 0x56a1e).

No relocation entry and no absolute reference covers the patched bytes, and the PE checksum is 0.
No AMXX gamedata pins mp.dll by CRC: the reTS sections are selected by the ReTS_GetInterface
export, which this patch does not touch.

3. Rollback
-------------------------------------------------------------

The original (MD5 {EXPECTED_MD5}) is kept as {ORIG} next to this script, and in the live
install as ts\dlls\mp.dll.original.bak-2026-10-20. Copy it back over ts\dlls\mp.dll with the
server closed.

Original: {EXPECTED_MD5}
Patched : {patched_md5}
"""

open(PATCH_TXT, 'w', encoding='utf-8', newline='\r\n').write(patch_doc)
print('wrote', PATCH_TXT)
