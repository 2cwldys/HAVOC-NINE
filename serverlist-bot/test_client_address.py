"""python -m unittest test_client_address -- the list bot's rule for who a request came from."""
import sys
import types
import unittest

# the module imports aiohttp and discord lazily where it can; stub what the import needs if they are missing
for name in ("aiohttp", "aiohttp.web"):
    if name not in sys.modules:
        try:
            __import__(name)
        except ImportError:
            sys.modules[name] = types.ModuleType(name)

import h9_serverlist as bot  # noqa: E402


class Req:
    def __init__(self, remote, headers):
        self.remote = remote
        self.headers = headers


class ClientAddress(unittest.TestCase):
    def test_nginx_header_from_loopback(self):
        self.assertEqual(bot.client_address(Req("127.0.0.1", {"x-real-ip": "198.51.100.7"})), "198.51.100.7")

    def test_header_from_anywhere_else_is_ignored(self):
        self.assertEqual(bot.client_address(Req("203.0.113.9", {"x-real-ip": "198.51.100.7"})), "203.0.113.9")

    def test_not_an_address_is_ignored(self):
        self.assertEqual(bot.client_address(Req("127.0.0.1", {"x-real-ip": "198.51.100.7, 10.0.0.1"})), "127.0.0.1")
        self.assertEqual(bot.client_address(Req("127.0.0.1", {"x-real-ip": "evil"})), "127.0.0.1")

    def test_tunnel_believes_only_its_own_header(self):
        r = Req("127.0.0.1", {"cf-connecting-ip": "198.51.100.7", "x-real-ip": "192.0.2.66"})
        self.assertEqual(bot.client_address(r, "cf-connecting-ip"), "198.51.100.7")
        self.assertEqual(bot.client_address(Req("127.0.0.1", {"x-real-ip": "192.0.2.66"}), "cf-connecting-ip"), "127.0.0.1")

    def test_none_believes_nothing(self):
        self.assertEqual(bot.client_address(Req("127.0.0.1", {"x-real-ip": "198.51.100.7"}), "none"), "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
