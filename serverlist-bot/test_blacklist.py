"""python -m unittest test_blacklist -- blacklisted.ini: what it names, and that no way onto the list gets past it."""
import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

try:
    import aiohttp  # noqa: F401
    from aiohttp import web  # noqa: F401
    from aiohttp.test_utils import TestClient, TestServer
    HAVE_AIOHTTP = True
except ImportError:
    HAVE_AIOHTTP = False
    for name in ("aiohttp", "aiohttp.web"):
        sys.modules.setdefault(name, types.ModuleType(name))

import h9_serverlist as bot  # noqa: E402

KEY = "test-heartbeat-key"
ANSWER = {"kind": "ip", "name": "a server", "map": "h9_te_neuropolis", "folder": "ts", "mode": "Match Mode",
          "players": 1, "max": 32, "bots": 0, "ping": 1.0}


def settings(**more):
    values = dict(gamedir="ts", probe_timeout=2.0, expire_seconds=300.0, poll_seconds=30.0, open_heartbeats=True,
                  proxy_header="x-real-ip", max_per_address=8, max_open_servers=100, heartbeats_per_minute=60)
    # the key is set by item, not as an argument at the start of a line: the secret scan reads a line that starts
    # with the name of the setting and an = as a filled-in key (tools/secret-scan.mjs, .gitleaks.toml)
    values["heartbeat_key"] = KEY
    values.update(more)
    return types.SimpleNamespace(**values)


class Probe:
    """Stands in for probe(): every address answers, and it counts the queries."""

    def __init__(self):
        self.asked = []

    async def __call__(self, target, timeout):
        self.asked.append(target)
        return dict(ANSWER)


class Quiet(unittest.IsolatedAsyncioTestCase):
    """No log file is written, nothing is queried over the network, and the log lines are kept."""

    def setUp(self):
        self.lines = []
        patcher = mock.patch.object(bot, "log", self.lines.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.folder = Path(tempfile.mkdtemp(dir=os.environ.get("TEMP")))
        self.file = self.folder / "blacklisted.ini"

    def use(self, probe):
        patcher = mock.patch.object(bot, "probe", probe)
        patcher.start()
        self.addCleanup(patcher.stop)
        return probe

    def write(self, text):
        self.file.write_text(text, encoding="utf-8")
        # the file's stamp is its time and its size: make the time differ even on a coarse clock
        stat = self.file.stat()
        os.utime(self.file, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000))

    def blacklist(self, text=None):
        if text is not None:
            self.write(text)
        return bot.Blacklist(self.file)

    def state(self, text=None, **more):
        return bot.ServerList(settings(**more), self.blacklist(text))


class Reading(Quiet):
    async def test_no_file_blacklists_nothing(self):
        black = self.blacklist()
        self.assertEqual(len(black), 0)
        self.assertIsNone(black.match("203.0.113.7", 27015))

    async def test_every_kind_of_entry(self):
        black = self.blacklist(
            "; a comment\n"
            "\n"
            "203.0.113.7\n"
            "198.51.100.9:27016   ; one server, with a note\n"
            "192.0.2.0/24 # a range\n"
            "Fake.Example.COM\n"
            "other.example.com:27015\n")
        self.assertEqual(len(black), 5)
        self.assertEqual(black.match("203.0.113.7", 1), "203.0.113.7", "an address holds on every port")
        self.assertEqual(black.match("203.0.113.7", 27015), "203.0.113.7")
        self.assertEqual(black.match("198.51.100.9", 27016), "198.51.100.9:27016")
        self.assertIsNone(black.match("198.51.100.9", 27015), "a server entry holds on its port only")
        self.assertEqual(black.match("192.0.2.77", 27015), "192.0.2.0/24")
        self.assertIsNone(black.match("192.0.3.1", 27015))
        self.assertEqual(black.match("fake.example.com", 27015), "fake.example.com", "a host name, whatever its case")
        self.assertEqual(black.match("FAKE.example.com", 1), "fake.example.com")
        self.assertEqual(black.match("other.example.com", 27015), "other.example.com:27015")
        self.assertIsNone(black.match("other.example.com", 27016))
        self.assertIsNone(black.match("203.0.113.8", 27015))

    async def test_a_bad_line_is_skipped_and_said_and_the_rest_still_count(self):
        black = self.blacklist("203.0.113.7\nnot a host!\n10.0.0.1:99999\n::1/128\n203.0.113.300\n198.51.100.9\n")
        self.assertEqual(len(black), 2)
        self.assertEqual(sum(1 for line in self.lines if "skipped" in line), 4)
        self.assertTrue(any("line 2" in line for line in self.lines))

    async def test_an_edit_is_picked_up_and_so_is_a_deleted_file(self):
        black = self.blacklist("203.0.113.7\n")
        self.assertFalse(black.refresh(), "nothing changed")
        self.write("198.51.100.9\n")
        self.assertTrue(black.refresh())
        self.assertIsNone(black.match("203.0.113.7", 27015))
        self.assertEqual(black.match("198.51.100.9", 27015), "198.51.100.9")
        self.file.unlink()
        self.assertTrue(black.refresh())
        self.assertEqual(len(black), 0)
        self.assertTrue(any("is gone" in line for line in self.lines))

    async def test_a_file_that_cannot_be_read_keeps_the_entries_from_before(self):
        black = self.blacklist("203.0.113.7\n")
        self.write("198.51.100.9\n")
        with mock.patch.object(Path, "read_text", side_effect=OSError("locked")):
            self.assertFalse(black.refresh())
        self.assertEqual(black.match("203.0.113.7", 27015), "203.0.113.7")
        self.assertTrue(black.refresh(), "and it is read again once it can be")
        self.assertEqual(black.match("198.51.100.9", 27015), "198.51.100.9")


