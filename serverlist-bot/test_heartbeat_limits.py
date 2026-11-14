"""python -m unittest test_heartbeat_limits -- what a heartbeat without the key may put on the list."""
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
    """Stands in for probe(): every address answers, and it counts how many queries are out at once."""

    def __init__(self, answer=None, gate=None):
        self.answer = ANSWER if answer is None else answer
        self.gate = gate
        self.out = 0
        self.most = 0
        self.asked = 0

    async def __call__(self, target, timeout):
        self.asked += 1
        self.out += 1
        self.most = max(self.most, self.out)
        try:
            if self.gate is not None:
                await self.gate.wait()
            else:
                await asyncio.sleep(0)
            return dict(self.answer) if self.answer else None
        finally:
            self.out -= 1


class Quiet(unittest.IsolatedAsyncioTestCase):
    """No log file is written, and nothing is queried over the network."""

    def setUp(self):
        patcher = mock.patch.object(bot, "log", lambda message: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def use(self, probe):
        patcher = mock.patch.object(bot, "probe", probe)
        patcher.start()
        self.addCleanup(patcher.stop)
        return probe


class ListCaps(Quiet):
    async def test_one_address_cannot_list_more_than_its_share(self):
        self.use(Probe())
        state = bot.ServerList(settings())
        sender = "198.51.100.7"
        listed = refused = 0
        for port in range(20000, 25000):
            entry, reason = await state.add((sender, port), "heartbeat from " + sender, open_=True)
            if entry is None:
                refused += 1
                self.assertIn("more need the heartbeat key", reason)
            else:
                listed += 1
        self.assertEqual(listed, 8)
        self.assertEqual(refused, 5000 - 8)
        self.assertEqual(len(state.entries), 8)
        self.assertEqual(len(state.live("ts")), 8)

    async def test_the_cap_is_checked_before_the_query_is_made(self):
        probe = self.use(Probe())
        state = bot.ServerList(settings(max_per_address=2))
        for port in range(27015, 27025):
            await state.add(("198.51.100.7", port), "heartbeat", open_=True)
        self.assertEqual(probe.asked, 2, "an address over its share costs no query")

    async def test_the_list_as_a_whole_takes_only_so_many(self):
        self.use(Probe())
        state = bot.ServerList(settings(max_open_servers=20))
        for host in range(1, 200):
            for port in (27015, 27016):
                await state.add((f"198.51.100.{host}", port), "heartbeat", open_=True)
        self.assertEqual(len(state.entries), 20)
        entry, reason = await state.add(("203.0.113.9", 27015), "heartbeat", open_=True)
        self.assertIsNone(entry)
        self.assertIn("no more servers", reason)

    async def test_a_listed_server_is_refreshed_at_the_cap(self):
        self.use(Probe())
        state = bot.ServerList(settings(max_per_address=1, max_open_servers=1))
        first, _ = await state.add(("198.51.100.7", 27015), "heartbeat", open_=True)
        self.assertIsNotNone(first)
        first["seen"] = 1.0
        again, reason = await state.add(("198.51.100.7", 27015), "heartbeat", open_=True)
        self.assertIsNone(reason)
        self.assertIs(again, first)
        self.assertGreater(again["seen"], 1.0, "refreshed, not refused")
        other, reason = await state.add(("198.51.100.8", 27015), "heartbeat", open_=True)
        self.assertIsNone(other)

    async def test_the_key_servers_txt_and_discord_are_not_held_to_it(self):
        self.use(Probe())
        state = bot.ServerList(settings(max_per_address=1, max_open_servers=1))
        await state.add(("198.51.100.7", 27015), "heartbeat", open_=True)
        for port in range(27016, 27030):
            entry, reason = await state.add(("198.51.100.7", port), "Discord someone")
            self.assertIsNone(reason)
        self.assertEqual(len(state.entries), 15)
        self.assertEqual(sum(1 for e in state.entries.values() if e["open"]), 1, "only the keyless one counts against the caps")
        seeds = Path(tempfile.mkdtemp(dir=os.environ.get("TEMP"))) / "servers.txt"
        seeds.write_text("\n".join(f"192.0.2.{n}:27015" for n in range(1, 30)) + "\n", encoding="utf-8")
        self.assertEqual(state.load_seeds(seeds), 29)
        self.assertEqual(len(state.entries), 15 + 29)
        entry, reason = await state.add(("203.0.113.9", 27015), "heartbeat", open_=True)
        self.assertIsNone(entry, "the keyless cap is still full")

    async def test_a_flood_that_arrives_at_once_does_not_get_past_the_caps(self):
        gate = asyncio.Event()
        probe = self.use(Probe(gate=gate))
        state = bot.ServerList(settings(max_per_address=3))
        sender = "198.51.100.7"
        tasks = [asyncio.create_task(state.add((sender, 20000 + n), "heartbeat", open_=True)) for n in range(200)]
        await asyncio.sleep(0.05)
        self.assertLessEqual(probe.most, bot.MAX_OPEN_ADDS, "never more queries out than MAX_OPEN_ADDS")
        gate.set()
        results = await asyncio.gather(*tasks)
        self.assertEqual(len(state.entries), 3, "four queries were out, and the fourth found the address full when it came back")
        self.assertEqual(sum(1 for entry, _ in results if entry is not None), 3)
        self.assertEqual(state.adding, 0)

    async def test_busy_is_a_refusal_not_a_queue(self):
        gate = asyncio.Event()
        self.use(Probe(gate=gate))
        state = bot.ServerList(settings())
        tasks = [asyncio.create_task(state.add((f"198.51.100.{n}", 27015), "heartbeat", open_=True)) for n in range(1, bot.MAX_OPEN_ADDS + 1)]
        await asyncio.sleep(0.05)
        self.assertEqual(state.adding, bot.MAX_OPEN_ADDS)
        entry, reason = await state.add(("198.51.100.99", 27015), "heartbeat", open_=True)
        self.assertIsNone(entry)
        self.assertIn("busy", reason)
        gate.set()
        await asyncio.gather(*tasks)
        self.assertEqual(state.adding, 0)
        entry, reason = await state.add(("198.51.100.99", 27015), "heartbeat", open_=True)
        self.assertIsNotNone(entry, "free again once the queries are back")

    async def test_a_query_that_fails_gives_its_place_back(self):
        probe = self.use(Probe(answer={}))
        state = bot.ServerList(settings())
        for n in range(bot.MAX_OPEN_ADDS * 3):
            entry, reason = await state.add(("198.51.100.7", 27000 + n), "heartbeat", open_=True)
            self.assertEqual(reason, "no answer from that address")
        self.assertEqual(state.adding, 0)
        self.assertEqual(len(state.entries), 0, "an address that does not answer never gets on")

    async def test_honest_servers_list_as_before(self):
        self.use(Probe())
        state = bot.ServerList(settings())
        for port in (27015, 27016, 27017):
            entry, reason = await state.add(("198.51.100.7", port), "heartbeat from 198.51.100.7", open_=True)
            self.assertIsNone(reason)
            self.assertEqual(entry["address"], f"198.51.100.7:{port}")
        self.assertEqual(len(state.live("ts")), 3)
        self.use(Probe(answer=dict(ANSWER, folder="cstrike")))
        entry, reason = await state.add(("198.51.100.8", 27015), "heartbeat", open_=True)
        self.assertIsNone(entry)
        self.assertIn("'cstrike'", reason)

    async def test_a_heartbeat_for_a_seed_named_by_host_is_not_a_new_server(self):
        self.use(Probe())
        state = bot.ServerList(settings(max_per_address=1, max_open_servers=2))
        state.entries["havoc9.org:27015"] = bot.new_entry("havoc9.org", 27015, "servers.txt")
        await state.add(("198.51.100.1", 27015), "heartbeat", open_=True)
        with mock.patch.object(bot.ServerList, "same_server", mock.AsyncMock(return_value="havoc9.org:27015")):
            entry, reason = await state.add(("203.0.113.10", 27015), "heartbeat", open_=True)
        self.assertIsNone(reason)
        self.assertEqual(entry["address"], "havoc9.org:27015")
        self.assertFalse(entry["open"], "still the seed's own entry")
        self.assertEqual(len(state.entries), 2)
        entry, reason = await state.add(("203.0.113.11", 27015), "heartbeat", open_=True)
        self.assertIsNone(reason, "the heartbeat that matched the seed used none of the keyless allowance")


class Rates(unittest.TestCase):
    def test_counts_per_address_per_window(self):
        rates = {}
        limit = 5
        for n in range(limit):
            self.assertFalse(bot.heartbeat_rate_exceeded(rates, "198.51.100.7", 100.0 + n, limit))
        self.assertTrue(bot.heartbeat_rate_exceeded(rates, "198.51.100.7", 106.0, limit))
        self.assertFalse(bot.heartbeat_rate_exceeded(rates, "198.51.100.8", 106.0, limit), "another address has its own count")
        self.assertFalse(bot.heartbeat_rate_exceeded(rates, "198.51.100.7", 100.0 + bot.HEARTBEAT_RATE_WINDOW + 1, limit), "a new window")

    def test_the_table_stays_small(self):
        rates = {}
        for n in range(30000):
            bot.heartbeat_rate_exceeded(rates, f"10.{n >> 16}.{(n >> 8) & 255}.{n & 255}", 1.0, 5)
        self.assertLessEqual(len(rates), 10001)


class SettingsFile(unittest.TestCase):
    def read(self, text):
        folder = Path(tempfile.mkdtemp(dir=os.environ.get("TEMP")))
        ini = folder / "serverlist.ini"
        ini.write_text(text, encoding="utf-8")
        with mock.patch.object(bot, "INI", ini), mock.patch.object(bot, "SECRETS", folder / "none.cfg"):
            return bot.Settings()

    def test_defaults(self):
        s = self.read("")
        self.assertEqual((s.max_per_address, s.max_open_servers, s.heartbeats_per_minute), (8, 100, 60))

    def test_the_file_sets_them(self):
        s = self.read("[list]\nmax_per_address = 3\nmax_open_servers = 40\n[http]\nheartbeats_per_minute = 12\n")
        self.assertEqual((s.max_per_address, s.max_open_servers, s.heartbeats_per_minute), (3, 40, 12))

    def test_zero_is_refused(self):
        for text in ("[list]\nmax_per_address = 0\n", "[list]\nmax_open_servers = 0\n", "[http]\nheartbeats_per_minute = 0\n"):
            with self.assertRaises(SystemExit):
                self.read(text)


@unittest.skipUnless(HAVE_AIOHTTP, "aiohttp is not installed")
class OverHttp(Quiet):
    """The same limits through POST /v1/heartbeat, the way a game server (or a flood) reaches them."""

    async def client(self, **more):
        state = bot.ServerList(settings(**more))
        app = bot.make_app(state, state.settings)
        client = TestClient(TestServer(app))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return client, state

    @staticmethod
    def beat(client, sender, body):
        return client.post("/v1/heartbeat", json=body, headers={"X-Real-IP": sender})

    async def test_a_flood_of_ports_from_one_address_lists_only_its_share(self):
        self.use(Probe())
        client, state = await self.client(heartbeats_per_minute=100000)
        statuses = []
        for port in range(20000, 20060):
            r = await self.beat(client, "198.51.100.7", {"port": port})
            statuses.append(r.status)
        self.assertEqual(statuses.count(200), 8)
        self.assertEqual(statuses.count(422), 52)
        text = await (await client.get("/v1/servers/ts")).text()
        self.assertEqual(sum(1 for line in text.splitlines() if line.startswith("ip ")), 8)

    async def test_too_many_heartbeats_a_minute_from_one_address_get_429(self):
        self.use(Probe())
        client, state = await self.client(heartbeats_per_minute=5, max_per_address=100)
        codes = [(await self.beat(client, "198.51.100.7", {"port": 20000 + n})).status for n in range(8)]
        self.assertEqual(codes, [200] * 5 + [429] * 3)
        r = await self.beat(client, "198.51.100.7", {"port": 20000})
        self.assertEqual(r.status, 429)
        self.assertEqual(r.headers["Retry-After"], str(bot.HEARTBEAT_RATE_WINDOW))
        r = await self.beat(client, "198.51.100.8", {"port": 27015})
        self.assertEqual(r.status, 200, "another address is not held back")

    async def test_the_key_is_not_held_to_the_limits(self):
        self.use(Probe())
        client, state = await self.client(heartbeats_per_minute=2, max_per_address=1, max_open_servers=1)
        for n in range(12):
            r = await self.beat(client, "198.51.100.7", {"key": KEY, "address": f"203.0.113.50:{27000 + n}"})
            self.assertEqual(r.status, 200)
        self.assertEqual(len(state.entries), 12)
        r = await self.beat(client, "198.51.100.7", {"port": 27015})
        self.assertEqual(r.status, 200, "and its keyless heartbeats still have their own allowance")

    async def test_wrong_keys_are_still_cut_off(self):
        self.use(Probe())
        client, state = await self.client()
        codes = [(await self.beat(client, "198.51.100.7", {"key": "wrong", "address": "203.0.113.50:27015"})).status
                 for _ in range(bot.HEARTBEAT_FAILS + 2)]
        self.assertEqual(codes, [401] * bot.HEARTBEAT_FAILS + [429] * 2)

    async def test_a_server_that_restarts_and_heartbeats_every_few_seconds_is_never_held_back(self):
        self.use(Probe())
        client, state = await self.client()
        for _ in range(12):
            r = await self.beat(client, "198.51.100.7", {"port": 27015})
            self.assertEqual(r.status, 200)
        self.assertEqual(len(state.entries), 1, "the same server, refreshed")


if __name__ == "__main__":
    unittest.main()
