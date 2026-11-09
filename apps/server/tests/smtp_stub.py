"""An in-process SMTP server for the mail sender's acceptance: docs/specs/OUTBOX_MAIL_SENDER.md §9.

Standard library only. It speaks enough SMTP for smtplib — greeting, EHLO, MAIL, RCPT, DATA, RSET,
NOOP, QUIT — answers each command from a script, and records every command and every message it
received. TLS is a script switch: with a server context it offers STARTTLS and upgrades the
connection with a certificate from `stub_pki()`, generated at test time; with `starttls` alone it
advertises STARTTLS and refuses it, so a check can see whether anything was sent without it.

A refusal of RCPT, and the final reply, echo the recipient address, as many real servers do, so a
check can tell whether the server's text reached a log, an output or a stored row.
"""

from __future__ import annotations

import atexit
import datetime
import functools
import shutil
import socketserver
import ssl
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

ACCEPT_RCPT = "250 2.1.5 <{address}> recipient ok"


@dataclass
class Script:
    """What the server answers. `final` None drops the connection once the content is read."""

    greeting: str = "220 stub.test ESMTP"
    starttls: bool = False
    tls: ssl.SSLContext | None = None
    mail: str = "250 2.1.0 Ok"
    rcpt: str = ACCEPT_RCPT
    data: str = "354 End data with <CR><LF>.<CR><LF>"
    final: str | None = "250 2.0.0 <{address}> Ok: queued as STUB{count}"


@dataclass
class Record:
    commands: list[str] = field(default_factory=list)
    messages: list[bytes] = field(default_factory=list)
    connections: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def verbs(self) -> list[str]:
        with self.lock:
            return [command.split(" ", 1)[0].split(":", 1)[0].upper() for command in self.commands]


class _Handler(socketserver.StreamRequestHandler):
    server: _Server

    def finish(self) -> None:
        super().finish()
        if isinstance(self.request, ssl.SSLSocket):
            self.request.close()

    def reply(self, line: str) -> None:
        self.wfile.write(line.encode("ascii") + b"\r\n")
        self.wfile.flush()

    def handle(self) -> None:
        script, record = self.server.script, self.server.record
        with record.lock:
            record.connections += 1
        address = ""
        self.reply(script.greeting)
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.decode("ascii", "replace").rstrip("\r\n")
            with record.lock:
                record.commands.append(line)
            verb = line.split(" ", 1)[0].split(":", 1)[0].upper()
            if verb in {"EHLO", "HELO"}:
                extensions = ["250-stub.test", "250-8BITMIME"]
                if script.starttls or script.tls is not None:
                    extensions.append("250-STARTTLS")
                extensions.append("250 SIZE 10240000")
                for extension in extensions:
                    self.reply(extension)
            elif verb == "STARTTLS":
                if script.tls is None:
                    self.reply("454 4.7.0 TLS not available in this stub")
                    continue
                self.reply("220 2.0.0 Ready to start TLS")
                try:
                    secure = script.tls.wrap_socket(self.request, server_side=True)
                except (ssl.SSLError, OSError):
                    with record.lock:
                        record.commands.append("TLS-REFUSED")
                    return
                self.rfile.close()
                self.request = secure
                self.rfile = secure.makefile("rb")
                self.wfile = secure.makefile("wb")
                with record.lock:
                    record.commands.append("TLS-ESTABLISHED")
            elif verb == "MAIL":
                self.reply(script.mail)
            elif verb == "RCPT":
                address = line.partition("<")[2].partition(">")[0]
                self.reply(script.rcpt.format(address=address))
            elif verb == "DATA":
                self.reply(script.data)
                if not script.data.startswith("354"):
                    continue
                content = bytearray()
                while True:
                    chunk = self.rfile.readline()
                    if not chunk:
                        return
                    if chunk == b".\r\n":
                        break
                    content += chunk
                with record.lock:
                    record.messages.append(bytes(content))
                    count = len(record.messages)
                if script.final is None:
                    return
                self.reply(script.final.format(address=address, count=count))
            elif verb == "QUIT":
                self.reply("221 2.0.0 Bye")
                return
            elif verb in {"RSET", "NOOP"}:
                self.reply("250 2.0.0 Ok")
            else:
                self.reply("502 5.5.2 Command not recognised")


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, script: Script) -> None:
        self.script = script
        self.record = Record()
        super().__init__(("127.0.0.1", 0), _Handler)


@dataclass
class Stub:
    host: str
    port: int
    script: Script
    record: Record


@contextmanager
def smtp_stub(script: Script | None = None) -> Iterator[Stub]:
    server = _Server(script or Script())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address[:2]
        yield Stub(host=str(host), port=int(port), script=server.script, record=server.record)
    finally:
        server.shutdown()
        server.server_close()


def unused_port() -> int:
    """A loopback port nothing listens on, for a transport that must fail to connect."""
    server = socketserver.TCPServer(("127.0.0.1", 0), socketserver.BaseRequestHandler)
    port = int(server.server_address[1])
    server.server_close()
    return port


@dataclass(frozen=True)
class Pki:
    """A certificate authority and a server certificate it signed for `localhost` only."""

    ca_pem: str
    chain: Path
    key: Path

    def server_context(self) -> ssl.SSLContext:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.chain, self.key)
        return context


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


@functools.cache
def stub_pki() -> Pki:
    """Generated once per process, in a directory removed at exit; never a committed key."""
    now = datetime.datetime.now(datetime.UTC)
    validity = (now - datetime.timedelta(minutes=5), now + datetime.timedelta(days=1))
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca = (
        x509.CertificateBuilder()
        .subject_name(_name("outbox stub test CA"))
        .issuer_name(_name("outbox stub test CA"))
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(validity[0])
        .not_valid_after(validity[1])
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    server_key = ec.generate_private_key(ec.SECP256R1())
    server = (
        x509.CertificateBuilder()
        .subject_name(_name("localhost"))
        .issuer_name(ca.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(validity[0])
        .not_valid_after(validity[1])
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    directory = Path(tempfile.mkdtemp(prefix="outbox-stub-pki-"))
    atexit.register(shutil.rmtree, directory, True)
    chain, key = directory / "chain.pem", directory / "key.pem"
    chain.write_bytes(server.public_bytes(serialization.Encoding.PEM))
    key.write_bytes(
        server_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return Pki(
        ca_pem=ca.public_bytes(serialization.Encoding.PEM).decode("ascii"), chain=chain, key=key
    )