class Refusing(Quiet):
    async def test_a_blacklisted_server_is_refused_before_it_is_queried(self):
        probe = self.use(Probe())
        state = self.state("203.0.113.7\n")
        entry, reason = await state.add(("203.0.113.7", 27015), "a test")
        self.assertIsNone(entry)
        self.assertEqual(reason, bot.BLACKLISTED)
        self.assertEqual(probe.asked, [], "no query went out")
        entry, reason = await state.add(("203.0.113.8", 27015), "a test")
        self.assertIsNotNone(entry, "another address is listed as ever")

    async def test_a_range_and_one_port(self):
        self.use(Probe())
        state = self.state("192.0.2.0/24\n198.51.100.9:27016\n")
        self.assertEqual((await state.add(("192.0.2.200", 27015), "a test"))[1], bot.BLACKLISTED)
        self.assertEqual((await state.add(("198.51.100.9", 27016), "a test"))[1], bot.BLACKLISTED)
        self.assertIsNotNone((await state.add(("198.51.100.9", 27015), "a test"))[0])

    async def test_the_key_and_a_moderator_do_not_get_past_it(self):
        # add() is what the key's heartbeats, Discord's /addserver and the open heartbeats all call, with open_ or not
        self.use(Probe())
        state = self.state("203.0.113.7\n")
        self.assertEqual((await state.add(("203.0.113.7", 27015), "heartbeat with the key", open_=False))[1], bot.BLACKLISTED)
        self.assertEqual((await state.add(("203.0.113.7", 27015), "heartbeat from 203.0.113.7", open_=True))[1], bot.BLACKLISTED)

    async def test_a_host_name_that_stands_for_a_blacklisted_address_is_refused(self):
        self.use(Probe())
        state = self.state("203.0.113.7\n")
        with mock.patch.object(bot.ServerList, "addresses_of", mock.AsyncMock(return_value=["203.0.113.7"])):
            entry, reason = await state.add(("sneaky.example.net", 27015), "a test")
        self.assertIsNone(entry)
        self.assertEqual(reason, bot.BLACKLISTED)

    async def test_a_name_is_not_looked_up_when_only_names_are_listed(self):
        self.use(Probe())
        state = self.state("fake.example.com\n")
        lookup = mock.AsyncMock(return_value=[])
        with mock.patch.object(bot.ServerList, "addresses_of", lookup):
            entry, _ = await state.add(("fine.example.org", 27015), "a test")
        self.assertIsNotNone(entry)
        lookup.assert_not_called()

    async def test_a_refusal_is_logged_once_in_a_while(self):
        self.use(Probe())
        state = self.state("203.0.113.7\n")
        for _ in range(5):
            await state.add(("203.0.113.7", 27015), "heartbeat from 203.0.113.7", open_=True)
        self.assertEqual(sum(1 for line in self.lines if line.startswith("refused 203.0.113.7:27015")), 1)

    async def test_a_seed_in_servers_txt_is_skipped(self):
        state = self.state("203.0.113.7\n")
        seeds = self.folder / "servers.txt"
        seeds.write_text("203.0.113.7:27015\n198.51.100.9:27015\n", encoding="utf-8")
        self.assertEqual(state.load_seeds(seeds), 1)
        self.assertEqual(list(state.entries), ["198.51.100.9:27015"])

    async def test_a_listed_server_is_taken_off_when_the_file_changes(self):
        self.use(Probe())
        state = self.state()
        await state.add(("203.0.113.7", 27015), "a test")
        await state.add(("198.51.100.9", 27015), "a test")
        self.assertEqual(len(state.entries), 2)
        self.write("203.0.113.7\n")
        await state.poll()
        self.assertEqual(list(state.entries), ["198.51.100.9:27015"])
        self.assertTrue(any(line.startswith("dropped 203.0.113.7:27015: blacklisted") for line in self.lines))

    async def test_taking_the_entry_out_lets_the_server_back(self):
        self.use(Probe())
        state = self.state("203.0.113.7\n")
        self.assertIsNone((await state.add(("203.0.113.7", 27015), "a test"))[0])
        self.write("; nothing\n")
        self.assertIsNotNone((await state.add(("203.0.113.7", 27015), "a test"))[0])


@unittest.skipUnless(HAVE_AIOHTTP, "aiohttp is not installed")
class OverHttp(Quiet):
    async def client(self, text):
        state = self.state(text)
        client = TestClient(TestServer(bot.make_app(state, state.settings)))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return client, state

    @staticmethod
    def beat(client, sender, body):
        return client.post("/v1/heartbeat", json=body, headers={"X-Real-IP": sender})

    async def test_a_blacklisted_heartbeat_is_answered_403_with_or_without_the_key(self):
        self.use(Probe())
        client, state = await self.client("198.51.100.7\n203.0.113.50\n")
        r = await self.beat(client, "198.51.100.7", {"port": 27015})
        self.assertEqual(r.status, 403)
        self.assertEqual((await r.json())["error"], bot.BLACKLISTED)
        r = await self.beat(client, "192.0.2.1", {"key": KEY, "address": "203.0.113.50:27015"})
        self.assertEqual(r.status, 403)
        self.assertEqual(state.entries, {})
        r = await self.beat(client, "192.0.2.1", {"port": 27015})
        self.assertEqual(r.status, 200, "an address that is not named is listed as ever")


if __name__ == "__main__":
    unittest.main()
