"""The origin of a link: `scheme://host[:port]` of an https URL, or an http URL on a local host.

The mail's link origins (apps/outbox/mail/links.py) and createPaymentLink's return URL are held to
the same rule, so the API image carries it without the outbox's mail package.
"""

from urllib.parse import urlsplit

LOCAL_LINK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def is_local_link_host(host: str) -> bool:
    return host in LOCAL_LINK_HOSTS or host.endswith(".localhost")


def origin_of(url: str) -> str | None:
    """`scheme://host[:port]`, lower-cased, of an https URL or an http URL on a local host."""
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if host == "" or parsed.username is not None or parsed.password is not None:
        return None
    if parsed.scheme != "https" and not (parsed.scheme == "http" and is_local_link_host(host)):
        return None
    shown = f"[{host}]" if ":" in host else host
    return f"{parsed.scheme}://{shown}" + ("" if port is None else f":{port}")
