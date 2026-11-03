import pefile, keystone, struct, hashlib

ORIG = 'client.dll'
OUT  = 'client_patched_v5.dll'

pe = pefile.PE(ORIG)
base = pe.OPTIONAL_HEADER.ImageBase
data = bytearray(open(ORIG, 'rb').read())
DELTA = 0x1000 - 0x400   # .text: RVA - fileoffset

def rva_to_off(rva): return rva - DELTA

ENGFUNCS_RVA     = 0xc9b08
CLIENTCMD_OFF    = 0x50
RANDOMLONG_OFF   = 0x110   # pfnRandomLong -- field 68 in cl_enginefuncs_s, cross-checked against
                           # the already-verified pfnClientCmd at field 20 (0x50) using the same
                           # per-declaration count from xash3d-fwgs/engine/cdll_int.h
HOOK_RVA   = 0x501f        # "mov eax, 1" in HUD_VidInit
RESUME_RVA = 0x5024        # the original "ret" right after it

hook_off = rva_to_off(HOOK_RVA)
assert bytes(data[hook_off:hook_off+5]) == b'\xb8\x01\x00\x00\x00', bytes(data[hook_off:hook_off+5]).hex()

# IAT slots already imported by this DLL -- calling through them needs no new import entry
pe.parse_data_directories()
iat = {}
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    for imp in entry.imports:
        name = imp.name.decode() if imp.name else None
        if name in ('CreateFileW', 'ReadFile', 'CloseHandle', 'WriteFile'):
            iat[name] = imp.address - base   # -> RVA of the IAT slot
assert len(iat) == 4, iat
print('IAT slots:', {k: hex(v) for k, v in iat.items()})

