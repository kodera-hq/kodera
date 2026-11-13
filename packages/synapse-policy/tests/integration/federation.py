"""Disposable two-homeserver Matrix protocol proof; no live hosts or client-build claims.

Requires a cached pinned image, Docker, and Python with cryptography. Acquires one machine-wide
heavy slot, uses an internal-only network, and deletes only its own containers/network/data.
Synthetic TLS verification exceptions exist only inside this isolated test network.
"""

import datetime
import json
import os
import pathlib
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = (
    pathlib.Path(__file__).resolve().parents[4]
    if len(pathlib.Path(__file__).resolve().parents) > 4
    else pathlib.Path("/proof")
)
sys.path.insert(
    0,
    "/proof"
    if sys.argv[1:] in (["--scenario"], ["--bootstrap-agent"])
    else str(ROOT / "apps/server"),
)
IMAGE = "matrixdotorg/synapse:v1.163.0@sha256:e98ab72138d90fa8b8876c6421fe78a9fdb181c0d7cc690ad740e5173e0c65e6"
HOME, PEER = "home.example.org", "partner.example.org"
AGENT, ALICE, BOB = f"@kodera-agent:{HOME}", f"@alice:{HOME}", f"@bob:{PEER}"
POLICY, MODE = "io.kodera.room.policy", "io.kodera.room.federation"
BASES = {"home": "http://127.0.0.1:8008", "peer": "http://partner.example.org:8008"}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def docker(*args):
    return subprocess.check_output(
        ["docker", *args], stderr=subprocess.STDOUT, text=True, timeout=60
    ).strip()


