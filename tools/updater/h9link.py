# h9link.py -- links an H9XASH install to a havoc9.org account the way the game's own h9_link does
# (engine/client/cl_h9link.c): the site's device-code flow (h9web/lib/link.js: the updater shows a
# short code, the player approves it on havoc9.org/link while signed in), and the player id kept in
# user_id.ini only sealed with Windows DPAPI for this Windows user on this PC. Nobody types, pastes
# or sees a player id.
#
# The store, written and read exactly as cl_h9link.c does:
#   user_id.ini   [client]
#                 protected=<hex of CryptProtectData(record, entropy ENTROPY, UI forbidden)>
#                 protected=<hex>   records this Windows user cannot open, kept, OTHERS at most
#   record        "h9id=1\nid=<32 hex>\nlinked=<the same id>\naccount=<username>\ntoken=<43 chars>\n
#                  site=<the site the token came from>\n"
# Linked means linked=, account=, token= and site= are there and linked= is the id. The site is
# https://havoc9.org, or a local test site (http://127.0.0.1:<port>, http://localhost:<port>); the
# game's start asks only that site whether the link stands, and only its answer can end it. A record
# from before site= (or with a site the game does not take) belongs to https://havoc9.org.

import ctypes
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

SITE = 'https://havoc9.org'
STORE = 'user_id.ini'
DEVICE_FILE = 'device_id.ini'
ENTROPY = b'h9xash user_id.ini v1'
OTHERS = 3
# Files the account step writes and an update never touches.
PLAYER_FILES = [STORE, DEVICE_FILE]
USER_AGENT = 'H9XASH-Updater'
HEX32 = re.compile(r'^[0-9a-f]{32}$')
TOKEN = re.compile(r'^[A-Za-z0-9_-]{43}$')
ACCOUNT = re.compile(r'^[A-Za-z0-9._-]{3,20}$')
LOCAL_SITE = re.compile(r'^http://(?:127\.0\.0\.1|localhost):[0-9]{1,5}$')
# The engine's own head of the file, line for line.
HEADER = [
    "; user_id.ini -- this install's client id. The engine reads and writes this file.",
    "; The id is kept protected for this Windows user (DPAPI): copied to another PC or",
    "; Windows account it cannot be read there, and the game makes a new id in its place.",
    "; Link the game to your havoc9.org account from the main menu (Link your Account).",
    "; Delete this file, or run h9_regenerate_userid.bat, for a new random id. A plain",
    "; id= line (enter_userid.cmd) is taken and protected at the next start. The engine",
    "; never sends this id as-is to a server -- see docs\\CUSTOM_XASH_USERID.txt.",
]


def supported():
    return os.name == 'nt'


def is_site(s):
    """A site a link may belong to, by the engine's rule: havoc9.org, or a local test site."""
    return s == SITE or bool(LOCAL_SITE.match(s or ''))


def site_name(site):
    """A site as the player reads it: havoc9.org, 127.0.0.1:8090."""
    for prefix in ('https://', 'http://'):
        if site.startswith(prefix):
            return site[len(prefix):]
    return site


# ---- DPAPI -------------------------------------------------------------------------------------

class _Blob(ctypes.Structure):
    _fields_ = [('cbData', ctypes.c_uint32), ('pbData', ctypes.POINTER(ctypes.c_char))]


def _api():
    from ctypes import wintypes
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    for fn in (crypt32.CryptProtectData, crypt32.CryptUnprotectData):
        fn.restype = wintypes.BOOL
    crypt32.CryptProtectData.argtypes = [ctypes.POINTER(_Blob), wintypes.LPCWSTR, ctypes.POINTER(_Blob),
                                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    crypt32.CryptUnprotectData.argtypes = [ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.POINTER(_Blob),
                                           ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return crypt32, kernel32


def _in(data):
    buf = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def protect(plain):
    crypt32, kernel32 = _api()
    data, _k1 = _in(plain)
    ent, _k2 = _in(ENTROPY)
    out = _Blob()
    if not crypt32.CryptProtectData(ctypes.byref(data), 'H9XASH user id', ctypes.byref(ent), None, None, 1,
                                    ctypes.byref(out)):
        raise OSError('CryptProtectData failed (error %d)' % ctypes.get_last_error())
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))


