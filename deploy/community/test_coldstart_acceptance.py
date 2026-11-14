"""Refusal proofs for the hosted Community runtime qualification controller."""

import copy
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import accept_coldstart as acceptance


class QualificationBoundaryTests(unittest.TestCase):
    def test_only_exact_hosted_linux_context_is_admitted(self):
        environment = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "kodera-hq/kodera",
                       "RUNNER_OS": "Linux", "GITHUB_RUN_ID": "123",
                       "RUNNER_ENVIRONMENT": "github-hosted"}
        self.assertTrue(acceptance.hosted(environment))
        for key in environment:
            with self.subTest(key=key):
                changed = dict(environment)
                changed[key] = "invalid"
                self.assertFalse(acceptance.hosted(changed))

    def test_every_probe_and_closed_boundary_must_match(self):
        observed = {path: next(iter(codes)) for path, codes in acceptance.PROBES.items()}
        acceptance.validate_probes(observed)
        for path in observed:
            for status in (False, 302, 500):
                with self.subTest(path=path, status=status), self.assertRaises(acceptance.Refused):
                    acceptance.validate_probes({**observed, path: status})
        with self.assertRaises(acceptance.Refused):
            acceptance.validate_probes({})
        with self.assertRaises(acceptance.Refused):
            acceptance.validate_probes({**observed, "/unreviewed": 200})

    def config(self):
        return {"name": "owned-test", "services": {
            "caddy": {"ports": ["443:443"], "volumes": [{"type": "bind",
                "source": str(acceptance.ROOT / "deploy/community/Caddyfile"),
                "target": "/etc/caddy/Caddyfile", "read_only": True}]},
            "livekit": {"ports": ["7881:7881"]},
            "server": {"volumes": []}},
            "volumes": {"database": {"name": "owned-test_database"}},
            "networks": {"default": {"name": "owned-test_default"}}}

    def test_html_fallback_cannot_impersonate_health_or_matrix(self):
        acceptance.validate_payload("/health/live", b'{"status":"alive"}')
        acceptance.validate_payload("/health/ready", b'{"status":"ready","database":"reachable"}')
        acceptance.validate_payload("/_matrix/client/versions", b'{"versions":["v1.16"]}')
        self.assertEqual(acceptance.validate_payload("/", b'<title>Kodera</title><script src="/assets/index-abc.js"></script>'), "/assets/index-abc.js")
        for path, body in (("/health/live", b'<html>fallback</html>'),
                           ("/health/ready", b'{"status":"ready"}'),
                           ("/_matrix/client/versions", b'{"versions":[]}'),
                           ("/", b'<title>Kodera</title>'),
                           ("/", b'<title>Kodera</title><script src="https://outside.invalid/a.js"></script>')):
            with self.subTest(path=path), self.assertRaises(acceptance.Refused):
                acceptance.validate_payload(path, body)

    def test_test_ingress_is_loopback_and_cannot_add_external_mounts(self):
        with tempfile.TemporaryDirectory() as directory:
            config = acceptance.isolate(self.config(), Path(directory), "owned-test")
            self.assertEqual(config["services"]["caddy"]["ports"][0]["host_ip"], "127.0.0.1")
            self.assertIn("tls internal", (Path(directory) / "Caddyfile").read_text())
            self.assertEqual(config["volumes"], {"database": {"name": "owned-test_database"}})
            cases = []
            for key, value in (("privileged", True), ("network_mode", "host"),
                               ("pid", "host"), ("ipc", "host")):
                changed = self.config()
                changed["services"]["server"][key] = value
                cases.append(changed)
            changed = self.config()
            changed["volumes"]["database"]["external"] = True
            cases.append(changed)
            changed = self.config()
            changed["volumes"]["database"]["name"] = "unowned-database"
            cases.append(changed)
            changed = self.config()
            changed["networks"]["default"] = {"external": True, "name": "unowned-network"}
            cases.append(changed)
            changed = self.config()
            changed["networks"]["default"]["name"] = "unowned-network"
            cases.append(changed)
            changed = self.config()
            changed["services"]["server"]["ports"] = ["8000:8000"]
            cases.append(changed)
            changed = self.config()
            changed["name"] = "another-project"
            cases.append(changed)
            changed = self.config()
            changed["services"]["caddy"]["volumes"][0]["source"] = "/var/run/docker.sock"
            cases.append(changed)
            for case in cases:
                with self.subTest(case=case), self.assertRaises(acceptance.Refused):
                    acceptance.isolate(copy.deepcopy(case), Path(directory), "owned-test")

    def test_overall_deadline_refuses_new_work_and_keeps_cleanup_available(self):
        controller = acceptance.Qualification()
        controller.deadline = 0
        with patch.object(acceptance.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(acceptance.Refused, "overall execution"):
                controller.run("expired-build", [sys.executable, "-c", "pass"])
            launch.assert_not_called()
        with redirect_stdout(io.StringIO()):
            controller.run("bounded-cleanup", [sys.executable, "-c", "pass"], guard=False)

    def test_host_docker_and_proxy_selection_is_never_forwarded(self):
        with patch.dict(acceptance.os.environ, {"DOCKER_HOST": "tcp://outside.invalid:2375",
                                               "DOCKER_CONTEXT": "remote", "HTTPS_PROXY": "private-value"}):
            controller = acceptance.Qualification()
        self.assertEqual(controller.environment["DOCKER_HOST"], "unix:///var/run/docker.sock")
        self.assertEqual(controller.environment["DOCKER_CONTEXT"], "default")
        self.assertNotIn("HTTPS_PROXY", controller.environment)

    def test_disk_guard_refuses_before_the_mandatory_floor(self):
        controller = acceptance.Qualification()
        fake = type("Disk", (), {"free": acceptance.STOP_FREE - 1})()
        with patch.object(acceptance.shutil, "disk_usage", return_value=fake):
            with self.assertRaisesRegex(acceptance.Refused, "disk stop"):
                controller.reserve()
        self.assertGreater(acceptance.STOP_FREE, acceptance.MINIMUM_FREE)

    def test_failed_and_timed_out_subprocesses_cannot_report_success(self):
        controller = acceptance.Qualification()
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(acceptance.Refused, "phase failed"):
            controller.run("test-failure", [sys.executable, "-c", "raise SystemExit(7)"], guard=False)
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(acceptance.Refused, "timeout"):
            controller.run("test-timeout", [sys.executable, "-c", "import time; time.sleep(10)"],
                           timeout=.05, guard=False)

    def test_private_configuration_is_deleted_even_when_project_cleanup_fails(self):
        controller = acceptance.Qualification()
        controller.scratch = Path(tempfile.mkdtemp())
        scratch = controller.scratch
        (scratch / "runtime.conf").write_text("synthetic-only")
        controller.owned = True
        controller.compose = ["docker", "compose"]
        with patch.object(controller, "run", side_effect=acceptance.Refused("cleanup failed")):
            with self.assertRaises(acceptance.Refused):
                controller.cleanup()
        self.assertFalse(scratch.exists())


if __name__ == "__main__":
    unittest.main()
