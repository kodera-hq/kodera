"""Renderer and tenant-agent agree on explicit modes and preserve abuse controls."""

import importlib.util
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "apps/server"))
spec = importlib.util.spec_from_file_location("renderer", HERE / "configure_synapse.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
from tenant_agent.config import Config, ConfigError

CHANNEL = "11111111-1111-4111-8111-111111111111"
SELECTED = '{"' + CHANNEL + '":["peer.example.org"]}'


class FederationModes(unittest.TestCase):
    def document(self):
        return {
            "server_name": "home.example.org",
            "listeners": [
                {"port": 8008, "resources": [{"names": ["client", "federation"]}]}
            ],
        }

    def test_default_closed_partner_and_explicit_open(self):
        for env, expected in (
            ({}, []),
            (
                {"KODERA_MATRIX_FEDERATION_ALLOWLIST": "peer.example.org"},
                ["peer.example.org"],
            ),
            ({"KODERA_FEDERATION_MODE": "open"}, None),
        ):
            with self.subTest(env=env):
                result = renderer.configure(self.document(), env)
                self.assertEqual(result["federation_domain_whitelist"], expected)
                self.assertEqual(
                    "federation" in result["listeners"][0]["resources"][0]["names"],
                    expected != [],
                )
                self.assertEqual(
                    result["rc_federation"],
                    {
                        "window_size": 1000,
                        "sleep_limit": 10,
                        "sleep_delay": 500,
                        "reject_limit": 50,
                        "concurrent": 3,
                    },
                )
                self.assertTrue(result["federation_verify_certificates"])
                self.assertFalse(result["allow_public_rooms_over_federation"])
                self.assertFalse(result["allow_profile_lookup_over_federation"])
                self.assertEqual(result["ip_range_whitelist"], [])
                self.assertIn("169.254.0.0/16", result["ip_range_blacklist"])
                self.assertIn("fc00::/7", result["ip_range_blacklist"])
                self.assertEqual(renderer.configure(result, env), result)

    def test_open_replaces_stale_transport_weakening_and_rejects_proxy_bypass(self):
        previous = {
            **self.document(),
            "federation_verify_certificates": False,
            "rc_federation": {"concurrent": 10000},
            "ip_range_blacklist": [],
            "ip_range_whitelist": ["127.0.0.1/32"],
        }
        result = renderer.configure(previous, {"KODERA_FEDERATION_MODE": "open"})
        self.assertTrue(result["federation_verify_certificates"])
        self.assertEqual(result["rc_federation"]["concurrent"], 3)
        self.assertEqual(result["ip_range_whitelist"], [])
        for name in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "proxies"):
                renderer.configure(
                    self.document(),
                    {
                        "KODERA_FEDERATION_MODE": "open",
                        name: "http://proxy.example.org",
                    },
                )

    def test_invalid_modes_and_ambiguous_global_lists_fail_closed(self):
        for env in (
            {"KODERA_FEDERATION_MODE": "typo"},
            {"KODERA_FEDERATION_MODE": "partner"},
            {
                "KODERA_FEDERATION_MODE": "closed",
                "KODERA_MATRIX_FEDERATION_ALLOWLIST": "peer.example.org",
            },
            {
                "KODERA_FEDERATION_MODE": "open",
                "KODERA_MATRIX_FEDERATION_ALLOWLIST": "peer.example.org",
            },
        ):
            with self.subTest(env=env), self.assertRaises(ValueError):
                renderer.configure(self.document(), env)

    def agent_environment(self):
        return {
            "KODERA_APPS": "matrix",
            "KODERA_CORE_URL": "http://server:8000",
            "KODERA_AGENT_TOKEN": "synthetic-agent-token",
            "KODERA_AGENT_STATE_DIR": "/tmp/synthetic-state",
            "KODERA_COMPOSE_PROJECT": "synthetic-project",
            "LIVEKIT_URL": "http://livekit:7880",
            "LIVEKIT_API_KEY": "synthetic-key",
            "LIVEKIT_API_SECRET": "synthetic-secret",
            "KODERA_SYNAPSE_URL": "http://synapse:8008",
            "KODERA_SYNAPSE_TOKEN": "synthetic-synapse-token",
            "KODERA_MATRIX_SERVER_NAME": "home.example.org",
        }

    def test_agent_open_mode_keeps_exact_channels_and_validated_public_servers(self):
        env = {
            **self.agent_environment(),
            "KODERA_FEDERATION_MODE": "open",
            "KODERA_MATRIX_PARTNER_CHANNELS": SELECTED,
        }
        self.assertEqual(
            Config.from_env(env).partner_channels, ((CHANNEL, ("peer.example.org",)),)
        )
        for changes in (
            {"KODERA_FEDERATION_MODE": "closed"},
            {"KODERA_FEDERATION_MODE": "partner"},
            {"KODERA_FEDERATION_MODE": "typo"},
            {"KODERA_MATRIX_FEDERATION_ALLOWLIST": "peer.example.org"},
            {
                "KODERA_MATRIX_PARTNER_CHANNELS": SELECTED.replace(
                    "peer.example.org", "127.0.0.1"
                )
            },
            {"KODERA_MATRIX_SERVER_NAME": "peer.example.org"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ConfigError):
                Config.from_env({**env, **changes})


if __name__ == "__main__":
    unittest.main()
