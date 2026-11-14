#!/usr/bin/env python3
"""Generate an explicit experimental partner overlay from a full source checkout.

Generation only: never reads secrets, modifies a running server, or replaces existing files.
"""

import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "apps/server"))
from tenant_agent.federation import parse, servers

MATRIX = "@matrix path /_matrix/client/* /_matrix/media/* /_synapse/client/*"
PARTNER_MATRIX = MATRIX + " /_matrix/federation/* /_matrix/key/*"


def render(
    topology: str, domain: str, allowlist: list[str], channels: str, mode: str = "partner"
) -> dict[str, str]:
    if mode not in {"partner", "open"}:
        raise ValueError("an explicit partner or open federation mode is required")
    servers([domain])
    allowed = servers(allowlist)
    selected = parse(channels, allowed)
    if not selected or domain in allowed:
        raise ValueError(
            "partner federation requires external servers and explicit channel UUIDs"
        )
    if topology not in {"single", "split"}:
        raise ValueError("unknown deployment topology")
    source = HERE / ("Caddyfile" if topology == "single" else "Caddyfile.split")
    caddy = source.read_text()
    if caddy.count(MATRIX) != 1:
        raise ValueError("canonical Matrix route changed; review the generator")
    caddy = caddy.replace(MATRIX, PARTNER_MATRIX)
    caddy = caddy.replace(
        '# Client API only. Federation and key routes stay closed (README.md, "Federation").',
        "# Explicit experimental partner overlay: exact federation and key endpoints only.",
    )
    caddy = caddy.replace(
        '# Synapse\'s client API and the room-access token endpoint. Federation, key, admin and server\n# discovery routes are not routed: they answer 404 (README.md, "Federation").',
        "# Explicit partner overlay: client, federation and key endpoints; admin remains closed.",
    )
    target = ("matrix." if topology == "split" else "") + domain + ":443"
    discovery = json.dumps({"m.server": target}, separators=(",", ":"))
    if topology == "single":
        caddy = caddy.replace(
            "\t" + PARTNER_MATRIX,
            "\t@server_discovery path /.well-known/matrix/server\n\thandle @server_discovery {\n\t\theader Content-Type application/json\n\t\trespond `"
            + discovery
            + "` 200\n\t}\n\n\t"
            + PARTNER_MATRIX,
        )
    env = (
        "KODERA_DOMAIN="
        + domain
        + "\nKODERA_TOPOLOGY="
        + topology
        + "\nKODERA_FEDERATION_MODE="
        + mode
        + "\nKODERA_MATRIX_FEDERATION_ALLOWLIST="
        + (",".join(allowed) if mode == "partner" else "")
        + "\nKODERA_MATRIX_PARTNER_CHANNELS="
        + json.dumps(dict(selected), separators=(",", ":"))
        + "\n"
    )
    instructions = (
        "Status: Experimental — requires ADR-0025 acceptance and operator review.\n\n"
        "Use the full source checkout. Review these public configuration values, then pass\n"
        "--env-file .env --env-file OUTPUT/partner.env to docker compose, together with the\n"
        "base profile, the split profile if selected, and OUTPUT/docker-compose.partner.yml.\n"
        "Use the same public configuration for the Synapse renderer and tenant-agent.\n"
        "The overlay adds only exact Matrix federation/key routes. Admin routes stay closed.\n"
        "Only eligible Core audience:all non-read-only text channels may be selected.\n"
        "Existing incompatible rooms require explicit replacement; no history is copied.\n"
        "Verify deployed TLS, discovery, peer allowlists and real-account acceptance separately.\n"
    )
    if mode == "open":
        instructions += (
            "\nOpen mode removes the homeserver-wide partner list. Each selected room still\n"
            "pins exact public servers and an invite-only ACL; no room or Core grant is public.\n"
            "Review ADR-0026 and qualify real federation and abuse controls before deployment.\n"
        )
    if topology == "split":
        instructions += (
            "\nBefore enabling federation, serve matrix-server.json as application/json at\n"
            "https://"
            + domain
            + "/.well-known/matrix/server on the separate web host.\n"
            "This generator cannot configure that external host.\n"
        )
    return {
        "Caddyfile.partner": caddy,
        "matrix-server.json": discovery + "\n",
        "partner.env": env,
        "README.txt": instructions,
    }


def generate(
    output: pathlib.Path,
    topology: str,
    domain: str,
    allowlist: list[str],
    channels: str,
    mode: str = "partner",
):
    files = render(topology, domain, allowlist, channels, mode)
    # Exclusive directory creation refuses existing outputs, including symlinks.
    output.mkdir(parents=False, exist_ok=False)
    mount = str(output.resolve() / "Caddyfile.partner")
    files["docker-compose.partner.yml"] = (
        "services:\n  caddy:\n    volumes:\n      - type: bind\n        source: "
        + json.dumps(mount)
        + "\n        target: /etc/caddy/Caddyfile\n        read_only: true\n"
    )
    for name, content in files.items():
        with (output / name).open("x") as stream:
            stream.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--enable-partner-federation", "--enable-federation", action="store_true", required=True
    )
    parser.add_argument("--mode", choices=("partner", "open"), default="partner")
    parser.add_argument("--topology", choices=("single", "split"), required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--allow-server", action="append", required=True)
    parser.add_argument(
        "--channels",
        required=True,
        help="JSON map of exact Core channel UUIDs to server lists",
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        required=True,
        help="new output directory; existing output is refused",
    )
    args = parser.parse_args()
    try:
        generate(args.out, args.topology, args.domain, args.allow_server, args.channels, args.mode)
    except (ValueError, OSError):
        parser.exit(
            2, "refused: invalid bounded partner policy or output already exists\n"
        )
    print("Generated experimental partner configuration; no live services changed")


if __name__ == "__main__":
    main()
