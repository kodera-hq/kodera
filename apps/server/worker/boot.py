"""The worker's accident guard against inbound sockets, entered before Django or any application code.

ADR-0003 gives the worker no inbound network. What enforces that is the network the worker runs on:
no published port and an internal network holding the database alone (compose.yaml, `worker-db`,
asserted statically by tests/worker WK-07), and in production Fleet's network policy, with a
seccomp profile planned (deployment profiles#109). That network has one limit compose cannot close: a
container on an internal network can still reach the host through its bridge gateway; the host
firewall must drop worker-network -> host traffic except to the database.

This module is not a sandbox. It is an accident guard: it stops a library, or our own code, from
opening a listener by mistake, and it says so loudly when one tries.

`enter()` installs it once, irreversibly:

- an audit hook refuses every `socket.bind`, whatever the family and whether the socket was made
  by `socket`, `_socket` or `asyncio`, and `socket.listen` too, should the runtime raise it;
- CPython 3.12 raises no `socket.listen` event (Modules/socketmodule.c audits `sock_bind`, not
  `sock_listen`; a probe of 3.12.12 saw only `socket.__new__` around a raw listen), and a listen on
  an unbound socket binds it to an ephemeral port on every address with no `socket.bind` event. So
  the ordinary ways to reach `listen` refuse it: `socket.socket` and `socket.SocketType`, and
  `_socket.socket` and `_socket.SocketType`, rebound to a subclass of the raw type that refuses it.

What it does not stop, by design: code that sets out to get past it. The native type stays
reachable (`_socket.socket.__base__`, `socket.socket.__mro__`, a reference taken before
`enter()`), and so do ctypes and C extensions below Python. Nothing here crosses `exec`: a child
process, Python or not, starts without the guard, and a Python step child that wants it enters it
again (G1.5-B).

`config.settings.deploy_worker` refuses to load in a process that has not entered the guard.
"""

from __future__ import annotations

import _socket
import socket
import sys
from collections.abc import MutableMapping
from typing import Any

WORKER_SETTINGS = "config.settings.deploy_worker"
NO_INBOUND = "it has no inbound network (ADR-0003)"

_entered = False


class BoundaryRefusal(RuntimeError):  # noqa: N818 - the name the refusal is read by
    """The worker refused an operation outside its boundary."""


LISTEN_REFUSED = f"the worker listens on no socket: {NO_INBOUND}"


def _audit(event: str, args: tuple[Any, ...]) -> None:
    if event == "socket.bind":
        raise BoundaryRefusal(f"the worker binds no socket: {NO_INBOUND}")
    if event == "socket.listen":
        raise BoundaryRefusal(LISTEN_REFUSED)


def _refuse_listen(self: object, *args: Any) -> None:
    raise BoundaryRefusal(LISTEN_REFUSED)


class _RawSocket(_socket.socket):
    """The raw socket type, refusing to listen."""

    def listen(self, *args: Any) -> None:
        raise BoundaryRefusal(LISTEN_REFUSED)


def _guard_raw_socket() -> None:
    setattr(_socket, "socket", _RawSocket)  # noqa: B010 - rebinding the module's type
    setattr(_socket, "SocketType", _RawSocket)  # noqa: B010
    setattr(socket, "SocketType", _RawSocket)  # noqa: B010


def enter() -> None:
    """Install the boundary in this process, once. Irreversible by design."""
    global _entered
    if _entered:
        return
    sys.addaudithook(_audit)
    setattr(socket.socket, "listen", _refuse_listen)  # noqa: B010 - replaced on the class
    _guard_raw_socket()
    _entered = True


def entered() -> bool:
    return _entered


def select_settings(environment: MutableMapping[str, str]) -> str:
    """The worker's settings module: its own, whether selected or not, and never another."""
    selected = environment.setdefault("DJANGO_SETTINGS_MODULE", WORKER_SETTINGS)
    if selected != WORKER_SETTINGS:
        raise SystemExit(f"the worker starts only with {WORKER_SETTINGS}")
    return selected
