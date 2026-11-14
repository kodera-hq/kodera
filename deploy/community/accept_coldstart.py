#!/usr/bin/env python3
"""Qualify a fresh Community stack on an isolated hosted Linux runner."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
GIB = 1024**3
MINIMUM_FREE = 20 * GIB
STOP_FREE = 21 * GIB
ADMISSION_FREE = 24 * GIB
EXECUTION_SECONDS = 30 * 60  # Workflow allows 35 minutes, reserving cleanup and runner setup.
DOMAIN = "chat.example.org"
HTTPS_PORT = 18443
PROBES = {
    "/health/live": {200},
    "/health/ready": {200},
    "/_matrix/client/versions": {200},
    "/": {200},
    "/_matrix/federation/v1/version": {404},
    "/_synapse/admin/v1/server_version": {404},
}


class Refused(RuntimeError):
    """A bounded acceptance predicate refused; captured configuration stays private."""


def hosted(environment):
    return (
        environment.get("GITHUB_ACTIONS") == "true"
        and environment.get("GITHUB_REPOSITORY") == "kodera-hq/kodera"
        and environment.get("RUNNER_OS") == "Linux"
        and environment.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and environment.get("GITHUB_RUN_ID", "").isdigit()
    )


def validate_probes(observed):
    if set(observed) != set(PROBES):
        raise Refused("probe inventory differs")
    if any(type(observed[path]) is not int or observed[path] not in expected
           for path, expected in PROBES.items()):
        raise Refused("HTTP acceptance refused")


def validate_payload(path, body):
    if not body or len(body) > 1024**2:
        raise Refused("probe payload size refused")
    if path in ("/health/live", "/health/ready", "/_matrix/client/versions"):
        try:
            document = json.loads(body)
        except (ValueError, UnicodeError):
            raise Refused("probe payload is not JSON") from None
        expected = {"status": "alive"} if path == "/health/live" else {"status": "ready", "database": "reachable"}
        if path.startswith("/health/") and document != expected:
            raise Refused("health payload differs")
        if path == "/_matrix/client/versions" and (
            not isinstance(document, dict) or not isinstance(document.get("versions"), list)
            or not 1 <= len(document["versions"]) <= 64
            or any(not isinstance(value, str) for value in document["versions"])
        ):
            raise Refused("Matrix versions payload differs")
    if path == "/":
        match = re.search(rb'src="(/assets/[A-Za-z0-9_.-]+\.js)"', body)
        if b"<title>Kodera</title>" not in body or match is None:
            raise Refused("web entry payload differs")
        return match[1].decode("ascii")
    return None


def isolate(config, scratch, project):
    """Keep source services and fresh named volumes; change only private test ingress/TLS."""
    if config.get("name") != project:
        raise Refused("project identity differs")
    for name, service in config["services"].items():
        if service.get("ports") and name not in {"caddy", "livekit"}:
            raise Refused("unreviewed service publishes ports")
        if service.get("privileged") or service.get("network_mode") == "host":
            raise Refused("unsafe service topology")
        if service.get("pid") == "host" or service.get("ipc") == "host":
            raise Refused("unsafe service namespace")
        for volume in service.get("volumes", []):
            if volume.get("type") == "bind":
                source = Path(volume["source"]).resolve()
                if not source.is_relative_to(ROOT):
                    raise Refused("source mount is outside the checkout")
    for name, volume in config.get("volumes", {}).items():
        if volume.get("external") or volume.get("name") != project + "_" + name:
            raise Refused("volume is outside the owned project")
    for name, network in config.get("networks", {}).items():
        if network.get("external") or network.get("name") != project + "_" + name:
            raise Refused("network is outside the owned project")
        if network.get("driver") not in (None, "bridge"):
            raise Refused("network driver is not isolated")
    config["services"]["caddy"]["ports"] = [
        {"target": 443, "published": str(HTTPS_PORT), "host_ip": "127.0.0.1", "protocol": "tcp"}
    ]
    config["services"]["livekit"]["ports"] = [
        "127.0.0.1:17881:7881/tcp", "127.0.0.1:50300-50500:50000-50200/udp"
    ]
    source = (ROOT / "deploy/community/Caddyfile").read_text()
    anchor = "{$KODERA_DOMAIN} {"
    if source.count(anchor) != 1:
        raise Refused("TLS test anchor differs")
    caddy = scratch / "Caddyfile"
    caddy.write_text(source.replace(anchor, anchor + "\n\ttls internal"))
    changed = 0
    for volume in config["services"]["caddy"]["volumes"]:
        if volume["target"] == "/etc/caddy/Caddyfile":
            volume["source"] = str(caddy)
            changed += 1
    if changed != 1:
        raise Refused("TLS source mount differs")
    return config


class Qualification:
    def __init__(self):
        self.deadline = time.monotonic() + EXECUTION_SECONDS
        self.project = "community-coldstart-" + uuid.uuid4().hex
        self.scratch = None
        self.compose = None
        self.owned = False
        # Never forward host proxy, signing, infrastructure or provider variables.
        self.environment = {
            key: os.environ[key] for key in ("PATH", "HOME")
            if key in os.environ
        }
        self.environment.update(COMPOSE_PARALLEL_LIMIT="1", BUILDKIT_PROGRESS="plain")
        self.environment.update(DOCKER_HOST="unix:///var/run/docker.sock", DOCKER_CONTEXT="default")
        self.evidence = {
            "status": "running", "project": self.project,
            "source": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
            "platform": platform.platform(), "logical_cpus": os.cpu_count(),
            "phases": [], "minimum_free_gib": shutil.disk_usage(ROOT).free / GIB,
            "qualification_scope": "Fresh volumes and exact-source images; synthetic trust, no sign-in or live media proof",
        }

    def reserve(self):
        if time.monotonic() >= self.deadline:
            raise Refused("overall execution deadline reached")
        free = shutil.disk_usage(ROOT).free
        self.evidence["minimum_free_gib"] = min(self.evidence["minimum_free_gib"], free / GIB)
        if free < STOP_FREE:
            raise Refused("disk stop reserve reached")

    def run(self, phase, args, timeout=600, guard=True):
        if guard:
            self.reserve()
        started = time.monotonic()
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen(args, cwd=ROOT, env=self.environment, stdout=output,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                while process.poll() is None:
                    if guard:
                        self.reserve()
                    if time.monotonic() - started > timeout:
                        raise Refused("phase timeout: " + phase)
                    time.sleep(.25)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
            output.seek(0)
            captured = output.read().decode(errors="replace")
        record = {"phase": phase, "seconds": round(time.monotonic() - started, 3),
                  "exit_code": process.returncode}
        self.evidence["phases"].append(record)
        print(json.dumps(record), flush=True)
        if process.returncode:
            raise Refused("phase failed: " + phase)
        return captured

    def resources(self):
        ids = self.run("container-inventory", ["docker", "ps", "-aq", "--filter",
                       "label=com.docker.compose.project=" + self.project], timeout=30, guard=False).split()
        volumes = self.run("volume-inventory", ["docker", "volume", "ls", "-q", "--filter",
                           "label=com.docker.compose.project=" + self.project], timeout=30, guard=False).split()
        return ids, volumes

    def configure(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="community-coldstart-"))
        self.scratch.chmod(0o700)
        # Only a synthetic public verification key is configured; no identity provider is contacted.
        private = subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt",
                                  "rsa_keygen_bits:2048"], capture_output=True, check=True, timeout=15).stdout
        modulus = subprocess.run(["openssl", "rsa", "-noout", "-modulus"], input=private,
                                 capture_output=True, check=True, timeout=15).stdout.decode().strip().split("=")[1]
        del private
        trust = [{"lane": "customer", "issuer": "https://id.example.org/realms/coldstart",
                  "generation": "coldstart-only", "expires_at": int(time.time()) + 86400,
                  "public_jwks": {"keys": [{"kty": "RSA", "kid": "coldstart-only", "use": "sig",
                  "alg": "RS256", "n": base64.urlsafe_b64encode(bytes.fromhex(modulus)).decode().rstrip("="),
                  "e": "AQAB"}]}}]
        values = {}
        for line in (ROOT / "deploy/community/.env.example").read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                if value.startswith("CHANGE_ME_"):
                    value = (base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
                             if "BASE64URL" in value else secrets.token_hex(32))
                values[key] = value
        values.update(KODERA_AUTH_TRUST=json.dumps(trust, separators=(",", ":")),
                      KODERA_DEFAULT_COMMUNITY_ORG_SLUG="", KODERA_DEFAULT_COMMUNITY_ISSUER="",
                      KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID="", KODERA_AGENT_TOKEN="",
                      KODERA_SYNAPSE_TOKEN="", KODERA_SYNAPSE_OIDC_ISSUER="",
                      KODERA_SYNAPSE_OIDC_CLIENT_SECRET="")
        conf = self.scratch / "runtime.conf"
        conf.write_text("\n".join(f"{key}={json.dumps(value) if key == 'KODERA_AUTH_TRUST' else value}"
                                  for key, value in values.items()) + "\n")
        conf.chmod(0o600)
        rendered = self.run("render", ["docker", "compose", "--env-file", str(conf), "-p",
                            self.project, "-f", "deploy/community/docker-compose.yml", "config", "--format", "json"])
        config = isolate(json.loads(rendered), self.scratch, self.project)
        runtime = self.scratch / "runtime-compose.json"
        runtime.write_text(json.dumps(config))
        runtime.chmod(0o600)
        self.compose = ["docker", "compose", "--env-file", "/dev/null", "-p", self.project, "-f", str(runtime)]

    def execute(self):
        if not hosted(os.environ):
            raise Refused("hosted isolated Linux runner required")
        if shutil.disk_usage(ROOT).free < ADMISSION_FREE:
            raise Refused("24 GiB build admission reserve required")
        endpoint = self.run("local-daemon", ["docker", "context", "inspect", "default", "--format",
                            "{{json .Endpoints.docker.Host}}"], 15).strip()
        if json.loads(endpoint) != "unix:///var/run/docker.sock":
            raise Refused("Docker daemon is not the hosted local socket")
        if any(self.resources()):
            raise Refused("project resources already exist")
        self.owned = True
        self.configure()
        self.evidence["docker_version"] = self.run("docker-version", ["docker", "version", "--format", "{{.Server.Version}}"], 30).strip()
        for service in ("server", "migrate", "yjs-collab", "web"):
            self.run("build-" + service, self.compose + ["build", service], timeout=900)
        started = time.monotonic()
        self.run("fresh-volume-start", self.compose + ["up", "-d", "--wait", "--wait-timeout", "240"], timeout=270)
        self.evidence["compose_healthy_seconds"] = self.evidence["phases"][-1]["seconds"]
        observed = {}
        entry_asset = None
        for path in PROBES:
            body_file = self.scratch / "probe-body"
            status = self.run("http-probe", ["curl", "-ksS", "--max-time", "5",
                "--retry", "8", "--retry-delay", "1", "--retry-connrefused", "--retry-max-time", "20", "--resolve",
                f"{DOMAIN}:{HTTPS_PORT}:127.0.0.1", "--max-filesize", "1048576", "-o", str(body_file), "-w", "%{http_code}",
                f"https://{DOMAIN}:{HTTPS_PORT}{path}"], 30).strip()
            if len(status) != 3 or not status.isdigit():
                raise Refused("HTTP status malformed")
            observed[path] = int(status)
            if observed[path] == 200:
                asset = validate_payload(path, body_file.read_bytes())
                if asset:
                    entry_asset = asset
        self.evidence["http_probes"] = observed
        validate_probes(observed)
        if entry_asset is None:
            raise Refused("built entry asset is absent")
        script_file = self.scratch / "entry-script"
        status = self.run("web-entry-asset", ["curl", "-ksS", "--max-time", "15", "--resolve",
            f"{DOMAIN}:{HTTPS_PORT}:127.0.0.1", "--max-filesize", "1048576", "-o", str(script_file),
            "-w", "%{http_code}", f"https://{DOMAIN}:{HTTPS_PORT}{entry_asset}"], 20).strip()
        script = script_file.read_bytes()
        if status != "200" or len(script) < 100 or script.lstrip().lower().startswith(b"<!doctype"):
            raise Refused("built entry script was not served")
        self.evidence["web_entry_asset_validated"] = True
        self.evidence["time_to_healthy_seconds"] = round(time.monotonic() - started, 3)
        idle_start = time.monotonic()
        while time.monotonic() - idle_start < 30:
            self.reserve()
            time.sleep(.25)
        ids = self.run("running-inventory", ["docker", "ps", "-q", "--filter",
                       "label=com.docker.compose.project=" + self.project], 30).split()
        if not ids:
            raise Refused("no running containers")
        stats = self.run("idle-container-stats", ["docker", "stats", "--no-stream", "--format", "{{json .}}", *ids], 30)
        self.evidence["idle_seconds"] = 30
        self.evidence["container_working_set_and_cpu"] = [json.loads(line) for line in stats.splitlines()]
        # docker top uses the Linux daemon's process table; RSS is KiB, unlike docker stats memory usage.
        rss = {}
        for container in ids:
            output = self.run("process-rss", ["docker", "top", container, "-eo", "rss"], 15)
            rows = output.splitlines()[1:]
            if not rows or any(not row.strip().isdigit() for row in rows):
                raise Refused("process RSS inventory malformed")
            rss[container] = sum(int(row.strip()) for row in rows)
        self.evidence["process_rss_kib_by_container"] = rss
        self.evidence["process_rss_kib_total"] = sum(rss.values())
        self.evidence["rss_semantics"] = "Sum of process RSS in KiB; shared pages may be counted in more than one process"
        self.evidence["status"] = "passed"

    def cleanup(self):
        try:
            if self.owned and self.compose:
                self.run("owned-cleanup", self.compose + ["down", "--volumes", "--remove-orphans", "--rmi", "local"], 90, guard=False)
                if any(self.resources()):
                    raise Refused("owned containers or volumes remain")
        finally:
            if self.scratch:
                shutil.rmtree(self.scratch)
        self.evidence["cleanup_verified"] = True
        self.evidence["final_free_gib"] = shutil.disk_usage(ROOT).free / GIB
        if shutil.disk_usage(ROOT).free < MINIMUM_FREE:
            raise Refused("mandatory disk floor breached")


def main():
    def interrupted(_signum, _frame):
        raise Refused("qualification interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    qualification = Qualification()
    try:
        qualification.execute()
    except Exception as error:
        qualification.evidence.update(status="failed", refusal=str(error) if isinstance(error, Refused) else type(error).__name__)
    finally:
        try:
            qualification.cleanup()
        except Exception as error:
            qualification.evidence.update(status="failed", cleanup_verified=False,
                                          cleanup_refusal=type(error).__name__)
        print("COMMUNITY_COLDSTART_EVIDENCE " + json.dumps(qualification.evidence, sort_keys=True), flush=True)
    return 0 if qualification.evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
