#!/usr/bin/env python3
"""Exercise pinned Caddy and real Gunicorn; --gunicorn needs no Docker, --fast skips Matrix.

The synthetic upstream isolates HTTP ingress and the production body guard. Focused server
acceptance separately exercises authenticated Django endpoints with real PostgreSQL.
"""

import argparse
import contextlib
import http.client
import os
import pathlib
import re
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def static_checks(root):
    for name in ("Caddyfile", "Caddyfile.split"):
        source = (root / "deploy/community" / name).read_text()
        for timeout in ("read_header 10s", "read_body 300s", "idle 120s"):
            require(timeout in source, f"{name}: missing {timeout}")
        require("{http.request.body}" not in source and "request_buffers" not in source,
                f"{name}: eager body buffering")
        require("max_size 1MiB" in source, f"{name}: missing API size limit")
        require("reverse_proxy api-admission:8080" in source,
                f"{name}: missing api-admission upstream")
        require("reverse_proxy server:8000" not in source,
                f"{name}: bypasses api-admission directly to server:8000")
    admission = (root / "apps/server/config/edge_admission.py").read_text()
    for setting in (
        "BODY_READ_SECONDS: Final[float] = 10.0",
        "BODY_MAX_BYTES: Final[int] = 1_048_576",
        "STREAM_READER_LIMIT: Final[int] = 16_384",
        "DEFAULT_MAX_CONNECTIONS: Final[int] = 256",
        "DEFAULT_GLOBAL_BODY_SLOTS: Final[int] = 32",
        "DEFAULT_MAX_GLOBAL_BODY_BYTES: Final[int] = 33_554_432",
        "DEFAULT_PER_IP_BODY_SLOTS: Final[int] = 8",
    ):
        require(setting in admission, f"edge_admission: missing {setting}")
    source = (root / "apps/server/config/gunicorn.py").read_text()
    for option in ('worker_class = "gthread"', 'workers = 2', 'threads = 4',
                   'worker_connections = 32'):
        require(option in source, f"Gunicorn: missing {option}")


def request(port, method, route, body=None, headers=None, **kwargs):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        try:
            conn.request(method, route, body=body, headers=headers or {}, **kwargs)
        except (BrokenPipeError, ConnectionResetError):
            if conn.sock is None:
                raise
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


@contextlib.contextmanager
def gunicorn_backend(root, folder):
    # A real production gthread worker, with only its downstream view replaced by an echo.
    source = '''
from config.body_guard import BodyGuard

def backend(environ, start_response):
    if environ["REQUEST_METHOD"] == "POST":
        with open(SEEN, "a") as seen:
            seen.write(environ["PATH_INFO"] + "\\n")
        stream = environ["wsgi.input"]
        while stream.read(65536):
            pass
    headers = [("Content-Length", "2")]
    status = "200 OK"
    if environ["PATH_INFO"].startswith(("/_matrix/", "/_synapse/")):
        headers.extend([("Access-Control-Allow-Origin", "*"), ("Vary", "Accept")])
        if environ.get("HTTP_X_ORIGINAL_URI") == "/_matrix/client/denied":
            status = "403 Forbidden"
    start_response(status, headers)
    return [b"OK"]

guarded = BodyGuard(backend)
def application(environ, start_response):
    handler = backend if environ["PATH_INFO"].startswith("/_matrix/") else guarded
    return handler(environ, start_response)
'''
    folder = pathlib.Path(folder)
    seen = folder / "seen"
    seen.touch()
    (folder / "ingress_backend.py").write_text("SEEN = " + repr(str(seen)) + "\n" + source)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = root / "apps/server"
    env = {"PATH": os.environ.get("PATH", ""), "PYTHONPATH": str(folder) + os.pathsep + str(server),
           "PYTHONDONTWRITEBYTECODE": "1", "DJANGO_SECRET_KEY": "synthetic-ingress-" + "a1b2c3" * 10,
           "DJANGO_ALLOWED_HOSTS": "localhost", "DATABASE_URL": "postgresql://synthetic:synthetic@localhost/core"}
    log = folder / "gunicorn.log"
    with log.open("w+") as output:
        process = subprocess.Popen(
            [sys.executable, "-m", "gunicorn", "-c", "config/gunicorn.py",
             "--bind", f"0.0.0.0:{port}", "--worker-tmp-dir", str(folder), "ingress_backend:application"],
            cwd=server, env=env, stdout=output, stderr=output,
        )
        try:
            for _ in range(100):
                require(process.poll() is None, "Gunicorn failed: " + log.read_text())
                try:
                    if request(port, "GET", "/health/live") == (200, b"OK"):
                        break
                except (OSError, http.client.HTTPException):
                    pass
                time.sleep(0.05)
            else:
                raise SystemExit("Gunicorn did not become ready: " + log.read_text())
            yield port, seen
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        require("Traceback" not in log.read_text(), "Gunicorn traceback: " + log.read_text())


