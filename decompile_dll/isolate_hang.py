import multiprocessing as mp

def worker(text, addr, q):
    import keystone
    ks = keystone.Ks(keystone.KS_ARCH_X86, keystone.KS_MODE_32)
    enc, cnt = ks.asm(text, addr=addr)
    q.put(('OK', len(enc), cnt))

def run(name, text, addr):
    q = mp.Queue()
    p = mp.Process(target=worker, args=(text, addr, q))
    p.start()
    p.join(timeout=6)
    if p.is_alive():
        p.terminate()
        p.join()
        print(name, ': HANGS')
    else:
        try:
            print(name, ':', q.get(timeout=1))
        except Exception:
            print(name, ': finished but no result (crashed?)')

diag_small_noprologue = '''
mov eax, [ebp + 100]
inc eax
mov [ebp + 100], eax
lea esi, [ebp + 200]
lea edi, [ebp + 300]
mov ecx, 25
push 0
push 0x80
push 2
push 0
push 1
push 0x40000000
lea eax, [ebp+400]
push eax
call dword ptr [ebp + 111111]
mov [ebp + 500], eax
push 0
lea eax, [ebp + 600]
push eax
push 28
lea eax, [ebp + 300]
push eax
mov eax, [ebp + 500]
push eax
call dword ptr [ebp + 222222]
mov eax, [ebp + 500]
push eax
call dword ptr [ebp + 333333]
ret
'''

diag_real_noprologue = '''
mov eax, [ebp + 809280]
inc eax
mov [ebp + 809280], eax
lea esi, [ebp + 2982051]
lea edi, [ebp + 809284]
mov ecx, 25
push 0
push 0x80
push 2
push 0
push 1
push 0x40000000
lea eax, [ebp+2981888]
push eax
call dword ptr [ebp + 763096]
mov [ebp + 804868], eax
push 0
lea eax, [ebp + 804872]
push eax
push 28
lea eax, [ebp + 809284]
push eax
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763412]
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763092]
ret
'''

prologue_real = '''
call L0
L0:
pop eax
mov ebp, eax
sub ebp, 2982081
push ebx
push esi
push edi
'''

diag_real_with_cap = '''
mov eax, [ebp + 809280]
inc eax
mov [ebp + 809280], eax
cmp eax, 99
jle dbg_count_ok
mov eax, 99
dbg_count_ok:
lea esi, [ebp + 2982051]
lea edi, [ebp + 809284]
mov ecx, 25
push 0
push 0x80
push 2
push 0
push 1
push 0x40000000
lea eax, [ebp+2981888]
push eax
call dword ptr [ebp + 763096]
mov [ebp + 804868], eax
push 0
lea eax, [ebp + 804872]
push eax
push 28
lea eax, [ebp + 809284]
push eax
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763412]
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763092]
ret
'''

diag_real_with_repmovsb = '''
mov eax, [ebp + 809280]
inc eax
mov [ebp + 809280], eax
mov ecx, eax
lea esi, [ebp + 2982051]
lea edi, [ebp + 809284]
push ecx
mov ecx, 25
rep movsb
pop ecx
push 0
push 0x80
push 2
push 0
push 1
push 0x40000000
lea eax, [ebp+2981888]
push eax
call dword ptr [ebp + 763096]
mov [ebp + 804868], eax
push 0
lea eax, [ebp + 804872]
push eax
push 28
lea eax, [ebp + 809284]
push eax
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763412]
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763092]
ret
'''

diag_real_with_div = '''
mov eax, [ebp + 809280]
inc eax
mov [ebp + 809280], eax
mov ecx, eax
xor edx, edx
mov ebx, 10
div ebx
lea esi, [ebp + 2982051]
lea edi, [ebp + 809284]
mov ecx, 25
push 0
push 0x80
push 2
push 0
push 1
push 0x40000000
lea eax, [ebp+2981888]
push eax
call dword ptr [ebp + 763096]
mov [ebp + 804868], eax
push 0
lea eax, [ebp + 804872]
push eax
push 28
lea eax, [ebp + 809284]
push eax
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763412]
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763092]
ret
'''

