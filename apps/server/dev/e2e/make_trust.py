"""Render the live end-to-end identity fixture and the trust configuration Core pins for it.

TEST ONLY. Every key, password, one-time-code seed, user id and admin password this script
produces is derived from SEED, a public label committed below. Anyone can derive all of it, so
none of it is a secret and none of it may be trusted outside this fixture. Deriving instead of
committing keeps private-key material out of the tree (gitleaks and the private-key hook stay
unallowlisted) while every run still gets the same fixed keys, so Core's trust can pin them.

    uv run python -m dev.e2e.make_trust render     # writes dev/e2e/rendered/ (gitignored)
    uv run python -m dev.e2e.make_trust trust      # prints KODERA_AUTH_TRUST
    uv run python -m dev.e2e.make_trust selftest   # offline proof; must pass before any bring-up
    uv run python -m dev.e2e.make_trust probe      # against the running stack (dev/e2e/README.md)
    uv run python -m dev.e2e.journey               # then: a fully journeyed organisation

Run from the repository root: the self-test and the probe use Core's own trust loader and
token verifier, never a re-implementation of them.
"""

import argparse
import base64
import copy
import hashlib
import hmac
import http.client
import json
import os
import secrets
import struct
import sys
import time
import uuid
from collections.abc import Callable
from html.parser import HTMLParser
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TEMPLATES = HERE / "realms"
RENDERED = HERE / "rendered"

# The one public label everything is derived from. Changing it rotates every fixture value.
SEED = b"kodera-core live end-to-end fixture v1 | TEST ONLY | public, never a secret"

STAFF_REALM = "kodera-staff"  # docs/specs/STAFF_IDENTITY.md section 1: a constant
ORG_REALM = "e2e-pilot"  # Organisation.slug == Organisation.realm, 5-20 characters
REALMS = (STAFF_REALM, ORG_REALM)
LANES = {STAFF_REALM: "staff", ORG_REALM: "customer"}
STAFF_USERS = ("staff-one", "staff-two")  # the two-person rule needs two operators
ORG_USERS = ("owner", "member")
OWNER_MODES = ("template", "test-credentials")

GENERATION = "e2e-fixed-v1"
# Fixed so the rendered trust is byte-identical on every run. 2036-01-01T00:00:00Z.
EXPIRES_AT = 2082758400

DEFAULT_KEYCLOAK_ORIGIN = "http://localhost:8180"
DEFAULT_CONSOLE_ORIGIN = "http://localhost:4173"
DEFAULT_API_ORIGIN = "http://localhost:8100"
DEFAULT_MAILPIT_ORIGIN = "http://localhost:8125"

# The registered-factor claim Core reads (services/identity/access_tokens.py). In production a
# provider of identity realm tooling will emit it from the user's stored OTP credential (identity realm tooling
# #59, open); the stock image here has no such provider, so the organisation realm's console client carries a hardcoded `true`,
# which holds by construction in this realm only: its browser flow requires a code of every user,
# so every token it issues belongs to a user with an OTP credential.
# The organisation realm's own service-account client, as realm-apply step 3 of identity realm tooling
# creates it: the realm worker turns users off and on and creates invitees' accounts with it
# (worker/credentials/realm.py). Its secret is rendered into one file per realm, which `ops` reads
# from the read-only checkout.
WORKER_CLIENT = "kodera-identity-worker"
WORKER_ROLES = ["manage-users", "view-users"]

REGISTERED_FACTOR_CLAIM = "kodera_mfa_enrolled"
REGISTERED_FACTOR_MAPPER = "e2e-test-only-registered-factor"

TOTP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
TOTP_DIGITS = 6
TOTP_PERIOD = 30
# Order of the P-256 group: a private scalar must lie in [1, n - 1].
P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


class FixtureError(Exception):
    """A closed refusal: the message names the check, never a derived value."""


class CodeRefused(FixtureError):  # noqa: N818 - a refusal, named as the others are
    """The provider answered the one-time-code step with the form again: the code was spent (a
    code is single-use within its step) or out of step. A caller may retry at the next step."""


def write_private(path: Path, text: str) -> None:
    """Write a file only its owner can read, created at mode 0600 rather than narrowed after.

    A symlink at the path is refused, not followed: it would write the secrets wherever it points."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        # A file left by an earlier render keeps its mode through O_CREAT: narrow it first.
        os.fchmod(handle.fileno(), 0o600)
        handle.write(text)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise FixtureError(message)


# --- Derivation ------------------------------------------------------------------------------


def derive(label: str, seed: bytes = SEED) -> bytes:
    return hmac.new(seed, label.encode("utf-8"), hashlib.sha256).digest()


def signing_key(realm: str, seed: bytes = SEED) -> ec.EllipticCurvePrivateKey:
    scalar = int.from_bytes(derive("signing-key:" + realm, seed), "big") % (P256_ORDER - 1) + 1
    return ec.derive_private_key(scalar, ec.SECP256R1())


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def spki(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def key_id(key: ec.EllipticCurvePrivateKey) -> str:
    """Keycloak's own kid: base64url, unpadded, of SHA-256 over the X.509 public key encoding
    (KeyUtils.createKeyId). The probe proves the live JWKS agrees."""
    return b64url(hashlib.sha256(spki(key)).digest())


def public_jwk(key: ec.EllipticCurvePrivateKey) -> dict[str, str]:
    numbers = key.public_key().public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "kid": key_id(key),
        "use": "sig",
        "alg": "ES256",
        "x": b64url(numbers.x.to_bytes(32, "big")),
        "y": b64url(numbers.y.to_bytes(32, "big")),
    }


def password(user: str, seed: bytes = SEED) -> str:
    return "e2e-test-only-" + b64url(derive("password:" + user, seed))[:20]


def totp_secret(user: str, seed: bytes = SEED) -> str:
    """Keycloak's stored OTP value; the HMAC key is its UTF-8 bytes (OTPCredentialModel)."""
    raw = derive("totp:" + user, seed)
    return "".join(TOTP_ALPHABET[byte % len(TOTP_ALPHABET)] for byte in raw[:20])


