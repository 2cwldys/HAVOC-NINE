"""GET /v1/servers/<gamedir>.json reaches the JSON list, and /v1/servers/<gamedir> the plain one (python test_json_route.py)."""
import asyncio
import unittest

from aiohttp.test_utils import make_mocked_request

import h9_serverlist as hs


class Routes(unittest.TestCase):
    def resolve(self, path):
        app = hs.make_app(object(), object())

        async def go():
            return await app.router.resolve(make_mocked_request("GET", path, app=app))
        return asyncio.run(go())

    def test_json_list(self):
        match = self.resolve("/v1/servers/ts.json")
        self.assertIs(match.handler, hs.handle_list_json)
        self.assertEqual(match["gamedir"], "ts")

    def test_plain_list(self):
        self.assertIs(self.resolve("/v1/servers/ts").handler, hs.handle_list)


if __name__ == "__main__":
    unittest.main()