def unprotect(blob):
    """The record's bytes, or None when this Windows user on this PC cannot open the blob."""
    crypt32, kernel32 = _api()
    data, _k1 = _in(blob)
    ent, _k2 = _in(ENTROPY)
    out = _Blob()
    if not crypt32.CryptUnprotectData(ctypes.byref(data), None, ctypes.byref(ent), None, None, 1,
                                      ctypes.byref(out)):
        return None
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))


# ---- user_id.ini -------------------------------------------------------------------------------

def _read_lines(path):
    try:
        with open(path, 'r', encoding='latin-1') as f:
            return f.read().splitlines()
    except OSError:
        return []


def _client_values(lines, key):
    section, out = '', []
    for raw in lines:
        line = raw.strip()
        if not line or line[0] in ';#':
            continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1].strip().lower()
            continue
        if section == 'client' and '=' in line:
            k, v = line.split('=', 1)
            if k.strip().lower() == key:
                out.append(v.strip())
    return out


def _parse_record(raw):
    """The record's fields, as cl_h9link.c reads them, or None when it is not a record."""
    try:
        text = raw.decode('ascii')
    except (UnicodeDecodeError, AttributeError):
        return None
    rec, magic = {}, False
    for line in text.split('\n'):
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        k, v = k.strip(), v.strip()
        if k == 'h9id':
            magic = v == '1'
        elif k in ('id', 'linked') and HEX32.match(v.lower()):
            rec[k] = v.lower()
        elif k == 'account' and ACCOUNT.match(v):
            rec[k] = v
        elif k == 'token' and TOKEN.match(v):
            rec[k] = v
        elif k == 'site' and is_site(v):
            rec[k] = v
    if not magic or not rec.get('id'):
        return None
    if rec.get('linked') and not rec.get('site'):
        rec['site'] = SITE  # a record from before site=: havoc9.org's
    return rec


def _is_linked(rec):
    return bool(rec and rec.get('linked') and rec.get('account') and rec.get('token') and rec.get('site')
                and rec['linked'] == rec['id'])


def read_store(install):
    """(this user's record or None, the blobs this user cannot open, whether a plain id= is there)."""
    lines = _read_lines(os.path.join(install, STORE))
    mine, others = None, []
    for b in _client_values(lines, 'protected'):
        try:
            raw = bytes.fromhex(b)
        except ValueError:
            continue
        plain = unprotect(raw)
        if plain is None:
            others.append(b.lower())
            continue
        rec = _parse_record(plain)
        if rec and mine is None:
            mine = rec
    return mine, others, bool(_client_values(lines, 'id'))


def status(install):
    """('linked' | 'not-linked' | 'other-user', words for the player). Never touches the network."""
    if not supported():
        return 'not-linked', 'not linked (linking needs Windows)'
    mine, others, plain = read_store(install)
    if _is_linked(mine):
        return 'linked', 'linked to %s account %s' % (site_name(mine['site']), mine['account'])
    if mine or plain:
        return 'not-linked', 'not linked (this install has its own id)'
    if others:
        return 'other-user', 'not linked for this Windows user (user_id.ini holds only other users\' ids)'
    return 'not-linked', 'not linked'


def write_link(install, player_id, token, account, site):
    """Seals the linked record for this Windows user into user_id.ini, as the engine's approval does:
    the link belongs to site, the one the token came from."""
    if not is_site(site):
        raise ValueError('a link belongs to %s or a local test site, not %s' % (SITE, site))
    path = os.path.join(install, STORE)
    _mine, others, plain = read_store(install)
    record = 'h9id=1\nid=%s\nlinked=%s\naccount=%s\ntoken=%s\nsite=%s\n' % (player_id, player_id, account, token, site)
    lines = HEADER + ['', '[client]', 'protected=' + protect(record.encode('ascii')).hex()]
    lines += ['protected=' + b for b in others[:OTHERS]]
    tmp = os.path.join(install, STORE + '.tmp')
    with open(tmp, 'w', encoding='ascii', newline='\r\n') as f:
        f.write('\n'.join(lines) + '\n')
    os.replace(tmp, path)
    # A plain id the record replaces may also sit in user_id.ini.bak; the engine deletes that file
    # when it seals a plain id, so no id is left in plain text.
    if plain:
        try:
            os.remove(path + '.bak')
        except OSError:
            pass


# ---- the device id and the device-code flow ----------------------------------------------------