# ---- new section for the code (the parser is too big for the one 216-byte cave) ----
last = pe.sections[-1]
new_sec_va  = ((last.VirtualAddress + last.Misc_VirtualSize + pe.OPTIONAL_HEADER.SectionAlignment - 1)
               // pe.OPTIONAL_HEADER.SectionAlignment) * pe.OPTIONAL_HEADER.SectionAlignment
new_sec_size = 0x1000
file_len = len(data)
new_sec_raw = ((file_len + pe.OPTIONAL_HEADER.FileAlignment - 1)
               // pe.OPTIONAL_HEADER.FileAlignment) * pe.OPTIONAL_HEADER.FileAlignment
assert new_sec_raw >= file_len
print('new section VA', hex(new_sec_va), 'raw offset', hex(new_sec_raw), 'size', hex(new_sec_size))

# ---- writable scratch, living in .data's zero-filled slack (no file bytes needed, and .data
#      actually has WRITE permission -- unlike .text, confirmed by checking section characteristics
#      after the v3 cave design turned out to write into a READ+EXECUTE-only page) ----
data_sec = next(s for s in pe.sections if s.Name.decode().strip('\x00') == '.data')
assert data_sec.Characteristics & 0x80000000, 'data section is not writable!'
slack_start = data_sec.VirtualAddress + data_sec.SizeOfRawData
slack_free  = data_sec.Misc_VirtualSize - data_sec.SizeOfRawData
print('.data BSS slack at', hex(slack_start), 'free bytes', slack_free)

GUARD      = slack_start + 0
HANDLE     = slack_start + 4
BYTESREAD  = slack_start + 8
COUNT      = slack_start + 12
PICKED_PTR = slack_start + 16
PICKED_LEN = slack_start + 20
TMP_PTR    = slack_start + 24
CANDTABLE  = slack_start + 32          # 16 * 8 bytes
READBUF    = CANDTABLE + 16 * 8        # 4096 bytes
FINALBUF   = READBUF + 4096            # 160 bytes
DATA_END   = FINALBUF + 160
assert DATA_END - slack_start < slack_free

# ---- layout inside the new code section: constants first (fixed, known offsets), code after ----
PATH_TEXT = r'ts\cl_dlls\menu_music.txt'
PATH_W = PATH_TEXT.encode('utf-16-le') + b'\x00\x00'
FALLBACK = b'vangelis.mp3\x00'
FALLBACK_LEN = len(FALLBACK) - 1
PREFIX = b'MP3Volume 1\nmp3 on\nmp3 loop sound/music/'
PREFIX_LEN = len(PREFIX)

# diagnostic only: proves whether HUD_VidInit fires at all, and roughly how many times, by
# unconditionally (no one-shot guard) rewriting this file every single call with the running
# count. Answers "is this the right hook point" directly instead of by inference.
DEBUG_PATH_TEXT = r'ts\cl_dlls\vidinit_debug.txt'
DEBUG_PATH_W = DEBUG_PATH_TEXT.encode('utf-16-le') + b'\x00\x00'
DEBUG_MSG = b'HUD_VidInit fired, call #'
DEBUG_MSG_LEN = len(DEBUG_MSG)

DEBUG_PATH_W_RVA = new_sec_va
PATH_W_RVA   = DEBUG_PATH_W_RVA + len(DEBUG_PATH_W)
FALLBACK_RVA = PATH_W_RVA + len(PATH_W)
PREFIX_RVA   = FALLBACK_RVA + len(FALLBACK)
DEBUG_MSG_RVA = PREFIX_RVA + len(PREFIX)
CODE_RVA     = DEBUG_MSG_RVA + len(DEBUG_MSG)
L0_RVA       = CODE_RVA + 5   # "call L0" is always 5 bytes (E8 rel32); L0 is the byte right after

print('DEBUG_PATH_W_RVA', hex(DEBUG_PATH_W_RVA), 'PATH_W_RVA', hex(PATH_W_RVA), 'FALLBACK_RVA', hex(FALLBACK_RVA), 'PREFIX_RVA', hex(PREFIX_RVA), 'DEBUG_MSG_RVA', hex(DEBUG_MSG_RVA), 'CODE_RVA', hex(CODE_RVA))

# extra scratch for the diagnostic: a call counter and a small ASCII scratch buffer to hold the
# debug message + the counter rendered as decimal digits + newline
CALLCOUNT  = DATA_END
DEBUGBUF   = CALLCOUNT + 4
DATA_END   = DEBUGBUF + 64
assert DATA_END - slack_start < slack_free

WRITE_LEN = DEBUG_MSG_LEN + 3   # 2 decimal digits + newline, not counting the null terminator

ks = keystone.Ks(keystone.KS_ARCH_X86, keystone.KS_MODE_32)

asm = f"""
call L0
L0:
pop eax
mov ebp, eax
sub ebp, {L0_RVA}

push ebx
push esi
push edi

mov eax, [ebp + {CALLCOUNT}]
inc eax
mov [ebp + {CALLCOUNT}], eax
cmp eax, 99
jle dbg_count_ok
mov eax, 99
dbg_count_ok:
mov ecx, eax
lea esi, [ebp + {DEBUG_MSG_RVA}]
lea edi, [ebp + {DEBUGBUF}]
push ecx
mov ecx, {DEBUG_MSG_LEN}
rep movsb
pop ecx
mov eax, ecx
xor edx, edx
mov ebx, 10
div ebx
add al, 0x30
mov [edi], al
inc edi
add dl, 0x30
mov [edi], dl
inc edi
mov byte ptr [edi], 0x0a
inc edi
mov byte ptr [edi], 0

lea eax, [ebp + {DEBUG_PATH_W_RVA}]
push 0
push 0x80
push 2
push 0
push 1
push 0x40000000
push eax
call dword ptr [ebp + {iat['CreateFileW']}]
mov [ebp + {HANDLE}], eax

push 0
lea eax, [ebp + {BYTESREAD}]
push eax
push {WRITE_LEN}
lea eax, [ebp + {DEBUGBUF}]
push eax
mov eax, [ebp + {HANDLE}]
push eax
call dword ptr [ebp + {iat['WriteFile']}]

mov eax, [ebp + {HANDLE}]
push eax
call dword ptr [ebp + {iat['CloseHandle']}]

cmp dword ptr [ebp + {GUARD}], 0
jne alldone
mov dword ptr [ebp + {GUARD}], 1

lea eax, [ebp + {PATH_W_RVA}]
push 0
push 0x80
push 3
push 0
push 1
push 0x80000000
push eax
call dword ptr [ebp + {iat['CreateFileW']}]
mov [ebp + {HANDLE}], eax
cmp eax, -1
je use_fallback

push 0
lea eax, [ebp + {BYTESREAD}]
push eax
push 4095
lea eax, [ebp + {READBUF}]
push eax
mov eax, [ebp + {HANDLE}]
push eax
call dword ptr [ebp + {iat['ReadFile']}]

mov eax, [ebp + {HANDLE}]
push eax
call dword ptr [ebp + {iat['CloseHandle']}]

mov dword ptr [ebp + {COUNT}], 0
lea esi, [ebp + {READBUF}]
mov eax, [ebp + {BYTESREAD}]
lea edi, [ebp + {READBUF}]
add edi, eax

parse_loop:
cmp esi, edi
jae parse_done
mov al, byte ptr [esi]
cmp al, 0x23
je skip_line
cmp al, 0x0d
je skip_line
cmp al, 0x0a
je skip_line_consume_nl

mov [ebp + {TMP_PTR}], esi
line_scan:
cmp esi, edi
jae line_end
mov al, byte ptr [esi]
cmp al, 0x0d
je line_end
cmp al, 0x0a
je line_end
inc esi
jmp line_scan
line_end:
mov eax, [ebp + {TMP_PTR}]
mov ecx, esi
sub ecx, eax
cmp ecx, 0
je find_nl
mov edx, [ebp + {COUNT}]
cmp edx, 16
jae find_nl
lea ebx, [ebp + {CANDTABLE}]
lea ebx, [ebx + edx*8]
mov [ebx], eax
mov [ebx+4], ecx
inc edx
mov [ebp + {COUNT}], edx
jmp find_nl

skip_line:
find_nl:
cmp esi, edi
jae parse_done
mov al, byte ptr [esi]
inc esi
cmp al, 0x0a
jne find_nl
jmp parse_loop

skip_line_consume_nl:
inc esi
jmp parse_loop

parse_done:
mov eax, [ebp + {COUNT}]
cmp eax, 0
je use_fallback
cmp eax, 1
je pick_single

dec eax
push eax
push 0
call dword ptr [ebp + {ENGFUNCS_RVA + RANDOMLONG_OFF}]
add esp, 8
jmp have_index

pick_single:
xor eax, eax

have_index:
lea ebx, [ebp + {CANDTABLE}]
lea ebx, [ebx + eax*8]
mov eax, [ebx]
mov [ebp + {PICKED_PTR}], eax
mov eax, [ebx+4]
mov [ebp + {PICKED_LEN}], eax
jmp build_cmd

use_fallback:
lea eax, [ebp + {FALLBACK_RVA}]
mov [ebp + {PICKED_PTR}], eax
mov dword ptr [ebp + {PICKED_LEN}], {FALLBACK_LEN}

build_cmd:
cld
lea esi, [ebp + {PREFIX_RVA}]
lea edi, [ebp + {FINALBUF}]
mov ecx, {PREFIX_LEN}
rep movsb

mov esi, [ebp + {PICKED_PTR}]
mov ecx, [ebp + {PICKED_LEN}]
rep movsb

mov byte ptr [edi], 0x0a
inc edi
mov byte ptr [edi], 0

lea eax, [ebp + {FINALBUF}]
push eax
call dword ptr [ebp + {ENGFUNCS_RVA + CLIENTCMD_OFF}]
add esp, 4

alldone:
pop edi
pop esi
pop ebx
mov eax, 1
ret
"""

encoding, count = ks.asm(asm, addr=CODE_RVA + base)
code_bytes = bytes(encoding)
print('assembled', len(code_bytes), 'instructions:', count, 'bytes, budget', new_sec_size - (CODE_RVA - new_sec_va))
assert len(code_bytes) <= new_sec_size - (CODE_RVA - new_sec_va), 'code does not fit in the new section'

# sanity re-check: the very first instruction must really be "call L0" = E8 rel32 (5 bytes),
# so L0_RVA computed above actually matches where keystone placed the label
assert code_bytes[0] == 0xE8, code_bytes[:8].hex()

# ---- assemble the hook: EXACTLY one 5-byte "call rel32", the same size as the "mov eax,1" it
#      replaces -- the stub ends in its own "mov eax,1; ret", and that ret naturally resumes at
#      the address right after this call, which is the ORIGINAL, untouched "ret" at RESUME_RVA.
#      (An earlier draft had the hook end in its own "jmp RESUME_RVA", which doesn't fit in 5
#      bytes -- it would have overwritten RESUME_RVA itself, jumping into its own bytes forever.)
hook_asm = f"call {CODE_RVA + base}"
hook_bytes, _ = ks.asm(hook_asm, addr=HOOK_RVA + base)
hook_bytes = bytes(hook_bytes)
print('hook bytes:', hook_bytes.hex(), 'length', len(hook_bytes))
assert len(hook_bytes) == 5, f'hook must be exactly 5 bytes to match the replaced instruction, got {len(hook_bytes)}'
assert rva_to_off(HOOK_RVA) + 5 == rva_to_off(RESUME_RVA), 'RESUME_RVA is not immediately after the 5-byte hook'

# ---- assemble the new section's full raw content: constants, then the parser code, zero-padded ----
sec_content = bytearray(new_sec_size)
sec_content[0:len(DEBUG_PATH_W)] = DEBUG_PATH_W
off = len(DEBUG_PATH_W)
sec_content[off:off+len(PATH_W)] = PATH_W
off += len(PATH_W)
sec_content[off:off+len(FALLBACK)] = FALLBACK
off += len(FALLBACK)
sec_content[off:off+len(PREFIX)] = PREFIX
off += len(PREFIX)
sec_content[off:off+len(DEBUG_MSG)] = DEBUG_MSG
off += len(DEBUG_MSG)
assert off == CODE_RVA - new_sec_va
sec_content[off:off+len(code_bytes)] = code_bytes

# ---- add the new section header entry ----
import struct as _s
pe_hdr_off = pe.DOS_HEADER.e_lfanew
sec_table_off = pe_hdr_off + 4 + 20 + pe.FILE_HEADER.SizeOfOptionalHeader
new_entry_off = sec_table_off + pe.FILE_HEADER.NumberOfSections * 40
name = b'.mus\x00\x00\x00\x00'
assert len(name) == 8
entry = _s.pack('<8sIIIIIIHHI',
    name,
    new_sec_size,        # VirtualSize
    new_sec_va,           # VirtualAddress
    new_sec_size,         # SizeOfRawData
    new_sec_raw,          # PointerToRawData
    0, 0, 0, 0,           # relocations/linenumbers (unused, legacy)
    0x60000020)           # Characteristics: CODE | EXECUTE | READ
assert len(entry) == 40
data[new_entry_off:new_entry_off+40] = entry

# bump NumberOfSections in the file header
num_sec_off = pe_hdr_off + 4 + 2  # signature(4) + Machine(2) -> NumberOfSections field
cur_num = _s.unpack_from('<H', data, num_sec_off)[0]
assert cur_num == pe.FILE_HEADER.NumberOfSections
_s.pack_into('<H', data, num_sec_off, cur_num + 1)

# bump SizeOfImage in the optional header to cover the new section
opt_off = pe_hdr_off + 4 + 20
size_of_image_off = opt_off + 56   # standard PE32 optional header field offset
cur_soi = _s.unpack_from('<I', data, size_of_image_off)[0]
new_soi = ((new_sec_va + new_sec_size + pe.OPTIONAL_HEADER.SectionAlignment - 1)
           // pe.OPTIONAL_HEADER.SectionAlignment) * pe.OPTIONAL_HEADER.SectionAlignment
assert _s.unpack_from('<I', data, size_of_image_off)[0] == pe.OPTIONAL_HEADER.SizeOfImage
_s.pack_into('<I', data, size_of_image_off, new_soi)
print('SizeOfImage', hex(cur_soi), '->', hex(new_soi))

# extend the file to the new section's raw offset, then append its content
if len(data) < new_sec_raw:
    data.extend(b'\x00' * (new_sec_raw - len(data)))
assert len(data) == new_sec_raw
data.extend(sec_content)

# write the hook (exactly 5 bytes, verified above)
data[hook_off:hook_off+5] = hook_bytes

open(OUT, 'wb').write(data)
print('wrote', OUT, len(data), 'bytes')
print('orig md5', hashlib.md5(open(ORIG,'rb').read()).hexdigest())
print('patched md5', hashlib.md5(open(OUT,'rb').read()).hexdigest())
