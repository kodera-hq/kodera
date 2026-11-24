"""Pure-Python RIFF/WebP parser, metadata scrubber, and dimension verifier for custom emojis."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import struct
from dataclasses import dataclass

from .models import (
    CUSTOM_EMOJI_SHORTCODE_RE,
    MAX_CUSTOM_EMOJI_BYTES,
    MAX_CUSTOM_EMOJI_DIMENSION,
)

SHORTCODE_PATTERN = re.compile(CUSTOM_EMOJI_SHORTCODE_RE + r"\Z")
BASE64_PATTERN = re.compile(r"\A[A-Za-z0-9+/]+={0,2}\Z")
MAX_BASE64_EMOJI_CHARS = ((MAX_CUSTOM_EMOJI_BYTES + 2) // 3) * 4

# VP8X extended feature flag bits (RFC 9649 §2.2):
#   0x20 = ICC profile present (`ICCP`)
#   0x10 = Alpha channel present (`ALPH` or `VP8L`)
#   0x08 = EXIF metadata present (`EXIF`)
#   0x04 = XMP metadata present (`XMP `)
#   0x02 = Animation present (`ANIM` + `ANMF`)
VP8X_METADATA_BITS = 0x20 | 0x08 | 0x04
VP8X_RESERVED_BITS = 0xC1
VP8X_ALPHA_BIT = 0x10
VP8X_ANIMATION_BIT = 0x02

STRIPPED_METADATA_FOURCCS = frozenset({b"EXIF", b"XMP ", b"ICCP"})
STRIPPED_NORMALIZED_NAMES = frozenset({b"EXIF", b"XMP", b"ICCP"})
ALLOWED_TOP_FOURCCS = frozenset({b"VP8X", b"ANIM", b"ANMF", b"ALPH", b"VP8 ", b"VP8L"})
ALLOWED_FRAME_FOURCCS = frozenset({b"ALPH", b"VP8 ", b"VP8L"})
POLYGLOT_SIGNATURES = (b"<svg", b"<?xml", b"<!doctype", b"<html", b"<script")


class CustomEmojiValidationError(ValueError):
    """Structured validation refusal carrying a stable machine code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class SanitizedWebpEmoji:
    webp_bytes: bytes
    sha256: str
    width: int
    height: int
    animated: bool


def validate_shortcode(raw: object) -> str:
    if not isinstance(raw, str):
        raise CustomEmojiValidationError("invalid_shortcode")
    normalized = raw.strip()
    if normalized.startswith(":") and normalized.endswith(":") and len(normalized) >= 4:
        normalized = normalized[1:-1]
    if SHORTCODE_PATTERN.fullmatch(normalized) is None:
        raise CustomEmojiValidationError("invalid_shortcode")
    if normalized.startswith("kodera_"):
        raise CustomEmojiValidationError("reserved_shortcode_prefix")
    return normalized


def decode_base64_webp(raw: object) -> bytes:
    if not isinstance(raw, str):
        raise CustomEmojiValidationError("invalid_base64")
    cleaned = raw.strip()
    if cleaned.startswith("data:image/webp;base64,"):
        cleaned = cleaned.removeprefix("data:image/webp;base64,")
    elif cleaned.startswith("data:"):
        raise CustomEmojiValidationError("unsupported_media_type")
    if (
        len(cleaned) < 16
        or len(cleaned) > MAX_BASE64_EMOJI_CHARS
        or len(cleaned) % 4 != 0
        or BASE64_PATTERN.fullmatch(cleaned) is None
    ):
        raise CustomEmojiValidationError("invalid_base64")
    try:
        decoded = base64.b64decode(cleaned, validate=True)
    except (binascii.Error, ValueError):
        raise CustomEmojiValidationError("invalid_base64") from None
    return decoded


def _parse_vp8_dimensions(payload: bytes) -> tuple[int, int]:
    """Parse lossy VP8 keyframe dimensions (RFC 6386 §9.1)."""
    if len(payload) < 10:
        raise CustomEmojiValidationError("invalid_vp8_bitstream")
    frame_tag = payload[0] | (payload[1] << 8) | (payload[2] << 16)
    if (frame_tag & 0x01) != 0:
        raise CustomEmojiValidationError("invalid_vp8_keyframe")
    if payload[3:6] != b"\x9d\x01\x2a":
        raise CustomEmojiValidationError("invalid_vp8_start_code")
    raw_w, raw_h = struct.unpack_from("<HH", payload, 6)
    width = raw_w & 0x3FFF
    height = raw_h & 0x3FFF
    if not (1 <= width <= MAX_CUSTOM_EMOJI_DIMENSION and 1 <= height <= MAX_CUSTOM_EMOJI_DIMENSION):
        raise CustomEmojiValidationError("invalid_dimensions")
    return width, height


