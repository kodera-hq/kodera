"""Ensure single and split Community topologies admit internal `server` for tenant-agent polling."""

import argparse
import importlib.util
import io
import json
import pathlib
import re
import secrets
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from urllib.parse import urlsplit

from configure_synapse import configure

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]

if "kodera_deploy" in sys.modules:
    kodera_deploy = sys.modules["kodera_deploy"]
else:
    deploy_spec = importlib.util.spec_from_file_location("kodera_deploy", HERE / "kodera_deploy.py")
    kodera_deploy = importlib.util.module_from_spec(deploy_spec)
    deploy_spec.loader.exec_module(kodera_deploy)

SERVER_DEPLOY_ENV = (ROOT / "apps/server/config/deploy_environment.py").read_text(encoding="utf-8")
SERVER_HOST_PATTERN = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z"
)


class DeployAllowedHostsTests(unittest.TestCase):
    def test_kodera_deploy_selftest_passes(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            kodera_deploy.selftest()
        self.assertIn("PASS:", buf.getvalue())

    def test_server_host_regex_matches_deploy_environment_and_admits_internal_server(self):
        self.assertIn(SERVER_HOST_PATTERN.pattern, SERVER_DEPLOY_ENV)
        compose_services = kodera_deploy.check.parse_compose_services(
            (HERE / "docker-compose.yml").read_text(encoding="utf-8")
        )
        agent_core_url = compose_services["tenant-agent"].environment["KODERA_CORE_URL"]
        self.assertEqual(agent_core_url, "http://server:8000")
        agent_host_header = urlsplit(agent_core_url).netloc
        self.assertEqual(agent_host_header, "server:8000")
        django_domain = agent_host_header.split(":", 1)[0]
        self.assertEqual(django_domain, "server")
        self.assertIsNotNone(SERVER_HOST_PATTERN.fullmatch(django_domain))

    def test_single_and_split_topologies_admit_internal_server_and_refuse_omission(self):
        template_text = (HERE / ".env.example").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix="kodera-allowed-hosts-") as tmp:
            tmp_path = pathlib.Path(tmp)
            trust = tmp_path / "public-trust.json"
            trust.write_text(
                json.dumps(
                    [
                        {
                            "lane": "customer",
                            "issuer": f"https://id.example.org/realms/{realm}",
                            "public_jwks": {
                                "keys": [{"kty": "RSA", "n": "public-test-modulus", "e": "AQAB"}]
                            },
                        }
                        for realm in ("studio", "community")
                    ]
                ),
                encoding="utf-8",
            )
            credential = tmp_path / "synthetic-credential.txt"
            credential.write_text("synthetic-issued-token-for-test-only", encoding="utf-8")

            def make_args(**overrides):
                base = {
                    "domain": "chat.example.org",
                    "matrix_domain": None,
                    "oidc_issuer": "https://id.example.org/realms/studio",
                    "oidc_origin": "https://id.example.org",
                    "support_mailbox": "support@example.org",
                    "trust_file": str(trust),
                    "oidc_client_id": "console",
                    "owner_user_id": None,
                    "agent_token_file": None,
                    "synapse_token_file": None,
                    "synapse_oidc_secret_file": None,
                    "staff_issuer": None,
                    "template": None,
                    "topology": "single",
                    "env_file": str(tmp_path / secrets.token_hex(8)),
                }
                if overrides.get("template") == "community":
                    base.update(
                        domain="community.example.org",
                        matrix_domain="example.org",
                        oidc_issuer="https://id.example.org/realms/community",
                        owner_user_id="00000000-0000-4000-8000-000000000001",
                        agent_token_file=str(credential),
                        synapse_token_file=str(credential),
                        synapse_oidc_secret_file=str(credential),
                    )
                base.update(overrides)
                return argparse.Namespace(**base)

            cases = (
                ("single-studio", make_args(topology="single"), "chat.example.org,127.0.0.1,server", False),
                ("single-community", make_args(template="community", topology="single"), "community.example.org,127.0.0.1,server", True),
                ("split-studio", make_args(topology="split"), "api.example.org,127.0.0.1,server", True),
                ("split-community", make_args(template="community", topology="split"), "api.example.org,127.0.0.1,server", True),
            )
            for label, ns, expected_hosts, requires_server_in_preflight in cases:
                with self.subTest(case=label):
                    generated = kodera_deploy.generate(ns).read_text(encoding="utf-8")
                    parsed, parse_errs = kodera_deploy.check.parse_env_example(generated)
                    self.assertEqual(parse_errs, [])
                    self.assertEqual(parsed["DJANGO_ALLOWED_HOSTS"], expected_hosts)
                    hosts = parsed["DJANGO_ALLOWED_HOSTS"].split(",")
                    self.assertIn("server", hosts)
                    self.assertTrue(all(SERVER_HOST_PATTERN.fullmatch(h) for h in hosts))
                    self.assertEqual(kodera_deploy.check.preflight_env(template_text, generated), [])
                    if requires_server_in_preflight:
                        without_server = generated.replace(
                            f"DJANGO_ALLOWED_HOSTS={expected_hosts}\n",
                            f"DJANGO_ALLOWED_HOSTS={expected_hosts.removesuffix(',server')}\n",
                        )
                        errors = kodera_deploy.check.preflight_env(template_text, without_server)
                        self.assertTrue(
                            any("DJANGO_ALLOWED_HOSTS must be" in err and ",127.0.0.1,server" in err for err in errors),
                            errors,
                        )

    def test_public_caddyfiles_still_close_agent_and_staff_routes(self):
        self.assertEqual(
            kodera_deploy.check.check_caddy_routes((HERE / "Caddyfile").read_text(encoding="utf-8")),
            [],
        )
        self.assertEqual(
            kodera_deploy.check.check_split_caddy_routes(
                (HERE / "Caddyfile.split").read_text(encoding="utf-8")
            ),
            [],
        )


class SynapseConfigurationTests(unittest.TestCase):
    def test_split_topology_rejects_an_insecure_app_origin(self):
        env = {
            "KODERA_TOPOLOGY": "split",
            "KODERA_COMPOSE_TOPOLOGY": "split",
            "KODERA_APP_ORIGIN": "http://app.example.org",
        }
        with self.assertRaisesRegex(ValueError, "KODERA_APP_ORIGIN must be an exact public HTTPS origin"):
            configure({"server_name": "community.example.org", "user_directory": None}, env)

    def test_null_user_directory_disables_search_across_all_users(self):
        result = configure({"server_name": "community.example.org", "user_directory": None})
        self.assertEqual(result["user_directory"], {"search_all_users": False})


if __name__ == "__main__":
    unittest.main()
