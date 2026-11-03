import pefile, keystone, struct, hashlib

ORIG = 'mp.dll.original'           # reTS mp.dll as shipped
BASE_IN = 'mp_patched_slots.dll'   # build_patch_mp_slots.py's output -- this patch stacks on it
OUT = 'mp_patched_slots_pwup.dll'
PATCH_TXT = 'mp_patched_slots_pwup.dll.patch'

ORIG_MD5 = '00b12524dcc913a3cd80d74449670df4'
SLOTS_MD5 = 'd13d4c6d029d9ba9a04a6fd08df8d96b'

orig = open(ORIG, 'rb').read()
data = bytearray(open(BASE_IN, 'rb').read())
print('original md5', hashlib.md5(orig).hexdigest())
print('slots md5   ', hashlib.md5(data).hexdigest())
assert hashlib.md5(orig).hexdigest() == ORIG_MD5, 'mp.dll.original is not the expected reTS build'
assert hashlib.md5(data).hexdigest() == SLOTS_MD5, 'mp_patched_slots.dll is not build_patch_mp_slots.py output'

pe = pefile.PE(data=bytes(data))
base = pe.OPTIONAL_HEADER.ImageBase

def rd(rva, n):
    o = pe.get_offset_from_rva(rva)
    return bytes(data[o:o + n])

def le(v):
    return struct.pack('<I', v)

# Patch A, carried over: the slots build differs from the original in the jg at RVA 0x62418 only.
SLOTS_SITE_RVA = 0x62415
SLOTS_JG_RVA = SLOTS_SITE_RVA + 3
slots_off = pe.get_offset_from_rva(SLOTS_JG_RVA)
diff = [i for i in range(len(orig)) if orig[i] != data[i]]
assert len(orig) == len(data) and diff == [slots_off, slots_off + 1], f'unexpected slots diff {diff}'
assert orig[slots_off - 3:slots_off + 2] == bytes.fromhex('83fb517f79')
assert data[slots_off:slots_off + 2] == b'\x90\x90'
print('patch A (slots) present at file offset', hex(slots_off))

# Patch B: CTSPowerup::Spawn (RVA 0x6f380) leaves the powerup's Touch NULL and schedules the
# materialize think (RVA 0x6f4a0). That think hides the powerup and checks again in 5 seconds
# while nopowerup is 1.0, and only arms Touch (RVA 0x6f5b4) once nopowerup is off and the
# powerup is on the floor. So with nopowerup 1 no powerup can ever be handed over.
SPAWN_RVA = 0x6f380
HOOK_RVA = 0x6f441                  # mov dword ptr [esi+0x18], 0  -- SetTouch(NULL)
HOOK_ORIG = bytes.fromhex('c7461800000000')
THINK_RVA = 0x6f4a0
NOPWUP_CVAR_RVA = 0xe1e98           # cvar_t nopowerup
NOPWUP_VALUE_RVA = NOPWUP_CVAR_RVA + 12
ONE_RVA = 0xab070                   # float 1.0
SETTOUCH_RVA = 0x6f5b4              # mov dword ptr [esi+0x18], &CTSPowerup::Touch (relocated)
TOUCHIMM_RVA = SETTOUCH_RVA + 3
TOUCH_RVA = 0x6f990                 # CTSPowerup::Touch
GRANT_RVA = 0x6fcc0                 # the grant Touch hands the player to
CVARPTR_SLOT_RVA = 0xe6e3c          # g_engfuncs (RVA 0xe6c6c) + 0x1d0: pfnCVarGetPointer
GRAVITY_CALL_RVA = 0x1c695          # push "sv_gravity"; call [pfnCVarGetPointer] -- reTS's own use
GRANT_SF = 0x40000000               # spawnflags bit 30: ts_matchmode's grant marker
GATE_CVAR = b'tsm_enabled'

