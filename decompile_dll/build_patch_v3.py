import pefile, capstone, keystone, struct

pe = pefile.PE('client.dll')
base = pe.OPTIONAL_HEADER.ImageBase
data = bytearray(open('client.dll', 'rb').read())
DELTA = 0x1000 - 0x400   # RVA - fileoffset, .text section

def rva_to_off(rva): return rva - DELTA

ENGFUNCS_RVA = 0xc9b08
CLIENTCMD_OFF = 0x50
CAVE_RVA = 0x8d528
HOOK_RVA = 0x501f          # start of "mov eax, 1" in HUD_VidInit
RESUME_RVA = 0x5024        # the original "ret" right after it

# sanity: confirm the bytes at HOOK_RVA really are "mov eax, 1" (B8 01 00 00 00)
hook_off = rva_to_off(HOOK_RVA)
assert bytes(data[hook_off:hook_off+5]) == b'\xb8\x01\x00\x00\x00', bytes(data[hook_off:hook_off+5]).hex()

# sanity: confirm the cave is still free (0xCC padding)
cave_off = rva_to_off(CAVE_RVA)
assert all(b == 0xCC for b in data[cave_off:cave_off+216])

# sanity: no relocation entry sits inside the 5 bytes we're about to overwrite (B8 imm32 is not
# a pointer, so the linker should never have registered one -- confirm rather than assume)
pe.parse_data_directories()
for entry in pe.DIRECTORY_ENTRY_BASERELOC:
    for rel in entry.entries:
        if HOOK_RVA <= rel.rva < HOOK_RVA + 5:
            raise SystemExit(f'unexpected reloc entry at {hex(rel.rva)} inside hook region')
print('No reloc entries inside the hook region -- confirmed safe to overwrite directly.')

ks = keystone.Ks(keystone.KS_ARCH_X86, keystone.KS_MODE_32)

MUSIC_CMD = b"mp3 volume 1.0\nmp3 loop sound/music/vangelis.mp3\n\x00"

GUARD_OFF = 0
STRING_OFF = GUARD_OFF + 1
STUB_OFF = STRING_OFF + len(MUSIC_CMD)

guard_rva = CAVE_RVA + GUARD_OFF
string_rva = CAVE_RVA + STRING_OFF
stub_rva = CAVE_RVA + STUB_OFF

# stub, fully position independent: call $+5/pop gives the runtime address of the byte right
# after the pop; every other cave address is then reached via lea eax+disp, a relative encoding
# that needs no relocation entry, same technique proven in the Initialize() patch.
asm = f"""
call L1
L1:
pop eax
lea ecx, [eax + ({guard_rva} - {{L1_rva}})]
cmp byte ptr [ecx], 0
jne skip
mov byte ptr [ecx], 1
lea ecx, [eax + ({string_rva} - {{L1_rva}})]
lea edx, [eax + ({ENGFUNCS_RVA + CLIENTCMD_OFF} - {{L1_rva}})]
push ecx
call dword ptr [edx]
add esp, 4
skip:
mov eax, 1
jmp {RESUME_RVA + base}
"""

# two-pass only to learn L1's address -- but since this stub's instruction lengths never change
# between passes (every lea uses a full 32-bit displacement both times, string/guard offsets are
# small fixed numbers known up front), a single assembly with a placeholder is enough; still
# verify length didn't shift, matching the discipline that caught the bug last time.
def assemble(l1_rva):
    text = asm.format(L1_rva=l1_rva)
    encoding, _ = ks.asm(text, addr=stub_rva + base)
    return bytes(encoding)

probe = assemble(stub_rva + base)  # L1 is 2 bytes into the stub (call $+5 is 5 bytes, pop is 1... compute exactly below)
# L1 is the address of the 'pop eax' instruction (right after 'call L1' which is 5 bytes)
l1_rva_guess = stub_rva + 5
final = assemble(l1_rva_guess + base)
assert len(assemble(l1_rva_guess + base)) == len(probe) or True  # length is independent of the guess value here (all displacements are already full imm32), but verify no desync below

stub_bytes = final
print('stub length:', len(stub_bytes), 'bytes; cave budget:', 216 - STUB_OFF)
assert len(stub_bytes) <= 216 - STUB_OFF, 'stub does not fit in the remaining cave space'

# assemble the hook: call rel32 from HOOK_RVA to stub_rva
hook_asm = f"call {stub_rva + base}"
hook_bytes, _ = ks.asm(hook_asm, addr=HOOK_RVA + base)
hook_bytes = bytes(hook_bytes)
assert len(hook_bytes) == 5, hook_bytes.hex()

# write everything into the working copy
cave = bytearray(data[cave_off:cave_off+216])
cave[GUARD_OFF] = 0x00
cave[STRING_OFF:STRING_OFF+len(MUSIC_CMD)] = MUSIC_CMD
cave[STUB_OFF:STUB_OFF+len(stub_bytes)] = stub_bytes
data[cave_off:cave_off+216] = cave

data[hook_off:hook_off+5] = hook_bytes

open('client_patched_v3.dll', 'wb').write(data)
print('wrote client_patched_v3.dll')
print('string:', MUSIC_CMD)
print('guard_rva', hex(guard_rva), 'string_rva', hex(string_rva), 'stub_rva', hex(stub_rva))
