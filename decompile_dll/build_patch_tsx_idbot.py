import pefile, keystone, struct, hashlib

ORIG = 'tsx_amxx.dll.original'   # reTSX as shipped with reTS; modules\tsx_amxx.dll is the deployed patched copy
OUT = 'tsx_amxx_patched_idbot.dll'
PATCH_TXT = 'tsx_amxx_patched_idbot.dll.patch'

EXPECTED_MD5 = 'd39732bce2d27488b7bbb0fa6996cd22'

pe = pefile.PE(ORIG)
base = pe.OPTIONAL_HEADER.ImageBase
data = bytearray(open(ORIG, 'rb').read())

print('original md5', hashlib.md5(data).hexdigest())
assert hashlib.md5(data).hexdigest() == EXPECTED_MD5, 'tsx_amxx.dll is not the expected reTSX build'

# tsx's ClientUserInfoChanged_Post marks a player that is not yet in game as a bot only when
# GetPlayerAuthId returns "BOT":
#   0x73cd  push [esi]; call [g_engfuncs.pfnGetPlayerAuthId]
#   0x73dc  push "BOT"            (relocated -- left alone)
#   0x73e1  push eax
#   0x73e2  call strcmp           (rel32, no relocation -- becomes call stub)
#   0x73ea  test eax, eax; jne skip; ... PutInServer
# Xash3D FWGS names its bots "ID_BOT", so there tsx never put a bot in game.
HOOK_RVA = 0x73e2
HOOK_ORIG = bytes.fromhex('e8b9b80000')
STRCMP_RVA = 0x12ca0
CVARPTR_SLOT_RVA = 0x8d560   # g_engfuncs (RVA 0x8d390) + 116*4: pfnCVarGetPointer
CONTEXT_RVA = 0x73dc            # push "BOT"; push eax -- checked, not changed

hook_off = pe.get_offset_from_rva(HOOK_RVA)
assert bytes(data[hook_off:hook_off+5]) == HOOK_ORIG, \
    f'unexpected hook bytes: {bytes(data[hook_off:hook_off+5]).hex()}'
ctx_off = pe.get_offset_from_rva(CONTEXT_RVA)
assert bytes(data[ctx_off:ctx_off+6]) == bytes.fromhex('687b5f021050'), 'push "BOT"; push eax not where expected'
assert pe.get_data(0x25f7b, 4) == b'BOT\0', 'the "BOT" literal moved'
assert struct.unpack_from('<I', data, ctx_off + 1)[0] == base + 0x25f7b

