"""The SMTP transport of the mail sender: docs/specs/OUTBOX_MAIL_SENDER.md §6 and §7.3.

`transport_from_environment` reads the settings once, at start, and refuses a malformed one. `send`
drives one SMTP conversation step by step, so that its outcome says whether the message content had
started to leave when the conversation ended: a failure before that is temporary, a failure after it
is ambiguous and is never retried automatically.

Nothing here logs. An SMTP error is described by its class name only, never by its text, which
commonly echoes the recipient address.
"""

from __future__ import annotations

import ipaddress
import re
import smtplib
import ssl
from collections.abc import Mapping
from dataclasses import dataclass, field
from email.headerregistry import Address
from email.utils import parseaddr
from typing import Literal
from urllib.parse import unquote, urlsplit

from django.core.exceptions import ImproperlyConfigured

Outcome = Literal["accepted", "temporary", "permanent", "ambiguous"]

SECURE_SCHEME = "smtp"
INSECURE_SCHEME = "smtp+insecure"
DEFAULT_PORT = 587
DEFAULT_REPLY_TO = "support@kodera.io"
# ADR-0015, Core platform mail: the only domains a remote transport may send from.
SENDER_DOMAINS = frozenset({"notify.kodera.io", "notify.staging.kodera.io"})
# Plaintext is accepted for loopback addresses and the literal `localhost` only. A test profile
# that reaches the compose Mailpit by its service name passes it as `insecure_hosts` (§6).
LOCAL_NAMES = frozenset({"localhost"})
TIMEOUT_S = 30.0
# smtplib prints the whole conversation, recipient and body included, at any level above 0.
SMTP_DEBUGLEVEL = 0
PROVIDER_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")


class TransportConfigError(ImproperlyConfigured):
    """The mail transport settings are malformed: the process refuses to start."""


@dataclass(frozen=True)
class MailTransport:
    host: str
    port: int
    starttls: bool
    username: str | None
    password: str | None = field(repr=False)
    sender: str
    reply_to: str
    # PEM certificates to trust instead of the system store: tests, and a private CA. Never read
    # from the environment.
    ca_pem: str | None = field(default=None, repr=False)

    @property
    def local(self) -> bool:
        """A plaintext transport to a loopback host, `localhost`, or a test profile's override."""
        return not self.starttls

    @property
    def sender_address(self) -> str:
        return parseaddr(self.sender)[1]

    @property
    def sender_domain(self) -> str:
        return self.sender_address.rpartition("@")[2].lower()


def is_local_host(host: str, insecure_hosts: frozenset[str] = frozenset()) -> bool:
    """`localhost`, a loopback address, or a name a test profile passes in `insecure_hosts`."""
    if host.lower() in LOCAL_NAMES | insecure_hosts:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def sender_domain_allowed(domain: str) -> bool:
    return domain in SENDER_DOMAINS


def _address(value: str, name: str) -> str:
    display, address = parseaddr(value)
    try:
        Address(display_name=display, addr_spec=address)
    except (ValueError, IndexError):
        raise TransportConfigError(f"{name} is not one mail address") from None
    if "@" not in address or any(c in value for c in "\r\n"):
        raise TransportConfigError(f"{name} is not one mail address")
    return value


