"""The realm account delivery logs the person out right before it asks the realm to mail a set-up
link (docs/specs/INVITATIONS.md §4): the logout moves the account's notBefore, and identity realm tooling
refuses every link issued before it, so only the newest invitation's link works."""

import pytest

from apps.outbox.realm.keycloak import RealmCallError, RealmUserAbsentError
from apps.outbox.realm_accounts import ACTIONS_LIFESPAN_S, REQUIRED_ACTIONS, ensure_account

EMAIL = "marc@example.test"


class Realm:
    """The account endpoints, recording every call in order."""

    def __init__(self, pending=REQUIRED_ACTIONS, logout_error=None):
        self.calls = []
        self.logout_error = logout_error
        self.user = {
            "id": "user-1",
            "email": EMAIL,
            "enabled": True,
            "requiredActions": list(pending),
        }

    def users_by_email(self, email):
        return [dict(self.user)] if email == EMAIL else []

    def create_user(self, representation):
        raise AssertionError("the account exists")

    def logout(self, user_id):
        self.calls.append(("logout", user_id))
        if self.logout_error is not None:
            raise self.logout_error

    def execute_actions_email(
        self, user_id, actions, lifespan_s, *, client_id=None, redirect_uri=None
    ):
        self.calls.append(("send", user_id, tuple(actions), lifespan_s, redirect_uri))


@pytest.mark.parametrize("redirect", [None, "https://app.localhost/"])
def test_the_person_is_logged_out_right_before_the_set_up_mail(redirect):
    realm = Realm()
    assert ensure_account(realm, EMAIL, "fr", redirect) == ("user-1", True)
    assert realm.calls == [
        ("logout", "user-1"),
        ("send", "user-1", tuple(REQUIRED_ACTIONS), ACTIONS_LIFESPAN_S, redirect),
    ]


@pytest.mark.parametrize(
    "error",
    [
        RealmCallError("ambiguous", http_status=502),
        RealmCallError("permanent", http_status=400),
        RealmCallError("credential", http_status=401),
        RealmCallError("transport", cause="refused"),
        RealmUserAbsentError(),
    ],
    ids=["ambiguous", "permanent-400", "credential", "transport", "absent"],
)
@pytest.mark.parametrize("redirect", [None, "https://app.localhost/"])
def test_a_failed_logout_sends_nothing_and_fails_as_the_send_would(error, redirect):
    realm = Realm(logout_error=error)
    with pytest.raises(type(error)) as raised:
        ensure_account(realm, EMAIL, "fr", redirect)
    # The logout's own error, unchanged: a 400 to it is not the return address being refused.
    assert raised.value is error
    assert realm.calls == [("logout", "user-1")]


def test_an_account_with_nothing_pending_is_neither_logged_out_nor_mailed():
    # No link is mailed, so there is no older link to revoke and the sessions are left alone.
    realm = Realm(pending=[])
    assert ensure_account(realm, EMAIL, "fr") == ("user-1", False)
    assert realm.calls == []


def test_ordinary_account_setup_does_not_force_totp():
    assert REQUIRED_ACTIONS == ("VERIFY_EMAIL", "UPDATE_PASSWORD"), (
        "ordinary signup must leave TOTP optional"
    )
    realm = Realm()
    ensure_account(realm, EMAIL, "en")
    assert realm.calls[-1][2] == ("VERIFY_EMAIL", "UPDATE_PASSWORD")
