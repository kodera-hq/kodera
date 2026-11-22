"""UTF-8 response byte-budget guard for paginated JSON surfaces."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence

# Mobile HTTP clients enforce a strict 65,536-byte response ceiling. Clamping page items at
# 48,000 UTF-8 JSON bytes leaves > 17 KiB of headroom for envelope metadata, signed cursors,
# and active device rosters while keeping OpenAPI `limit` bounds unchanged.
MAX_PAGE_UTF8_BYTES = 48_000


def utf8_json_size(value: object) -> int:
    """Upper-bound UTF-8 byte length of `value` across both standard and compact JSON encoders."""
    return len(json.dumps(value).encode("utf-8"))


def clamp_page_rows[Row, Item](
    candidates: Sequence[Row],
    *,
    limit: int,
    render: Callable[[Row], Item],
    max_bytes: int = MAX_PAGE_UTF8_BYTES,
) -> tuple[list[Row], list[Item], bool]:
    """Render up to `limit` items from `candidates` (typically `limit + 1` rows) within `max_bytes`.

    Always emits at least one item when `candidates` is non-empty so forward cursor progress is
    guaranteed even for a single oversized record, and sets `has_more = True` whenever either
    `len(candidates) > len(emitted_rows)` or byte clamping stopped accumulation early.
    """
    selected = candidates[:limit]
    emitted_rows: list[Row] = []
    emitted_items: list[Item] = []
    used_bytes = 0
    clamped = False
    for row in selected:
        item = render(row)
        item_bytes = utf8_json_size(item) + (2 if emitted_items else 0)
        if emitted_items and used_bytes + item_bytes > max_bytes:
            clamped = True
            break
        emitted_rows.append(row)
        emitted_items.append(item)
        used_bytes += item_bytes
    has_more = clamped or len(candidates) > len(emitted_rows)
    return emitted_rows, emitted_items, has_more