assert rd(HOOK_RVA - 3, 3) == bytes.fromhex('83c40c'), 'Spawn: add esp,0xc not before the hook'
assert rd(HOOK_RVA, 7) == HOOK_ORIG, f'unexpected hook bytes {rd(HOOK_RVA, 7).hex()}'
assert rd(HOOK_RVA + 7, 7) == bytes.fromhex('c74614') + le(base + THINK_RVA), 'Spawn: SetThink(materialize) moved'
assert rd(THINK_RVA + 0xf, 8) == bytes.fromhex('f30f1005') + le(base + NOPWUP_VALUE_RVA), 'think: nopowerup load moved'
assert rd(THINK_RVA + 0x17, 7) == bytes.fromhex('0f2e05') + le(base + ONE_RVA), 'think: compare with 1.0 moved'
assert struct.unpack('<f', rd(ONE_RVA, 4))[0] == 1.0
name_ptr = struct.unpack('<I', rd(NOPWUP_CVAR_RVA, 4))[0]
assert pe.get_data(name_ptr - base, 10) == b'nopowerup\0', 'cvar_t at 0xe1e98 is not nopowerup'
assert rd(SETTOUCH_RVA, 7) == bytes.fromhex('c74618') + le(base + TOUCH_RVA), 'think: SetTouch(Touch) moved'
assert rd(TOUCH_RVA, 7) == bytes.fromhex('5553575650 89ce'.replace(' ', '')), 'Touch prologue'
assert rd(GRANT_RVA, 5) == bytes.fromhex('568b442410'), 'grant prologue'
assert rd(GRAVITY_CALL_RVA, 11) == b'\x68' + le(base + 0xce8b5) + b'\xff\x15' + le(base + CVARPTR_SLOT_RVA)
assert pe.get_data(0xce8b5, 11) == b'sv_gravity\0', 'reTS does not look sv_gravity up through the slot'
dsec = [s for s in pe.sections if s.Name.startswith(b'.data')][0]
assert dsec.VirtualAddress <= CVARPTR_SLOT_RVA < dsec.VirtualAddress + dsec.Misc_VirtualSize
print('Spawn, think, Touch, grant and the engine slot all where expected')

relocs = set()
for entry in pe.DIRECTORY_ENTRY_BASERELOC:
    for r in entry.entries:
        if r.type:
            relocs.add(r.rva)
assert not any(HOOK_RVA <= r < HOOK_RVA + 7 for r in relocs), 'relocation inside the hook'
assert TOUCHIMM_RVA in relocs, 'the SetTouch immediate the stub reads is not relocated'
print('no relocation inside the hook; the SetTouch immediate at', hex(TOUCHIMM_RVA), 'is relocated')