def _parse_vp8l_dimensions(payload: bytes) -> tuple[int, int]:
    """Parse lossless VP8L bitstream dimensions (RFC 9649 §5.1)."""
    if len(payload) < 5 or payload[0] != 0x2F:
        raise CustomEmojiValidationError("invalid_vp8l_bitstream")
    (bits,) = struct.unpack_from("<I", payload, 1)
    version = (bits >> 29) & 0x07
    if version != 0:
        raise CustomEmojiValidationError("invalid_vp8l_version")
    width = (bits & 0x3FFF) + 1
    height = ((bits >> 14) & 0x3FFF) + 1
    if not (1 <= width <= MAX_CUSTOM_EMOJI_DIMENSION and 1 <= height <= MAX_CUSTOM_EMOJI_DIMENSION):
        raise CustomEmojiValidationError("invalid_dimensions")
    return width, height


def _pack_riff_chunk(fourcc: bytes, payload: bytes) -> bytes:
    pad = b"\x00" if (len(payload) % 2 == 1) else b""
    return fourcc + struct.pack("<I", len(payload)) + payload + pad


def _sanitize_anmf_payload(
    payload: bytes, *, canvas_width: int, canvas_height: int
) -> tuple[bytes, bool]:
    """Validate and rebuild an `ANMF` animation frame chunk, stripping any metadata sub-chunks."""
    if len(payload) < 24:
        raise CustomEmojiValidationError("invalid_anmf_chunk")
    frame_x = int.from_bytes(payload[0:3], "little") * 2
    frame_y = int.from_bytes(payload[3:6], "little") * 2
    frame_w = int.from_bytes(payload[6:9], "little") + 1
    frame_h = int.from_bytes(payload[9:12], "little") + 1
    if not (
        1 <= frame_w <= MAX_CUSTOM_EMOJI_DIMENSION
        and 1 <= frame_h <= MAX_CUSTOM_EMOJI_DIMENSION
        and frame_x + frame_w <= canvas_width
        and frame_y + frame_h <= canvas_height
    ):
        raise CustomEmojiValidationError("invalid_dimensions")
    if (payload[15] & 0xFC) != 0:
        raise CustomEmojiValidationError("invalid_anmf_flags")

    header = payload[:16]
    offset = 16
    rebuilt_subchunks: list[bytes] = []
    saw_frame_bitstream = False
    has_alpha = False
    while offset < len(payload):
        if offset + 8 > len(payload):
            raise CustomEmojiValidationError("truncated_webp_chunk")
        sub_fourcc = payload[offset : offset + 4]
        (sub_size,) = struct.unpack_from("<I", payload, offset + 4)
        offset += 8
        if offset + sub_size > len(payload):
            raise CustomEmojiValidationError("truncated_webp_payload")
        sub_data = payload[offset : offset + sub_size]
        offset += sub_size
        if sub_size % 2 == 1:
            if offset >= len(payload) or payload[offset] != 0:
                raise CustomEmojiValidationError("invalid_webp_padding")
            offset += 1

        if sub_fourcc in STRIPPED_METADATA_FOURCCS or (
            sub_fourcc.rstrip(b" \x00").upper() in STRIPPED_NORMALIZED_NAMES
        ):
            continue
        if sub_fourcc not in ALLOWED_FRAME_FOURCCS:
            raise CustomEmojiValidationError("unsupported_webp_chunk")
        if sub_fourcc == b"ALPH":
            if sub_size == 0:
                raise CustomEmojiValidationError("invalid_alph_chunk")
            has_alpha = True
        elif sub_fourcc == b"VP8 ":
            if saw_frame_bitstream:
                raise CustomEmojiValidationError("duplicate_frame_bitstream")
            bw, bh = _parse_vp8_dimensions(sub_data)
            if bw != frame_w or bh != frame_h:
                raise CustomEmojiValidationError("mismatched_dimensions")
            saw_frame_bitstream = True
        elif sub_fourcc == b"VP8L":
            if saw_frame_bitstream:
                raise CustomEmojiValidationError("duplicate_frame_bitstream")
            bw, bh = _parse_vp8l_dimensions(sub_data)
            if bw != frame_w or bh != frame_h:
                raise CustomEmojiValidationError("mismatched_dimensions")
            has_alpha = True
            saw_frame_bitstream = True
        rebuilt_subchunks.append(_pack_riff_chunk(sub_fourcc, sub_data))

    if not saw_frame_bitstream:
        raise CustomEmojiValidationError("missing_webp_bitstream")
    return header + b"".join(rebuilt_subchunks), has_alpha