def slow_body_check(port, *, expect_close=True):
    partial = []
    started = time.monotonic()
    try:
        for _ in range(16):
            sock = socket.create_connection(("127.0.0.1", port), timeout=3)
            sock.sendall(b"POST /api/partial HTTP/1.1\r\nHost: localhost\r\n"
                         b"Content-Length: 1048575\r\n\r\n1234")
            partial.append(sock)
        # Probe repeatedly while admitted reads are blocked, rather than only racing admission.
        time.sleep(0.3)
        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda _: request(port, "GET", "/health/live"), range(24)))
        require(all(result == (200, b"OK") for result in results), "Slow bodies starved health")
        if not expect_close:
            # Caddy can finish receiving a client's body before forwarding the upstream's
            # refusal. Direct Gunicorn checks above verify the 408/503 and close semantics.
            return
        statuses = []
        for sock in partial:
            sock.settimeout(12)
            response = http.client.HTTPResponse(sock)
            response.begin()
            statuses.append(response.status)
            if expect_close:
                require(response.getheader("Connection") == "close", "Refused body connection reused")
            if response.status == 503:
                require(response.getheader("Retry-After") == "1", "Busy body lacks Retry-After")
            response.read()
        require(1 <= statuses.count(408) <= 4 and statuses.count(503) >= 12,
                f"Body reader capacity/deadline failed: {statuses}")
        require(time.monotonic() - started < 12, "Body deadline exceeded ten seconds plus scheduling margin")
        require(all(status in {408, 503} for status in statuses), f"Unexpected body status: {statuses}")
    finally:
        for sock in partial:
            sock.close()


@contextlib.contextmanager
def edge_admission_frontend(root, folder, backend_port):
    folder = pathlib.Path(folder)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = root / "apps/server"
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": str(server),
        "PYTHONDONTWRITEBYTECODE": "1",
        "KODERA_TRUSTED_EDGE_ADDRESSES": "127.0.0.1/32,172.17.0.0/24,192.168.65.0/24",
    }
    log = folder / "edge-admission.log"
    with log.open("w+") as output:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "config.edge_admission",
                "--bind",
                f"0.0.0.0:{port}",
                "--upstream",
                f"127.0.0.1:{backend_port}",
                "--require-trusted-edge",
            ],
            cwd=server,
            env=env,
            stdout=output,
            stderr=output,
        )
        try:
            for _ in range(100):
                require(process.poll() is None, "edge_admission failed: " + log.read_text())
                try:
                    status, _ = request(port, "GET", "/_admission/live")
                    if status == 200:
                        break
                except (OSError, http.client.HTTPException):
                    pass
                time.sleep(0.05)
            else:
                raise SystemExit("edge_admission did not become ready: " + log.read_text())
            yield port
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        require("Traceback" not in log.read_text(), "edge_admission traceback: " + log.read_text())


