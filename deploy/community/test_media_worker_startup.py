"""Credential-free worker cold start and crash recovery, without containers or providers."""

import http.client
import json
import os
from pathlib import Path
import runpy
import socket
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/server"))
from apps.media.storage import StorageRefusedError
from apps.media.storage_worker import DirectorySource, bind, descriptor

CHECK = runpy.run_path(str(ROOT / "scripts/ci/check-community-deploy.py"))


class MediaWorkerStartupTests(unittest.TestCase):
    def test_initializer_recovers_stale_socket_and_preserves_credentials(self):
        # Keep Unix paths short on hosts with a 104-byte sockaddr_un limit.
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="media-") as temporary:
            root = Path(temporary)
            runtime, secrets = root / "socket", root / "secrets"
            runtime.mkdir()
            secrets.mkdir()
            credential = secrets / str(UUID(int=1))
            credential.write_text("synthetic credential marker")
            path = runtime / "media.sock"
            with socket.socket(socket.AF_UNIX) as stale:
                stale.bind(str(path))
            self.assertTrue(path.is_socket())
            with self.assertRaises(StorageRefusedError):
                bind(path, DirectorySource(secrets))
            code = CHECK["MEDIA_INIT_CODE"].replace("/run/kodera-media-secrets", str(secrets)).replace("/run/kodera-media", str(runtime))
            # Ownership calls are checked without requiring a privileged local test runner.
            with patch("os.chown") as chown:
                exec(code, {})
                self.assertEqual(chown.call_args_list[0].args, (str(runtime), 10001, 10001))
                self.assertEqual(chown.call_args_list[1].args, (str(secrets), 10001, 10001))
            self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(secrets.stat().st_mode), 0o700)
            self.assertFalse(path.exists())
            self.assertEqual(credential.read_text(), "synthetic credential marker")
            worker = bind(path, DirectorySource(secrets))
            worker.server_close()

    def test_empty_secrets_are_healthy_and_signing_fails_closed(self):
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="media-") as temporary:
            root = Path(temporary)
            root.chmod(0o700)
            secrets = root / "secrets"
            secrets.mkdir(mode=0o700)
            path = root / "media.sock"
            worker = bind(path, DirectorySource(secrets))
            thread = threading.Thread(target=worker.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            try:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(path.stat().st_uid, os.getuid())
                # Execute the actual Compose health probe against the real worker.
                exec(CHECK["MEDIA_HEALTH_CODE"].replace(CHECK["MEDIA_SOCKET"], str(path)), {})
                message = {
                    "operation": "upload",
                    "object": {
                        "organisationId": str(UUID(int=1)),
                        "attachmentId": str(UUID(int=2)),
                        "filename": "fixture.txt",
                        "contentType": "text/plain",
                        "sizeBytes": 1,
                        "sha256": "0" * 64,
                    },
                }
                # Ensure the 503 tests absent credentials, rather than an invalid descriptor.
                self.assertEqual(descriptor(message["object"]).organisation_id, UUID(int=1))
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.settimeout(2)
                    connection.connect(str(path))
                    body = json.dumps(message).encode()
                    connection.sendall(b"POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: "
                                       + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
                    response = http.client.HTTPResponse(connection)
                    response.begin()
                    self.assertEqual(response.status, 503)
                    self.assertEqual(json.loads(response.read()), {"error": "storage unavailable"})
                exec(CHECK["MEDIA_HEALTH_CODE"].replace(CHECK["MEDIA_SOCKET"], str(path)), {})
                self.assertEqual(list(secrets.iterdir()), [])
            finally:
                worker.shutdown()
                worker.server_close()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