def verify_custom_emoji_webp_clean(data: bytes) -> str | None:
    """Verify sanitized WebP carries zero EXIF/XMP/ICCP chunks, zero VP8X metadata flags, and valid bounds."""
    if not (20 <= len(data) <= MAX_CUSTOM_EMOJI_BYTES):
        return "size_out_of_bounds"
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return "invalid_magic"
    (riff_size,) = struct.unpack_from("<I", data, 4)
    if riff_size + 8 != len(data):
        return "invalid_webp_container"

    offset = 12
    saw_bitstream = False
    while offset < len(data):
        if offset + 8 > len(data):
            return "truncated_webp_chunk"
        fourcc = data[offset : offset + 4]
        (chunk_size,) = struct.unpack_from("<I", data, offset + 4)
        offset += 8
        if offset + chunk_size > len(data):
            return "truncated_webp_payload"
        payload = data[offset : offset + chunk_size]
        offset += chunk_size
        if chunk_size % 2 == 1:
            if offset >= len(data) or data[offset] != 0:
                return "invalid_webp_padding"
            offset += 1
        if fourcc not in ALLOWED_TOP_FOURCCS:
            return "metadata_or_unknown_chunk_present"
        if fourcc == b"VP8X":
            if chunk_size != 10 or (payload[0] & (VP8X_METADATA_BITS | VP8X_RESERVED_BITS)) != 0:
                return "vp8x_metadata_bits_present"
        elif fourcc in {b"VP8 ", b"VP8L", b"ANMF"} and chunk_size > 0:
            saw_bitstream = True

    if not saw_bitstream:
        return "missing_webp_bitstream"
    return None


