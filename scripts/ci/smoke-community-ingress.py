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
    source = (root / "apps/server/config/gunicorn.py").read_text()
    for option in ('worker_class = "gthread"', 'workers = 2', 'threads = 4',
                   'worker_connections = 32'):
        require(option in source, f"Gunicorn: missing {option}")


def request(port, method, route, body=None, **kwargs):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        conn.request(method, route, body=body, **kwargs)
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
    start_response("200 OK", [("Content-Length", "2")])
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--static", action="store_true")
    parser.add_argument("--gunicorn", action="store_true")
    parser.add_argument("--fast", action="store_true")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    static_checks(root)
    if args.static:
        print("PASS: streaming ingress, 1 MiB API limit, 300s Matrix window, bounded gthread")
        return
    with tempfile.TemporaryDirectory(prefix="kodera-ingress-smoke-") as tmp:
        with gunicorn_backend(root, tmp) as (backend_port, seen):
            slow_body_check(backend_port)
            if args.gunicorn:
                print("PASS: real 2 x 4 Gunicorn keeps health available under 16 slow bodies; 408/503 close")
                return
            compose = (root / "deploy/community/docker-compose.yml").read_text()
            image = re.search(r"(?m)^    image: (caddy:\S+)$", compose).group(1)
            name = "kodera-ingress-smoke-" + uuid.uuid4().hex[:8]
            try:
                config = (root / "deploy/community/Caddyfile").read_text()
                config = config.replace("email {$KODERA_ACME_EMAIL}", "auto_https off\n\tadmin off")
                config = config.replace("{$KODERA_DOMAIN} {", ":8080 {")
                for upstream in ["server:8000", "synapse:8008"]:
                    config = config.replace(upstream, f"host.docker.internal:{backend_port}")
                path = pathlib.Path(tmp) / "Caddyfile"
                path.write_text(config)
                subprocess.run([
                    "docker", "run", "--pull=never", "-d", "--rm", "--name", name,
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
                print("PASS: pinned Caddy with real Gunicorn, slow-body capacity, API limits and chunked streaming")
            finally:
                subprocess.run(["docker", "rm", "-f", name], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