def parse_transport(
    url: str,
    *,
    password: str | None,
    sender: str,
    reply_to: str = DEFAULT_REPLY_TO,
    insecure_hosts: frozenset[str] = frozenset(),
) -> MailTransport:
    """A transport from its settings, or TransportConfigError."""
    parsed = urlsplit(url)
    if parsed.scheme not in {SECURE_SCHEME, INSECURE_SCHEME}:
        raise TransportConfigError("KODERA_MAIL_SMTP_URL must be smtp:// or smtp+insecure://")
    if parsed.password is not None:
        raise TransportConfigError("KODERA_MAIL_SMTP_URL must not carry a password")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment or not parsed.hostname:
        raise TransportConfigError("KODERA_MAIL_SMTP_URL must be scheme://[user@]host[:port]")
    try:
        port = parsed.port or DEFAULT_PORT
    except ValueError:
        raise TransportConfigError("KODERA_MAIL_SMTP_URL has a malformed port") from None
    host = parsed.hostname
    starttls = parsed.scheme == SECURE_SCHEME
    if not starttls and not is_local_host(host, insecure_hosts):
        raise TransportConfigError("plaintext SMTP is accepted only for a local host")
    username = unquote(parsed.username) if parsed.username else None
    if (username is None) != (not password):
        raise TransportConfigError(
            "KODERA_MAIL_SMTP_PASSWORD is required with a user, and refused without one"
        )
    transport = MailTransport(
        host=host,
        port=port,
        starttls=starttls,
        username=username,
        password=password or None,
        sender=_address(sender, "KODERA_MAIL_FROM"),
        reply_to=_address(reply_to, "KODERA_MAIL_REPLY_TO"),
    )
    if starttls and not sender_domain_allowed(transport.sender_domain):
        raise TransportConfigError(
            "a remote transport sends only from notify.kodera.io or notify.staging.kodera.io"
        )
    return transport


def transport_from_environment(
    environment: Mapping[str, str], *, insecure_hosts: frozenset[str] = frozenset()
) -> MailTransport | None:
    """The transport the environment configures, None when KODERA_MAIL_SMTP_URL is unset."""
    url = environment.get("KODERA_MAIL_SMTP_URL", "")
    if url == "":
        return None
    return parse_transport(
        url,
        password=environment.get("KODERA_MAIL_SMTP_PASSWORD") or None,
        sender=environment.get("KODERA_MAIL_FROM", ""),
        reply_to=environment.get("KODERA_MAIL_REPLY_TO") or DEFAULT_REPLY_TO,
        insecure_hosts=insecure_hosts,
    )


@dataclass(frozen=True)
class SendResult:
    outcome: Outcome
    smtp_code: int | None
    provider_message_id: str | None = None
    # True when the conversation ended before the server accepted MAIL: the transport itself
    # failed, and the next delivery of the run would meet the same failure (§7.3).
    transport_failure: bool = False
    # The class of the error that ended the conversation, never its text.
    error_class: str | None = None


def reply_outcome(code: int) -> Outcome:
    """What a reply to MAIL, RCPT, DATA or the end of the content says about the message."""
    if 200 <= code < 300:
        return "accepted"
    if 400 <= code < 500:
        return "temporary"
    return "permanent"


# A failure once the content started to leave: the server may hold the message.
CONTENT_FAILURE: Outcome = "ambiguous"
# The reply classes that decide a message's fate. Any other reply — 1xx, 3xx, or nothing a reply
# code can be read from — decides nothing: temporary before the content, ambiguous after it.
DECIDING_CLASSES = frozenset({2, 4, 5})


def provider_id(reply: bytes) -> str | None:
    """The provider's queue identifier: the last token of the final reply, if it is an id."""
    tokens = reply.decode("ascii", "replace").split()
    if not tokens:
        return None
    candidate = tokens[-1].strip("<>")
    return candidate if PROVIDER_ID.fullmatch(candidate) else None


def tls_context(transport: MailTransport) -> ssl.SSLContext:
    """Verify the server's certificate chain and its host name, TLS 1.2 at least."""
    context = ssl.create_default_context(cadata=transport.ca_pem)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def negotiate_tls(client: smtplib.SMTP, transport: MailTransport) -> None:
    """Upgrade with STARTTLS, verifying the server, before any credential or address is sent.

    The client was built with the host, so smtplib hands the TLS layer that name to verify."""
    if not transport.starttls:
        return
    if not client.has_extn("starttls"):
        raise smtplib.SMTPNotSupportedError("STARTTLS not offered")
    code, _ = client.starttls(context=tls_context(transport))
    if code != 220:
        raise smtplib.SMTPResponseException(code, b"STARTTLS refused")
    client.ehlo()


