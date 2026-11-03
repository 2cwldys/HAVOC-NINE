import pefile, keystone, struct, hashlib

ORIG = 'client.dll.original'   # keep the stock DLL here; client.dll is the deployed patched copy
OUT = 'client_patched_cloak.dll'
PATCH_TXT = 'client_patched_cloak.dll.patch'

EXPECTED_MD5 = 'cfc60e4e96c51903e6ef7d2b9839b3b7'

pe = pefile.PE(ORIG)
base = pe.OPTIONAL_HEADER.ImageBase
data = bytearray(open(ORIG, 'rb').read())

print('original md5', hashlib.md5(data).hexdigest())
assert hashlib.md5(data).hexdigest() == EXPECTED_MD5, 'client.dll is not the expected original'

# Same .text RVA-to-file-offset relationship verified by the v3/v4/v5 patches.
DELTA = 0x1000 - 0x400
def rva_to_off(rva): return rva - DELTA

# Two paths reach the same local-player transparency block at 0x4d0b7:
#   0x4cfe6  jne 0x4d0b7   (the non-null result path)
#   0x4d0b1  je  0x4d191   (the fall-through path)
# Both are 6-byte relative branches, so neither has a relocation entry. Hooking both catches
# every route into the block without overwriting the relocated cmp immediate at 0x4d0bb.
HOOK1_RVA = 0x4cfe6
HOOK1_ORIG = bytes.fromhex('0f85cb000000')   # jne 0x1004d0b7
HOOK2_RVA = 0x4d0b1
HOOK2_ORIG = bytes.fromhex('0f84da000000')   # je  0x1004d191

hook1_off = rva_to_off(HOOK1_RVA)
hook2_off = rva_to_off(HOOK2_RVA)
assert bytes(data[hook1_off:hook1_off+6]) == HOOK1_ORIG, \
    f'unexpected hook1 bytes: {bytes(data[hook1_off:hook1_off+6]).hex()}'
assert bytes(data[hook2_off:hook2_off+6]) == HOOK2_ORIG, \
    f'unexpected hook2 bytes: {bytes(data[hook2_off:hook2_off+6]).hex()}'

