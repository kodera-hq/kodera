"""The request fingerprint of CONVENTIONS §8: docs/specs/IDEMPOTENCY_REPLAY.md §2.4.

The hash covers the raw bytes after removing insignificant whitespace, not the parsed object: key
order, number spelling and escapes stay significant, and a body that is not JSON is canonicalised by
the same rule, so the fingerprint never depends on a parser.
"""

import hashlib

# RFC 8259 §2: the only insignificant whitespace is space, tab, line feed and carriage return.
_INSIGNIFICANT = frozenset(b" \t\n\r")
_QUOTE = 0x22
_BACKSLASH = 0x5C


def canonical_body(raw: bytes) -> bytes:
    """`raw` without the whitespace bytes outside JSON strings; a string is kept whole."""
    kept = bytearray()
    in_string = False
    escaped = False
    for byte in raw:
        if in_string:
            kept.append(byte)
            if escaped:
                escaped = False
            elif byte == _BACKSLASH:
                escaped = True
            elif byte == _QUOTE:
                in_string = False
        elif byte not in _INSIGNIFICANT:
            kept.append(byte)
            in_string = byte == _QUOTE
    return bytes(kept)


def body_sha256(raw: bytes) -> str:
    """The lower-case hexadecimal SHA-256 of the canonical body."""
    return hashlib.sha256(canonical_body(raw)).hexdigest()