diag_real_full = '''
mov eax, [ebp + 809280]
inc eax
mov [ebp + 809280], eax
cmp eax, 99
jle dbg_count_ok
mov eax, 99
dbg_count_ok:
mov ecx, eax
lea esi, [ebp + 2982051]
lea edi, [ebp + 809284]
push ecx
mov ecx, 25
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
push 0
push 0x80
push 2
push 0
push 1
push 0x40000000
lea eax, [ebp+2981888]
push eax
call dword ptr [ebp + 763096]
mov [ebp + 804868], eax
push 0
lea eax, [ebp + 804872]
push eax
push 28
lea eax, [ebp + 809284]
push eax
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763412]
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763092]
ret
'''

exact_real_chunk = open('real_chunk_exact.txt').read()

diag_real_full_reordered = '''
mov eax, [ebp + 809280]
inc eax
mov [ebp + 809280], eax
cmp eax, 99
jle dbg_count_ok
mov eax, 99
dbg_count_ok:
mov ecx, eax
lea esi, [ebp + 2982051]
lea edi, [ebp + 809284]
push ecx
mov ecx, 25
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

lea eax, [ebp + 2981888]
push 0
push 0x80
push 2
push 0
push 1
push 0x40000000
push eax
call dword ptr [ebp + 763096]
mov [ebp + 804868], eax

push 0
lea eax, [ebp + 804872]
push eax
push 28
lea eax, [ebp + 809284]
push eax
mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763412]

mov eax, [ebp + 804868]
push eax
call dword ptr [ebp + 763092]
ret
'''

diag_with_comments = diag_real_full_reordered.replace(
    'mov eax, [ebp + 809280]\ninc eax',
    '; -- diagnostic, unconditional, runs on every single call regardless of the guard below --\nmov eax, [ebp + 809280]\ninc eax',
    1
).replace(
    'call dword ptr [ebp + 763092]\nret',
    'call dword ptr [ebp + 763092]\n; -- end diagnostic --\nret',
    1
)

diag_comment1_only = diag_real_full_reordered.replace(
    'mov eax, [ebp + 809280]\ninc eax',
    '; -- diagnostic, unconditional, runs on every single call regardless of the guard below --\nmov eax, [ebp + 809280]\ninc eax',
    1
)
diag_comment2_only = diag_real_full_reordered.replace(
    'call dword ptr [ebp + 763092]\nret',
    'call dword ptr [ebp + 763092]\n; -- end diagnostic --\nret',
    1
)
diag_short_comment = diag_real_full_reordered.replace(
    'mov eax, [ebp + 809280]\ninc eax',
    '; hi\nmov eax, [ebp + 809280]\ninc eax',
    1
)
diag_no_dashes = diag_real_full_reordered.replace(
    'mov eax, [ebp + 809280]\ninc eax',
    '; diagnostic unconditional runs on every single call regardless of the guard below\nmov eax, [ebp + 809280]\ninc eax',
    1
)

if __name__ == '__main__':
    run('K: comment 1 (before) only', prologue_real + diag_comment1_only, 0x102d80bc)
    run('L: comment 2 (after) only', prologue_real + diag_comment2_only, 0x102d80bc)
    run('M: short comment, no dashes', prologue_real + diag_short_comment, 0x102d80bc)
    run('N: long comment, no -- dashes', prologue_real + diag_no_dashes, 0x102d80bc)
    run('A: no prologue, SMALL numbers', diag_small_noprologue, 0x102d80bc)
    run('B: no prologue, REAL numbers', diag_real_noprologue, 0x102d80bc)
    run('C: prologue + SMALL numbers', prologue_real + diag_small_noprologue, 0x102d80bc)
    run('D: prologue + REAL numbers', prologue_real + diag_real_noprologue, 0x102d80bc)
    run('E: D + cap-branch (jle)', prologue_real + diag_real_with_cap, 0x102d80bc)
    run('F: D + rep movsb w/ push-pop ecx', prologue_real + diag_real_with_repmovsb, 0x102d80bc)
    run('G: D + div', prologue_real + diag_real_with_div, 0x102d80bc)
    run('H: FULL (cap + rep movsb + div together)', prologue_real + diag_real_full, 0x102d80bc)
