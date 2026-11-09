"""What an image built from this tree carries, read without Docker.

A file is in an image when its Dockerfile's ignore rules admit it into the build context — the last
matching rule deciding — and the Dockerfile's runtime (last) stage copies a path it lies under.
BuildKit reads `<Dockerfile>.dockerignore` beside a Dockerfile in place of `.dockerignore` when
that file exists, so `Dockerfile.worker` is read with `Dockerfile.worker.dockerignore`. The rules
are those `.dockerignore` documents: `*` stays inside one path segment, `**` spans any number, and
a pattern that matches a directory matches everything under it.
"""

from __future__ import annotations

import fnmatch
import shutil
from pathlib import Path


def pattern_matches(pattern: str, path: str) -> bool:
    """A .dockerignore pattern against a relative path."""

    def match(wanted: list[str], parts: list[str]) -> bool:
        if not wanted:
            return not parts
        if wanted[0] == "**":
            return any(match(wanted[1:], parts[skip:]) for skip in range(len(parts) + 1))
        return (
            bool(parts)
            and fnmatch.fnmatchcase(parts[0], wanted[0])
            and match(wanted[1:], parts[1:])
        )

    wanted, parts = pattern.strip("/").split("/"), path.split("/")
    return any(match(wanted, parts[:length]) for length in range(1, len(parts) + 1))


def runtime_copies(dockerfile: str) -> list[str]:
    """The paths the Dockerfile's last stage copies from the build context."""
    stage = dockerfile.split("\nFROM ")[-1].splitlines()
    copies = [line.split()[1:-1] for line in stage if line.startswith("COPY ")]
    return [source.strip("/") for sources in copies for source in sources if "--from" not in source]


def ignore_file(root: Path, dockerfile: str = "Dockerfile") -> Path:
    """The ignore file BuildKit reads for `dockerfile`."""
    own = root / f"{dockerfile}.dockerignore"
    return own if own.is_file() else root / ".dockerignore"


def image_files(root: Path, dockerfile: str = "Dockerfile") -> list[str]:
    """Every file the image built from `root`/`dockerfile` carries, relative to `root`."""
    lines = ignore_file(root, dockerfile).read_text().splitlines()
    rules = [line.strip() for line in lines]
    rules = [rule for rule in rules if rule and not rule.startswith("#")]
    found = []
    for source in runtime_copies((root / dockerfile).read_text()):
        top = root / source
        for path in [top] if top.is_file() else sorted(top.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            admitted = True
            for rule in rules:
                if pattern_matches(rule.removeprefix("!"), relative):
                    admitted = rule.startswith("!")
            if admitted:
                found.append(relative)
    return found


def image_tree(root: Path, destination: Path, dockerfile: str = "Dockerfile") -> list[str]:
    """Copy the files the image carries into `destination`; the files copied."""
    files = image_files(root, dockerfile)
    for relative in files:
        (destination / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, destination / relative)
    return files
