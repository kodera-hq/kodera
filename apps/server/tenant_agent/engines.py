"""What the agent does to each engine of its tenant (ADR-0016).

Docs and Meet are changed through their own models, by code run inside their backend container, so
that the engines' side effects run: in Docs, the yhub reset-connections kick that closes a revoked
editor. That code reaches private upstream functions; tests/test_tenant_agent.py pins the names it
needs, and ADR-0016 asks for a contract test at every upstream release. The member set travels as a
file copied into the container, since it can exceed what an environment variable may hold. LiveKit
is driven through its server API with the key that stays on the VM.
"""

import http.client
import json
import logging
import secrets
import time
import urllib.error
import urllib.request
from typing import Any, Protocol

import jwt

from .docker_exec import ExecResult

RESULT_MARKER = "KODERA_AGENT_RESULT "
log = logging.getLogger("tenant_agent.engines")


class EngineError(Exception):
    """An engine could not be reached or answered something the agent cannot use."""


class LiveKitUnavailableError(EngineError):
    """LiveKit did not answer at all (refused, reset, timed out): a transport failure, not an HTTP
    status. Later LiveKit calls in the same pass would wait as long, so the pass skips them."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is answered as the error it is: the LiveKit token never follows one."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class Runner(Protocol):
    def run(self, service: str, argv: list[str], env: dict[str, str]) -> ExecResult: ...

    def put_file(self, service: str, name: str, content: bytes) -> str: ...


# Shared by both engines: read the set, deactivate every active user whose subject is inactive,
# reactivate every inactive user whose subject is released, and touch nobody else (ADR-0016). Each
# engine snippet then deletes the newly deactivated users' sessions. `sub` is the Keycloak subject
# both engines store at sign-in.
_CONVERGE = """
import json, os
from django.conf import settings
from django.db import transaction
from importlib import import_module
from core import models
path = os.environ["AGENT_INPUT"]
with open(path) as fh:
    wanted = json.load(fh)
try:
    os.unlink(path)
except OSError:
    pass
inactive, released = set(wanted["inactive"]), set(wanted["released"]) - set(wanted["inactive"])
with transaction.atomic():
    newly = list(models.User.objects.filter(sub__in=inactive, is_active=True))
    for user in newly:
        user.is_active = False
        user.save(update_fields=["is_active"])
    reactivated = models.User.objects.filter(sub__in=released, is_active=False).update(is_active=True)
    # On a received set (FULL), the follow-up steps run again for every inactive user, not only
    # the newly deactivated: a run that failed after its deactivation committed is completed by
    # the retry. Doing them again is harmless.
    if os.environ.get("AGENT_FULL") == "1":
        closing = list(models.User.objects.filter(sub__in=inactive, is_active=False))
    else:
        closing = newly
    on_deactivation(closing)
ids = {str(user.pk) for user in closing}
SessionStore = import_module(settings.SESSION_ENGINE).SessionStore
"""

# Docs keeps sessions in the cache only (django-redis): one scan for the newly deactivated users.
# The kick makes yhub re-check their open editors now, on every document reached by a direct
# access, a team access (Docs defines no teams yet) or a link trace.
DOCS_CONVERGE = (
    """
from django.db.models import Q
from core.tasks.access import reset_service_connections_on_commit
kicked = set()
def on_deactivation(newly):
    # In the deactivation's own transaction: the kicks are queued on its commit, so a crash cannot
    # leave a deactivated user's editor open.
    for user in newly:
        accesses = models.DocumentAccess.objects.filter(Q(user=user) | Q(team__in=user.teams))
        docs = {str(d) for d in accesses.values_list("document_id", flat=True)}
        docs |= {str(d) for d in models.LinkTrace.objects.filter(user=user).values_list("document_id", flat=True)}
        for doc_id in sorted(docs):
            reset_service_connections_on_commit(doc_id, user.id)
        kicked.update(docs)
"""
    + _CONVERGE
    + """
from django.core.cache import caches
dropped = 0
if ids:
    cache = caches[settings.SESSION_CACHE_ALIAS]
    prefix = SessionStore.cache_key_prefix
    for key in list(cache.iter_keys(prefix + "*")):
        store = SessionStore(session_key=key[len(prefix):])
        if str(store.get("_auth_user_id")) in ids:
            store.delete()
            dropped += 1
print("KODERA_AGENT_RESULT " + json.dumps({"deactivated": len(newly), "reactivated": reactivated,
      "sessions_dropped": dropped, "documents_kicked": len(kicked)}))
"""
)

# Meet runs database-backed sessions (ADR-0016): delete the newly deactivated users' rows, through
# the session store so its cache goes too.
MEET_CONVERGE = (
    """
def on_deactivation(newly):
    pass
"""
    + _CONVERGE
    + """
