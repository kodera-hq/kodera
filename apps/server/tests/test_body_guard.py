"""Body admission happens before Django and preserves bodyless serving capacity."""

import io
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from config.body_guard import BodyGuard


def invoke(guard, body=b"", **extra):
    environ = {
        "REQUEST_METHOD": "POST",
        "CONTENT_LENGTH": str(len(body)),
        "wsgi.input": io.BytesIO(body),
        **extra,
    }
    response = Mock()
    response.start_response.__self__ = response
    environ.setdefault("gunicorn.socket", Mock(gettimeout=lambda: None))
    result = b"".join(guard(environ, response.start_response))
    return environ, response, result


def test_body_buffered_and_slot_released_before_downstream():
    guard = None

    def app(environ, start):
        assert guard.slots.acquire(blocking=False)
        guard.slots.release()
        assert isinstance(environ["wsgi.input"], io.BytesIO)
        assert environ["wsgi.input"].read() == b"abc"
        assert environ["CONTENT_LENGTH"] == "3"
        assert "HTTP_TRANSFER_ENCODING" not in environ
        return [b"ok"]

    guard = BodyGuard(app)
    assert invoke(guard, b"abc", HTTP_TRANSFER_ENCODING="chunked")[2] == b"ok"


def test_capacity_refusal_closes_gunicorn_response_and_skips_bodyless_gets():
    app = Mock(return_value=[b"ok"])
    guard = BodyGuard(app)
    for _ in range(2):
        assert guard.slots.acquire(blocking=False)
    try:
        _, response, body = invoke(guard, b"abc")
        assert response.start_response.call_args.args[0] == "503 Service Unavailable"
        assert ("Retry-After", "1") in response.start_response.call_args.args[1]
        response.force_close.assert_called_once()
        assert b"capacity busy" in body
        for headers in ({"CONTENT_LENGTH": "0"}, {"CONTENT_LENGTH": ""}):
            assert invoke(guard, REQUEST_METHOD="GET", **headers)[2] == b"ok"
        app.assert_called()
    finally:
        guard.slots.release()
        guard.slots.release()


@pytest.mark.parametrize(
    "headers",
    [
        {"CONTENT_LENGTH": "invalid"},
        {"CONTENT_LENGTH": "-1"},
        {"CONTENT_LENGTH": "0", "HTTP_TRANSFER_ENCODING": "chunked"},
        {"CONTENT_LENGTH": "", "REQUEST_METHOD": "PATCH"},
    ],
)
def test_all_possible_body_framings_are_admitted(headers):
    guard = BodyGuard(Mock())
    guard.slots.acquire()
    guard.slots.acquire()
    assert invoke(guard, **headers)[1].start_response.call_args.args[0].startswith("503")


@pytest.mark.parametrize("chunked", [False, True])
def test_limit_is_inclusive_and_overflow_closes(chunked):
    app = Mock(return_value=[b"ok"])
    guard = BodyGuard(app)
    extra = {"HTTP_TRANSFER_ENCODING": "chunked", "CONTENT_LENGTH": ""} if chunked else {}
    assert invoke(guard, b"x" * 1048576, **extra)[2] == b"ok"
    _, response, _ = invoke(guard, b"x" * 1048577, **extra)
    assert response.start_response.call_args.args[0].startswith("413")
    response.force_close.assert_called_once()
    assert app.call_count == 1


def test_absolute_deadline_interrupts_trickling_read_and_returns_slot(monkeypatch):
    import config.body_guard as module

    monkeypatch.setattr(module, "BODY_READ_SECONDS", 0.15)
    server, client = socket.socketpair()
    server.settimeout(7)
    stop = threading.Event()

    def trickle():
        while not stop.wait(0.02):
            try:
                client.sendall(b"x")
            except OSError:
                break

    thread = threading.Thread(target=trickle)
    thread.start()
    try:
        with server.makefile("rb") as stream, ThreadPoolExecutor(1) as pool:
            guard = BodyGuard(Mock())
            future = pool.submit(
                invoke,
                guard,
                CONTENT_LENGTH="1000",
                **{"wsgi.input": stream, "gunicorn.socket": server},
            )
            _, response, _ = future.result(timeout=1)
        assert response.start_response.call_args.args[0] == "408 Request Timeout"
        response.force_close.assert_called_once()
        assert server.gettimeout() == 7
        assert guard.slots.acquire(blocking=False)
        assert guard.slots.acquire(blocking=False)
    finally:
        stop.set()
        thread.join(1)
        server.close()
        client.close()


def test_truncated_known_length_is_refused_before_django():
    app = Mock()
    guard = BodyGuard(app)
    _, response, _ = invoke(guard, b"x", CONTENT_LENGTH="3")
    assert response.start_response.call_args.args[0].startswith("400")
    app.assert_not_called()


def test_success_restores_socket_timeout_and_bounds_each_read():
    server, client = socket.socketpair()
    server.settimeout(7)
    reads = []
    stream = io.BytesIO(b"x" * 1048576)

    def read(size):
        reads.append(size)
        return stream.read(size)

    try:
        guard = BodyGuard(Mock(return_value=[b"ok"]))
        assert (
            invoke(
                guard,
                CONTENT_LENGTH="1048576",
                **{"wsgi.input": Mock(read=read), "gunicorn.socket": server},
            )[2]
            == b"ok"
        )
        assert server.gettimeout() == 7
        assert max(reads) <= 65536
        # A successful body never half-closes a reusable connection.
        client.sendall(b"next")
        assert server.recv(4) == b"next"
    finally:
        server.close()
        client.close()


def test_generic_wsgi_refusal_has_no_hop_by_hop_header():
    response = Mock()
    result = BodyGuard(Mock())(
        {"REQUEST_METHOD": "POST", "CONTENT_LENGTH": "invalid", "wsgi.input": io.BytesIO()},
        response,
    )
    assert b"Invalid" in b"".join(result)
    assert ("Connection", "close") not in response.call_args.args[1]