# The new section starts at the next section-aligned RVA after the last section.
last = pe.sections[-1]
align = pe.OPTIONAL_HEADER.SectionAlignment
new_sec_va = ((last.VirtualAddress + last.Misc_VirtualSize + align - 1) // align) * align
new_sec_size = 0x1000
new_sec_raw = ((len(data) + pe.OPTIONAL_HEADER.FileAlignment - 1)
               // pe.OPTIONAL_HEADER.FileAlignment) * pe.OPTIONAL_HEADER.FileAlignment
STUB_RVA = new_sec_va
STUB_VA = base + STUB_RVA
STR_HOSTVER_RVA = STUB_RVA + 0x80
STR_IDBOT_RVA = STUB_RVA + 0x90
L0_RVA = STUB_RVA + 5          # call L0 (5) is the first instruction
print('new section RVA', hex(new_sec_va), 'VA', hex(base + new_sec_va), 'raw', hex(new_sec_raw))

# Same contract as the strcmp it replaces: cdecl (auth, "BOT"), 0 means "this is a bot".
# Position-independent: call/pop turns ecx into the module base, and everything else is reached
# as base+RVA, so the stub needs no relocation entries.
stub_asm = f"""
    call L0
L0:
    pop ecx
    sub ecx, {L0_RVA}
    push ecx
    push dword ptr [esp + 12]
    push dword ptr [esp + 12]
    call {base + STRCMP_RVA}
    add esp, 8
    pop ecx
    test eax, eax
    je done
    push ecx
    lea edx, [ecx + {STR_HOSTVER_RVA}]
    push edx
    call dword ptr [ecx + {CVARPTR_SLOT_RVA}]
    add esp, 4
    pop ecx
    test eax, eax
    je not_bot
    lea edx, [ecx + {STR_IDBOT_RVA}]
    push edx
    push dword ptr [esp + 8]
    call {base + STRCMP_RVA}
    add esp, 8
done:
    ret
not_bot:
    mov eax, 1
    ret
"""

ks = keystone.Ks(keystone.KS_ARCH_X86, keystone.KS_MODE_32)
code_bytes, count = ks.asm(stub_asm, addr=STUB_VA)
code_bytes = bytes(code_bytes)
print('stub assembled:', len(code_bytes), 'bytes,', count, 'instructions')
assert len(code_bytes) <= STR_HOSTVER_RVA - STUB_RVA, 'stub runs into its strings'

enc, _ = ks.asm(f'call {STUB_VA}', addr=base + HOOK_RVA)
hook_patch = bytes(enc)
assert len(hook_patch) == 5 and hook_patch[0] == 0xE8, hook_patch.hex()
print('hook', hex(HOOK_RVA), hook_patch.hex(' '))

# No relocation entry may live inside the replaced call or the new section.
pe.parse_data_directories()
for entry in pe.DIRECTORY_ENTRY_BASERELOC:
    for rel in entry.entries:
        if not rel.type:
            continue
        if HOOK_RVA <= rel.rva < HOOK_RVA + 5:
            raise SystemExit(f'unexpected relocation at {hex(rel.rva)} inside the hook')
        if new_sec_va <= rel.rva < new_sec_va + new_sec_size:
            raise SystemExit(f'unexpected relocation at {hex(rel.rva)} inside new section')
print('no relocation entries inside the hook or new section')

# The engine-function slot is inside .data, which GiveFnptrsToDll fills at load.
dsec = [s for s in pe.sections if s.Name.startswith(b'.data')][0]
assert dsec.VirtualAddress <= CVARPTR_SLOT_RVA < dsec.VirtualAddress + dsec.Misc_VirtualSize

sec_content = bytearray(new_sec_size)
sec_content[0:len(code_bytes)] = code_bytes
for rva, text in ((STR_HOSTVER_RVA, b'host_ver\0'), (STR_IDBOT_RVA, b'ID_BOT\0')):
    o = rva - STUB_RVA
    sec_content[o:o+len(text)] = text

pe_hdr_off = pe.DOS_HEADER.e_lfanew
sec_table_off = pe_hdr_off + 4 + 20 + pe.FILE_HEADER.SizeOfOptionalHeader
new_entry_off = sec_table_off + pe.FILE_HEADER.NumberOfSections * 40
assert new_entry_off + 40 <= pe.OPTIONAL_HEADER.SizeOfHeaders
assert bytes(data[new_entry_off:new_entry_off+40]) == b'\0' * 40, 'no free slot for a section header'
name = b'.h9bot\x00\x00'
assert len(name) == 8
entry = struct.pack('<8sIIIIIIHHI',
    name,
    new_sec_size,        # VirtualSize
    new_sec_va,          # VirtualAddress
    new_sec_size,        # SizeOfRawData
    new_sec_raw,         # PointerToRawData
    0, 0, 0, 0,          # relocations/linenumbers (unused, legacy)
    0x60000020)          # CODE | EXECUTE | READ
assert len(entry) == 40
data[new_entry_off:new_entry_off+40] = entry

num_sec_off = pe_hdr_off + 4 + 2
cur_num = struct.unpack_from('<H', data, num_sec_off)[0]
assert cur_num == pe.FILE_HEADER.NumberOfSections
struct.pack_into('<H', data, num_sec_off, cur_num + 1)

opt_off = pe_hdr_off + 4 + 20
size_of_image_off = opt_off + 56
cur_soi = struct.unpack_from('<I', data, size_of_image_off)[0]
new_soi = ((new_sec_va + new_sec_size + align - 1) // align) * align
assert cur_soi == pe.OPTIONAL_HEADER.SizeOfImage
struct.pack_into('<I', data, size_of_image_off, new_soi)
print('SizeOfImage', hex(cur_soi), '->', hex(new_soi))

orig_size = len(data)
if len(data) < new_sec_raw:
    data.extend(b'\x00' * (new_sec_raw - len(data)))
assert len(data) == new_sec_raw
data.extend(sec_content)

data[hook_off:hook_off+5] = hook_patch

open(OUT, 'wb').write(data)
patched_md5 = hashlib.md5(data).hexdigest()
print('wrote', OUT, len(data), 'bytes')
print('patched md5', patched_md5)

# Read the result back as a PE and check the hook really lands on the stub.
chk = pefile.PE(OUT)
assert chk.FILE_HEADER.NumberOfSections == cur_num + 1
assert chk.sections[-1].Name.rstrip(b'\0') == b'.h9bot'
rel = struct.unpack_from('<i', chk.get_data(HOOK_RVA + 1, 4))[0]
assert HOOK_RVA + 5 + rel == STUB_RVA, 'hook does not reach the stub'
assert chk.get_data(STR_HOSTVER_RVA, 9) == b'host_ver\0' and chk.get_data(STR_IDBOT_RVA, 7) == b'ID_BOT\0'
print('patched PE re-read: hook -> stub, strings in place')

try:
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    def lines(buf, va):
        return '\n'.join('    %08x  %-16s %s %s' % (i.address, i.bytes.hex(), i.mnemonic, i.op_str)
                         for i in md.disasm(buf, va))
    site = lines(bytes(data[ctx_off-15:ctx_off+25]), base + CONTEXT_RVA - 15)
    disasm = lines(code_bytes, STUB_VA)
except Exception as e:
    site = disasm = f'(capstone unavailable: {e})'

patch_doc = rf"""TSM tsx_amxx.dll patch -- Xash3D's bots count as bots
=======================================================

What this is: a binary patch to reTSX (ts\addons\amxmodx\modules\tsx_amxx.dll), the AMX Mod X
TS module that ships with reTS, so it puts Xash3D FWGS's bots in game the way it does
GoldSrc's.

tsx keeps its own table of who is in game, and every tsx native refuses a player that table
does not have ("[TSX] Player N is not ingame"). A bot reaches that table only through tsx's
ClientUserInfoChanged_Post, and only when the engine's GetPlayerAuthId for it is "BOT". GoldSrc
says "BOT". Xash3D FWGS says "ID_BOT" (engine/server/sv_client.c, SV_GetClientIDString), so on
Xash no bot was ever put in game: ts_setuserslots and every other tsx native failed on them,
and the plugin call setting a bot up died with a run time error.

The patch keeps the "BOT" test and adds one more: when the engine is Xash3D -- the cvar
host_ver exists, the same test ts_matchmode uses -- "ID_BOT" counts as well. On GoldSrc host_ver
does not exist and the answer is exactly what it was. AMX Mod X core needs nothing: its own bot
test checks FL_FAKECLIENT first, which FWGS sets.

Original file : {ORIG} (reTSX as shipped with reTS)
Patched file  : {OUT}
Original MD5  : {EXPECTED_MD5}
Patched MD5   : {patched_md5}
Original size : {orig_size} bytes
Patched size  : {len(data)} bytes (+{len(data) - orig_size})

1. The hook
-------------------------------------------------------------

The bot test in ClientUserInfoChanged_Post, after the patch:

{site}

Only the call at RVA 0x{HOOK_RVA:x} changes:

    file offset 0x{hook_off:x}:
      original: {HOOK_ORIG.hex(' ')}   (call strcmp)
      patched:  {hook_patch.hex(' ')}   (call stub)

It is a relative call with no relocation entry, so it stays correct when the DLL is relocated.
The push of "BOT" before it carries a relocation and is left exactly as it was; the stub reads
that argument like strcmp would.

2. PE header changes -- registering the new section
-------------------------------------------------------------

  * File header, NumberOfSections: {cur_num} -> {cur_num + 1}
  * Optional header, SizeOfImage: 0x{cur_soi:x} -> 0x{new_soi:x}
  * New section table entry appended into existing header slack:

      Name             .h9bot
      VirtualAddress   0x{new_sec_va:x}
      VirtualSize      0x{new_sec_size:x}
      PointerToRawData 0x{new_sec_raw:x}
      SizeOfRawData    0x{new_sec_size:x}
      Characteristics  0x60000020  (CODE | EXECUTE | READ -- not writable)

Existing sections are untouched. The new section is appended after the original last byte.

3. The new .h9bot section (file offset 0x{new_sec_raw:x}, 4096 bytes)
-------------------------------------------------------------

The stub is at offset 0, "host_ver" at 0x{STR_HOSTVER_RVA - STUB_RVA:x}, "ID_BOT" at 0x{STR_IDBOT_RVA - STUB_RVA:x}; the rest is zero.
It keeps strcmp's contract (cdecl, returns 0 for a bot) and is position independent:
`call L0 / pop ecx / sub ecx,0x{L0_RVA:x}` turns ecx into the module base, and the engine
function and both strings are reached as base+RVA, so it needs no relocation entries.

Stub disassembly (VA 0x{STUB_VA:x}):

{disasm}

The steps are:

  * strcmp(auth, "BOT") through the module's own strcmp (RVA 0x{STRCMP_RVA:x}). 0 is returned as is.
  * Otherwise g_engfuncs.pfnCVarGetPointer("host_ver"), from slot RVA 0x{CVARPTR_SLOT_RVA:x} -- the slot
    reTSX itself uses at load (RVA 0x76c0) to look up its tsstats cvars.
  * NULL means GoldSrc: return 1, not a bot by auth -- the same answer as before.
  * Otherwise return strcmp(auth, "ID_BOT").

No real player's auth is exactly "ID_BOT": FWGS gives players ID_LOOPBACK, ID_LAN or ID_<hash>,
and GoldSrc's are STEAM_/VALVE_ forms.

4. Rollback
-------------------------------------------------------------

The original (MD5 {EXPECTED_MD5}) is kept as {ORIG} next to this script. Copy it back over
ts\addons\amxmodx\modules\tsx_amxx.dll with the server closed.

Original: {EXPECTED_MD5}
Patched : {patched_md5}
"""

open(PATCH_TXT, 'w', encoding='utf-8', newline='\r\n').write(patch_doc)
print('wrote', PATCH_TXT)
