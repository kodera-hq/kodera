"""The invitation leg of the live end-to-end stack: docs/specs/INVITATIONS.md section 8.

TEST ONLY. Run it after `python -m dev.e2e.journey`, on the same bring-up: it needs the owner the
journey left signed in and the organisation active. Every address it calls is
http://localhost:<port> from journey.json.

    uv run python -m dev.e2e.invitations [--scheduler]

The steps, each checked before the next:

1. The owner invites a new address as `org_member` (`inviteToOrganisation`).
2. `run_realm_deliveries --once`, `send_invitations --once` and `run_deliveries --once`, in the
   operator schedule's order. The realm worker creates the account with its required actions and
   the invitation's locale, and has the realm mail the set-up link. The invitation mail, which
   waits for that outcome, then announces the set-up mail. Both reach Mailpit.
3. The invitee follows the set-up link: the address is verified, then a password, a name and a
   one-time code are set, through the realm's own pages.
4. The invitee signs in (password and code) through the Console client and posts the invitation
   token (`acceptInvitation`). `GET /api/v1/me` shows the active membership.
5. The owner removes the membership, and `run_realm_deliveries --once` turns the realm user off.
   The admin API shows the user disabled with no session left, and the invitee's sign-in is
   refused.

With `--scheduler`, one pass of `run_operator_schedule` replaces each set of `--once` commands.

It prints identifiers and outcomes, never a token, a password or a code.

`--until set-up` stops after step 3, for the Console's own acceptance smoke: the invitation stays
pending, its mail stays in Mailpit, and the invitee's sign-in (realm, address, password, one-time
code secret) is written to `rendered/invitee.json`, mode 0600, like `journey.json`.
"""

import argparse
import base64
import html
import json
import re
import sys
import time
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from . import make_trust
from .journey import admin_token, call, idempotency_key, login, ops, problem
from .make_trust import ORG_REALM, RENDERED, FixtureError, require

INVITEE = "invitee@e2e-pilot.kodera-e2e.test"
# The invitation link's fragment (apps/orgs/invitations.py: `inv1_<id>_<43 characters>`).
INVITATION_TOKEN = re.compile(r"#(inv1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])")
# The realm's set-up link: an action token on the organisation realm.
ACTION_LINK = re.compile(r"https?://[^\s\"'<>]+/login-actions/action-token\?[^\s\"'<>]+")
MAX_PAGES = 10


class Page(HTMLParser):
    """The forms and links of one provider page."""

    def __init__(self) -> None:
        super().__init__()
        self.forms: list[dict[str, Any]] = []
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "form":
            self.forms.append({"action": attributes.get("action"), "inputs": {}})
        elif tag == "input" and self.forms and attributes.get("name"):
            self.forms[-1]["inputs"][attributes["name"]] = attributes.get("value") or ""
        elif tag == "a" and "/login-actions/" in (attributes.get("href") or ""):
            self.links.append(str(attributes["href"]))


