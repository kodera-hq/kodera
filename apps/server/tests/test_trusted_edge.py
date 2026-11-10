"""The trusted edge's client address and the caller's request-id namespace (docs/specs/TRUSTED_EDGE.md).

Pure cases first, then one owned source mutation per rule: each mutant must fail the one case
named for it, so a rule no case can tell apart from its absence shows up here, not in production.
"""

import ipaddress
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.http import HttpResponse
from django.test import RequestFactory

from config.environment import trusted_edge
from core.api import edge

ROOT = Path(__file__).resolve().parents[1]
EDGE = (ipaddress.ip_network("172.19.0.2/32"),)
CHAIN = (ipaddress.ip_network("172.19.0.2/32"), ipaddress.ip_network("10.0.0.0/24"))


def meta(peer: str, forwarded: str | None = None) -> dict[str, str]:
    values = {"REMOTE_ADDR": peer}
    if forwarded is not None:
        values["HTTP_X_FORWARDED_FOR"] = forwarded
    return values


# --- client address ------------------------------------------------------------------------------


def case_nothing_trusted_keeps_the_peer(m) -> bool:
    return m.client_address(meta("172.19.0.2", "198.51.100.1"), ()) == "172.19.0.2"


def case_untrusted_peer_spoofing_is_ignored(m) -> bool:
    return m.client_address(meta("203.0.113.9", "198.51.100.1"), EDGE) == "203.0.113.9"


def case_trusted_edge_names_the_client(m) -> bool:
    return m.client_address(meta("172.19.0.2", "198.51.100.1"), EDGE) == "198.51.100.1"


def case_caller_written_left_hops_are_not_believed(m) -> bool:
    forged = "1.1.1.1, 2.2.2.2, 198.51.100.1"
    return m.client_address(meta("172.19.0.2", forged), EDGE) == "198.51.100.1"


def case_trusted_hops_are_skipped(m) -> bool:
    forwarded = "1.1.1.1, 198.51.100.1, 10.0.0.5"
    return m.client_address(meta("172.19.0.2", forwarded), CHAIN) == "198.51.100.1"


def case_malformed_hop_keeps_the_peer(m) -> bool:
    forwarded = "198.51.100.1, not-an-address"
    return m.client_address(meta("172.19.0.2", forwarded), EDGE) == "172.19.0.2"


def case_mapped_peer_is_the_edge(m) -> bool:
    return m.client_address(meta("::ffff:172.19.0.2", "198.51.100.1"), EDGE) == "198.51.100.1"


def case_only_trusted_hops_keep_the_peer(m) -> bool:
    return m.client_address(meta("172.19.0.2", "10.0.0.5, 172.19.0.2"), CHAIN) == "172.19.0.2"


def case_absent_header_keeps_the_peer(m) -> bool:
    return m.client_address(meta("172.19.0.2"), EDGE) == "172.19.0.2"


def case_ipv6_client_is_its_text(m) -> bool:
    return m.client_address(meta("172.19.0.2", "2001:db8::1"), EDGE) == "2001:db8::1"


def case_rightmost_hop_wins_over_left_padding(m) -> bool:
    # A caller pads the left with garbage; the edge's own hop on the right still names the client.
    forwarded = ", ".join(["junk"] * 40 + ["198.51.100.1"])
    return m.client_address(meta("172.19.0.2", forwarded), EDGE) == "198.51.100.1"


def case_at_most_sixteen_hops_are_read(m) -> bool:
    within = ", ".join(["198.51.100.1"] + ["10.0.0.5"] * 15)
    beyond = ", ".join(["198.51.100.1"] + ["10.0.0.5"] * 16)
    return (
        m.client_address(meta("172.19.0.2", within), CHAIN) == "198.51.100.1"
        and m.client_address(meta("172.19.0.2", beyond), CHAIN) == "172.19.0.2"
    )


# --- caller request id ---------------------------------------------------------------------------


def case_caller_id_is_namespaced(m) -> bool:
    return m.caller_request_id("safe-request-123") == "c-safe-request-123"


def case_caller_id_fits_the_contract_once_namespaced(m) -> bool:
    return (
        m.caller_request_id("x" * 62) == "c-" + "x" * 62 and m.caller_request_id("x" * 63) is None
    )


def case_unsafe_caller_id_is_dropped(m) -> bool:
    return all(m.caller_request_id(v) is None for v in ("short", "a b c d e", "x/yyyyyyyy", None))


