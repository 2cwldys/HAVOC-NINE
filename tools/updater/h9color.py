# h9color.py -- colour for the updater's console, and only there.
#
# Colour is used when standard output is a console that understands it: a terminal on Linux, and on
# Windows 10 and later once virtual-terminal processing is switched on for the console. A run whose
# output goes elsewhere (a file, a pipe, ssh, ship.ps1's logs) gets plain text, and updater.log always
# does: Log strips every colour code before it writes a line. NO_COLOR (https://no-color.org),
# TERM=dumb or --no-color turn it off.
#
# Three colours only, the H9 ones: white, orange and purple.
#   head  bold white    a section title
#   ok    white         done, up to date, linked, checked
#   warn  orange        needs your attention
#   err   bold orange   stopped by an error
#   code  purple        something to type or compare: a link code, a console command
#   bar   orange        the progress meter

import os
import re
import sys

STYLES = {
    'head': '1;97',
    'ok': '97',
    'warn': '38;5;208',
    'err': '1;38;5;208',
    'code': '38;5;141',
    'bar': '38;5;208',
}
ANSI = re.compile(r'\x1b\[[0-9;]*m')
ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004

_on = None


def _console_can():
    if os.environ.get('NO_COLOR') or os.environ.get('TERM') == 'dumb':
        return False
    try:
        if sys.stdout is None or not sys.stdout.isatty():
            return False
    except (AttributeError, ValueError):
        return False
    if os.name != 'nt':
        return True
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.GetStdHandle.restype = wintypes.HANDLE
        k32.GetStdHandle.argtypes = [wintypes.DWORD]
        k32.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k32.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        handle = k32.GetStdHandle(wintypes.DWORD(-11 & 0xFFFFFFFF))     # STD_OUTPUT_HANDLE
        mode = wintypes.DWORD()
        if not k32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        if mode.value & ENABLE_VIRTUAL_TERMINAL_PROCESSING:
            return True
        # a console older than Windows 10 refuses the flag: plain text then
        return bool(k32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING))
    except (AttributeError, OSError, ValueError):
        return False


def enable(allowed=True):
    """Decide once, at start: colour only when allowed and the console can show it."""
    global _on
    _on = bool(allowed) and _console_can()
    return _on


def on():
    global _on
    if _on is None:
        _on = _console_can()
    return _on


def paint(text, style):
    """text in a style, or text unchanged when colour is off."""
    if not text or style not in STYLES or not on():
        return text
    return '\x1b[%sm%s\x1b[0m' % (STYLES[style], text)


def plain(text):
    """text without colour codes: what goes into updater.log."""
    return ANSI.sub('', text)
