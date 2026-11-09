#!/usr/bin/env python3
"""Qualify an owned real code-flow fixture without outputting bearer material."""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dev.accept_runtime import POSTGRES  # noqa: E402
from dev.identity_fixture import (  # noqa: E402
    KEYCLOAK,
    REALM,
    code_flow,
    owned_provider,
    profile_only,
    require,
)
from services.identity.access_tokens import (  # noqa: E402
    IssuerKeySnapshot,
    TokenVerificationError,
    verify_access_token,
)


def main():
    with owned_provider() as (transport, password):
        for mode in ("missing", "wrong"):
            code_flow(transport, password, verifier_mode=mode)
        tokens = code_flow(transport, password)
        audience = profile_only(tokens["access_token"]).get("aud", [])
        require(
            "kodera-server" in ([audience] if isinstance(audience, str) else audience),
            "Core audience mapper did not execute",
        )
        unmapped = code_flow(transport, password, "without-core-audience")
        audience = profile_only(unmapped["access_token"]).get("aud", [])
        require(
            "kodera-server" not in ([audience] if isinstance(audience, str) else audience),
            "wrong audience fixture is not distinct",
        )
        admitted = IssuerKeySnapshot.from_jwks(
            transport.jwks(),
            issuer=transport.origin + f"/realms/{REALM}",
            generation="owned-local-fixture",
            expires_at=int(time.time()) + 600,
        )
        verified = verify_access_token(tokens["access_token"], admitted=admitted)
        require(verified.amr is None or "mfa" not in verified.amr, "fixture fabricated MFA")
        for token in (tokens["id_token"], tokens["refresh_token"], unmapped["access_token"]):
            try:
                verify_access_token(token, admitted=admitted)
            except TokenVerificationError:
                pass
            else:
                raise RuntimeError("non-access/wrong-audience token accepted")
        print("PASS: real S256 PKCE access/ID token issuance and audience distinction")
        print(
            "PASS: same verifier accepts actual access token and refuses ID/refresh/wrong audience"
        )
        print("Provider:", KEYCLOAK)
        print("Database:", POSTGRES)
        print("Signed evidence only; Core identity, MFA and current authority remain unimplemented")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Subprocess and provider exceptions may contain response/command secrets.
        print("FAIL: local token qualification (details withheld)", file=sys.stderr)
        sys.exit(1)