def call(port, method, path, token=None, body=None):
    request = urllib.request.Request(
        BASES[port] + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with OPENER.open(request, timeout=20) as result:
            raw = result.read()
            return result.status, (
                {} if path == "/health" else json.loads(raw or b"{}")
            )
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def expect(label, answer, status):
    if answer[0] != status:
        raise AssertionError(f"{label}: expected {status}, got {answer}")
    print(f"PASS {label}", flush=True)
    return answer[1]


def register(port, username, password=None):
    # This standard client flow is enabled only on the disposable internal Docker network.
    # The trusted agent is promoted offline afterward; no shared registration secret is needed.
    result = expect(
        "synthetic account",
        call(
            port,
            "POST",
            "/_matrix/client/v3/register",
            body={
                "username": username,
                "password": password or secrets.token_urlsafe(24),
                "auth": {"type": "m.login.dummy"},
            },
        ),
        200,
    )
    return result["access_token"]


def wait_message(port, token, room, event_id):
    path = (
        "/_matrix/client/v3/rooms/"
        + urllib.parse.quote(room, safe="")
        + "/messages?dir=b&limit=100"
    )
    for _ in range(40):
        status, body = call(port, "GET", path, token)
        if status == 200 and any(
            event["event_id"] == event_id for event in body.get("chunk", [])
        ):
            return
        time.sleep(0.5)
    raise AssertionError("federated event did not arrive within 20 seconds")


def scenario(homeport, peerport, agent_password):
    from tenant_agent.channels import Channels, parse
    from tenant_agent.engines import LiveKit
    from tenant_agent.state import MemberSet, State
    from tenant_agent.synapse import Synapse

    agent = expect(
        "synthetic administrator login",
        call(
            homeport,
            "POST",
            "/_matrix/client/v3/login",
            body={
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": AGENT},
                "password": agent_password,
            },
        ),
        200,
    )["access_token"]
    alice = register(homeport, "alice")
    bob = register(peerport, "bob")
    client = Synapse(BASES[homeport], agent, HOME)
    entries = []
    state = State(pathlib.Path("/data/proof-state"))
    state.keep(MemberSet(1, frozenset({"alice"}), frozenset(), frozenset()))
    engine = Channels(
        client,
        LiveKit("http://127.0.0.1:1", "unused", "synthetic-unused"),
        state,
        partner_channels=(("22222222-2222-4222-8222-222222222222", (PEER,)),),
    )

    def desired():
        parsed = parse({"revision": 1, "all_members": ["alice"], "channels": entries})
        assert parsed is not None
        return parsed

    def create(channel, partner):
        entries.append(
            {
                "channel_id": channel,
                "kind": "text",
                "name": "protocol proof",
                "topic": "synthetic",
                "access_etag": '"a1"',
                "archived": False,
                "audience": "all",
                "members": [],
                "denied": [],
                "read_only": False,
                "listen_only": False,
                "exempt": [],
                "notices": [],
            }
        )
        result = engine.apply(desired(), full=True)
        assert not result.failed and not result.unavailable, (
            "actual channel producer did not converge"
        )
        room = client.resolve(channel)
        assert room is not None
        client.require_federation_mode(room, (PEER,) if partner else ())
        print("PASS actual channel producer creates and joins local member", flush=True)
        content = client.state(room, POLICY)
        return room, content

    internal, _ = create("11111111-1111-4111-8111-111111111111", False)
    expect(
        "internal agent remote invite refused",
        call(
            homeport,
            "POST",
            f"/_matrix/client/v3/rooms/{internal}/invite",
            agent,
            {"user_id": BOB},
        ),
        403,
    )
    expect(
        "internal policy cannot upgrade immutable mode",
        call(
            homeport,
            "PUT",
            f"/_matrix/client/v3/rooms/{internal}/state/{POLICY}/",
            agent,
            {"allow_federated_invites": True},
        ),
        403,
    )
    room, content = create("22222222-2222-4222-8222-222222222222", True)
    expect(
        "joined member invites approved partner",
        call(
            homeport,
            "POST",
            f"/_matrix/client/v3/rooms/{room}/invite",
            alice,
            {"user_id": BOB},
        ),
        200,
    )
    expect(
        "remote partner joins through real federation",
        call(
            peerport,
            "POST",
            "/_matrix/client/v3/join/"
            + urllib.parse.quote(room, safe="")
            + "?server_name="
            + HOME,
            bob,
            {},
        ),
        200,
    )
    reconciled = engine.apply(desired(), full=True)
    assert not reconciled.failed and client.members(room).get(BOB) == "join", (
        "Core convergence removed an approved partner"
    )
    print("PASS actual channel convergence retains approved partner", flush=True)
    for port, token, targetport, targettoken, body in [
        (peerport, bob, homeport, alice, "partner-to-home"),
        (homeport, alice, peerport, bob, "home-to-partner"),
    ]:
        sent = expect(
            body,
            call(
                port,
                "PUT",
                f"/_matrix/client/v3/rooms/{room}/send/m.room.message/{body}",
                token,
                {"msgtype": "m.text", "body": body},
            ),
            200,
        )
        wait_message(targetport, targettoken, room, sent["event_id"])
        print(f"PASS real federated delivery {body}", flush=True)
    expect(
        "member policy escalation refused",
        call(
            homeport,
            "PUT",
            f"/_matrix/client/v3/rooms/{room}/state/{POLICY}/",
            alice,
            content,
        ),
        403,
    )
    expect(
        "agent cannot widen room ACL",
        call(
            homeport,
            "PUT",
            f"/_matrix/client/v3/rooms/{room}/state/m.room.server_acl/",
            agent,
            {"allow": ["*"], "deny": [], "allow_ip_literals": False},
        ),
        403,
    )
    expect(
        "partner ciphertext refused by home ingress",
        call(
            peerport,
            "PUT",
            f"/_matrix/client/v3/rooms/{room}/send/m.room.encrypted/encrypted",
            bob,
            {"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "synthetic"},
        ),
        200,
    )
    delivered = expect(
        "plaintext after rejected ciphertext",
        call(
            peerport,
            "PUT",
            f"/_matrix/client/v3/rooms/{room}/send/m.room.message/after-encrypted",
            bob,
            {"msgtype": "m.text", "body": "after-encrypted"},
        ),
        200,
    )
    wait_message(homeport, alice, room, delivered["event_id"])
    messages = expect(
        "home timeline readable",
        call(
            homeport,
            "GET",
            f"/_matrix/client/v3/rooms/{room}/messages?dir=b&limit=100",
            alice,
        ),
        200,
    )
    assert all(
        event["type"] != "m.room.encrypted" for event in messages.get("chunk", [])
    ), "ciphertext crossed ingress policy"
    expect(
        "partner can leave for cleanup",
        call(peerport, "POST", f"/_matrix/client/v3/rooms/{room}/leave", bob, {}),
        200,
    )
    for _ in range(40):
        if client.members(room).get(BOB) not in {"join", "invite"}:
            break
        time.sleep(0.25)
    else:
        raise AssertionError("remote departure did not reach home")
    expect(
        "member reinvites approved partner",
        call(
            homeport,
            "POST",
            f"/_matrix/client/v3/rooms/{room}/invite",
            alice,
            {"user_id": BOB},
        ),
        200,
    )
    expect(
        "approved partner rejoins",
        call(
            peerport,
            "POST",
            "/_matrix/client/v3/join/"
            + urllib.parse.quote(room, safe="")
            + "?server_name="
            + HOME,
            bob,
            {},
        ),
        200,
    )
    entries[-1] = {**entries[-1], "audience": "listed", "members": ["alice"]}
    restricted = engine.apply(desired(), full=True)
    assert restricted.failed == [entries[-1]["channel_id"]] and client.members(
        room
    ).get(BOB) not in {"join", "invite"}, (
        "private Core audience retained remote membership"
    )
    print(
        "PASS actual Core restriction removes foreign membership and holds incompatible room",
        flush=True,
    )
    print(
        "PASS two-homeserver federation proof (protocol only; no native client builds tested)",
        flush=True,
    )


def wait_healthy(container):
    for _ in range(90):
        if docker("inspect", "--format", "{{.State.Running}}", container) != "true":
            raise RuntimeError("disposable Synapse exited during startup")
        try:
            docker(
                "exec",
                container,
                "python",
                "-c",
                'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8008/health", timeout=2).read()',
            )
            return
        except subprocess.CalledProcessError:
            pass
        time.sleep(1)
    raise RuntimeError("disposable Synapse did not become healthy")


def promote_fixture_agent(database):
    # Only called after the disposable homeserver has stopped. Preserve every other cell.
    database.chmod(0o600)
    with sqlite3.connect(database, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        before = [
            dict(row) for row in connection.execute("SELECT * FROM users ORDER BY name")
        ]
        matches = [row for row in before if row["name"] == AGENT]
        if len(matches) != 1 or matches[0]["admin"] != 0:
            raise RuntimeError("refused: expected exactly one ordinary synthetic agent")
        changed = connection.execute(
            "UPDATE users SET admin = 1 WHERE name = ? AND admin = 0", (AGENT,)
        )
        after = [
            dict(row) for row in connection.execute("SELECT * FROM users ORDER BY name")
        ]
        expected = [
            {**row, "admin": 1} if row["name"] == AGENT else row for row in before
        ]
        if changed.rowcount != 1 or connection.total_changes != 1 or after != expected:
            raise RuntimeError(
                "refused: fixture promotion changed unexpected account data"
            )


def main():
    if shutil.disk_usage(ROOT).free < 20 * 1024**3:
        raise SystemExit("refused: less than 20 GiB free")
    lock = None
    for number in (1, 2):
        candidate = pathlib.Path(f"/tmp/kodera-heavy/slot-{number}.heavy")
        try:
            candidate.mkdir(parents=True)
        except FileExistsError:
            continue
        lock = candidate
        (lock / "owner").write_text(f"partner-federation-proof pid {os.getpid()}\n")
        break
    if lock is None:
        raise SystemExit("refused: both machine-wide heavy slots occupied")
    prefix = f"kodera-federation-{os.getpid()}"
    network = prefix + "-net"
    running = []
    made_network = False
    previous_umask = os.umask(0o077)
    try:
        docker("image", "inspect", IMAGE)  # no implicit image pulls
        import jwt
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        if jwt.__version__ != "2.15.1":
            raise RuntimeError(
                "use the server locked PyJWT dependency for the provisioning client"
            )
        jwt_source = pathlib.Path(jwt.__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix="kodera-federation-") as temp:
            folder = pathlib.Path(temp)
            docker("network", "create", "--internal", network)
            made_network = True
            if (
                docker("network", "inspect", "--format", "{{.Internal}}", network)
                != "true"
            ):
                raise RuntimeError(
                    "refused: fixture registration requires an internal network"
                )
            for index, server in enumerate((HOME, PEER)):
                data = folder / str(index)
                data.mkdir(mode=0o700)
                key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
                name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, server)])
                now = datetime.datetime.now(datetime.UTC)
                cert = (
                    x509.CertificateBuilder()
                    .subject_name(name)
                    .issuer_name(name)
                    .public_key(key.public_key())
                    .serial_number(x509.random_serial_number())
                    .not_valid_before(now - datetime.timedelta(minutes=1))
                    .not_valid_after(now + datetime.timedelta(days=1))
                    .add_extension(
                        x509.SubjectAlternativeName([x509.DNSName(server)]),
                        critical=False,
                    )
                    .sign(key, hashes.SHA256())
                )
                (data / "tls.key").write_bytes(
                    key.private_bytes(
                        serialization.Encoding.PEM,
                        serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption(),
                    )
                )
                (data / "tls.crt").write_bytes(
                    cert.public_bytes(serialization.Encoding.PEM)
                )
                config = {
                    "server_name": server,
                    "public_baseurl": f"https://{server}/",
                    "serve_server_wellknown": True,
                    "report_stats": False,
                    "pid_file": "/data/homeserver.pid",
                    "media_store_path": "/data/media_store",
                    "database": {
                        "name": "sqlite3",
                        "args": {"database": "/data/homeserver.db"},
                    },
                    "signing_key_path": "/data/signing.key",
                    # Fixture-only registration: no published ports, an internal network,
                    # disposable ordinary users, and no shared registration secret.
                    "enable_registration": True,
                    "enable_registration_without_verification": True,
                    "listeners": [
                        {
                            "port": 8008,
                            "type": "http",
                            "tls": False,
                            "resources": [{"names": ["client"], "compress": False}],
                        },
                        {
                            "port": 443,
                            "type": "http",
                            "tls": True,
                            "resources": [
                                {"names": ["client", "federation"], "compress": False}
                            ],
                        },
                    ],
                    "tls_certificate_path": "/data/tls.crt",
                    "tls_private_key_path": "/data/tls.key",
                    "federation_verify_certificates": False,
                    "ip_range_whitelist": [
                        "10.0.0.0/8",
                        "172.16.0.0/12",
                        "192.168.0.0/16",
                    ],
                    "trusted_key_servers": [],
                    "suppress_key_server_warning": True,
                    "federation_domain_whitelist": [PEER if index == 0 else HOME],
                    "rc_message": {"per_second": 100, "burst_count": 1000},
                    "rc_login": {
                        "address": {"per_second": 100, "burst_count": 1000},
                        "account": {"per_second": 100, "burst_count": 1000},
                    },
                }
                if index == 0 and os.environ.get("WITHOUT_MODULE") != "1":
                    config["modules"] = [
                        {
                            "module": "kodera_synapse_policy.KoderaPolicy",
                            "config": {
                                "agent_user_id": AGENT,
                                "federation_domain_allowlist": [PEER],
                            },
                        }
                    ]
                (data / "homeserver.yaml").write_text(json.dumps(config))
                if data.stat().st_mode & 0o777 != 0o700 or any(
                    path.stat().st_mode & 0o777 != 0o600
                    for path in (
                        data / "tls.key",
                        data / "tls.crt",
                        data / "homeserver.yaml",
                    )
                ):
                    raise RuntimeError(
                        "refused: fixture inputs require private file modes"
                    )
                name = prefix + f"-{index}"
                docker(
                    "run",
                    "--pull",
                    "never",
                    "-d",
                    "--name",
                    name,
                    "--network",
                    network,
                    "--network-alias",
                    server,
                    "-e",
                    f"UID={os.getuid()}",
                    "-e",
                    f"GID={os.getgid()}",
                    "-e",
                    "PYTHONPATH=/modules",
                    "-v",
                    f"{data}:/data",
                    "-v",
                    f"{ROOT / 'packages/synapse-policy/src'}:/modules:ro",
                    "-v",
                    f"{ROOT / 'apps/server/tenant_agent'}:/proof/tenant_agent:ro",
                    "-v",
                    f"{jwt_source}:/proof/jwt:ro",
                    "-v",
                    f"{pathlib.Path(__file__).resolve()}:/proof/federation.py:ro",
                    IMAGE,
                )
                running.append(name)
                if json.loads(
                    docker(
                        "inspect", "--format", "{{json .HostConfig.PortBindings}}", name
                    )
                ) not in (None, {}):
                    raise RuntimeError(
                        "refused: fixture registration cannot publish host ports"
                    )
            print("Started disposable homeserver containers", flush=True)
            for container in running:
                wait_healthy(container)
            agent_password = secrets.token_urlsafe(24)
            subprocess.run(
                [
                    "docker",
                    "exec",
                    "-i",
                    running[0],
                    "python",
                    "/proof/federation.py",
                    "--bootstrap-agent",
                ],
                input=json.dumps(agent_password),
                text=True,
                check=True,
                timeout=30,
            )
            docker("stop", "--time", "10", running[0])
            if (
                docker("inspect", "--format", "{{.State.Running}}", running[0])
                != "false"
            ):
                raise RuntimeError("refused: fixture database owner is still running")
            promote_fixture_agent(folder / "0" / "homeserver.db")
            docker("start", running[0])
            wait_healthy(running[0])
            subprocess.run(
                [
                    "docker",
                    "exec",
                    "-i",
                    running[0],
                    "python",
                    "-u",
                    "/proof/federation.py",
                    "--scenario",
                ],
                input=json.dumps(agent_password),
                text=True,
                check=True,
                timeout=180,
            )
    except Exception:
        for container in running:
            print(docker("logs", "--tail", "40", container), file=sys.stderr)
        raise
    finally:
        os.umask(previous_umask)
        for container in running:
            docker("rm", "-f", container)
        if made_network:
            docker("network", "rm", network)
        (lock / "owner").unlink()
        lock.rmdir()


if __name__ == "__main__":
    if sys.argv[1:] == ["--scenario"]:
        scenario("home", "peer", json.load(sys.stdin))
    elif sys.argv[1:] == ["--bootstrap-agent"]:
        register("home", "kodera-agent", json.load(sys.stdin))
    else:
        main()
