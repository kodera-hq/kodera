#!/usr/bin/env python3
"""Exercise fixture startup/default source/teardown without a service or developer config."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="espace-runtime-") as tmp:
    root = Path(tmp)
    stack = root / "apps/web/tests/espace/stack"
    scripts = stack / "bin"
    scripts.mkdir(parents=True)
    server = root / "apps/server/room_access"
    server.mkdir(parents=True)
    (server / "__main__.py").touch()
    for name in ("up.sh", "down.sh", "compose.sh"):
        shutil.copyfile(HERE / name, scripts / name)
    (stack / "env.example").write_text("POSTGRES_PASSWORD=CHANGE_ME\nSYNAPSE_PORT=8008\n")
    mocks = root / "bin"
    mocks.mkdir()
    docker = mocks / "docker"
    docker.write_text('''#!/usr/bin/env python3
import os, sys
from pathlib import Path
assert os.environ.get("COMPOSE_DISABLE_ENV_FILE") == "1"
assert Path(os.environ["CORE_SRC"]).resolve() == Path.cwd().parents[3] / "server"
assert sys.argv[1:6] == ["compose", "--env-file", ".runtime/config", "-f", "compose.yaml"]
assert Path(".runtime/config").stat().st_mode & 0o077 == 0
if "down" in sys.argv and Path("refuse-down").exists(): sys.exit(7)
''')
    docker.chmod(0o755)
    node = mocks / "node"
    node.write_text("#!/bin/sh\nexit 0\n")
    node.chmod(0o755)
    env = {**os.environ, "PATH": str(mocks) + os.pathsep + os.environ["PATH"]}
    env.pop("CORE_SRC", None)
    def run(script):
        return subprocess.run(["bash", str(scripts / script)], env=env, capture_output=True)
    assert run("up.sh").returncode == 0, "default monorepo source and explicit private config"
    config = stack / ".runtime/config"
    assert "CHANGE_ME" not in config.read_text(), "throwaway secret generated"
    first = config.read_bytes()
    assert run("up.sh").returncode == 0 and config.read_bytes() == first, "restart preserves fixture secrets"
    (stack / "refuse-down").touch()
    assert run("down.sh").returncode == 7 and config.exists(), "failed teardown retains retry configuration"
    (stack / "refuse-down").unlink()
    assert run("down.sh").returncode == 0 and not config.exists(), "successful teardown removes fixture state"
    compose = scripts / "compose.sh"
    compose.write_text(compose.read_text().replace("--env-file .runtime/config ", ""))
    assert run("up.sh").returncode != 0, "mutation refuses implicit developer configuration"
print("PASS: default monorepo source, private fixture generation/restart, teardown retry/cleanup, explicit-config mutation")