last = pe.sections[-1]
align = pe.OPTIONAL_HEADER.SectionAlignment
falign = pe.OPTIONAL_HEADER.FileAlignment
new_sec_va = ((last.VirtualAddress + last.Misc_VirtualSize + align - 1) // align) * align
new_sec_size = 0x1000
new_sec_raw = ((len(data) + falign - 1) // falign) * falign
STUB_RVA = new_sec_va
STUB_VA = base + STUB_RVA
L0_RVA = STUB_RVA + 5
STR_RVA = STUB_RVA + 0x80
assert new_sec_va not in relocs and not any(new_sec_va <= r < new_sec_va + new_sec_size for r in relocs)
print('new section RVA', hex(new_sec_va), 'VA', hex(STUB_VA), 'raw', hex(new_sec_raw))

# Called in place of SetTouch(NULL), with esi = the powerup. eax, ecx and edx are dead there:
# the call just before it already clobbered them and the code after reloads all three.
stub_asm = f"""
    call L0
L0:
    pop eax
    sub eax, {L0_RVA}
    mov ecx, dword ptr [esi + 4]
    test byte ptr [ecx + 0x1a3], 0x40
    je unarmed
    push eax
    lea ecx, [eax + {STR_RVA}]
    push ecx
    call dword ptr [eax + {CVARPTR_SLOT_RVA}]
    add esp, 4
    pop ecx
    test eax, eax
    je unarmed
    mov eax, dword ptr [eax + 12]
    add eax, eax
    je unarmed
    mov eax, dword ptr [ecx + {TOUCHIMM_RVA}]
    mov dword ptr [esi + 0x18], eax
    ret
unarmed:
    mov dword ptr [esi + 0x18], 0
    ret
"""
ks = keystone.Ks(keystone.KS_ARCH_X86, keystone.KS_MODE_32)
code_bytes, count = ks.asm(stub_asm, addr=STUB_VA)
code_bytes = bytes(code_bytes)
print('stub assembled:', len(code_bytes), 'bytes,', count, 'instructions')
assert len(code_bytes) <= STR_RVA - STUB_RVA, 'stub runs into its string'

enc, _ = ks.asm(f'call {STUB_VA}', addr=base + HOOK_RVA)
hook_patch = bytes(enc) + b'\x90\x90'
assert len(hook_patch) == 7 and hook_patch[0] == 0xE8, hook_patch.hex()
print('hook', hex(HOOK_RVA), hook_patch.hex(' '))

sec_content = bytearray(new_sec_size)
sec_content[0:len(code_bytes)] = code_bytes
so = STR_RVA - STUB_RVA
sec_content[so:so + len(GATE_CVAR) + 1] = GATE_CVAR + b'\0'

pe_hdr_off = pe.DOS_HEADER.e_lfanew
sec_table_off = pe_hdr_off + 4 + 20 + pe.FILE_HEADER.SizeOfOptionalHeader
new_entry_off = sec_table_off + pe.FILE_HEADER.NumberOfSections * 40
assert new_entry_off + 40 <= pe.OPTIONAL_HEADER.SizeOfHeaders
assert bytes(data[new_entry_off:new_entry_off + 40]) == b'\0' * 40, 'no free slot for a section header'
entry = struct.pack('<8sIIIIIIHHI', b'.h9pwup\x00', new_sec_size, new_sec_va, new_sec_size,
                    new_sec_raw, 0, 0, 0, 0, 0x60000020)   # CODE | EXECUTE | READ
data[new_entry_off:new_entry_off + 40] = entry

num_sec_off = pe_hdr_off + 4 + 2
cur_num = struct.unpack_from('<H', data, num_sec_off)[0]
assert cur_num == pe.FILE_HEADER.NumberOfSections
struct.pack_into('<H', data, num_sec_off, cur_num + 1)

size_of_image_off = pe_hdr_off + 4 + 20 + 56
cur_soi = struct.unpack_from('<I', data, size_of_image_off)[0]
assert cur_soi == pe.OPTIONAL_HEADER.SizeOfImage
new_soi = ((new_sec_va + new_sec_size + align - 1) // align) * align
struct.pack_into('<I', data, size_of_image_off, new_soi)
print('SizeOfImage', hex(cur_soi), '->', hex(new_soi))

slots_size = len(data)
if len(data) < new_sec_raw:
    data.extend(b'\0' * (new_sec_raw - len(data)))
assert len(data) == new_sec_raw
data.extend(sec_content)

hook_off = pe.get_offset_from_rva(HOOK_RVA)
data[hook_off:hook_off + 7] = hook_patch

open(OUT, 'wb').write(data)
patched_md5 = hashlib.md5(data).hexdigest()
print('wrote', OUT, len(data), 'bytes')
print('patched md5', patched_md5)

chk = pefile.PE(OUT)
assert chk.FILE_HEADER.NumberOfSections == cur_num + 1
assert chk.sections[-1].Name.rstrip(b'\0') == b'.h9pwup'
rel = struct.unpack('<i', chk.get_data(HOOK_RVA + 1, 4))[0]
assert HOOK_RVA + 5 + rel == STUB_RVA, 'hook does not reach the stub'
assert chk.get_data(STR_RVA, len(GATE_CVAR) + 1) == GATE_CVAR + b'\0'
assert chk.get_data(TOUCHIMM_RVA, 4) == le(base + TOUCH_RVA)
print('patched PE re-read: hook -> stub, string in place, Touch immediate intact')

# Every byte that differs from the shipped file, as ranges.
ranges = []
for i in range(len(data)):
    if i >= len(orig) or data[i] != orig[i]:
        if ranges and ranges[-1][1] == i:
            ranges[-1][1] = i + 1
        else:
            ranges.append([i, i + 1])
what = [(pe_hdr_off + 6, 2, 'FILE_HEADER.NumberOfSections'),
        (size_of_image_off, 4, 'OPTIONAL_HEADER.SizeOfImage'),
        (new_entry_off, 40, 'section table: the .h9pwup entry'),
        (slots_off, 2, 'A: the 81-slot jg'),
        (hook_off, 7, 'B: the hook in CTSPowerup::Spawn'),
        (new_sec_raw, new_sec_size, 'B: the .h9pwup section (appended)')]
for lo, hi in ranges:
    assert any(lo < k + n and k < hi for k, n, t in what), f'unlabelled change at {hex(lo)}'
diff_lines = []
for k, n, t in what:
    changed = sum(1 for i in range(k, k + n) if i >= len(orig) or data[i] != orig[i])
    diff_lines.append('    0x%06x-0x%06x  %4d bytes, %4d changed  %s' % (k, k + n - 1, n, changed, t))
diff_text = '\n'.join(diff_lines)

from capstone import Cs, CS_ARCH_X86, CS_MODE_32
md = Cs(CS_ARCH_X86, CS_MODE_32)
def lines(buf, va):
    return '\n'.join('    %08x  %-16s %s %s' % (i.address, i.bytes.hex(), i.mnemonic, i.op_str)
                     for i in md.disasm(buf, va))
slots_before = lines(orig[slots_off - 19:slots_off + 6], base + SLOTS_JG_RVA - 19)
slots_after = lines(bytes(data[slots_off - 19:slots_off + 6]), base + SLOTS_JG_RVA - 19)
hook_before = lines(orig[hook_off - 8:hook_off + 14], base + HOOK_RVA - 8)
hook_after = lines(bytes(data[hook_off - 8:hook_off + 14]), base + HOOK_RVA - 8)
think_lines = lines(rd(THINK_RVA + 0xf, 0x4c - 0xf), base + THINK_RVA + 0xf)
stub_lines = lines(code_bytes, STUB_VA)

patch_doc = rf"""TSM mp.dll patches -- reTS's server DLL, two changes
=====================================================

What this is: reTS's mp.dll (ts\dlls\mp.dll) with two binary patches, built from the shipped
file in this order:

  A. The weapon inventory's fixed 81-slot ceiling is lifted, so the room ts_setuserslots grants
     is the only slot limit a player has. 2 bytes. (build_patch_mp_slots.py)
  B. ts_matchmode can hand a player a powerup through TS's own pickup while nopowerup is 1 --
     only powerups ts_matchmode builds, and only while tsm_enabled is on. Everywhere else
     nopowerup 1 still blocks every powerup. A 7-byte hook and one new section.
     (build_patch_mp_pwup.py)

It is deployed as ts\dlls\mp.dll, with this file beside it as mp.dll.patch, in the Steam
install and in H9XASH.

Original file : {ORIG} (reTS mp.dll as shipped)
After A       : {BASE_IN}
After A and B : {OUT}
Original MD5  : {ORIG_MD5}
After A MD5   : {SLOTS_MD5}
Patched MD5   : {patched_md5}
Original size : {len(orig)} bytes
Patched size  : {len(data)} bytes (+{len(data) - len(orig)}, the new section)

Every byte that differs from the original (file offsets):

{diff_text}


A. The weapon inventory's fixed 81-slot ceiling
-------------------------------------------------------------

reTS checks a weapon give twice. The player check (RVA 0x567a0, free slots from RVA 0x61460)
counts the bonus ts_setuserslots stores at player+0xc0c, so a player given 999 passes it. The
weapon inventory's own add routine (RVA 0x622d0) then sums the weight of everything carried,
adds the new weapon's, and refuses past a fixed 81 -- ignoring that bonus. The Heavy's kit is
M60E3 70 + Glock-20C 10 + M61 grenade 7 = 87, so one piece of it was always refused, however
much room the plugin gave him. No other class's kit passes 81 (the Marksman's 80 is closest).

    file offset 0x{slots_off:x} (RVA 0x{SLOTS_JG_RVA:x}):
      original: 7f 79   (jg 0x10062493 -- return false)
      patched:  90 90   (nop; nop)

Before:

{slots_before}

After:

{slots_after}

ebx is reloaded at 0x6241a, so nothing downstream reads the compare.

The add routine has one caller (RVA 0x56845, inside 0x567a0), and that caller has already
refused any weapon heavier than the player's free slots:

    free = min(max(81 - carried - item penalties, 0), 81) + bonus

With no bonus -- every player ts_setuserslots never touched -- that is at least as strict as the
removed check (81 - carried), so the result is the same. Only a player with a bonus can now carry
past 81. reTS clears the bonus on every spawn (RVA 0x56a1e). No relocation entry and no absolute
reference covers the two bytes.
"""

patch_doc += rf"""

B. The powerup grant, for ts_matchmode only
-------------------------------------------------------------

B.1 Why no powerup could be given while nopowerup is 1

A ts_powerup does nothing when touched until its first think has armed it. CTSPowerup::Spawn
(RVA 0x{SPAWN_RVA:x}) sets Touch to NULL and schedules the materialize think (RVA 0x{THINK_RVA:x})
for 0.1 s later. The think starts with the nopowerup test:

{think_lines}

While nopowerup is 1.0 it sets EF_NODRAW and looks again in 5 seconds, for as long as the
powerup exists. Only with nopowerup off and the powerup on the floor does it make it a trigger,
size it, and set Touch to CTSPowerup::Touch (the SetTouch at RVA 0x{SETTOUCH_RVA:x}).

So with nopowerup 1, every way the AMXX TS module offers fails:

  * ts_createpwup builds a powerup that never materializes: invisible, and untouchable.
  * ts_givepwup calls the powerup's Touch -- still NULL, so nothing happens -- and removes it.
  * ts_force_run_powerup writes the player's running and carried powerup slots (+0x794 and
    +0x798, through the reTS interface, with the timer at +0x79c). Kung fu is never read from
    there: reTS reads it from the player's own flag at +0x960 (RVA 0x55800), as infinite ammo
    and double fire rate are read from the running slot's bits 2 and 0x10 (RVA 0x557d0,
    0x557e0). So it never gave kung fu at all.

CTSPowerup::Touch (RVA 0x{TOUCH_RVA:x}) does not look at nopowerup itself. It checks the toucher
is a live player, works out whether a carried slow-motion type has to be swapped (+use), and
hands the player to the grant at RVA 0x{GRANT_RVA:x}, which applies each type the way TS does:
kung fu sets the player's flag at +0x960 and sends PwUp, superjump sets its flag and physics key,
armor and health top up, the grenade and infinite ammo are given, and the slow-motion types are
carried until used. It plays items/gunpickup2.wav, and Touch then removes the powerup.

B.2 The hook

SetTouch(NULL) in Spawn becomes a call to the stub:

    file offset 0x{hook_off:x} (RVA 0x{HOOK_RVA:x}):
      original: {HOOK_ORIG.hex(' ')}   (mov dword ptr [esi+0x18], 0)
      patched:  {hook_patch.hex(' ')}   (call stub; nop; nop)

Before:

{hook_before}

After:

{hook_after}

A relative call: no relocation entry, correct wherever the DLL loads. eax, ecx and edx are dead
there -- the call just before clobbered them and the code after reloads all three -- and the
stub touches nothing else.

B.3 The stub (section .h9pwup, VA 0x{STUB_VA:x})

{stub_lines}

  * spawnflags bit 30 (0x{GRANT_SF:08x}) clear: Touch = NULL, exactly as before.
  * Otherwise g_engfuncs.pfnCVarGetPointer("{GATE_CVAR.decode()}"), through slot RVA 0x{CVARPTR_SLOT_RVA:x} -- the
    slot reTS itself uses at load to look up sv_gravity (RVA 0x{GRAVITY_CALL_RVA:x}). NULL (no
    ts_matchmode loaded) or a value of 0: Touch = NULL, exactly as before.
  * Otherwise Touch = CTSPowerup::Touch, read from the immediate of the think's own SetTouch at
    RVA 0x{TOUCHIMM_RVA:x}. That immediate carries a relocation entry, so it holds the address
    the loader really put Touch at, also when ASLR moves the DLL (DllCharacteristics 0x140,
    DYNAMIC_BASE).

It is position independent -- call/pop gives the module base, and the engine slot, the string
and the Touch immediate are reached as base+RVA -- so the section has no relocation entries.
"{GATE_CVAR.decode()}" is at offset 0x{STR_RVA - STUB_RVA:x}; the rest of the 4096 bytes is zero.
"""

patch_doc += rf"""
B.4 Why every other server, and every other powerup, is unchanged

  * The think is not touched. A powerup still never materializes while nopowerup is 1: never
    drawn, never a trigger, no size, so nobody walks into one. An armed one differs only in that
    an explicit Touch call -- the grant -- now works.
  * Arming needs both conditions. The bit: no map sets it (TS's powerup reads only spawnflags'
    low bits, as the random-type mask at RVA 0x6f672), and ts_matchmode sets it on the powerups
    it builds. And tsm_enabled: it exists only while ts_matchmode is loaded, and is non-zero
    only while its mode is on. On any server without ts_matchmode, or with tsm_enabled 0, this
    DLL behaves as reTS with patch A.
  * ts_matchmode touches an armed powerup in the frame it builds it, and TS's Touch removes it,
    so none is left lying around.

B.5 How ts_matchmode uses it

tsm_grant_powerup(id, type) creates a ts_powerup, gives it pwuptype and pwupduration, puts it at
the player, sets spawnflags bit 30, and calls Spawn and then Touch(player) -- all in one frame.
TS's Touch removes a powerup it handed over (FL_KILLME), so one still standing was refused, or
this DLL is not the patched one; the plugin removes it and reports false. The Officer's kung fu
goes through it at the start of every live round.

B.6 PE header changes -- registering the new section

  * File header, NumberOfSections: {cur_num} -> {cur_num + 1}
  * Optional header, SizeOfImage: 0x{cur_soi:x} -> 0x{new_soi:x}
  * New section table entry, in existing header slack:

      Name             .h9pwup
      VirtualAddress   0x{new_sec_va:x}
      VirtualSize      0x{new_sec_size:x}
      PointerToRawData 0x{new_sec_raw:x}
      SizeOfRawData    0x{new_sec_size:x}
      Characteristics  0x60000020  (CODE | EXECUTE | READ -- not writable)

The existing sections are untouched; the new one is appended after the original last byte. The
PE checksum is 0, as shipped.


Rollback
-------------------------------------------------------------

The original (MD5 {ORIG_MD5}) is kept as {ORIG} next to the build scripts, and in the Steam
install as ts\dlls\mp.dll.original.bak-2026-10-20. Patch A alone is {BASE_IN} (MD5 {SLOTS_MD5}).
Copy either over ts\dlls\mp.dll with the server closed.

Original: {ORIG_MD5}
Patched : {patched_md5}
"""

open(PATCH_TXT, 'w', encoding='utf-8', newline='\r\n').write(patch_doc)
bad = [c for c in patch_doc if ord(c) < 32 and c != '\n']
assert not bad, f'control characters in the doc: {set(map(ord, bad))}'
print('wrote', PATCH_TXT)