def mails(journey: dict[str, Any], recipient: str, *, want: int) -> list[str]:
    """The text of every mail Mailpit holds for `recipient`, once at least `want` arrived."""
    origin = journey["mailpit_origin"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status, listing = call(origin, "GET", "/api/v1/messages?limit=100")
        require(status == 200 and isinstance(listing, dict), "Mailpit's API refused")
        found = [
            message["ID"]
            for message in listing.get("messages") or []
            if any(to.get("Address") == recipient for to in message.get("To") or [])
        ]
        if len(found) >= want:
            texts = []
            for message_id in found:
                status, full = call(origin, "GET", f"/api/v1/message/{message_id}")
                require(status == 200 and isinstance(full, dict), "Mailpit's message refused")
                texts.append(str(full.get("Text", "")) + "\n" + str(full.get("HTML", "")))
            return texts
        time.sleep(1)
    raise FixtureError(f"fewer than {want} mails reached Mailpit for the invitee")


def complete_actions(journey: dict[str, Any], link: str, password: str) -> str:
    """Follow the realm's set-up link through its pages: verify, set the password, configure the
    code. Returns the code's secret, as the authenticator app would hold it."""
    browser = make_trust.Browser(journey["keycloak_origin"])
    status, headers, body = browser.request("GET", html.unescape(link))
    secret = None
    for _ in range(MAX_PAGES):
        if status in (302, 303):
            location = headers.get("Location") or headers.get("location") or ""
            if not location.startswith(journey["keycloak_origin"]) and not location.startswith("/"):
                break  # Sent on to an application: the actions are done.
            status, headers, body = browser.request("GET", location)
            continue
        require(status == 200, f"the set-up page answered {status}")
        page = Page()
        page.feed(body.decode("utf-8"))
        forms = [f for f in page.forms if "/login-actions/" in str(f["action"])]
        if forms:
            fields = dict(forms[0]["inputs"])
            if "password-new" in fields:
                fields.update({"password-new": password, "password-confirm": password})
            elif {"firstName", "lastName"} <= set(fields):
                # The realm's user profile asks the person their name once.
                fields.update({"firstName": "E2E", "lastName": "Invitee"})
            elif "totpSecret" in fields:
                secret = fields["totpSecret"]
                fields["totp"] = make_trust.totp(secret.encode("utf-8"), time.time())
                fields["userLabel"] = "e2e authenticator"
            else:
                raise FixtureError(f"an unexpected set-up form: {sorted(fields)}")
            status, headers, body = browser.request(
                "POST", html.unescape(str(forms[0]["action"])), fields
            )
            continue
        if page.links:
            status, headers, body = browser.request("GET", html.unescape(page.links[0]))
            continue
        break  # An information page with nothing left to do.
    require(secret is not None, "the set-up never asked for a one-time code")
    assert secret is not None  # noqa: S101 - narrows for the type checker
    return secret


def realm_user(journey: dict[str, Any], email: str) -> dict[str, Any]:
    status, users = call(
        journey["keycloak_origin"],
        "GET",
        f"/admin/realms/{ORG_REALM}/users?email={email}&exact=true&briefRepresentation=false",
        token=admin_token(journey),
    )
    require(status == 200 and isinstance(users, list) and len(users) == 1, "invitee account")
    return dict(users[0])


def deliver(scheduler: bool, *runs: str) -> None:
    """The operator's runs: each `--once` command by hand, or one pass of the operator schedule,
    which runs them all (OPERATOR_SCHEDULE.md)."""
    if scheduler:
        ops("run_operator_schedule", "--passes", "1", "--interval", "10")
        return
    for name in runs:
        ops(name, "--once")


UNTIL = ("set-up",)


def run(
    journey_path: Path = RENDERED / "journey.json",
    *,
    scheduler: bool = False,
    until: str | None = None,
) -> list[str]:
    journey = json.loads(journey_path.read_text(encoding="utf-8"))
    api = journey["api_origin"]
    done: list[str] = []
    owner = journey["accounts"]["owner"]
    require("after_binding" in owner, "run the journey in template owner mode first")
    owner_token = login(journey, "owner", {**owner, **owner["after_binding"]})
    status, me = call(api, "GET", "/api/v1/me", token=owner_token)
    require(status == 200 and isinstance(me, dict), f"the owner's /me answered {status}")
    organisation_id = me["organisations"][0]["organisation"]["id"]

    # 1. The invitation.
    status, batch = call(
        api,
        "POST",
        f"/api/v1/organisations/{organisation_id}/invitations",
        token=owner_token,
        body={
            "invitations": [
                {"email": INVITEE, "role": "org_member", "display_name": "E2E Invitee"}
            ],
            "locale": "fr",
        },
        headers={"Idempotency-Key": idempotency_key("invite")},
    )
    require(status == 201 and isinstance(batch, dict), f"invite answered {status}")
    require(batch["created"] == 1, f"invite outcome {batch['results'][0]['outcome']}")
    invitation_id = batch["results"][0]["invitation"]["id"]
    done.append(f"owner inviteToOrganisation: 201, invitation {invitation_id} pending")

    # 2. The three runs, and both mails.
    deliver(scheduler, "run_realm_deliveries", "send_invitations", "run_deliveries")
    texts = mails(journey, INVITEE, want=2)
    tokens = [m.group(1) for text in texts for m in [INVITATION_TOKEN.search(text)] if m]
    links = [m.group(0) for text in texts for m in [ACTION_LINK.search(text)] if m]
    require(len(set(tokens)) == 1, "exactly one invitation token expected in the mails")
    require(len(links) >= 1, "the realm's set-up mail carries no action link")
    require(tokens[0].startswith(f"inv1_{invitation_id}_"), "the mail names another invitation")
    require(
        any(f"/invitations/accept/{organisation_id}/" in text for text in texts),
        "the invitation link does not name the organisation",
    )
    created = realm_user(journey, INVITEE)
    require(
        set(created.get("requiredActions") or [])
        == {"VERIFY_EMAIL", "UPDATE_PASSWORD", "CONFIGURE_TOTP"},
        "the invitee's account lacks its required actions",
    )
    require(
        (created.get("attributes") or {}).get("locale") == ["fr"],
        "the invitee's account does not carry the invitation's locale",
    )
    done.append("realm account created with VERIFY_EMAIL, UPDATE_PASSWORD, CONFIGURE_TOTP")
    done.append("Mailpit: the realm's set-up mail and Core's invitation mail for the invitee")

    # 3. The set-up, through the realm's pages.
    password = make_trust.password("invitee")
    secret = complete_actions(journey, links[-1], password)
    after = realm_user(journey, INVITEE)
    require(not after.get("requiredActions"), "required actions left after the set-up")
    require(after.get("emailVerified") is True, "the invitee's address is not verified")
    done.append("invitee set-up: address verified, password and one-time code set")
    account = {
        "realm": ORG_REALM,
        "password": password,
        "totp_base32": base64.b32encode(secret.encode("utf-8")).decode("ascii"),
    }
    if until == "set-up":
        invitee_file = journey_path.parent / "invitee.json"
        make_trust.write_private(
            invitee_file,
            json.dumps({"email": INVITEE, "invitation_id": invitation_id, **account}, indent=2)
            + "\n",
        )
        done.append(f"stopped after the set-up: invitation pending, sign-in in {invitee_file.name}")
        return done

    # 4. Sign-in, acceptance, /me.
    invitee_token = login(journey, INVITEE, account)
    status, membership = call(
        api,
        "POST",
        "/api/v1/invitations/accept",
        token=invitee_token,
        body={"token": tokens[0]},
        headers={"Idempotency-Key": idempotency_key("accept")},
    )
    require(
        status == 200 and isinstance(membership, dict), f"accept: {status} {problem(membership)}"
    )
    require(membership["state"] == "active" and membership["role"] == "org_member", "membership")
    done.append(f"invitee acceptInvitation: 200, membership {membership['id']} active org_member")
    status, again = call(
        api,
        "POST",
        "/api/v1/invitations/accept",
        token=invitee_token,
        body={"token": tokens[0]},
        headers={"Idempotency-Key": idempotency_key("accept-again")},
    )
    require(status == 409, f"a second acceptance answered {status}: {problem(again)}")
    done.append("the same link again: 409 conflict, single use")
    status, mine = call(api, "GET", "/api/v1/me", token=invitee_token)
    require(status == 200 and isinstance(mine, dict), f"the invitee's /me answered {status}")
    require(
        [(e["membership_id"], e["role"], e["state"]) for e in mine["organisations"]]
        == [(membership["id"], "org_member", "active")],
        "the invitee's /me does not show the membership",
    )
    done.append(f"invitee GET /api/v1/me: 200, active org_member of {ORG_REALM}")

    # 5. Removal reaches the realm.
    status, removed = call(
        api,
        "DELETE",
        f"/api/v1/organisations/{organisation_id}/memberships/{membership['id']}",
        token=owner_token,
    )
    require(status == 200 and removed["state"] == "removed", f"removal answered {status}")
    deliver(scheduler, "run_realm_deliveries")
    gone = realm_user(journey, INVITEE)
    status, sessions = call(
        journey["keycloak_origin"],
        "GET",
        f"/admin/realms/{ORG_REALM}/users/{gone['id']}/sessions",
        token=admin_token(journey),
    )
    require(gone.get("enabled") is False, "the removed member's realm user is still enabled")
    require(status == 200 and sessions == [], "the removed member still has a session")
    done.append(
        "owner removeMembership, then run_realm_deliveries: realm user disabled, 0 sessions"
    )
    try:
        login(journey, INVITEE, account)
    except FixtureError:
        done.append("the removed member's sign-in is refused")
    else:
        raise FixtureError("the removed member could still sign in")
    return done


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--journey", type=Path, default=RENDERED / "journey.json")
    parser.add_argument(
        "--scheduler",
        action="store_true",
        help="Deliver with one pass of run_operator_schedule instead of each --once command",
    )
    parser.add_argument("--until", choices=UNTIL, help="stop after this step")
    arguments = parser.parse_args(argv)
    try:
        for line in run(arguments.journey, scheduler=arguments.scheduler, until=arguments.until):
            print("ok", line)
    except FixtureError as error:
        print("refused:", error, file=sys.stderr)
        return 1
    except OSError as error:
        print(
            "unreachable:", type(error).__name__, "(is the stack up and rendered?)", file=sys.stderr
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