def _through(m, supplied: str | None, *, read_first: bool = False) -> str | None:
    """What a view behind the middleware reads as `X-Request-Id`."""
    request = RequestFactory().get("/api/v1/me")
    if supplied is not None:
        request.META["HTTP_X_REQUEST_ID"] = supplied
    if read_first:
        assert request.headers.get("X-Request-Id") == supplied
    seen: list[str | None] = []

    def view(r) -> HttpResponse:
        seen.append(r.headers.get("X-Request-Id"))
        return HttpResponse()

    m.CallerRequestIdMiddleware(view)(request)
    return seen[0]


def case_view_reads_the_namespaced_id(m) -> bool:
    return _through(m, "safe-request-123") == "c-safe-request-123"


def case_view_never_reads_an_unsafe_id(m) -> bool:
    # 63 characters pass a view's own check, so only the middleware's removal keeps it out.
    value = _through(m, "x" * 63)
    return value is not None and len(value) == 36 and value != "x" * 63


def case_a_cached_header_read_is_refreshed(m) -> bool:
    return _through(m, "safe-request-123", read_first=True) == "c-safe-request-123"


CASES: dict[str, Callable[[object], bool]] = {
    name: value for name, value in globals().items() if name.startswith("case_")
}


@pytest.mark.parametrize("name", sorted(CASES))
def test_case_holds(name):
    assert CASES[name](edge), name


# Each mutant replaces exactly one anchor in core/api/edge.py and must fail the case that owns it.
MUTATIONS = [
    (
        "case_untrusted_peer_spoofing_is_ignored",
        "if peer_address is None or not _trusted(peer_address, trusted):",
        "if peer_address is None:",
    ),
    (
        "case_caller_written_left_hops_are_not_believed",
        'for hop in reversed(forwarded.split(",")[-MAX_HOPS:]):',
        'for hop in forwarded.split(",")[-MAX_HOPS:]:',
    ),
    (
        "case_at_most_sixteen_hops_are_read",
        'for hop in reversed(forwarded.split(",")[-MAX_HOPS:]):',
        'for hop in reversed(forwarded.split(",")):',
    ),
    (
        "case_trusted_hops_are_skipped",
        "        if not _trusted(address, trusted):\n            return str(address)",
        "        if True:\n            return str(address)",
    ),
    (
        "case_malformed_hop_keeps_the_peer",
        "        if address is None:\n            return peer\n        if not",
        "        if address is None:\n            continue\n        if not",
    ),
    (
        "case_mapped_peer_is_the_edge",
        "    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:\n"
        "        return address.ipv4_mapped\n",
        "",
    ),
    ("case_caller_id_is_namespaced", "return CALLER_PREFIX + supplied", "return supplied"),
    (
        "case_caller_id_fits_the_contract_once_namespaced",
        r're.compile(r"[A-Za-z0-9_-]{8,62}\Z")',
        r're.compile(r"[A-Za-z0-9_-]{8,64}\Z")',
    ),
    (
        "case_view_never_reads_an_unsafe_id",
        'namespaced or str(new_uuid7())',
        'namespaced or "x" * 63',
    ),
    (
        "case_a_cached_header_read_is_refreshed",
        '        request.__dict__.pop("headers", None)\n',
        "",
    ),
]


def mutant(before: str, after: str) -> SimpleNamespace:
    source = (ROOT / "core/api/edge.py").read_text()
    assert source.count(before) == 1, f"mutation anchor moved: {before!r}"
    namespace: dict[str, object] = {"__name__": "trusted_edge_mutant"}
    code = compile(source.replace(before, after), "<trusted-edge-mutant>", "exec")
    exec(code, namespace)  # noqa: S102 - owned source mutation only
    return SimpleNamespace(**namespace)


@pytest.mark.parametrize(("owner", "before", "after"), MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_each_rule_has_a_case_that_catches_its_mutant(owner, before, after):
    assert CASES[owner](edge), "the owning case must hold on the real module"
    assert not CASES[owner](mutant(before, after)), f"{owner} did not catch its mutant"


# --- the operator's setting ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", ()),
        ("   ", ()),
        ("172.19.0.2", (ipaddress.ip_network("172.19.0.2/32"),)),
        (
            "172.19.0.2, 10.8.0.0/24",
            (ipaddress.ip_network("172.19.0.2/32"), ipaddress.ip_network("10.8.0.0/24")),
        ),
        ("172.19.0.0/24", (ipaddress.ip_network("172.19.0.0/24"),)),
        ("2001:db8::/120", (ipaddress.ip_network("2001:db8::/120"),)),
    ],
)
def test_the_setting_admits_exact_edges(value, expected):
    assert trusted_edge({"KODERA_TRUSTED_EDGE_ADDRESSES": value}) == expected


