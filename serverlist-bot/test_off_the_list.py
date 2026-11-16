"""python -m unittest test_off_the_list -- a server that does not answer, or says it is closing, is off the list at once."""
import asyncio
import unittest

from aiohttp.test_utils import TestClient, TestServer

import h9_serverlist as bot
from test_heartbeat_limits import Probe, Quiet, settings


class OffTheList(Quiet):
    async def test_a_server_that_misses_one_query_is_not_on_the_list_and_is_back_when_it_answers(self):
        probe = self.use(Probe())
        state = bot.ServerList(settings())
        entry, _ = await state.add(("198.51.100.7", 27015), "heartbeat", open_=True)
        self.assertEqual(len(state.live("ts")), 1)
        probe.answer = None                                  # the server has closed
        await state.poll()
        self.assertEqual(state.live("ts"), [], "off the list at the first query nobody answers")
        self.assertIn("198.51.100.7:27015", state.entries, "still queried")
        probe.answer = {"kind": "ip", "name": "a server", "map": "m", "folder": "ts", "mode": "x", "players": 1, "max": 32, "bots": 0, "ping": 1.0}
        await state.poll()
        self.assertEqual(len(state.live("ts")), 1, "back the moment it answers")

    async def test_a_closing_heartbeat_takes_it_off_at_once(self):
        self.use(Probe())
        state = bot.ServerList(settings())
        await state.add(("127.0.0.1", 27015), "heartbeat", open_=True)
        app = bot.make_app(state, settings())
        async with TestClient(TestServer(app)) as client:
            self.assertEqual(len(state.live("ts")), 1)
            res = await client.post("/v1/heartbeat", json={"port": 27015, "closing": True})
            self.assertEqual(res.status, 200)
            self.assertEqual((await res.json())["closed"], True)
            self.assertEqual(state.live("ts"), [])
            self.assertEqual(state.entries, {})
            res = await client.post("/v1/heartbeat", json={"port": 27015, "closing": True})
            self.assertEqual((await res.json())["closed"], False, "closing twice is harmless")

    async def test_a_closing_heartbeat_names_only_the_senders_own_address(self):
        self.use(Probe())
        state = bot.ServerList(settings())
        await state.add(("198.51.100.99", 27015), "heartbeat", open_=True)
        app = bot.make_app(state, settings())
        async with TestClient(TestServer(app)) as client:
            res = await client.post("/v1/heartbeat", json={"port": 27015, "closing": True, "address": "198.51.100.99:27015"})
            self.assertEqual(res.status, 403, "someone else's server cannot be closed without the key")
            self.assertEqual(len(state.live("ts")), 1)


class DiscordStatus(unittest.TestCase):
    def test_nothing_is_called_unreachable_but_the_list_itself(self):
        self.assertEqual(bot.status_for(0, 0, 0, True), ("idle", "no servers to track"))
        self.assertEqual(bot.status_for(2, 2, 0, True), ("online", "Tracking 2 servers"))
        self.assertEqual(bot.status_for(0, 0, 1, True), ("idle", "no servers to track"), "a silent server is not on the list")
        self.assertEqual(bot.status_for(1, 1, 0, False), ("dnd", "server list unreachable"))


if __name__ == "__main__":
    unittest.main()