def admission_multi_client_check(admission_port, seen):
    def open_trickle(client_ip_and_route):
        client_ip, route = client_ip_and_route
        sock = socket.create_connection(("127.0.0.1", admission_port), timeout=5)
        sock.sendall(
            f"POST {route} HTTP/1.1\r\n"
            f"Host: localhost\r\n"
            f"X-Forwarded-For: {client_ip}\r\n"
            f"Content-Length: 1048575\r\n\r\n1234".encode("ascii")
        )
        return client_ip, sock

    targets = (
        [("198.51.100.10", "/api/trickle-a")] * 12
        + [("198.51.100.11", "/api/trickle-b")] * 12
    )
    started = time.monotonic()
    opened = []
    try:
        with ThreadPoolExecutor(24) as pool:
            opened = list(pool.map(open_trickle, targets))
        time.sleep(0.35)

        # While 16 admitted slow-trickle streams (8 per attacker IP) stall mid-body, verify:
        # 1) 24 concurrent health reads succeed without worker starvation.
        # 2) A 24-way shared-NAT burst of fast buffered writes from a third IP succeeds 100%.
        with ThreadPoolExecutor(16) as pool:
            health_futures = [
                pool.submit(
                    request,
                    admission_port,
                    "GET",
                    "/health/live",
                    headers={"X-Forwarded-For": "203.0.113.5"},
                )
                for _ in range(24)
            ]
            burst_futures = [
                pool.submit(
                    request,
                    admission_port,
                    "POST",
                    "/api/shared-nat-burst",
                    b"x" * 4096,
                    headers={"X-Forwarded-For": "203.0.113.99"},
                )
                for _ in range(24)
            ]
            health_results = [f.result() for f in health_futures]
            burst_results = [f.result() for f in burst_futures]

        require(
            all(res == (200, b"OK") for res in health_results),
            f"Slow tricklers starved health reads through api-admission: {health_results}",
        )
        require(
            all(res == (200, b"OK") for res in burst_results),
            f"Shared-NAT fast write burst failed under concurrent slow tricklers: {burst_results}",
        )

        # Verify exact 1 MiB, > 1 MiB, and chunked framing through api-admission.
        clean_hdr = {"X-Forwarded-For": "203.0.113.77"}
        require(
            request(admission_port, "POST", "/api/admission-exact", b"x" * 1048576, headers=clean_hdr)[0] == 200,
            "Exact 1 MiB API write refused by api-admission",
        )
        require(
            request(admission_port, "POST", "/api/admission-oversized", b"x" * 1048577, headers=clean_hdr)[0] == 413,
            "Oversized API write admitted by api-admission",
        )
        require(
            request(
                admission_port,
                "POST",
                "/api/admission-chunked",
                iter([b"abcd", b"efgh"]),
                headers=clean_hdr,
                encode_chunked=True,
            )[0] == 200,
            "Chunked API write refused by api-admission",
        )
        require(
            request(
                admission_port,
                "POST",
                "/api/admission-chunked-oversized",
                iter([b"x" * 1048577]),
                headers=clean_hdr,
                encode_chunked=True,
            )[0] == 413,
            "Oversized chunked API write admitted by api-admission",
        )

        by_ip = {"198.51.100.10": [], "198.51.100.11": []}
        for client_ip, sock in opened:
            sock.settimeout(12)
            response = http.client.HTTPResponse(sock)
            response.begin()
            require(
                response.getheader("Connection") == "close",
                "Refused slow-trickle socket was not closed",
            )
            if response.status in {429, 503}:
                require(
                    response.getheader("Retry-After") is not None,
                    f"Status {response.status} lacked Retry-After",
                )
            response.read()
            by_ip[client_ip].append(response.status)

        for client_ip, statuses in by_ip.items():
            require(
                statuses.count(408) == 8 and statuses.count(429) == 4,
                f"Expected 8 deadline 408s and 4 per-IP 429s for {client_ip}, got {statuses}",
            )
        require(
            time.monotonic() - started < 13,
            "Edge admission body deadline exceeded 10s plus scheduling margin",
        )

        # Prove zero incomplete or oversized bodies ever opened a Gunicorn worker stream.
        reached = seen.read_text().splitlines()
        for forbidden in (
            "/api/trickle-a",
            "/api/trickle-b",
            "/api/admission-oversized",
            "/api/admission-chunked-oversized",
        ):
            require(
                forbidden not in reached,
                f"Unbuffered or oversized write {forbidden} leaked to Gunicorn backend",
            )
        require(
            reached.count("/api/shared-nat-burst") == 24,
            "Shared-NAT burst writes did not all reach Gunicorn backend",
        )
    finally:
        for _, sock in opened:
            sock.close()


PRIMARY_ORIGIN = "https://community.example.org"
APP_ORIGIN = "https://app.example.org"


def split_matrix_sites(root):
    # Exercise the checked-in Matrix handle twice on the smoke container's existing port.
    source = (root / "deploy/community/Caddyfile.split").read_text()
    site = re.search(r"(?ms)^matrix\.\{\$KODERA_DOMAIN\} \{.*?^\}", source).group()
    sites = []
    for host, variable in (("primary.test", "SMOKE_UNSET_ORIGIN"), ("dual.test", "KODERA_APP_ORIGIN")):
        fixture = site.replace("matrix.{$KODERA_DOMAIN} {", f"http://{host}:8080 {{")
        fixture = fixture.replace("{$KODERA_DOMAIN}", PRIMARY_ORIGIN.removeprefix("https://"))
        sites.append(fixture.replace("KODERA_APP_ORIGIN", variable))
    return "\n".join(sites)