def dot_stuffed(message: bytes) -> bytes:
    """The content as DATA carries it: CRLF line ends, leading dots doubled, the closing dot."""
    lines = re.sub(rb"\r\n|\r|\n", b"\r\n", message)
    if not lines.endswith(b"\r\n"):
        lines += b"\r\n"
    return re.sub(rb"(?m)^\.", b"..", lines) + b".\r\n"


def _transport_failure(error: BaseException, code: int | None = None) -> SendResult:
    return SendResult(
        outcome="temporary",
        smtp_code=code,
        transport_failure=True,
        error_class=type(error).__name__,
    )


def _refused(code: int) -> SendResult:
    """A refusal before the content. 421 closes the channel, so it is the transport's; a reply
    of a class that decides nothing is temporary: nothing of the message has left."""
    if code // 100 not in DECIDING_CLASSES:
        return SendResult(outcome="temporary", smtp_code=code)
    return SendResult(outcome=reply_outcome(code), smtp_code=code, transport_failure=code == 421)


def _close(client: smtplib.SMTP | None) -> None:
    if client is None:
        return
    try:
        client.quit()
    except Exception:  # noqa: BLE001, S110 - the outcome is already decided; closing cannot change it
        pass
    try:
        client.close()
    except Exception:  # noqa: BLE001, S110 - as above
        pass


def send(transport: MailTransport, *, recipient: str, message: bytes) -> SendResult:
    """One SMTP conversation delivering `message` to `recipient`. It never raises: whatever goes
    wrong is a transport failure before MAIL, temporary before the content, ambiguous after."""
    client: smtplib.SMTP | None = None
    try:
        # Transport phase: until MAIL is sent, a failure is the transport's (§7.3). The client is
        # built with the host so that STARTTLS verifies the certificate against that name. The
        # EHLO name is the sending domain: no lookup of this host's own name.
        try:
            client = smtplib.SMTP(
                transport.host,
                transport.port,
                local_hostname=transport.sender_domain,
                timeout=TIMEOUT_S,
            )
            client.set_debuglevel(SMTP_DEBUGLEVEL)
            client.ehlo()
            negotiate_tls(client, transport)
            if transport.username is not None and transport.password is not None:
                client.login(transport.username, transport.password)
        except smtplib.SMTPResponseException as error:
            return _transport_failure(error, error.smtp_code)
        except Exception as error:  # noqa: BLE001 - any failure here is the transport's
            return _transport_failure(error)

        # Envelope phase: nothing of the message has left; a lost connection is temporary.
        try:
            code, _ = client.mail(transport.sender_address)
            if code != 250:
                return _refused(code)
            code, _ = client.rcpt(recipient)
            if code not in (250, 251):
                return _refused(code)
            code, _ = client.docmd("DATA")
            if code != 354:
                return _refused(code)
        except smtplib.SMTPResponseException as error:
            return SendResult(
                outcome="temporary", smtp_code=error.smtp_code, error_class=type(error).__name__
            )
        except Exception as error:  # noqa: BLE001 - nothing of the message has left
            return SendResult(outcome="temporary", smtp_code=None, error_class=type(error).__name__)

        # Content phase: the message is leaving. Only a deciding reply decides; anything else,
        # an exception included, leaves the outcome unknown.
        try:
            client.send(dot_stuffed(message))
            code, reply = client.getreply()
        except Exception as error:  # noqa: BLE001 - the server may hold the message
            return SendResult(
                outcome=CONTENT_FAILURE, smtp_code=None, error_class=type(error).__name__
            )
        if code // 100 not in DECIDING_CLASSES:
            return SendResult(outcome=CONTENT_FAILURE, smtp_code=code if code > 0 else None)
        outcome = reply_outcome(code)
        return SendResult(
            outcome=outcome,
            smtp_code=code,
            provider_message_id=provider_id(reply) if outcome == "accepted" else None,
        )
    finally:
        _close(client)
