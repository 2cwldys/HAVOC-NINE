"""h9tls.py -- the updater's HTTPS: a bundled, current certificate list first, the system's list second.

Python on Windows trusts only what Windows trusts, and a Windows that has kept an expired copy of a root (ISRG Root X2, which
Let's Encrypt's current chain runs through) makes every connection to havoc9.org fail with "certificate has expired" even though the
site's certificate is fine. cacert.pem beside this file (inside the one-file exe: the folder PyInstaller unpacks to) is Mozilla's
list as published by curl.se; it is tried first. If that fails the way a certificate does, the system's list is tried, which is what
a PC behind an antivirus that scans HTTPS (it puts its own certificate in front of every site) or a company proxy needs. Either list
verifying is enough; a connection neither list verifies is refused, as before.
"""
import os
import ssl
import sys
import urllib.error
import urllib.request


def _contexts():
    out = []
    for base in (getattr(sys, '_MEIPASS', ''), os.path.dirname(os.path.abspath(__file__))):
        pem = os.path.join(base, 'cacert.pem') if base else ''
        if pem and os.path.isfile(pem):
            try:
                out.append(ssl.create_default_context(cafile=pem))
            except (ssl.SSLError, OSError):
                pass
            break
    out.append(ssl.create_default_context())
    return out


def urlopen(request, timeout):
    """urllib.request.urlopen(request, timeout=timeout) that tries each certificate list in turn when a certificate is what fails."""
    last = None
    for ctx in _contexts():
        try:
            return urllib.request.urlopen(request, timeout=timeout, context=ctx)
        except urllib.error.URLError as e:
            if not isinstance(getattr(e, 'reason', None), ssl.SSLError):
                raise
            last = e
    raise last