def matrix_cors_check(port):
    for host in ("primary.test", "dual.test"):
        for route, status in (("/_matrix/client/versions", 200), ("/_matrix/client/denied", 403)):
            for method in ("GET", "OPTIONS"):
                for origins in ((), (PRIMARY_ORIGIN,), (APP_ORIGIN,), (APP_ORIGIN + ".invalid",),
                                ("null",), (PRIMARY_ORIGIN, APP_ORIGIN)):
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    try:
                        conn.putrequest(method, route, skip_host=True)
                        conn.putheader("Host", host)
                        for origin in origins:
                            conn.putheader("Origin", origin)
                        conn.endheaders()
                        response = conn.getresponse()
                        response.read()
                        require(response.status == status, f"Matrix {method} {route} returned {response.status}")
                        grants = response.headers.get_all("Access-Control-Allow-Origin") or []
                        allowed = origins == (PRIMARY_ORIGIN,) or (host == "dual.test" and origins == (APP_ORIGIN,))
                        require(grants == (list(origins) if allowed else []), f"Unexpected Matrix CORS grant on {host}: {grants}")
                        varies = {item.strip().lower() for line in response.headers.get_all("Vary", []) for item in line.split(",")}
                        require({"origin", "accept"} <= varies, "Matrix CORS must vary by Origin and retain upstream Vary")
                    finally:
                        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--static", action="store_true")
    parser.add_argument("--gunicorn", action="store_true")
    parser.add_argument("--fast", action="store_true")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    static_checks(root)
    if args.static:
        print("PASS: streaming ingress, api-admission buffering, 1 MiB API limit, 300s Matrix window, bounded gthread")
        return
    with tempfile.TemporaryDirectory(prefix="kodera-ingress-smoke-") as tmp:
        with gunicorn_backend(root, tmp) as (backend_port, seen):
            slow_body_check(backend_port)
            with edge_admission_frontend(root, tmp, backend_port) as admission_port:
                admission_multi_client_check(admission_port, seen)
                if args.gunicorn:
                    print(
                        "PASS: real api-admission + 2 x 4 Gunicorn isolates multi-client slow tricklers "
                        "(zero upstream leak), preserves 24-way shared-NAT bursts and health reads"
                    )
                    return
                compose = (root / "deploy/community/docker-compose.yml").read_text()
                image = re.search(r"(?m)^    image: (caddy:\S+)$", compose).group(1)
                name = "kodera-ingress-smoke-" + uuid.uuid4().hex[:8]
                try:
                    config = (root / "deploy/community/Caddyfile").read_text()
                    config = config.replace("email {$KODERA_ACME_EMAIL}", "auto_https off\n\tadmin off")
                    config = config.replace("{$KODERA_DOMAIN} {", ":8080 {")
                    config += "\n" + split_matrix_sites(root) + "\n"
                    config = config.replace("api-admission:8080", f"host.docker.internal:{admission_port}")
                    config = config.replace("synapse:8008", f"host.docker.internal:{backend_port}")
                    path = pathlib.Path(tmp) / "Caddyfile"
                    path.write_text(config)
                    subprocess.run([
                        "docker", "run", "--pull=never", "-d", "--rm", "--name", name,
                        "-e", f"KODERA_APP_ORIGIN={APP_ORIGIN}",
                        "--add-host=host.docker.internal:host-gateway", "-p", "127.0.0.1::8080",
                        "-v", f"{path}:/etc/caddy/Caddyfile:ro", image,
                    ], check=True, stdout=subprocess.DEVNULL)
                    port = int(subprocess.check_output(["docker", "port", name, "8080/tcp"])
                               .decode().strip().rsplit(":", 1)[-1])
                    for _ in range(50):
                        try:
                            if request(port, "GET", "/health/live") == (200, b"OK"):
                                break
                        except (OSError, http.client.HTTPException):
                            pass
                        time.sleep(0.1)
                    else:
                        raise SystemExit("Caddy not ready")
                    require(request(port, "GET", "/agent")[0] == 404, "Agent route exposed")
                    matrix_cors_check(port)
                    slow_body_check(port, expect_close=False)
                    for _ in range(40):
                        if request(port, "POST", "/api/drain", b"ok")[0] == 200:
                            break
                        time.sleep(0.05)
                    else:
                        raise SystemExit("Slow-body reader slots did not drain after client disconnect")
                    require(request(port, "POST", "/api/exact", b"x" * 1048576)[0] == 200, "Exact API body refused")
                    require(request(port, "POST", "/api/oversized", b"x" * 1048577)[0] == 413, "Oversize API body admitted")
                    require("/api/oversized" not in seen.read_text().splitlines(), "Oversize API body reached backend")
                    require(request(port, "POST", "/api/chunked", iter([b"1234", b"5678"]), encode_chunked=True)[0] == 200, "Chunked API refused")
                    require(request(port, "POST", "/api/chunked-large", iter([b"x" * 1048577]), encode_chunked=True)[0] == 413, "Oversize chunked API admitted")
                    if not args.fast:
                        with socket.create_connection(("127.0.0.1", port), timeout=30) as sock:
                            sock.sendall(b"POST /_matrix/media/v3/upload HTTP/1.1\r\nHost: localhost\r\n"
                                         b"Content-Length: 26214400\r\nConnection: close\r\n\r\n")
                            start = time.monotonic()
                            for _ in range(25):
                                sock.sendall(b"x" * 1048576)
                                time.sleep(0.45)
                            response = http.client.HTTPResponse(sock)
                            response.begin()
                            require(response.status == 200, "Slow Matrix upload refused")
                            response.read()
                            require(time.monotonic() - start > 10, "Matrix window not exercised")
                    print("PASS: pinned Caddy + api-admission + real Gunicorn, slow-body capacity, API limits and chunked streaming")
                finally:
                    subprocess.run(["docker", "rm", "-f", name], check=False,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