def user_id(user: str, seed: bytes = SEED) -> str:
    """Fixed Keycloak user id, so a token's `sub` is known before the stack starts."""
    return str(uuid.UUID(bytes=derive("user-id:" + user, seed)[:16], version=4))


def totp(key: bytes, at: float, *, digits: int = TOTP_DIGITS, period: int = TOTP_PERIOD) -> str:
    """RFC 6238 over HMAC-SHA1, what the realm's OTP policy configures."""
    counter = struct.pack(">Q", int(at) // period)
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 10**digits
    return str(code).zfill(digits)


# --- Rendering -------------------------------------------------------------------------------


def issuer(keycloak_origin: str, realm: str) -> str:
    return f"{keycloak_origin}/realms/{realm}"


def key_components(realm: str, seed: bytes = SEED) -> dict[str, list[dict[str, object]]]:
    key = signing_key(realm, seed)
    private = key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    providers: list[dict[str, object]] = [
        {
            # The provider that reads ecdsaPrivateKey/ecdsaPublicKey as given and keeps them when
            # both are present and on the configured curve (AbstractGeneratedEcKeyProviderFactory).
            "name": "e2e-fixed-es256",
            "providerId": "ecdsa-generated",
            "subComponents": {},
            "config": {
                "priority": ["1000"],
                "enabled": ["true"],
                "active": ["true"],
                "ecdsaEllipticCurveKey": ["P-256"],
                "ecdsaPrivateKey": [base64.b64encode(private).decode("ascii")],
                "ecdsaPublicKey": [base64.b64encode(spki(key)).decode("ascii")],
            },
        },
        # Any key provider in the import suppresses Keycloak's defaults (DefaultKeyProviders runs
        # only when there is none), so the two internal ones are declared; their secrets are
        # generated at import. HS512 signs refresh and action tokens.
        {
            "name": "hmac-generated-hs512",
            "providerId": "hmac-generated",
            "subComponents": {},
            "config": {"priority": ["100"], "algorithm": ["HS512"]},
        },
        {
            "name": "aes-generated",
            "providerId": "aes-generated",
            "subComponents": {},
            "config": {"priority": ["100"]},
        },
    ]
    return {"org.keycloak.keys.KeyProvider": providers}


def credentials(user: str, seed: bytes = SEED) -> list[dict[str, object]]:
    return [
        {"type": "password", "value": password(user, seed), "temporary": False},
        {
            "type": "otp",
            "userLabel": "e2e test-only seed",
            "secretData": json.dumps({"value": totp_secret(user, seed)}),
            "credentialData": json.dumps(
                {
                    "subType": "totp",
                    "digits": TOTP_DIGITS,
                    "counter": 0,
                    "period": TOTP_PERIOD,
                    "algorithm": "HmacSHA1",
                }
            ),
        },
    ]


def load_template(realm: str) -> dict[str, Any]:
    value = json.loads((TEMPLATES / f"{realm}.json").read_text(encoding="utf-8"))
    require(isinstance(value, dict) and value.get("realm") == realm, "realm template mismatch")
    return value


def render_realm(
    realm: str, console_origin: str, owner_mode: str, seed: bytes = SEED
) -> dict[str, Any]:
    require(owner_mode in OWNER_MODES, "unknown owner mode")
    value = copy.deepcopy(load_template(realm))
    value["components"] = key_components(realm, seed)
    clients = value["clients"]
    require(isinstance(clients, list) and len(clients) == 1, "one console client expected")
    client = clients[0]
    client["rootUrl"] = console_origin
    client["baseUrl"] = "/"
    # As the customer realm template registers them (identity realm tooling): the Console's claim page
    # signs the owner in through its own callback, distinct from the ordinary one.
    client["redirectUris"] = [
        console_origin + "/auth/callback",
        console_origin + "/auth/claim-callback",
    ]
    client["webOrigins"] = [console_origin]
    client["attributes"]["post.logout.redirect.uris"] = console_origin + "/*"
    users = value["users"]
    require(isinstance(users, list), "users expected")
    for user in users:
        name = user["username"]
        user["id"] = user_id(name, seed)
        if realm == STAFF_REALM:
            user["credentials"] = credentials(name, seed)
        elif owner_mode == "test-credentials":
            # TEST-ONLY VARIANT: the pilot binding (`bind_intended_owner`, FIRST_OWNER_BOOTSTRAP.md
            # section 5.6) expects these accounts credential-free with required actions.
            # Presetting a password and a code skips the actions e-mail so automation can sign
            # in; it never describes a real organisation realm.
            user["credentials"] = credentials(name, seed)
            user["requiredActions"] = []
            user["emailVerified"] = True
        else:
            require(not user.get("credentials"), "template account must be credential-free")
    if realm == ORG_REALM:
        client, account = worker_client(realm, seed)
        clients.append(client)
        users.append(account)
    if realm == ORG_REALM and owner_mode == "test-credentials":
        value["displayName"] = str(value["displayName"]) + " [TEST-ONLY preset owner credentials]"
    return value


def worker_secret(realm: str, seed: bytes = SEED) -> str:
    return "e2e-test-only-" + derive(f"realm-worker-secret:{realm}", seed).hex()


def worker_client(realm: str, seed: bytes = SEED) -> tuple[dict[str, Any], dict[str, Any]]:
    """The realm worker's confidential client and its service-account user: client credentials
    only, `manage-users` and `view-users` of `realm-management` and nothing else."""
    client = {
        "clientId": WORKER_CLIENT,
        "name": "Kodera identity worker (e2e, test only)",
        "enabled": True,
        "publicClient": False,
        "clientAuthenticatorType": "client-secret",
        "secret": worker_secret(realm, seed),
        "serviceAccountsEnabled": True,
        "standardFlowEnabled": False,
        "implicitFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "protocol": "openid-connect",
    }
    user = {
        "username": f"service-account-{WORKER_CLIENT}",
        "enabled": True,
        "serviceAccountClientId": WORKER_CLIENT,
        "clientRoles": {"realm-management": list(WORKER_ROLES)},
    }
    return client, user


def console_client_id() -> str:
    """The Console's OAuth client id, read from the realm templates, which must agree: Core's
    KODERA_CONSOLE_CLIENT_ID is this value, so the two cannot drift apart."""
    found = {load_template(realm)["clients"][0]["clientId"] for realm in REALMS}
    require(len(found) == 1, "the realms name different console clients")
    return str(found.pop())


def trust_entries(keycloak_origin: str, seed: bytes = SEED) -> list[dict[str, object]]:
    return [
        {
            "lane": LANES[realm],
            "issuer": issuer(keycloak_origin, realm),
            "generation": GENERATION,
            "expires_at": EXPIRES_AT,
            "public_jwks": {"keys": [public_jwk(signing_key(realm, seed))]},
        }
        for realm in REALMS
    ]


def trust_json(keycloak_origin: str, seed: bytes = SEED) -> str:
    return json.dumps(trust_entries(keycloak_origin, seed), separators=(",", ":"), sort_keys=True)


def port_of(origin: str) -> int:
    parsed = urlsplit(origin)
    try:
        port = parsed.port
    except ValueError:  # Out of 0-65535, or not a number.
        port = None
    require(
        parsed.scheme == "http"
        and parsed.hostname == "localhost"
        and port is not None
        and parsed.path == ""
        and not parsed.query
        and not parsed.fragment,
        "an origin must be http://localhost:<port>",
    )
    return int(port or 0)


def render(
    out: Path = RENDERED,
    *,
    keycloak_origin: str = DEFAULT_KEYCLOAK_ORIGIN,
    console_origin: str = DEFAULT_CONSOLE_ORIGIN,
    api_origin: str = DEFAULT_API_ORIGIN,
    mailpit_origin: str = DEFAULT_MAILPIT_ORIGIN,
    owner_mode: str = "template",
    seed: bytes = SEED,
) -> dict[str, Any]:
    ports = {
        name: port_of(o)
        for name, o in (
            ("keycloak", keycloak_origin),
            ("console", console_origin),
            ("api", api_origin),
            ("mailpit", mailpit_origin),
        )
    }
    require(len(set(ports.values())) == len(ports), "every origin needs its own port")
    # Keycloak listens on its origin's own port inside the shared namespace, as a nonroot user.
    require(ports["keycloak"] >= 1024, "provider port must be unprivileged")
    realms_dir = out / "realms"
    realms_dir.mkdir(parents=True, exist_ok=True)
    # The import directory is read by the provider container's own user.
    realms_dir.chmod(0o755)
    for realm in REALMS:
        target = realms_dir / f"{realm}.json"
        target.write_text(
            json.dumps(render_realm(realm, console_origin, owner_mode, seed), indent=2) + "\n",
            encoding="utf-8",
        )
        target.chmod(0o644)
    # The realm worker's credential source: one file per organisation realm, readable by the
    # operator container's own user through the read-only checkout.
    workers_dir = out / "realm-workers"
    workers_dir.mkdir(parents=True, exist_ok=True)
    workers_dir.chmod(0o755)
    secret_file = workers_dir / ORG_REALM
    secret_file.write_text(worker_secret(ORG_REALM, seed) + "\n", encoding="ascii")
    secret_file.chmod(0o644)
    trust = trust_json(keycloak_origin, seed)
    staff_issuer = issuer(keycloak_origin, STAFF_REALM)
    # Interpolation input for `docker compose --env-file`, never a container env_file: compose.yaml
    # names each variable each service receives. Single quotes keep the JSON literal.
    environment = {
        "KODERA_AUTH_TRUST": trust,
        "KODERA_STAFF_ISSUER": staff_issuer,
        "KODERA_MEMBERSHIP_CURSOR_KEY": derive("membership-cursor-key", seed).hex(),
        "KODERA_CONTACT_SEAL_KEY": base64.urlsafe_b64encode(
            derive("contact-seal-key", seed)
        ).decode("ascii"),
        # discoverRealm's quota key: exactly 32 bytes, canonical standard base64 (44 characters).
        "KODERA_DISCOVERY_HMAC_KEY": base64.b64encode(derive("discovery-hmac-key", seed)).decode(
            "ascii"
        ),
        "KODERA_CONSOLE_CLIENT_ID": console_client_id(),
        "KODERA_CONSOLE_ORIGINS": console_origin,
        # The operator side's mail: the outbox seal key, and the Console origin and claim landing
        # the owner claim's link is built on (the Console's route is /claim/<id>/<slug>).
        "KODERA_OUTBOX_SEAL_KEY": base64.urlsafe_b64encode(derive("outbox-seal-key", seed)).decode(
            "ascii"
        ),
        "KODERA_MAIL_LINK_ORIGINS": console_origin,
        "KODERA_OWNER_CLAIM_LINK": console_origin + "/claim",
        # The invitation mail's link: the Console's acceptance page, the token its fragment.
        "KODERA_INVITATION_LINK": console_origin + "/invitations/accept",
        "E2E_DJANGO_SECRET_KEY": "e2e-test-only-" + derive("django-secret-key", seed).hex(),
        "E2E_KEYCLOAK_ADMIN_PASSWORD": password("keycloak-bootstrap-admin", seed),
        "E2E_KEYCLOAK_ORIGIN": keycloak_origin,
        "E2E_KEYCLOAK_PORT": str(ports["keycloak"]),
        "E2E_API_PORT": str(ports["api"]),
        "E2E_MAILPIT_PORT": str(ports["mailpit"]),
    }
    for name, item in environment.items():
        require("'" not in item and "\n" not in item, f"{name} cannot be quoted")
    env_file = out / "compose.env"
    write_private(
        env_file,
        "# TEST ONLY, rendered by dev/e2e/make_trust.py; every value is derived from a public label.\n"
        + "".join(f"{name}='{item}'\n" for name, item in environment.items()),
    )
    accounts: dict[str, dict[str, Any]] = {}
    for realm, names in ((STAFF_REALM, STAFF_USERS), (ORG_REALM, ORG_USERS)):
        preset = realm == STAFF_REALM or owner_mode == "test-credentials"
        for name in names:
            accounts[name] = {
                "realm": realm,
                "username": name,
                "subject": user_id(name, seed),
                "email": next(
                    u["email"] for u in load_template(realm)["users"] if u["username"] == name
                ),
                "password": password(name, seed) if preset else None,
                # Base32 of the stored value's UTF-8 bytes: what an authenticator app is given.
                "totp_base32": base64.b32encode(totp_secret(name, seed).encode()).decode()
                if preset
                else None,
            }
            if name == "owner" and not preset:
                # Set by `python -m dev.e2e.journey` after the binding, which needs the account
                # credential-free (TEST ONLY: it stands in for the owner's actions e-mail).
                accounts[name]["after_binding"] = {
                    "password": password(name, seed),
                    "totp_base32": base64.b32encode(totp_secret(name, seed).encode()).decode(),
                }
    journey: dict[str, Any] = {
        "test_only": "Every value here is derived from a public label; never reuse one.",
        "owner_mode": owner_mode,
        "keycloak_origin": keycloak_origin,
        "keycloak_admin": {
            "username": "admin",
            "password": environment["E2E_KEYCLOAK_ADMIN_PASSWORD"],
        },
        "console_origin": console_origin,
        "api_origin": api_origin,
        "mailpit_origin": mailpit_origin,
        "staff_issuer": staff_issuer,
        "organisation": {
            "slug": ORG_REALM,
            "realm": ORG_REALM,
            "issuer": issuer(keycloak_origin, ORG_REALM),
        },
        "accounts": accounts,
    }
    journey_file = out / "journey.json"
    write_private(journey_file, json.dumps(journey, indent=2) + "\n")
    return journey


# --- Offline self-test -----------------------------------------------------------------------


def es256_token(key: ec.EllipticCurvePrivateKey, claims: dict[str, object]) -> str:
    import jwt

    return jwt.encode(claims, key, algorithm="ES256", headers={"kid": key_id(key)})


def access_claims(iss: str, *, amr: list[str] | None = None) -> dict[str, object]:
    now = int(time.time())
    claims: dict[str, object] = {
        "iss": iss,
        "sub": user_id("staff-one"),
        "aud": ["kodera-server"],
        "iat": now,
        "exp": now + 300,
        "typ": "Bearer",
        # Keycloak names the client a token was issued to; the customer lane admits only its
        # allowed clients (config.environment.allowed_oidc_client_ids), the realms' console one.
        "azp": console_client_id(),
    }
    if amr is not None:
        claims["amr"] = amr
    return claims


def realm_private_key(rendered: dict[str, Any]) -> ec.EllipticCurvePrivateKey:
    components = rendered["components"]
    require(isinstance(components, dict), "components expected")
    fixed = [
        c for c in components["org.keycloak.keys.KeyProvider"] if c["name"] == "e2e-fixed-es256"
    ]
    require(len(fixed) == 1, "one fixed signing provider expected")
    loaded = serialization.load_der_private_key(
        base64.b64decode(fixed[0]["config"]["ecdsaPrivateKey"][0]), password=None
    )
    require(isinstance(loaded, ec.EllipticCurvePrivateKey), "fixed key is not an EC key")
    assert isinstance(loaded, ec.EllipticCurvePrivateKey)  # noqa: S101 - narrows for the type checker
    return loaded


def check_realm(rendered: dict[str, Any], realm: str, owner_mode: str) -> None:
    """The realm properties the journey and Core rely on, read off the rendered import."""
    require(rendered["realm"] == realm, "realm name")
    require(rendered["defaultSignatureAlgorithm"] == "ES256", "tokens must use the fixed key")
    flows = {flow["alias"]: flow for flow in rendered["authenticationFlows"]}
    require(rendered["browserFlow"] in flows, "browser flow must be the declared one")
    forms = flows["e2e browser forms"]["authenticationExecutions"]
    otp = [e for e in forms if e.get("authenticator") == "auth-otp-form"]
    require(len(otp) == 1 and otp[0]["requirement"] == "REQUIRED", "a one-time code is required")
    # Every sign-in passes the code, whatever the account's required actions: an invitee whose
    # account existed already with none pending is asked for it too (INVITATIONS.md §5). The only
    # other path is the session cookie, which only those forms can have set.
    top = [
        (e.get("authenticator") or e.get("flowAlias"), e.get("requirement"))
        for e in flows[rendered["browserFlow"]]["authenticationExecutions"]
    ]
    steps = [(e.get("authenticator"), e.get("requirement")) for e in forms]
    require(
        top == [("auth-cookie", "ALTERNATIVE"), ("e2e browser forms", "ALTERNATIVE")]
        and steps == [("auth-username-password-form", "REQUIRED"), ("auth-otp-form", "REQUIRED")],
        "every browser sign-in must pass the one-time code",
    )
    configs = {c["alias"]: c["config"] for c in rendered["authenticatorConfig"]}
    require(
        configs[otp[0]["authenticatorConfig"]]["default.reference.value"] == "otp",
        "the code step must put otp in amr (AUTHZ section 3)",
    )
    require(
        int(configs[otp[0]["authenticatorConfig"]]["default.reference.maxAge"]) > 0,
        "an amr max age of 0 expires the reference within the second",
    )
    client = rendered["clients"][0]
    require(
        client["clientId"] == "console"
        and client["publicClient"] is True
        and client["directAccessGrantsEnabled"] is False
        and client["implicitFlowEnabled"] is False
        and client["attributes"]["pkce.code.challenge.method"] == "S256",
        "console must be a public PKCE client with no password grant",
    )
    mappers = {m["protocolMapper"]: m.get("config", {}) for m in client["protocolMappers"]}
    audience = mappers.get("oidc-audience-mapper", {})
    require(
        audience.get("included.custom.audience") == "kodera-server"
        and audience.get("access.token.claim") == "true",
        "access tokens must carry Core's audience",
    )
    require(
        mappers.get("oidc-amr-mapper", {}).get("access.token.claim") == "true",
        "amr in access tokens",
    )
    factor = [m for m in client["protocolMappers"] if m["name"] == REGISTERED_FACTOR_MAPPER]
    if realm == ORG_REALM:
        # consumeOwnerClaim refuses a token without it (FIRST_OWNER_BOOTSTRAP.md section 8).
        missing = "the organisation realm's console tokens must carry the registered-factor claim"
        require(len(factor) == 1, missing)
        config = factor[0].get("config", {})
        require(
            factor[0]["protocolMapper"] == "oidc-hardcoded-claim-mapper"
            and config.get("claim.name") == REGISTERED_FACTOR_CLAIM
            and config.get("claim.value") == "true"
            and config.get("jsonType.label") == "boolean"
            and config.get("access.token.claim") == "true",
            missing,
        )
    else:
        require(not factor, "only the organisation realm carries the registered-factor stand-in")
    workers = [c for c in rendered["clients"] if c["clientId"] == WORKER_CLIENT]
    if realm == ORG_REALM:
        require(
            len(workers) == 1
            and workers[0]["publicClient"] is False
            and workers[0]["serviceAccountsEnabled"] is True
            and workers[0]["standardFlowEnabled"] is False
            and workers[0]["directAccessGrantsEnabled"] is False,
            "the realm worker must be a confidential client-credentials client",
        )
        accounts = [u for u in rendered["users"] if u.get("serviceAccountClientId")]
        require(
            [u["clientRoles"] for u in accounts] == [{"realm-management": WORKER_ROLES}],
            "the realm worker holds manage-users and view-users and nothing else",
        )
    else:
        require(not workers, "only the organisation realm has a realm worker")
    for user in rendered["users"]:
        if user.get("serviceAccountClientId"):
            continue
        has_credentials = bool(user.get("credentials"))
        if realm == STAFF_REALM or owner_mode == "test-credentials":
            kinds = sorted(c["type"] for c in user["credentials"])
            require(kinds == ["otp", "password"], "seeded accounts carry a password and a code")
        else:
            require(
                not has_credentials
                and {"UPDATE_PASSWORD", "CONFIGURE_TOTP"} <= set(user["requiredActions"]),
                "template accounts are credential-free with required actions",
            )


def read_env(path: Path) -> dict[str, str]:
    """compose.env as written by render: NAME='value' lines, values never holding a quote."""
    return {
        name: value.strip("'")
        for name, value in (
            line.split("=", 1)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line and not line.startswith("#")
        )
    }


def check_settings(env: dict[str, str], console_origin: str = DEFAULT_CONSOLE_ORIGIN) -> None:
    """Each rendered value the API and `ops` read passes Core's own parser, and the one the
    deployed profiles must refuse (a plain-http Console origin) is refused without the e2e flag."""
    from django.core.exceptions import ImproperlyConfigured

    from apps.orgs.claim_configuration import ClaimConfigurationError, claim_link
    from apps.outbox.mail.links import origins_from_environment
    from apps.outbox.mail.seal import key_from_environment as outbox_key
    from config.environment import console_client_id as core_console_client_id
    from core.sealing import key_from_environment
    from services.identity.discovery_input import allowed_origins
    from services.identity.discovery_policy import DiscoveryUnavailableError, configured_key

    try:
        require(len(configured_key(env["KODERA_DISCOVERY_HMAC_KEY"])) == 32, "discovery key")
        require(outbox_key(env) is not None, "outbox seal key")
        require(key_from_environment(env, "KODERA_CONTACT_SEAL_KEY") is not None, "contact key")
        require(core_console_client_id(env) == console_client_id(), "console client id")
        origins = origins_from_environment(env)
        require(origins == frozenset({console_origin}), "mail link origins")
        require(claim_link(env, origins) == console_origin + "/claim", "owner claim link")
    except (DiscoveryUnavailableError, ImproperlyConfigured, ClaimConfigurationError):
        raise FixtureError("Core refused a rendered setting") from None
    require(
        allowed_origins(env["KODERA_CONSOLE_ORIGINS"], loopback_http=True)
        == frozenset({console_origin}),
        "the e2e profile refused the stack's Console origin",
    )
    require(
        allowed_origins(env["KODERA_CONSOLE_ORIGINS"]) is None,
        "a deployed profile would admit a plain-http Console origin",
    )


def selftest() -> list[str]:
    """Offline proof, with a refusal beside every acceptance. Returns the names of the checks."""
    import tempfile

    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from django.core.exceptions import ImproperlyConfigured

    from config.environment import staff_issuer
    from services.identity.access_tokens import TokenVerificationError
    from services.identity.trusted_issuers import load_trust, verify_configured_token

    passed: list[str] = []

    def refused(action: Callable[[], object], error_type: type[Exception], message: str) -> None:
        try:
            action()
        except error_type:
            return
        raise FixtureError(message)

    # 1. Derivation is fixed, and the seed is what fixes it.
    require(key_id(signing_key(STAFF_REALM)) == key_id(signing_key(STAFF_REALM)), "unstable key")
    require(
        key_id(signing_key(STAFF_REALM)) != key_id(signing_key(ORG_REALM)), "realms share a key"
    )
    require(
        key_id(signing_key(STAFF_REALM, b"other")) != key_id(signing_key(STAFF_REALM)),
        "the seed does not reach the key",
    )
    require(trust_json(DEFAULT_KEYCLOAK_ORIGIN) == trust_json(DEFAULT_KEYCLOAK_ORIGIN), "unstable")
    passed.append("derivation-fixed")

    # 2. RFC 6238 appendix B, SHA-1, T=59: 94287082, so 287082 at six digits.
    require(totp(b"12345678901234567890", 59, digits=8) == "94287082", "TOTP vector")
    require(totp(b"12345678901234567890", 59) == "287082", "TOTP six digits")
    require(totp(b"12345678901234567890", 89) != "287082", "TOTP ignores the time step")
    passed.append("totp-rfc6238")

    with tempfile.TemporaryDirectory(prefix="e2e-trust-selftest-") as directory:
        for mode in OWNER_MODES:
            journey = render(Path(directory) / mode, owner_mode=mode)
            require(journey["owner_mode"] == mode, "owner mode not recorded")
            rendered = {
                realm: json.loads((Path(directory) / mode / "realms" / f"{realm}.json").read_text())
                for realm in REALMS
            }
            for realm in REALMS:
                check_realm(rendered[realm], realm, mode)
            env = (Path(directory) / mode / "compose.env").read_text()
            require(f"KODERA_AUTH_TRUST='{trust_json(DEFAULT_KEYCLOAK_ORIGIN)}'" in env, "env")
        passed.append("realms-shape")
        # A template account given a credential is refused by the shape check.
        broken = copy.deepcopy(rendered[ORG_REALM])
        broken["users"][0]["credentials"] = credentials("owner")
        refused(lambda: check_realm(broken, ORG_REALM, "template"), FixtureError, "credential")
        broken = copy.deepcopy(rendered[STAFF_REALM])
        broken["authenticationFlows"][1]["authenticationExecutions"][1]["requirement"] = "OPTIONAL"
        refused(lambda: check_realm(broken, STAFF_REALM, "template"), FixtureError, "OTP optional")
        passed.append("realms-shape-refusals")

        # 3. Core's own loader admits the trust, and the staff issuer is on the staff lane.
        trust_raw = trust_json(DEFAULT_KEYCLOAK_ORIGIN)
        trusted = load_trust(trust_raw)
        require([t.lane for t in trusted] == ["staff", "customer"], "lanes")
        staff = issuer(DEFAULT_KEYCLOAK_ORIGIN, STAFF_REALM)
        require(
            staff_issuer(
                {"KODERA_STAFF_ISSUER": staff, "KODERA_AUTH_TRUST": trust_raw},
                loopback_issuers=True,
            )
            == staff,
            "Core refused the staff issuer",
        )
        swapped = json.loads(trust_raw)
        swapped[0]["lane"], swapped[1]["lane"] = "customer", "staff"
        refused(
            lambda: staff_issuer(
                {"KODERA_STAFF_ISSUER": staff, "KODERA_AUTH_TRUST": json.dumps(swapped)},
                loopback_issuers=True,
            ),
            ImproperlyConfigured,
            "a staff issuer on the customer lane was admitted",
        )
        passed.append("core-admits-trust")

        # 3a. Core's own parsers admit every other rendered setting; a mangled one is refused.
        settings = read_env(Path(directory) / "template" / "compose.env")
        check_settings(settings)
        key = settings["KODERA_DISCOVERY_HMAC_KEY"]
        mangled = {**settings, "KODERA_DISCOVERY_HMAC_KEY": key[:-1]}
        refused(lambda: check_settings(mangled), FixtureError, "a short discovery key passed")
        passed.append("core-admits-settings")

        # 4. The key Keycloak imports signs what the pinned key verifies, in the right lane.
        for realm in REALMS:
            imported = realm_private_key(rendered[realm])
            token = es256_token(
                imported, access_claims(issuer(DEFAULT_KEYCLOAK_ORIGIN, realm), amr=["pwd", "otp"])
            )
            verified, lane = verify_configured_token(token, trusted=trusted)
            require(lane == LANES[realm] and "otp" in (verified.amr or ()), "lane or amr")
        # Signed by the other realm's key under this realm's issuer: refused.
        forged = es256_token(
            signing_key(ORG_REALM), access_claims(issuer(DEFAULT_KEYCLOAK_ORIGIN, STAFF_REALM))
        )
        refused(
            lambda: verify_configured_token(forged, trusted=trusted),
            TokenVerificationError,
            "a token signed by another realm's key was admitted",
        )
        # A different seed's key: refused.
        stranger = es256_token(
            signing_key(STAFF_REALM, b"another seed"),
            access_claims(issuer(DEFAULT_KEYCLOAK_ORIGIN, STAFF_REALM)),
        )
        refused(
            lambda: verify_configured_token(stranger, trusted=trusted),
            TokenVerificationError,
            "a token from a key nobody pinned was admitted",
        )
        passed.append("imported-key-verifies")
    return passed


# --- Live probe ------------------------------------------------------------------------------


class Forms(HTMLParser):
    """Every <form> with its action and its named inputs."""

    def __init__(self) -> None:
        super().__init__()
        self.forms: list[dict[str, Any]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "form":
            self.forms.append({"action": attributes.get("action"), "inputs": {}})
        elif tag == "input" and self.forms and attributes.get("name"):
            self.forms[-1]["inputs"][attributes["name"]] = attributes.get("value") or ""


class Browser:
    """A loopback-only client: fixed origin, no proxy, no redirect following, bounded bodies."""

    def __init__(self, origin: str) -> None:
        port_of(origin)
        self.origin = origin
        self.cookies = SimpleCookie()

    def request(
        self, method: str, target: str, body: dict[str, str] | None = None
    ) -> tuple[int, dict[str, str], bytes]:
        parsed = urlsplit(target)
        require(
            not parsed.scheme or f"{parsed.scheme}://{parsed.netloc}" == self.origin,
            "the provider sent the probe to another origin",
        )
        path = parsed.path + ("?" + parsed.query if parsed.query else "")
        connection = http.client.HTTPConnection("localhost", port_of(self.origin), timeout=10)
        headers = {"Accept": "text/html, application/json"}
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{k}={v.value}" for k, v in self.cookies.items())
        encoded = None
        if body is not None:
            encoded = urlencode(body)
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        try:
            connection.request(method, path, body=encoded, headers=headers)
            response = connection.getresponse()
            data = response.read(512 * 1024)
            for name, value in response.getheaders():
                if name.lower() == "set-cookie":
                    self.cookies.load(value)
            return response.status, dict(response.getheaders()), data
        finally:
            connection.close()


def login(
    journey: dict[str, Any], username: str, account: dict[str, Any] | None = None
) -> dict[str, str]:
    """Authorization code + PKCE through the realm's real browser flow: password, then code.
    `account` overrides the journey's record of the account (the owner after its binding)."""
    account = account or journey["accounts"][username]
    require(account["password"] is not None, f"{username} has no preset credentials")
    realm = account["realm"]
    origin = str(journey["keycloak_origin"])
    callback = str(journey["console_origin"]) + "/auth/callback"  # intercepted, never requested
    browser = Browser(origin)
    verifier = secrets.token_urlsafe(48)
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    state = secrets.token_urlsafe(16)
    status, _, body = browser.request(
        "GET",
        f"/realms/{realm}/protocol/openid-connect/auth?"
        + urlencode(
            {
                "client_id": "console",
                "redirect_uri": callback,
                "response_type": "code",
                "scope": "openid profile email",
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        ),
    )
    require(status == 200, "authorization page refused")
    key = base64.b32decode(account["totp_base32"])
    steps = (
        {"username": username, "password": account["password"]},
        {"otp": None},
    )
    location = None
    for step in steps:
        parser = Forms()
        parser.feed(body.decode("utf-8"))
        forms = [f for f in parser.forms if "/login-actions/" in str(f["action"])]
        require(len(forms) == 1, "expected exactly one login form")
        fields = {k: v for k, v in forms[0]["inputs"].items() if k not in step}
        if "otp" in step:
            fields["otp"] = totp(key, time.time())
        else:
            fields.update(step)
        status, headers, body = browser.request("POST", str(forms[0]["action"]), fields)
        if status == 302:
            location = headers.get("Location") or headers.get("location")
            break
        require(status == 200, "login step refused")
        if "otp" in step:
            raise CodeRefused("the one-time code was refused: spent, or out of step")
    require(location is not None, "the flow never redirected: is the code step missing?")
    redirected = urlsplit(str(location))
    require(f"{redirected.scheme}://{redirected.netloc}{redirected.path}" == callback, "callback")
    query = parse_qs(redirected.query)
    require(query.get("state") == [state] and len(query.get("code", [])) == 1, "state or code")
    status, _, body = browser.request(
        "POST",
        f"/realms/{realm}/protocol/openid-connect/token",
        {
            "grant_type": "authorization_code",
            "client_id": "console",
            "redirect_uri": callback,
            "code": query["code"][0],
            "code_verifier": verifier,
        },
    )
    require(status == 200, "token exchange refused")
    return json.loads(body)


PROBLEMS = "https://kodera.io/problems/"


def api_get(origin: str, path: str, token: str) -> tuple[int, dict[str, str], bytes]:
    """One bearer GET to the API; the status, the headers (names lower-cased) and the body."""
    connection = http.client.HTTPConnection("localhost", port_of(origin), timeout=5)
    try:
        connection.request("GET", path, headers={"Authorization": "Bearer " + token})
        response = connection.getresponse()
        return (
            response.status,
            {name.lower(): value for name, value in response.getheaders()},
            response.read(64 * 1024),
        )
    finally:
        connection.close()


def require_refusal(
    response: tuple[int, dict[str, str], bytes], *, status: int, kind: str, what: str
) -> None:
    """A refusal of a token that verified: `status`, the problem type `kind`, and no
    WWW-Authenticate, which only a token that fails verification is answered with (`401`)."""
    answered, headers, body = response
    require(answered == status, f"{what} answered {answered}, not {status} {kind}")
    try:
        document = json.loads(body)
    except ValueError:
        document = None
    require(
        isinstance(document, dict) and document.get("type") == PROBLEMS + kind,
        f"{what} is not the {kind} problem",
    )
    require("www-authenticate" not in headers, f"{what} carries WWW-Authenticate")


def require_unauthenticated(response: tuple[int, dict[str, str], bytes], *, what: str) -> None:
    """A token that does not verify: `401`, the `unauthenticated` problem and a Bearer challenge,
    distinct from the `403` a verified token Core refuses or holds no identity for."""
    answered, headers, body = response
    require(answered == 401, f"{what} answered {answered}, not 401")
    try:
        document = json.loads(body)
    except ValueError:
        document = None
    require(
        isinstance(document, dict) and document.get("type") == PROBLEMS + "unauthenticated",
        f"{what} is not the unauthenticated problem",
    )
    require(
        headers.get("www-authenticate", "").split(" ")[0].lower() == "bearer",
        f"{what} carries no Bearer challenge",
    )


def probe(journey_path: Path = RENDERED / "journey.json") -> list[str]:
    """Against the running stack: what can only be proven live. Each line is one claim."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from services.identity.trusted_issuers import load_trust, verify_configured_token

    journey = json.loads(journey_path.read_text(encoding="utf-8"))
    origin = journey["keycloak_origin"]
    trust_raw = read_env(journey_path.parent / "compose.env")["KODERA_AUTH_TRUST"]
    trusted = load_trust(trust_raw)
    pinned = {entry["issuer"]: entry for entry in json.loads(trust_raw)}
    passed = []
    provider = Browser(origin)
    for realm in REALMS:
        iss = issuer(origin, realm)
        status, _, body = provider.request(
            "GET", f"/realms/{realm}/.well-known/openid-configuration"
        )
        require(status == 200 and json.loads(body)["issuer"] == iss, f"{realm}: issuer")
        status, _, body = provider.request("GET", f"/realms/{realm}/protocol/openid-connect/certs")
        live = {k["kid"]: k for k in json.loads(body)["keys"]}
        expected = pinned[iss]["public_jwks"]["keys"][0]
        require(expected["kid"] in live, f"{realm}: Keycloak derived another kid")
        require(
            all(live[expected["kid"]][f] == expected[f] for f in ("kty", "crv", "x", "y")),
            f"{realm}: the live key differs from the pinned key",
        )
        passed.append(f"{realm}: issuer and pinned key published")
    tokens = login(journey, "staff-one")
    verified, lane = verify_configured_token(tokens["access_token"], trusted=trusted)
    require(lane == "staff" and verified.issuer == journey["staff_issuer"], "staff lane")
    require(verified.subject == journey["accounts"]["staff-one"]["subject"], "fixed subject")
    require("otp" in (verified.amr or ()), "staff token without otp in amr (AUTHZ section 3)")
    passed.append("staff-one: password + code, staff lane, amr has otp, fixed sub")
    owner = None
    if journey["owner_mode"] == "test-credentials":
        owner = login(journey, "owner")
        verified, lane = verify_configured_token(owner["access_token"], trusted=trusted)
        require(lane == "customer", "owner token not on the customer lane")
        passed.append("owner (TEST-ONLY preset): customer lane")
    api = Browser(journey["api_origin"])
    status, _, _ = api.request("GET", "/health/ready")
    require(status == 200, "API not ready")
    # getMe (contracts/core-api.openapi.yaml): verified staff authentication is 403 `forbidden`
    # until the separate staff implementation exists, never `identity-unknown`; 401 is only for
    # a token that does not verify.
    require_refusal(
        api_get(journey["api_origin"], "/api/v1/me", tokens["access_token"]),
        status=403,
        kind="forbidden",
        what="GET /api/v1/me with a staff token",
    )
    passed.append("api: ready; a staff token is no customer principal (403 forbidden on /me)")
    # A bearer that is no token at all must fail verification: 401, never the 403 of a verified one.
    require_unauthenticated(
        api_get(journey["api_origin"], "/api/v1/me", "invalid-e2e-token"),
        what="GET /api/v1/me with an invalid bearer token",
    )
    passed.append("api: an invalid bearer token is 401 unauthenticated on /me")
    if owner is not None:
        # Before any binding Core knows no owner identity: a verified customer token it cannot
        # resolve is 403 `identity-unknown` (Core #284), not 401.
        require_refusal(
            api_get(journey["api_origin"], "/api/v1/me", owner["access_token"]),
            status=403,
            kind="identity-unknown",
            what="GET /api/v1/me with the unbound owner's token",
        )
        passed.append("api: the unbound owner is 403 identity-unknown on /me")
    return passed


# --- Command line ----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    render_command = commands.add_parser("render", help="write dev/e2e/rendered/")
    render_command.add_argument("--keycloak-origin", default=DEFAULT_KEYCLOAK_ORIGIN)
    render_command.add_argument("--console-origin", default=DEFAULT_CONSOLE_ORIGIN)
    render_command.add_argument("--api-origin", default=DEFAULT_API_ORIGIN)
    render_command.add_argument("--mailpit-origin", default=DEFAULT_MAILPIT_ORIGIN)
    render_command.add_argument("--owner-mode", choices=OWNER_MODES, default="template")
    trust_command = commands.add_parser("trust", help="print KODERA_AUTH_TRUST")
    trust_command.add_argument("--keycloak-origin", default=DEFAULT_KEYCLOAK_ORIGIN)
    commands.add_parser("selftest", help="offline proof")
    commands.add_parser("probe", help="live proof against the running stack")
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "render":
            render(
                keycloak_origin=arguments.keycloak_origin,
                console_origin=arguments.console_origin,
                api_origin=arguments.api_origin,
                mailpit_origin=arguments.mailpit_origin,
                owner_mode=arguments.owner_mode,
            )
            print(f"rendered {RENDERED.relative_to(ROOT)} (owner mode {arguments.owner_mode})")
        elif arguments.command == "trust":
            print(trust_json(arguments.keycloak_origin))
        elif arguments.command == "selftest":
            for name in selftest():
                print("ok", name)
        else:
            for line in probe():
                print("ok", line)
    except FixtureError as error:
        print("refused:", error, file=sys.stderr)
        return 1
    except OSError as error:
        # The probe's only I/O is loopback HTTP and the rendered files.
        print(
            "unreachable:", type(error).__name__, "(is the stack up and rendered?)", file=sys.stderr
        )
        return 1
    return 0


if __name__ == "__main__":
    os.umask(0o022)
    raise SystemExit(main())