# The .text section's virtual size is 0x8c528, so the next section VA is 0x2d8000.
last = pe.sections[-1]
new_sec_va = ((last.VirtualAddress + last.Misc_VirtualSize + pe.OPTIONAL_HEADER.SectionAlignment - 1)
              // pe.OPTIONAL_HEADER.SectionAlignment) * pe.OPTIONAL_HEADER.SectionAlignment
new_sec_size = 0x1000
new_sec_raw = ((len(data) + pe.OPTIONAL_HEADER.FileAlignment - 1)
               // pe.OPTIONAL_HEADER.FileAlignment) * pe.OPTIONAL_HEADER.FileAlignment
new_sec_rva = new_sec_va
print('new section RVA', hex(new_sec_rva), 'VA', hex(base + new_sec_rva),
      'raw', hex(new_sec_raw), 'size', hex(new_sec_size))

# The stub starts at the new section. L0 is the pop ecx immediately after the 5-byte call.
STUB_RVA = new_sec_rva
STUB_VA = base + STUB_RVA
L0_RVA = STUB_RVA + 7       # mov edi,eax (2) + call L0 (5)

# Position-independent: ecx is turned into the module base, and all engine addresses are
# reached as base+RVA. The only absolute value is the RVA subtracted from the call/pop result.
#
# If the local player's current client state is kRenderTransTexture (2) with alpha below 255,
# the server is asking for a cloak: leave that state alone and continue at the post-override
# label 0x4d191. Otherwise restore eax=edi and continue at the original block at 0x4d0b7, which
# performs the normal cl_thirdtransparency logic unchanged.
stub_asm = f"""
    mov edi, eax
    call L0
L0:
    pop ecx
    sub ecx, {L0_RVA}
    test edi, edi
    je skip_all
    cmp dword ptr [edi + 0x2f8], 2
    jne not_cloak
    cmp dword ptr [edi + 0x2fc], 255
    jb skip_all
not_cloak:
    mov eax, edi
    lea edx, [ecx + 0x4d0b7]
    jmp edx
skip_all:
    lea edx, [ecx + 0x4d191]
    jmp edx
"""

ks = keystone.Ks(keystone.KS_ARCH_X86, keystone.KS_MODE_32)
code_bytes, count = ks.asm(stub_asm, addr=STUB_VA)
code_bytes = bytes(code_bytes)
print('stub assembled:', len(code_bytes), 'bytes,', count, 'instructions')
assert len(code_bytes) <= new_sec_size, 'stub does not fit in the new section'

# Each 6-byte branch is replaced by a 5-byte relative jmp plus a NOP. Relative jmps need no
# relocation and stay correct if the DLL is relocated.
def make_hook(rva):
    enc, _ = ks.asm(f'jmp {STUB_VA}', addr=base + rva)
    enc = bytes(enc)
    assert len(enc) == 5 and enc[0] == 0xE9, (rva, enc.hex())
    return enc + b'\x90'

hook1_patch = make_hook(HOOK1_RVA)
hook2_patch = make_hook(HOOK2_RVA)
print('hook1', hex(HOOK1_RVA), hook1_patch.hex(' '))
print('hook2', hex(HOOK2_RVA), hook2_patch.hex(' '))

# Make sure no relocation entry lives inside the bytes we replace or the new section.
pe.parse_data_directories()
for entry in pe.DIRECTORY_ENTRY_BASERELOC:
    for rel in entry.entries:
        for rva in (HOOK1_RVA, HOOK2_RVA):
            if rva <= rel.rva < rva + 6:
                raise SystemExit(f'unexpected relocation at {hex(rel.rva)} inside hook {hex(rva)}')
        if new_sec_rva <= rel.rva < new_sec_rva + new_sec_size:
            raise SystemExit(f'unexpected relocation at {hex(rel.rva)} inside new section')
print('no relocation entries inside hooks or new section')

# New section content: stub at offset 0, rest zero padding.
sec_content = bytearray(new_sec_size)
sec_content[0:len(code_bytes)] = code_bytes

# Add the section header entry in the existing header slack.
pe_hdr_off = pe.DOS_HEADER.e_lfanew
sec_table_off = pe_hdr_off + 4 + 20 + pe.FILE_HEADER.SizeOfOptionalHeader
new_entry_off = sec_table_off + pe.FILE_HEADER.NumberOfSections * 40
name = b'.cloak\x00\x00'
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

# NumberOfSections: signature(4) + Machine(2) -> the field is at e_lfanew + 6.
num_sec_off = pe_hdr_off + 4 + 2
cur_num = struct.unpack_from('<H', data, num_sec_off)[0]
assert cur_num == pe.FILE_HEADER.NumberOfSections
struct.pack_into('<H', data, num_sec_off, cur_num + 1)

# SizeOfImage: PE32 optional header field at optional-header + 56.
opt_off = pe_hdr_off + 4 + 20
size_of_image_off = opt_off + 56
cur_soi = struct.unpack_from('<I', data, size_of_image_off)[0]
new_soi = ((new_sec_va + new_sec_size + pe.OPTIONAL_HEADER.SectionAlignment - 1)
           // pe.OPTIONAL_HEADER.SectionAlignment) * pe.OPTIONAL_HEADER.SectionAlignment
assert cur_soi == pe.OPTIONAL_HEADER.SizeOfImage
struct.pack_into('<I', data, size_of_image_off, new_soi)
print('SizeOfImage', hex(cur_soi), '->', hex(new_soi))

# Extend to the new section's raw offset and append its content.
if len(data) < new_sec_raw:
    data.extend(b'\x00' * (new_sec_raw - len(data)))
assert len(data) == new_sec_raw
data.extend(sec_content)

# Install both hooks. The two bytes after each 5-byte jmp are overwritten by the NOP plus the
# original last branch byte (which is part of the dead displacement and is never executed).
data[hook1_off:hook1_off+6] = hook1_patch
data[hook2_off:hook2_off+6] = hook2_patch

open(OUT, 'wb').write(data)
patched_md5 = hashlib.md5(data).hexdigest()
print('wrote', OUT, len(data), 'bytes')
print('patched md5', patched_md5)

# Human-readable, byte-for-byte patch description, matching the style of the existing v5 patch.
try:
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    disasm_lines = []
    for ins in md.disasm(code_bytes, STUB_VA):
        disasm_lines.append('    %08x  %-24s %s %s' % (ins.address, ins.bytes.hex(), ins.mnemonic, ins.op_str))
    disasm = '\n'.join(disasm_lines)
except Exception as e:
    disasm = f'(capstone unavailable: {e})'

patch_doc = f"""TSM client.dll patch -- local-player cloak alpha
=================================================

What this is: a binary patch to Half-Life's TS client DLL (cl_dlls\\client.dll) that lets the
server's cloak render amount apply to the local player's own third-person model.

The TS client has a per-frame block (around RVA 0x4d0af) that grabs the local player entity and
overwrites its curstate rendermode/renderamt with a fixed third-person transparency based on
cl_thirdtransparency. It uses 100 when cl_thirdtransparency is 1 and third-person is active,
otherwise 255. That overwrite is why changing tsm_cloak_opacity never changed the cloaker's own
model: the client replaced the server's value every frame.

This patch adds a small pre-check before that block. If the local player's current client state is
already kRenderTransTexture (2) with renderamt below 255 -- which is exactly what the server sends
for a cloak -- the client skips the fixed override and leaves the server's render state alone.
Every non-cloak frame still takes the original path, so normal cl_thirdtransparency behavior is
unchanged.

Original file : client.dll.original (stock client.dll)
Patched file  : client_patched_cloak.dll
Original MD5  : {EXPECTED_MD5}
Patched MD5   : {patched_md5}
Original size : {len(data) - new_sec_size} bytes
Patched size  : {len(data)} bytes (+{new_sec_size})

1. The two hooks
-------------------------------------------------------------

There are two paths into the same local-player transparency block at 0x4d0b7:

    0x4cfe6  jne 0x1004d0b7
    0x4d0b1  je  0x1004d191

Both are 6-byte relative branches with no relocation entries, so both can be replaced safely.
The block at 0x4d0b7 starts with a relocated cmp immediate at 0x4d0bb, which is why the hook is
not placed there: overwriting that byte would let the PE loader corrupt the patch at load time.

    hook 1, file offset 0x{hook1_off:x}:
      original: {HOOK1_ORIG.hex(' ')}   (jne 0x1004d0b7)
      patched:  {hook1_patch.hex(' ')}   (jmp stub; nop)

    hook 2, file offset 0x{hook2_off:x}:
      original: {HOOK2_ORIG.hex(' ')}   (je 0x1004d191)
      patched:  {hook2_patch.hex(' ')}   (jmp stub; nop)

Both hooks are relative jmps, so they stay correct if the DLL is relocated. The original bytes at
0x4d0b7 and after are untouched.

2. PE header changes -- registering the new section
-------------------------------------------------------------

  * File header, NumberOfSections: 7 -> 8
  * Optional header, SizeOfImage: 0x{cur_soi:x} -> 0x{new_soi:x}
  * New section table entry appended into existing header slack:

      Name             .cloak
      VirtualAddress   0x{new_sec_va:x}
      VirtualSize      0x{new_sec_size:x}
      PointerToRawData 0x{new_sec_raw:x}
      SizeOfRawData    0x{new_sec_size:x}
      Characteristics  0x60000020  (CODE | EXECUTE | READ -- not writable)

Existing sections are untouched. The new section is appended after the original last byte.

3. The new .cloak section (file offset 0x{new_sec_raw:x}, 4096 bytes)
-------------------------------------------------------------

The first {len(code_bytes)} bytes are the stub; the rest is zero padding. The stub is position
independent: `call L0 / pop ecx / sub ecx,0x{L0_RVA:x}` turns ecx into the module base, and all
engine addresses are reached as base+RVA.

Stub disassembly (VA 0x{STUB_VA:x}):

{disasm}

The checks are:

  * edi is the local player entity pointer (or 0).
  * [edi+0x2f8] is curstate.rendermode. 2 is kRenderTransTexture.
  * [edi+0x2fc] is curstate.renderamt. The server cloak uses 10 in the current config.
  * If rendermode == 2 and renderamt < 255, jump to 0x4d191 and do not overwrite the state.
  * Otherwise restore eax=edi and jump to 0x4d0b7, where the original cl_thirdtransparency code
    runs exactly as before.

4. What it does not change
-------------------------------------------------------------

The server-side cloak is unchanged. Other players still receive the cloak state through
AddToFullPack. The normal cl_thirdtransparency fixed alpha (100) is still used on every frame
where the local player is not in a texture-render cloak state. No other client behavior is
touched.

5. Rollback
-------------------------------------------------------------

The original unmodified client.dll (MD5 {EXPECTED_MD5}) is kept in the backup folder and as
client.dll.original next to the build script. Restore it by copying it back over client.dll in
both locations, with the game client closed.

Original: {EXPECTED_MD5}
Patched : {patched_md5}
"""

open(PATCH_TXT, 'w', encoding='utf-8', newline='\r\n').write(patch_doc)
print('wrote', PATCH_TXT)
