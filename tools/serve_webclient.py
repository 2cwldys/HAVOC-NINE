r"""
serve_webclient.py - serves havoc9.org and a web client package on this PC, laid out the way the
VPS's nginx serves them (havoc9.org\webclient\DEPLOY.txt, sections 5 and 8), for trying the web
client before it is deployed.

    py -3 serve_webclient.py --site D:\Downloads\TSM\havoc9.org --stage <package> [--port 8080]
                             [--relay ws://127.0.0.1:27016/] [--server NAME=IP:PORT ...]
                             [--args "-dev 2"]

    --site     the site folder, served at /
    --stage    make_webclient_game.py's --out folder. Its engine\, game\, manifest.json and
               preload.json are served at /webclient/engine/, /webclient/game/,
               /webclient/manifest.json and /webclient/preload.json, as on the VPS, so the site
               folder never holds the 1.2 GB of game files.
    --relay    the relay every engine socket goes through, in place of settings.json's "relay",
               for a relay that is not at /webclient/relay on this server (a ws:// URL)
    --server   a JOIN link under PLAY, in place of settings.json's list: NAME=IP:PORT, the address
               as numbers; give it once per server
    --args     engine arguments in place of settings.json's "args", e.g. "-dev 2" for the engine's
               loading messages in the page's console (window.h9web.log)
    --port     the port, on 127.0.0.1 only (default 8080)

The site's own settings.json is never changed; what these options give is served in its place.

Then open http://127.0.0.1:8080/webclient/index.html. As on the VPS, DEPLOY.txt and backups give 404.
"""
import argparse
import http.server
import json
import os
import posixpath
import sys
import urllib.parse

STAGED = ("/webclient/engine/", "/webclient/game/")
STAGED_FILES = ("/webclient/manifest.json", "/webclient/preload.json")
HIDDEN_NAMES = ("deploy.txt",)

TYPES = {".wasm": "application/wasm", ".js": "text/javascript", ".json": "application/json",
         ".html": "text/html", ".css": "text/css", ".txt": "text/plain", ".gif": "image/gif",
         ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


def safe_join(root, rel):
    """root joined with a URL path, with no way out of root."""
    parts = []
    for p in posixpath.normpath(urllib.parse.unquote(rel)).split("/"):
        if not p or p in (".", "..") or ":" in p or "\\" in p:
            continue
        parts.append(p)
    return os.path.join(root, *parts)


def make_handler(site, stage, settings_override):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            path = urllib.parse.urlsplit(path).path
            for prefix in STAGED:
                if path.startswith(prefix):
                    return safe_join(stage, path[len("/webclient/"):])
            if path in STAGED_FILES:
                return safe_join(stage, path[len("/webclient/"):])
            return safe_join(site, path)

        def guess_type(self, path):
            return TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")

        def hidden(self):
            path = urllib.parse.urlsplit(self.path).path.lower()
            name = path.rsplit("/", 1)[-1]
            return name in HIDDEN_NAMES or ".bak" in name or name.endswith(".zip")

        def settings(self):
            return bool(settings_override) and urllib.parse.urlsplit(self.path).path == "/webclient/settings.json"

        def send_settings(self, head):
            with open(os.path.join(site, "webclient", "settings.json"), encoding="utf-8") as f:
                s = json.load(f)
            s.update(settings_override)
            body = json.dumps(s, indent=2).encode("ascii")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def do_GET(self):
            if self.hidden():
                return self.send_error(404)
            if self.settings():
                return self.send_settings(False)
            return super().do_GET()

        def do_HEAD(self):
            if self.hidden():
                return self.send_error(404)
            if self.settings():
                return self.send_settings(True)
            return super().do_HEAD()

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def log_message(self, fmt, *args):
            if args and str(args[1]) not in ("200", "304"):
                sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    ap.add_argument("--site", required=True)
    ap.add_argument("--stage", required=True)
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--server", action="append", default=[])
    ap.add_argument("--relay")
    ap.add_argument("--args")
    a = ap.parse_args()

    site = os.path.abspath(a.site)
    stage = os.path.abspath(a.stage)
    if not os.path.isfile(os.path.join(site, "webclient", "index.html")):
        sys.exit("no webclient/index.html in %s" % site)
    if not os.path.isfile(os.path.join(stage, "manifest.json")) or not os.path.isdir(os.path.join(stage, "game")):
        sys.exit("no package in %s (make_webclient_game.py --out)" % stage)

    override = {}
    if a.args:
        override["args"] = a.args.split()
    if a.relay:
        override["relay"] = a.relay
    if a.server:
        override["servers"] = []
        for s in a.server:
            name, _, address = s.rpartition("=")
            if not address:
                sys.exit("--server takes NAME=IP:PORT")
            override["servers"].append({"name": name or address, "address": address})

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(site, stage, override))
    print("http://127.0.0.1:%d/webclient/index.html  (site %s, package %s)" % (a.port, site, stage))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
