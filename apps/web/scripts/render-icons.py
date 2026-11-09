#!/usr/bin/env python3
"""Render the raster icons in public/ from public/favicon.svg.

The SVG is the one source: its seven paths (those of src/ui/icons/KoderaMark.tsx), the group
transform that places them on the 512 x 512 tile, and the two fills. Every raster is the mark on a
full-bleed, opaque tile of the SVG's tile colour, so the corner pixel of every PNG and of every
.ico frame is that colour: the operating system rounds the corners itself, and a transparent
corner showed whatever lay beneath it.

Run from apps/web:  python3 scripts/render-icons.py
Needs Pillow (used only here, at generation time; the bundle never loads it). The output is
deterministic for a given Pillow version and carries no text chunk, which
tests/unit/brand/legacy-brand.test.ts refuses.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

PUBLIC = Path(__file__).resolve().parent.parent / "public"
PNG_SIZES = (16, 32, 48, 180, 192, 512)
ICO_SIZES = (16, 32, 48)
# Coordinates are drawn on a canvas this many times larger, then box-averaged down: the
# anti-aliasing is the exact covered area to 1/SUPERSAMPLE^2.
CANVAS = 4096
BEZIER_STEPS = 32

Point = tuple[float, float]


def hex_colour(value: str) -> tuple[int, int, int]:
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
        sys.exit(f"render-icons: not a #RRGGBB colour: {value!r}")
    return (int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16))


def read_source() -> tuple[tuple[int, int, int], tuple[int, int, int], Point, float, list[str]]:
    svg = (PUBLIC / "favicon.svg").read_text(encoding="utf-8")
    tile = re.search(r'<rect width="512" height="512"[^>]*fill="(#[0-9A-Fa-f]{6})"', svg)
    group = re.search(
        r'<g transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)" fill="(#[0-9A-Fa-f]{6})"',
        svg,
    )
    paths = re.findall(r'\bd="([^"]+)"', svg)
    if tile is None or group is None or len(paths) != 7:
        sys.exit("render-icons: favicon.svg no longer has the tile, the group or seven paths")
    offset = (float(group.group(1)), float(group.group(2)))
    return hex_colour(tile.group(1)), hex_colour(group.group(4)), offset, float(group.group(3)), paths


def subpaths(d: str) -> list[list[Point]]:
    """Absolute M, L, C and Z only, which is all the monogram uses; anything else stops the run."""
    tokens = re.findall(r"[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", d)
    shapes: list[list[Point]] = []
    current: list[Point] = []
    index = 0

    def number() -> float:
        nonlocal index
        value = float(tokens[index])
        index += 1
        return value

    command = ""
    while index < len(tokens):
        if tokens[index].isalpha():
            command = tokens[index]
            index += 1
        if command == "M":
            if current:
                shapes.append(current)
            current = [(number(), number())]
            command = "L"
        elif command == "L":
            current.append((number(), number()))
        elif command == "C":
            p0 = current[-1]
            p1, p2, p3 = (number(), number()), (number(), number()), (number(), number())
            for step in range(1, BEZIER_STEPS + 1):
                t = step / BEZIER_STEPS
                u = 1 - t
                current.append(
                    (
                        u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                        u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
                    )
                )
        elif command == "Z":
            if current:
                shapes.append(current)
            current = []
            command = ""
        else:
            sys.exit(f"render-icons: unsupported path command {command!r}")
    if current:
        shapes.append(current)
    return shapes


def render(size: int, tile, mark, offset: Point, scale: float, paths: list[str]) -> Image.Image:
    supersample = max(1, CANVAS // size)
    side = size * supersample
    factor = side / 512
    coverage = Image.new("L", (side, side), 0)
    draw = ImageDraw.Draw(coverage)
    for d in paths:
        for shape in subpaths(d):
            draw.polygon(
                [
                    ((offset[0] + scale * x) * factor, (offset[1] + scale * y) * factor)
                    for x, y in shape
                ],
                fill=255,
            )
    coverage = coverage.reduce(supersample)
    return Image.composite(Image.new("RGB", (size, size), mark), Image.new("RGB", (size, size), tile), coverage)


def main() -> None:
    tile, mark, offset, scale, paths = read_source()
    rendered = {size: render(size, tile, mark, offset, scale, paths) for size in PNG_SIZES}
    for size, image in rendered.items():
        image.save(PUBLIC / f"icon-{size}.png", optimize=True)
    # The maskable icon is the same full-bleed tile: no lit pixel of the mark is more than 165 px
    # from the centre, inside the 204.8 px radius of the central 80 % safe zone (the test checks it).
    rendered[512].save(PUBLIC / "icon-512-maskable.png", optimize=True)
    largest = rendered[max(ICO_SIZES)]
    largest.save(
        PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=[rendered[s] for s in ICO_SIZES if s != max(ICO_SIZES)],
    )


if __name__ == "__main__":
    main()
