"""Install the mandatory Community room-policy configuration on fresh and existing volumes."""

import sys
from importlib.metadata import version
from pathlib import Path


MODULE = "kodera_synapse_policy.KoderaPolicy"


def configure(document):
    server = document["server_name"]
    document.setdefault("presence", {})["enabled"] = True
    modules = document.setdefault("modules", [])
    modules[:] = [item for item in modules if item.get("module") != MODULE]
    modules.append({"module": MODULE, "config": {
        "agent_user_id": f"@kodera-agent:{server}",
        "room_access_user_id": f"@kodera-rooms:{server}",
    }})
    return document


if __name__ == "__main__":
    import yaml

    if version("kodera-synapse-policy") != "0.1.4":
        raise RuntimeError("Community requires room-policy version 0.1.4")
    config = Path(sys.argv[1])
    document = yaml.safe_load(config.read_text())
    temporary = config.with_name(config.name + ".policy.tmp")
    temporary.write_text(yaml.safe_dump(configure(document), sort_keys=False))
    temporary.chmod(config.stat().st_mode & 0o777)
    temporary.replace(config)
