"""Install the mandatory Community room-policy configuration on fresh and existing volumes."""

import sys
import os
import re
import tempfile
from importlib.metadata import version
from pathlib import Path


MODULE = "kodera_synapse_policy.KoderaPolicy"


def configure(document, environment=None):
    environment = environment or {}
    server = document["server_name"]
    document.setdefault("presence", {})["enabled"] = True
    modules = document.setdefault("modules", [])
    modules[:] = [item for item in modules if item.get("module") != MODULE]
    modules.append({"module": MODULE, "config": {
        "agent_user_id": f"@kodera-agent:{server}",
        "room_access_user_id": f"@kodera-rooms:{server}",
    }})
    if environment.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG"):
        issuer = environment.get("KODERA_DEFAULT_COMMUNITY_ISSUER", "")
        secret = environment.get("KODERA_SYNAPSE_OIDC_CLIENT_SECRET", "")
        if environment["KODERA_DEFAULT_COMMUNITY_ORG_SLUG"] != "community" or not re.fullmatch(
            r"https://(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}/realms/community", issuer
        ) or any(issuer.endswith(suffix + "/realms/community") for suffix in (".local", ".localhost", ".internal")) or not secret or secret.startswith("CHANGE_ME_"):
            raise ValueError("Community Synapse requires canonical issuer and issued OIDC client credential")
        if any(provider.get("idp_id") != "community" for provider in document.get("oidc_providers", [])):
            raise ValueError("Community Synapse requires one canonical identity provider")
        document["public_baseurl"] = f"https://{server}/"
        document["enable_registration"] = False
        document["password_config"] = {"enabled": False}
        document["oidc_providers"] = [{
            "idp_id": "community", "idp_name": "Kodera Community",
            "issuer": issuer, "client_id": "synapse", "client_secret": secret,
            "scopes": ["openid", "profile", "email"], "pkce_method": "always",
            "allow_existing_users": False, "backchannel_logout_enabled": True,
            "user_mapping_provider": {"config": {
                "subject_template": "{{ user.sub }}", "localpart_template": "{{ user.sub | lower }}",
                "confirm_localpart": False,
            }},
        }]
    return document


if __name__ == "__main__":
    import yaml

    if version("kodera-synapse-policy") != "0.1.5":
        raise RuntimeError("Community requires room-policy version 0.1.5")
    config = Path(sys.argv[1])
    document = yaml.safe_load(config.read_text())
    # A unique mode-0600 file prevents a readable secret window or a stale symlink.
    with tempfile.NamedTemporaryFile("w", dir=config.parent, prefix=config.name + ".policy.", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(yaml.safe_dump(configure(document, os.environ), sort_keys=False))
            stream.flush()
            original = config.stat()
            temporary.chmod(0o600 if os.environ.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG") else original.st_mode & 0o777)
            if (temporary.stat().st_uid, temporary.stat().st_gid) != (original.st_uid, original.st_gid):
                os.chown(temporary, original.st_uid, original.st_gid)
            temporary.replace(config)
        finally:
            temporary.unlink(missing_ok=True)