from django.contrib.sessions.models import Session
from django.utils import timezone
dropped = 0
if ids:
    for session in Session.objects.filter(expire_date__gte=timezone.now()):
        if str(session.get_decoded().get("_auth_user_id")) in ids:
            SessionStore(session_key=session.session_key).delete()
            dropped += 1
print("KODERA_AGENT_RESULT " + json.dumps({"deactivated": len(newly), "reactivated": reactivated,
      "sessions_dropped": dropped, "documents_kicked": 0}))
"""
)

# Which of these participant identities are Meet users that are deactivated. Room-level access
# (roles, the lobby, moderation) stays Meet's: a participant Meet admitted is never second-guessed.
MEET_DEACTIVATED = """
import json, os
from core import models
identities = [i for i in os.environ["AGENT_IDENTITIES"].split(",") if i]
found = models.User.objects.filter(sub__in=identities, is_active=False).values_list("sub", flat=True)
print("KODERA_AGENT_RESULT " + json.dumps({"deactivated": sorted(str(s) for s in found)}))
"""


def _shell(runner: Runner, service: str, code: str, env: dict[str, str]) -> dict[str, Any]:
    result = runner.run(service, ["python", "manage.py", "shell", "-c", code], env)
    # The exec runs with a TTY, so the shell may colour its output: find the marker anywhere in a
    # line, after any escape sequence.
    lines = [
        line[line.index(RESULT_MARKER) :]
        for line in result.output.splitlines()
        if RESULT_MARKER in line
    ]
    if result.exit_code != 0 or not lines:
        # The output stays in the VM's log (it may name users or documents); the error does not.
        log.warning("%s answered exit %s:\n%s", service, result.exit_code, result.output[-2000:])
        raise EngineError(f"{service} answered exit {result.exit_code}")
    try:
        answer: dict[str, Any] = json.loads(lines[-1][len(RESULT_MARKER) :])
    except ValueError as exc:
        raise EngineError(f"{service} answered an unreadable result") from exc
    return answer


class _DjangoEngine:
    code = ""

    def __init__(self, runner: Runner, service: str) -> None:
        self._runner, self._service = runner, service

    def converge(self, inactive: list[str], released: list[str], *, full: bool) -> dict[str, Any]:
        content = json.dumps({"inactive": inactive, "released": released}).encode()
        path = self._runner.put_file(
            self._service, f"kodera-set-{secrets.token_hex(8)}.json", content
        )
        env = {"AGENT_INPUT": path, "AGENT_FULL": "1" if full else "0"}
        return _shell(self._runner, self._service, self.code, env)


class Docs(_DjangoEngine):
    code = DOCS_CONVERGE


class Meet(_DjangoEngine):
    code = MEET_CONVERGE

    def deactivated(self, identities: list[str]) -> set[str]:
        answer = _shell(
            self._runner,
            self._service,
            MEET_DEACTIVATED,
            {"AGENT_IDENTITIES": ",".join(identities)},
        )
        return {str(subject) for subject in answer["deactivated"]}


class LiveKit:
    """The LiveKit server API (Twirp, JSON), with short-lived tokens signed by the VM's key."""

    def __init__(self, url: str, key: str, secret: str, timeout: float = 10.0) -> None:
        self._url, self._key, self._secret, self._timeout = url, key, secret, timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _token(self, video: dict[str, Any]) -> str:
        now = int(time.time())
        claims = {
            "iss": self._key,
            "sub": "kodera-agent",
            "nbf": now - 5,
            "exp": now + 60,
            "video": video,
        }
        return jwt.encode(claims, self._secret, algorithm="HS256")

    def _post(self, method: str, body: dict[str, Any], video: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(  # noqa: S310 - the URL is the VM's own LiveKit, from config
            f"{self._url}/twirp/livekit.RoomService/{method}",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token(video)}",
            },
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                answer: dict[str, Any] = json.loads(response.read() or b"{}")
                return answer
        except urllib.error.HTTPError as exc:
            exc.close()
            if exc.code == 404:
                return {"not_found": True}
            raise EngineError(f"livekit {method} answered {exc.code}") from exc
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            raise LiveKitUnavailableError(f"livekit {method}: {exc}") from exc

    def rooms(self) -> list[str]:
        answer = self._post("ListRooms", {}, {"roomList": True})
        return [str(room["name"]) for room in answer.get("rooms", [])]

    def participants(self, room: str) -> list[dict[str, Any]]:
        answer = self._post("ListParticipants", {"room": room}, {"roomAdmin": True, "room": room})
        return list(answer.get("participants", []))

    def remove(self, room: str, identity: str) -> None:
        self._post(
            "RemoveParticipant",
            {"room": room, "identity": identity},
            {"roomAdmin": True, "room": room},
        )