def test_the_setting_is_empty_when_unset():
    assert trusted_edge({}) == ()


@pytest.mark.parametrize(
    "value",
    [
        "0.0.0.0/0",
        "::/0",
        "172.0.0.0/8",
        "172.19.0.0/15",
        "172.19.0.0/16",  # the whole edge network: every container on it could choose its bucket
        "172.19.0.0/23",
        "2001:db8::/64",
        "2001:db8::/119",
        "172.19.0.2/16",  # host bits set: the operator meant one address or the network?
        "::ffff:172.19.0.2",
        "172.19.0.2,",
        "172.19.0.2,172.19.0.2",
        "traefik",
        "172.19.0.2;10.8.0.1",
        ",".join(f"10.0.0.{i}" for i in range(1, 10)),
    ],
)
def test_the_setting_refuses_anything_wider_or_unclear(value):
    with pytest.raises(ImproperlyConfigured) as refused:
        trusted_edge({"KODERA_TRUSTED_EDGE_ADDRESSES": value})
    assert value not in str(refused.value), "a refused value is never reflected"


def test_the_deployed_profile_reads_the_setting_and_installs_the_middleware_first():
    program = """
import json
from django.conf import settings
print(json.dumps({
    'edge': [str(n) for n in settings.KODERA_TRUSTED_EDGE],
    'first': settings.MIDDLEWARE[0],
}))
"""
    result = subprocess.run(  # noqa: S603 - fixed isolated probe
        [sys.executable, "-c", program],
        cwd=ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(ROOT),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings.deploy",
            "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
            "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
            "DATABASE_URL": "postgresql://synthetic:synthetic-pass@db:5432/kodera_server",
            "KODERA_TRUSTED_EDGE_ADDRESSES": "172.19.0.2",
        },
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "edge": ["172.19.0.2/32"],
        "first": "core.api.edge.CallerRequestIdMiddleware",
    }


def test_the_width_bound_has_a_case_that_catches_its_mutant():
    source = (ROOT / "config/environment.py").read_text()
    before = "if network.prefixlen < (24 if network.version == 4 else 120):"
    assert source.count(before) == 1, "mutation anchor moved"
    namespace: dict[str, object] = {"__name__": "trusted_edge_setting_mutant"}
    mutated = source.replace(before, "if network.prefixlen < (16 if network.version == 4 else 64):")
    exec(compile(mutated, "<trusted-edge-setting-mutant>", "exec"), namespace)  # noqa: S102 - owned source mutation only
    widened = namespace["trusted_edge"]({"KODERA_TRUSTED_EDGE_ADDRESSES": "172.19.0.0/16"})
    assert widened == (ipaddress.ip_network("172.19.0.0/16"),), "the mutant must admit the network"


# docs/api/CONVENTIONS.md §11: nothing but core/api/edge.py reads X-Forwarded-For.
FORWARDED_READ = re.compile(r"HTTP_X_FORWARDED_FOR|[\"']X-Forwarded-For[\"']", re.IGNORECASE)


def _readers() -> tuple[list[str], list[str]]:
    listed = subprocess.run(  # noqa: S603 - fixed read-only probe
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.py"],  # noqa: S607
        cwd=ROOT,
        capture_output=True,
        check=True,
    ).stdout.decode()
    found, scanned = [], []
    for name in filter(None, listed.split("\0")):
        if name == "core/api/edge.py" or name.startswith("tests/"):
            continue
        scanned.append(name)
        if FORWARDED_READ.search((ROOT / name).read_text(encoding="utf-8", errors="replace")):
            found.append(name)
    return found, scanned


def test_only_the_edge_module_reads_the_forwarded_header():
    found, scanned = _readers()
    # Not vacuous: the scan reads the application code, the view that consumes the address included.
    assert "apps/identity/api/discovery.py" in scanned and len(scanned) > 100
    assert found == []


@pytest.mark.parametrize(
    "planted",
    [
        'request.META.get("HTTP_X_FORWARDED_FOR")',
        "request.headers['X-Forwarded-For']",
        'request.headers.get("x-forwarded-for", "")',
    ],
)
def test_the_reader_gate_sees_a_planted_read(planted):
    assert FORWARDED_READ.search(planted), planted
    assert (ROOT / "core/api/edge.py").read_text().count("HTTP_X_FORWARDED_FOR") == 1
