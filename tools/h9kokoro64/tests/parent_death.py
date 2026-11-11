"""parent_death.py -- the helper must not outlive the program that started it.

The lab (kokoro_lab hold) starts the helper and waits; this script ends the lab from outside, abruptly, the way a crashed game ends, and then watches the
process list: h9kokoro64.exe must be gone within a few seconds (the client puts it in a job object that kills it when the client's process ends; the
helper also watches its parent and its pipe). The helper's process id is taken from the process list before and after, so a helper of someone else is never touched.

usage: python -I parent_death.py <kokoro_lab.exe>
"""
import subprocess
import sys
import time


def helpers():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq h9kokoro64.exe", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    pids = set()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].strip('"').lower() == "h9kokoro64.exe":
            pids.add(int(parts[1]))
    return pids


def main():
    lab = sys.argv[1]
    before = helpers()
    p = subprocess.Popen([lab, "hold", "120"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    mine = set()
    deadline = time.time() + 90
    while time.time() < deadline and not mine:
        mine = helpers() - before
        time.sleep(0.5)
    if not mine:
        print("FAIL: the helper did not appear")
        p.kill()
        return 1
    print("helper started, pid %s; ending the lab (pid %d) abruptly" % (sorted(mine), p.pid))
    time.sleep(3)
    p.kill()
    gone_at = None
    t0 = time.time()
    while time.time() - t0 < 15:
        if not (helpers() & mine):
            gone_at = time.time() - t0
            break
        time.sleep(0.2)
    if gone_at is None:
        print("FAIL: the helper is still running 15 s after its parent was ended")
        return 1
    print("ok: the helper was gone %.1f s after its parent ended" % gone_at)
    return 0


if __name__ == "__main__":
    sys.exit(main())
