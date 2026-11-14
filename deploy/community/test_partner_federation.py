"""Explicit routing remains narrow, bounded and off by default."""

import importlib.util
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("partner", HERE / "partner_federation.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CHANNELS = '{"11111111-1111-4111-8111-111111111111":["partner.example.org"]}'


class PartnerConfig(unittest.TestCase):
    def test_narrow_routes_and_explicit_discovery(self):
        for topology in ("single", "split"):
            with self.subTest(topology=topology):
                result = module.render(
                    topology, "home.example.org", ["partner.example.org"], CHANNELS
                )
                caddy = result["Caddyfile.partner"]
                self.assertEqual(caddy.count("/_matrix/federation/* /_matrix/key/*"), 1)
                self.assertNotIn("/_synapse/admin", caddy)
                self.assertNotIn("@matrix path /_matrix/*", caddy)
                self.assertIn("respond 404", caddy)
                self.assertEqual(
                    "@server_discovery path" in caddy, topology == "single"
                )
                self.assertEqual(
                    "external host" in result["README.txt"], topology == "split"
                )
        self.assertNotIn("/_matrix/federation/*", (HERE / "Caddyfile").read_text())
        self.assertNotIn(
            "/_matrix/federation/*", (HERE / "Caddyfile.split").read_text()
        )

    def test_named_refusals(self):
        cases = [
            ("no global optin", [], CHANNELS),
            ("no exact channel", ["partner.example.org"], "{}"),
            ("server port", ["partner.example.org:8448"], CHANNELS),
            ("private address", ["127.0.0.1"], CHANNELS),
            ("wildcard", ["*.example.org"], CHANNELS),
            ("private suffix", ["partner.internal"], CHANNELS),
            ("duplicate global", ["partner.example.org"] * 2, CHANNELS),
            ("unlisted partner", ["elsewhere.example.org"], CHANNELS),
            (
                "invalid channel",
                ["partner.example.org"],
                '{"everyone":["partner.example.org"]}',
            ),
            ("unbounded map", ["partner.example.org"], " " * 32769),
        ]
        for name, allowed, channels in cases:
            with self.subTest(reason=name), self.assertRaises(ValueError):
                module.render("single", "home.example.org", allowed, channels)
        with self.assertRaises(ValueError):
            module.render("single", "home.example.org", ["home.example.org"], CHANNELS)
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "generated"
            module.generate(
                output, "single", "home.example.org", ["partner.example.org"], CHANNELS
            )
            before = (output / "Caddyfile.partner").read_text()
            with self.assertRaises(FileExistsError):
                module.generate(
                    output,
                    "single",
                    "home.example.org",
                    ["partner.example.org"],
                    CHANNELS,
                )
            self.assertEqual(before, (output / "Caddyfile.partner").read_text())


if __name__ == "__main__":
    unittest.main()