def device_hash(install):
    """(the device hash the site keeps with a link, whether device_id.ini was made here).
    The hash is presence's form, SHA-256("h9device1:" + the 16 bytes of the device id), first 32 hex.
    device_id.ini is made in the engine's own form when the game has not made it yet."""
    path = os.path.join(install, DEVICE_FILE)
    made = False
    if not os.path.exists(path):
        with open(path, 'w', encoding='ascii', newline='\n') as f:
            f.write('[device]\nid=%s\n' % os.urandom(16).hex())
        made = True
    for raw in _read_lines(path):
        line = raw.strip()
        if line.lower().startswith('id='):
            dev = line[3:].strip().lower()[:32]
            if HEX32.match(dev):
                return hashlib.sha256(b'h9device1:' + bytes.fromhex(dev)).hexdigest()[:32], made
    return None, made


def _running_under_wine():
    try:
        return hasattr(ctypes.WinDLL('ntdll'), 'wine_get_version')
    except (OSError, AttributeError):
        return False


def _get(url):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode('utf-8'))


def link(install, say=print, interactive=True, site=SITE):
    """Runs the device-code flow with site, and stores the link as that site's. True once linked;
    Ctrl+C skips. site is https://havoc9.org, or a local test site (http://127.0.0.1:<port>)."""
    site = (site or SITE).rstrip('/')
    if not is_site(site):
        say('Account: the game links only to %s or a local test site (http://127.0.0.1:<port>), not %s.'
            % (SITE, site))
        return False
    os.makedirs(install, exist_ok=True)
    device, made = device_hash(install)
    linked = False
    try:
        linked = _link(install, say, site, device)
    finally:
        if made and not linked:
            try:
                os.remove(os.path.join(install, DEVICE_FILE))
            except OSError:
                pass
    return linked


def _link(install, say, site, device):
    query = {'v': '1'}
    if device:
        query['device'] = device
    query['os'] = 'wine' if _running_under_wine() else 'windows'
    try:
        ans = _get(site + '/api/link/start?' + urllib.parse.urlencode(query))
    except (urllib.error.URLError, OSError, ValueError) as e:
        say('Account: cannot reach %s (%s). Link later from the game menu, or run the updater with --link.'
            % (site, getattr(e, 'reason', e)))
        return False
    if ans.get('status') == 'busy':
        say('Account: %s is busy right now; try again in %s seconds (H9XASH-Updater.exe --link).'
            % (site, ans.get('retryAfter', 60)))
        return False
    if ans.get('status') != 'ok' or not ans.get('deviceCode') or not ans.get('userCode'):
        say('Account: %s did not start a link (%s).' % (site, ans.get('status')))
        return False
    code, device_code = ans['userCode'], ans['deviceCode']
    url = ans.get('linkUrl') or site + '/link/'
    interval = max(2, int(ans.get('interval') or 5))
    deadline = time.monotonic() + int(ans.get('expiresIn') or 600)
    say('')
    say('  1. Sign in on %s/link/ (it opens in your browser now).' % site)
    say('  2. Check that the page shows this code, then press LINK:   %s' % code)
    say('  Waiting for you to approve it there (Ctrl+C skips)...')
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        while time.monotonic() < deadline:
            time.sleep(interval)
            try:
                ans = _get(site + '/api/link/poll?' + urllib.parse.urlencode({'code': device_code}))
            except (urllib.error.URLError, OSError, ValueError):
                continue
            st = ans.get('status')
            if st == 'pending':
                continue
            if st == 'slow_down':
                interval = max(interval, int(ans.get('interval') or interval + 5))
                continue
            if st == 'approved':
                pid = str(ans.get('playerId', '')).lower()
                token, account = str(ans.get('token', '')), str(ans.get('account', ''))
                if not HEX32.match(pid) or not TOKEN.match(token) or not ACCOUNT.match(account):
                    say('Account: the site\'s answer was not a link; nothing was stored.')
                    return False
                write_link(install, pid, token, account, site)
                say('Account: linked to %s account %s, stored in user_id.ini protected for this Windows user.'
                    % (site_name(site), account))
                return True
            if st == 'denied':
                say('Account: the code was turned down on %s (NOT ME), or the account is suspended.'
                    % site_name(site))
                return False
            break
        say('Account: the code ran out of time. Run H9XASH-Updater.exe --link for a new one.')
        return False
    except KeyboardInterrupt:
        say('Account: skipped.')
        return False
