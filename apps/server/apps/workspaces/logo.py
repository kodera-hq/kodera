"""Bounded raster workspace identity, never a remote URL or executable image format."""

import base64
import binascii
import re

MAX_LOGO_BYTES = 2 * 1024 * 1024
MAX_LOGO_URL = 4 * ((MAX_LOGO_BYTES + 2) // 3) + 32


def validate_logo(value: object) -> str:
    if value == "":
        return ""
    if not isinstance(value, str) or len(value) > MAX_LOGO_URL:
        raise ValueError("invalid logo")
    match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})", value)
    if match is None:
        raise ValueError("invalid logo")
    try:
        raw = base64.b64decode(match[2], validate=True)
    except binascii.Error:
        raise ValueError("invalid logo") from None
    if not 12 <= len(raw) <= MAX_LOGO_BYTES:
        raise ValueError("invalid logo")
    valid = {
        "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n")
        and raw[12:16] == b"IHDR"
        and raw.endswith(b"IEND\xaeB`\x82"),
        "image/jpeg": raw.startswith(b"\xff\xd8\xff") and raw.endswith(b"\xff\xd9"),
        "image/webp": raw[:4] == b"RIFF"
        and raw[8:12] == b"WEBP"
        and int.from_bytes(raw[4:8], "little") == len(raw) - 8,
    }
    if not valid[match[1]]:
        raise ValueError("invalid logo")
    return value