def sanitize_custom_emoji_webp(data: bytes) -> SanitizedWebpEmoji:
    """Parse RIFF/WEBP in pure Python, strip EXIF/XMP/ICCP metadata, and enforce `1..128px` & `<= 256 KiB`."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise CustomEmojiValidationError("invalid_type")
    raw = bytes(data)
    if len(raw) == 0 or len(raw) > MAX_CUSTOM_EMOJI_BYTES:
        raise CustomEmojiValidationError("size_out_of_bounds")

    raw_lower = raw.lower()
    if raw_lower.lstrip().startswith(b"<") or any(sig in raw_lower for sig in POLYGLOT_SIGNATURES):
        raise CustomEmojiValidationError("polyglot_or_markup_refused")
    if len(raw) < 20 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        raise CustomEmojiValidationError("invalid_magic")

    (riff_size,) = struct.unpack_from("<I", raw, 4)
    if riff_size + 8 != len(raw):
        raise CustomEmojiValidationError("invalid_webp_container")

    offset = 12
    vp8x_payload: bytearray | None = None
    vp8x_width: int | None = None
    vp8x_height: int | None = None
    bitstream_width: int | None = None
    bitstream_height: int | None = None
    saw_still_bitstream = False
    saw_anim = False
    saw_anmf = False
    saw_alpha = False
    kept_chunks: list[tuple[bytes, bytes]] = []

    while offset < len(raw):
        if offset + 8 > len(raw):
            raise CustomEmojiValidationError("truncated_webp_chunk")
        fourcc = raw[offset : offset + 4]
        (chunk_size,) = struct.unpack_from("<I", raw, offset + 4)
        offset += 8
        if offset + chunk_size > len(raw):
            raise CustomEmojiValidationError("truncated_webp_payload")
        payload = raw[offset : offset + chunk_size]
        offset += chunk_size
        if chunk_size % 2 == 1:
            if offset >= len(raw) or raw[offset] != 0:
                raise CustomEmojiValidationError("invalid_webp_padding")
            offset += 1

        if not all(32 <= b <= 126 for b in fourcc):
            raise CustomEmojiValidationError("invalid_webp_fourcc")

        if fourcc in STRIPPED_METADATA_FOURCCS or (
            fourcc.rstrip(b" ").upper() in STRIPPED_NORMALIZED_NAMES
        ):
            continue

        if fourcc not in ALLOWED_TOP_FOURCCS:
            raise CustomEmojiValidationError("unsupported_webp_chunk")

        if fourcc == b"VP8X":
            if kept_chunks or vp8x_payload is not None or chunk_size != 10:
                raise CustomEmojiValidationError("invalid_vp8x")
            if (payload[0] & VP8X_RESERVED_BITS) != 0 or payload[1:4] != b"\x00\x00\x00":
                raise CustomEmojiValidationError("invalid_vp8x")
            vp8x_width = int.from_bytes(payload[4:7], "little") + 1
            vp8x_height = int.from_bytes(payload[7:10], "little") + 1
            if not (
                1 <= vp8x_width <= MAX_CUSTOM_EMOJI_DIMENSION
                and 1 <= vp8x_height <= MAX_CUSTOM_EMOJI_DIMENSION
            ):
                raise CustomEmojiValidationError("invalid_dimensions")
            cleaned_vp8x = bytearray(payload)
            cleaned_vp8x[0] &= ~VP8X_METADATA_BITS
            vp8x_payload = cleaned_vp8x
            continue

        if fourcc == b"ANIM":
            if vp8x_payload is None or saw_anim or saw_still_bitstream or chunk_size != 6:
                raise CustomEmojiValidationError("invalid_anim_chunk")
            saw_anim = True
            kept_chunks.append((fourcc, payload))
            continue

        if fourcc == b"ANMF":
            if vp8x_payload is None or vp8x_width is None or vp8x_height is None or not saw_anim:
                raise CustomEmojiValidationError("invalid_anmf_chunk")
            clean_anmf, frame_alpha = _sanitize_anmf_payload(
                payload, canvas_width=vp8x_width, canvas_height=vp8x_height
            )
            saw_anmf = True
            if frame_alpha:
                saw_alpha = True
            kept_chunks.append((fourcc, clean_anmf))
            continue

        if fourcc == b"ALPH":
            if vp8x_payload is None or saw_anim or saw_still_bitstream or chunk_size == 0:
                raise CustomEmojiValidationError("invalid_alph_chunk")
            saw_alpha = True
            kept_chunks.append((fourcc, payload))
            continue

        if fourcc == b"VP8 ":
            if saw_anim or saw_still_bitstream:
                raise CustomEmojiValidationError("duplicate_bitstream")
            bw, bh = _parse_vp8_dimensions(payload)
            if vp8x_width is not None and (bw != vp8x_width or bh != vp8x_height):
                raise CustomEmojiValidationError("mismatched_dimensions")
            bitstream_width, bitstream_height = bw, bh
            saw_still_bitstream = True
            kept_chunks.append((fourcc, payload))
            continue

        if fourcc == b"VP8L":
            if saw_anim or saw_still_bitstream or saw_alpha:
                raise CustomEmojiValidationError("duplicate_bitstream")
            bw, bh = _parse_vp8l_dimensions(payload)
            if vp8x_width is not None and (bw != vp8x_width or bh != vp8x_height):
                raise CustomEmojiValidationError("mismatched_dimensions")
            bitstream_width, bitstream_height = bw, bh
            saw_still_bitstream = True
            kept_chunks.append((fourcc, payload))
            continue

    if saw_anim and not saw_anmf:
        raise CustomEmojiValidationError("missing_webp_bitstream")
    if not saw_still_bitstream and not saw_anmf:
        raise CustomEmojiValidationError("missing_webp_bitstream")

    animated = saw_anim and saw_anmf
    serialized_chunks: list[bytes] = []
    if vp8x_payload is not None:
        flags = vp8x_payload[0] & ~VP8X_METADATA_BITS
        if animated:
            flags |= VP8X_ANIMATION_BIT
        else:
            flags &= ~VP8X_ANIMATION_BIT
        if saw_alpha:
            flags |= VP8X_ALPHA_BIT
        vp8x_payload[0] = flags
        serialized_chunks.append(_pack_riff_chunk(b"VP8X", bytes(vp8x_payload)))

    for chunk_fourcc, chunk_payload in kept_chunks:
        serialized_chunks.append(_pack_riff_chunk(chunk_fourcc, chunk_payload))

    webp_body = b"WEBP" + b"".join(serialized_chunks)
    sanitized = b"RIFF" + struct.pack("<I", len(webp_body)) + webp_body

    width = vp8x_width if vp8x_width is not None else bitstream_width
    height = vp8x_height if vp8x_height is not None else bitstream_height
    if width is None or height is None:
        raise CustomEmojiValidationError("missing_webp_bitstream")

    verdict = verify_custom_emoji_webp_clean(sanitized)
    if verdict is not None:
        raise CustomEmojiValidationError(verdict)

    return SanitizedWebpEmoji(
        webp_bytes=sanitized,
        sha256=hashlib.sha256(sanitized).hexdigest(),
        width=width,
        height=height,
        animated=animated,
    )
