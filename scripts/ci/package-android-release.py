#!/usr/bin/env python3
"""Stage paired deterministic Android release APKs, CycloneDX 1.6 SBOM, and build evidence.

Resolves real runtime Maven `.jar`/`.aar` binaries and their `.pom` (and parent `.pom`)
metadata from Gradle's cache or `--resolved-artifacts-json`, computing true SHA-256 file
digests and normalized SPDX licenses (failing closed on missing, unknown, or copyleft POMs).

Used by `.github/workflows/release-binaries.yml` (`android-release` job) immediately before
`python3 scripts/ci/check-native-packaging.py --target android-apk`.

    python3 scripts/ci/package-android-release.py \
      --first-raw /tmp/first.apk \
      --second-raw /tmp/second.apk \
      --resolved-artifacts-json /tmp/android-runtime-artifacts.json \
      --candidate-dir candidate \
      --revision <40-hex-sha>

    python3 scripts/ci/package-android-release.py --selftest
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECK_NATIVE_PACKAGING = ROOT / "scripts" / "ci" / "check-native-packaging.py"

FIXED_ZIP_DATE_TIME = (2020, 1, 1, 0, 0, 0)
FIXED_SOURCE_DATE_EPOCH = 1704067200
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
CLIENT_ID_RE = re.compile(r"\A[\x21-\x7e]{1,128}\Z")
DNS_HOST_RE = re.compile(r"\A(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
DEX_ENTRY_RE = re.compile(r"^classes[0-9]*\.dex$")
BUILDCONFIG_DESCRIPTOR = "Lio/kodera/android/BuildConfig;"
DEX_ENDIAN_CONSTANT = 0x12345678
MAX_POM_BYTES = 2 * 1024 * 1024
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

PERMISSIVE_SPDX = frozenset(
    {
        "Apache-2.0",
        "MIT",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "ISC",
        "0BSD",
        "Zlib",
        "BSL-1.0",
        "CC0-1.0",
        "Unlicense",
    }
)

KNOWN_NONPERMISSIVE_SPDX = frozenset(
    {
        "GPL-2.0-only",
        "GPL-2.0-or-later",
        "GPL-3.0-only",
        "GPL-3.0-or-later",
        "LGPL-2.0-only",
        "LGPL-2.0-or-later",
        "LGPL-2.1-only",
        "LGPL-2.1-or-later",
        "LGPL-3.0-only",
        "LGPL-3.0-or-later",
        "AGPL-3.0-only",
        "AGPL-3.0-or-later",
    }
)


def canonicalize_apk_zip(src_apk: Path, dst_apk: Path) -> tuple[str, int]:
    """Rewrite a single unsigned APK archive with deterministic entry order and DOS timestamps.

    Each build output is canonicalized independently from its own bytes: if two Gradle builds
    produce different compiled DEX or manifest bytes, their canonicalized SHA-256 digests still
    differ and `check-native-packaging.py` refuses them. Cryptographic `zipalign` + `apksigner`
    signing MUST run after `check-native-packaging.py`, never before this function.
    """
    dst_apk.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src_apk, "r") as zin:
        entries = sorted(
            (info for info in zin.infolist() if not info.is_dir()),
            key=lambda item: item.filename,
        )
        with zipfile.ZipFile(dst_apk, "w") as zout:
            for info in entries:
                payload = zin.read(info.filename)
                out_info = zipfile.ZipInfo(filename=info.filename, date_time=FIXED_ZIP_DATE_TIME)
                out_info.compress_type = (
                    zipfile.ZIP_STORED
                    if info.compress_type == zipfile.ZIP_STORED
                    else zipfile.ZIP_DEFLATED
                )
                out_info.create_system = 3
                out_info.external_attr = 0o100644 << 16
                if out_info.compress_type == zipfile.ZIP_DEFLATED:
                    zout.writestr(out_info, payload, compresslevel=9)
                else:
                    zout.writestr(out_info, payload)
    raw = dst_apk.read_bytes()
    return hashlib.sha256(raw).hexdigest(), len(raw)


def _read_uleb128(buf: bytes, offset: int) -> tuple[int, int]:
    result = 0
    shift = 0
    for _ in range(5):
        if offset >= len(buf):
            raise ValueError("truncated ULEB128 in DEX payload")
        byte = buf[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            return result, offset
        shift += 7
    raise ValueError("overlong ULEB128 in DEX payload")


def _default_dex_static_value(type_descriptor: str) -> object:
    if type_descriptor == "Z":
        return False
    if type_descriptor in {"B", "S", "C", "I", "J"}:
        return 0
    if type_descriptor in {"F", "D"}:
        return 0.0
    return None


def _read_dex_encoded_value(
    buf: bytes, offset: int, get_string: object
) -> tuple[object, int]:
    if offset >= len(buf):
        raise ValueError("truncated DEX encoded_value")
    header = buf[offset]
    offset += 1
    value_type = header & 0x1F
    value_arg = header >> 5

    if value_type in {0x00, 0x02, 0x04, 0x06}:
        size = 1 if value_type == 0x00 else (value_arg + 1)
        return int.from_bytes(buf[offset : offset + size], "little", signed=True), offset + size
    if value_type in {0x03, 0x17, 0x18, 0x19, 0x1A, 0x1B}:
        size = value_arg + 1
        idx = int.from_bytes(buf[offset : offset + size], "little", signed=False)
        offset += size
        if value_type == 0x17:
            return get_string(idx), offset  # type: ignore[operator]
        return idx, offset
    if value_type in {0x10, 0x11}:
        return 0.0, offset + value_arg + 1
    if value_type == 0x1C:
        count, offset = _read_uleb128(buf, offset)
        items: list[object] = []
        for _ in range(count):
            val, offset = _read_dex_encoded_value(buf, offset, get_string)
            items.append(val)
        return items, offset
    if value_type == 0x1D:
        _, offset = _read_uleb128(buf, offset)
        count, offset = _read_uleb128(buf, offset)
        for _ in range(count):
            _, offset = _read_uleb128(buf, offset)
            _, offset = _read_dex_encoded_value(buf, offset, get_string)
        return None, offset
    if value_type == 0x1E:
        return None, offset
    if value_type == 0x1F:
        return bool(value_arg), offset
    raise ValueError(f"unsupported DEX encoded_value type 0x{value_type:02x}")


def _parse_buildconfig_from_dex(buf: bytes) -> dict[str, object] | None:
    if len(buf) < 112 or buf[:4] != b"dex\n" or buf[7:8] != b"\x00":
        raise ValueError("invalid DEX header magic")
    endian_tag = struct.unpack_from("<I", buf, 40)[0]
    if endian_tag != DEX_ENDIAN_CONSTANT:
        raise ValueError(f"unexpected DEX endian tag 0x{endian_tag:08x}")

    string_ids_size, string_ids_off = struct.unpack_from("<II", buf, 56)
    type_ids_size, type_ids_off = struct.unpack_from("<II", buf, 64)
    field_ids_size, field_ids_off = struct.unpack_from("<II", buf, 80)
    class_defs_size, class_defs_off = struct.unpack_from("<II", buf, 96)

    def get_string(idx: int) -> str:
        if idx < 0 or idx >= string_ids_size:
            raise ValueError(f"DEX string index {idx} out of range ({string_ids_size})")
        data_off = struct.unpack_from("<I", buf, string_ids_off + idx * 4)[0]
        _, pos = _read_uleb128(buf, data_off)
        end = buf.find(b"\x00", pos)
        if end == -1:
            raise ValueError("unterminated MUTF-8 string in DEX")
        return buf[pos:end].decode("utf-8", errors="replace")

    def get_type(idx: int) -> str:
        if idx < 0 or idx >= type_ids_size:
            raise ValueError(f"DEX type index {idx} out of range ({type_ids_size})")
        desc_idx = struct.unpack_from("<I", buf, type_ids_off + idx * 4)[0]
        return get_string(desc_idx)

    def get_field(idx: int) -> tuple[int, int, int]:
        if idx < 0 or idx >= field_ids_size:
            raise ValueError(f"DEX field index {idx} out of range ({field_ids_size})")
        return struct.unpack_from("<HHI", buf, field_ids_off + idx * 8)

    for c_idx in range(class_defs_size):
        (
            class_type_idx,
            _access_flags,
            _super_idx,
            _interfaces_off,
            _source_idx,
            _annotations_off,
            class_data_off,
            static_values_off,
        ) = struct.unpack_from("<IIIIIIII", buf, class_defs_off + c_idx * 32)
        if get_type(class_type_idx) != BUILDCONFIG_DESCRIPTOR:
            continue
        if class_data_off == 0:
            return {}
        static_fields_size, pos = _read_uleb128(buf, class_data_off)
        _, pos = _read_uleb128(buf, pos)
        _, pos = _read_uleb128(buf, pos)
        _, pos = _read_uleb128(buf, pos)

        static_fields: list[tuple[str, str]] = []
        field_idx = 0
        for _ in range(static_fields_size):
            delta, pos = _read_uleb128(buf, pos)
            _, pos = _read_uleb128(buf, pos)
            field_idx += delta
            _, f_type_idx, f_name_idx = get_field(field_idx)
            static_fields.append((get_string(f_name_idx), get_type(f_type_idx)))

        encoded_values: list[object] = []
        if static_values_off != 0:
            val_count, vpos = _read_uleb128(buf, static_values_off)
            for _ in range(val_count):
                val, vpos = _read_dex_encoded_value(buf, vpos, get_string)
                encoded_values.append(val)

        fields: dict[str, object] = {}
        for idx, (f_name, f_type) in enumerate(static_fields):
            fields[f_name] = (
                encoded_values[idx]
                if idx < len(encoded_values)
                else _default_dex_static_value(f_type)
            )
        return fields

    return None


def extract_apk_buildconfig_fields(apk_path: Path) -> dict[str, object]:
    """Read `io.kodera.android.BuildConfig` static constants directly from APK `classes*.dex`."""
    with zipfile.ZipFile(apk_path, "r") as archive:
        dex_names = sorted(
            name for name in archive.namelist() if DEX_ENTRY_RE.fullmatch(name)
        )
        if not dex_names:
            raise ValueError(f"APK contains no classes*.dex entries: {apk_path}")
        for dex_name in dex_names:
            found = _parse_buildconfig_from_dex(archive.read(dex_name))
            if found is not None:
                return found
    raise ValueError(
        f"APK DEX bytecode does not contain {BUILDCONFIG_DESCRIPTOR}: {apk_path}"
    )


def _validate_https_origin(raw: str, field_name: str) -> None:
    parsed = urllib.parse.urlsplit(raw)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.port is not None
        or ":" in parsed.netloc
        or parsed.netloc != parsed.hostname
        or not DNS_HOST_RE.fullmatch(parsed.hostname)
        or len(parsed.hostname) > 253
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != ""
        or parsed.query
        or parsed.fragment
        or raw != f"https://{parsed.hostname}"
    ):
        raise ValueError(
            f"BuildConfig.{field_name} must be a bare https:// DNS origin without port, path, or query, got {raw!r}"
        )


def verify_apk_release_buildconfig(apk_path: Path) -> dict[str, object]:
    """Refuse unconfigured, debug, or non-HTTPS `BuildConfig` fields in a release APK."""
    fields = extract_apk_buildconfig_fields(apk_path)
    if fields.get("APPLICATION_ID") != "io.kodera.app":
        raise ValueError(
            f"BuildConfig.APPLICATION_ID must be 'io.kodera.app', got {fields.get('APPLICATION_ID')!r}"
        )
    if fields.get("BUILD_TYPE") != "release":
        raise ValueError(
            f"BuildConfig.BUILD_TYPE must be 'release', got {fields.get('BUILD_TYPE')!r}"
        )
    if fields.get("DEBUG") is not False:
        raise ValueError(
            f"BuildConfig.DEBUG must be False in release APK, got {fields.get('DEBUG')!r}"
        )
    if "KODERA_DEV_ISSUER" in fields:
        raise ValueError("release APK BuildConfig must never declare KODERA_DEV_ISSUER")

    core_origin = fields.get("KODERA_CORE_ORIGIN")
    if not isinstance(core_origin, str) or not core_origin.strip():
        raise ValueError("BuildConfig.KODERA_CORE_ORIGIN is empty in release APK")
    _validate_https_origin(core_origin, "KODERA_CORE_ORIGIN")

    issuer_raw = fields.get("KODERA_ISSUER_ORIGINS")
    if not isinstance(issuer_raw, str) or not issuer_raw.strip():
        raise ValueError("BuildConfig.KODERA_ISSUER_ORIGINS is empty in release APK")
    issuers = [part for part in issuer_raw.split(" ") if part]
    if not issuers or len(set(issuers)) != len(issuers):
        raise ValueError(
            f"BuildConfig.KODERA_ISSUER_ORIGINS must hold unique non-empty origins, got {issuer_raw!r}"
        )
    for issuer_origin in issuers:
        _validate_https_origin(issuer_origin, "KODERA_ISSUER_ORIGINS")

    client_id = fields.get("KODERA_CLIENT_ID")
    if not isinstance(client_id, str) or not CLIENT_ID_RE.fullmatch(client_id):
        raise ValueError(
            f"BuildConfig.KODERA_CLIENT_ID must be a non-empty client identifier, got {client_id!r}"
        )

    console_origin = fields.get("KODERA_CONSOLE_ORIGIN")
    if not isinstance(console_origin, str) or not console_origin.strip():
        raise ValueError("BuildConfig.KODERA_CONSOLE_ORIGIN is empty in release APK")
    _validate_https_origin(console_origin, "KODERA_CONSOLE_ORIGIN")

    return fields


def sha256_regular_file(path: Path, max_bytes: int = MAX_ARTIFACT_BYTES) -> str:
    """Compute SHA-256 of a real regular file on disk, refusing symlinks and empty files."""
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise ValueError(f"artifact file missing or unreadable: {path}") from exc
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise ValueError(f"artifact path must be a regular file, never a symlink: {path}")
    if st.st_size <= 0 or st.st_size > max_bytes:
        raise ValueError(f"artifact file size {st.st_size} outside valid bounds: {path}")

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def detect_java_version() -> str:
    try:
        proc = subprocess.run(
            ["java", "-version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
        combined = f"{proc.stdout}\n{proc.stderr}"
        match = re.search(r'version "([0-9][0-9A-Za-z.+_-]*)"', combined)
        if match:
            return match.group(1)
    except OSError:
        pass
    return "21.0.0"


def read_android_app_version(root: Path = ROOT) -> str:
    app_gradle = (root / "apps" / "android" / "app" / "build.gradle.kts").read_text(
        encoding="utf-8"
    )
    match = re.search(r'versionName\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"', app_gradle)
    if not match:
        raise ValueError("unable to extract semver versionName from apps/android/app/build.gradle.kts")
    android_version = match.group(1)
    pkg_doc = json.loads((root / "package.json").read_text(encoding="utf-8"))
    root_version = str(pkg_doc.get("version") or "").strip()
    if android_version != root_version:
        raise ValueError(
            f"Android versionName {android_version!r} drifted from root package.json version {root_version!r}"
        )
    return android_version


def read_android_toolchain_versions(
    root: Path = ROOT, java_version_override: str | None = None
) -> list[dict[str, str]]:
    root_gradle = (root / "apps" / "android" / "build.gradle.kts").read_text(encoding="utf-8")
    wrapper_props = (
        root / "apps" / "android" / "gradle" / "wrapper" / "gradle-wrapper.properties"
    ).read_text(encoding="utf-8")

    agp_match = re.search(r'id\("com\.android\.application"\)\s+version\s+"([^"]+)"', root_gradle)
    kotlin_match = re.search(r'id\("org\.jetbrains\.kotlin\.jvm"\)\s+version\s+"([^"]+)"', root_gradle)
    gradle_match = re.search(r"gradle-([0-9][0-9A-Za-z.+_-]*)-bin\.zip", wrapper_props)

    if not (agp_match and kotlin_match and gradle_match):
        raise ValueError("unable to extract pinned AGP, Kotlin, and Gradle versions from apps/android")

    return [
        {"name": "android-gradle-plugin", "version": agp_match.group(1)},
        {"name": "gradle", "version": gradle_match.group(1)},
        {"name": "java", "version": java_version_override or detect_java_version()},
        {"name": "kotlin", "version": kotlin_match.group(1)},
    ]


def _local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _classify_pom_license_name(raw_name: str) -> str | None:
    if not raw_name:
        return None
    if raw_name in PERMISSIVE_SPDX or raw_name in KNOWN_NONPERMISSIVE_SPDX:
        return raw_name

    lowered = raw_name.lower()

    # Check copyleft families FIRST so exceptions or dual mentions never misclassify as permissive.
    if "affero" in lowered or re.search(r"\bagpl\b", lowered):
        return "AGPL-3.0-or-later" if "later" in lowered else "AGPL-3.0-only"
    if "lesser general public" in lowered or re.search(r"\blgpl\b", lowered):
        if "2.0" in lowered:
            return "LGPL-2.0-or-later" if "later" in lowered else "LGPL-2.0-only"
        if "3" in lowered:
            return "LGPL-3.0-or-later" if "later" in lowered else "LGPL-3.0-only"
        return "LGPL-2.1-or-later" if "later" in lowered else "LGPL-2.1-only"
    if "general public license" in lowered or re.search(r"\bgpl(?:v?[23]|-[23])?\b", lowered):
        if "3" in lowered:
            return "GPL-3.0-or-later" if "later" in lowered else "GPL-3.0-only"
        return "GPL-2.0-or-later" if "later" in lowered else "GPL-2.0-only"

    if (
        "apache-2.0" in lowered
        or ("apache" in lowered and "2.0" in lowered)
        or lowered.startswith("asf 2.0")
    ):
        return "Apache-2.0"

    if "0bsd" in lowered or "zero-clause bsd" in lowered or "bsd zero clause" in lowered:
        return "0BSD"

    if (
        "bsd-2-clause" in lowered
        or "bsd 2-clause" in lowered
        or "2-clause bsd" in lowered
        or "simplified bsd" in lowered
        or "freebsd license" in lowered
    ):
        return "BSD-2-Clause"

    if (
        "bsd-3-clause" in lowered
        or "bsd 3-clause" in lowered
        or "3-clause bsd" in lowered
        or "new bsd" in lowered
        or "modified bsd" in lowered
        or "revised bsd" in lowered
        or lowered in {"bsd", "bsd license", "the bsd license"}
    ):
        return "BSD-3-Clause"

    if (
        re.search(r"\bmit\b", lowered)
        or "bouncy castle licence" in lowered
        or "bouncy castle license" in lowered
    ):
        return "MIT"

    if re.search(r"\bisc\b", lowered):
        return "ISC"

    if "zlib" in lowered:
        return "Zlib"

    if "bsl-1.0" in lowered or "boost software license" in lowered:
        return "BSL-1.0"

    if "cc0-1.0" in lowered or "cc0 1.0" in lowered:
        return "CC0-1.0"

    if "unlicense" in lowered:
        return "Unlicense"

    return None


_CANONICAL_SPDX_LOWER = {
    spdx_id.lower(): spdx_id for spdx_id in (PERMISSIVE_SPDX | KNOWN_NONPERMISSIVE_SPDX)
}


def _classify_pom_license_url(raw_url: str) -> str | None:
    if not raw_url:
        return None
    if raw_url in PERMISSIVE_SPDX or raw_url in KNOWN_NONPERMISSIVE_SPDX:
        return raw_url

    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    path = parsed.path.lower().rstrip("/")

    if host in ("gnu.org", "www.gnu.org"):
        if path.startswith("/licenses/agpl"):
            return "AGPL-3.0-only"
        if path.startswith(("/licenses/lgpl-2.0", "/licenses/old-licenses/lgpl-2.0")):
            return "LGPL-2.0-only"
        if path.startswith("/licenses/lgpl-3"):
            return "LGPL-3.0-only"
        if path.startswith(("/licenses/lgpl", "/licenses/old-licenses/lgpl")):
            return "LGPL-2.1-only"
        if path.startswith("/licenses/gpl-3"):
            return "GPL-3.0-only"
        if path.startswith(("/licenses/gpl", "/licenses/old-licenses/gpl")):
            return "GPL-2.0-only"
        return None

    if host in ("spdx.org", "www.spdx.org") and path.startswith("/licenses/"):
        slug = path.removeprefix("/licenses/")
        for suffix in (".html", ".json", ".txt"):
            if slug.endswith(suffix):
                slug = slug[: -len(suffix)]
                break
        return _CANONICAL_SPDX_LOWER.get(slug)

    if host in ("apache.org", "www.apache.org"):
        if path in {
            "/licenses/license-2.0",
            "/licenses/license-2.0.txt",
            "/licenses/license-2.0.html",
        }:
            return "Apache-2.0"
        return None

    if host in ("opensource.org", "www.opensource.org"):
        opensource_paths = {
            "/licenses/apache-2.0": "Apache-2.0",
            "/license/apache-2-0": "Apache-2.0",
            "/licenses/0bsd": "0BSD",
            "/license/0bsd": "0BSD",
            "/licenses/bsd-2-clause": "BSD-2-Clause",
            "/license/bsd-2-clause": "BSD-2-Clause",
            "/licenses/bsd-3-clause": "BSD-3-Clause",
            "/licenses/bsd-license": "BSD-3-Clause",
            "/licenses/bsd-license.php": "BSD-3-Clause",
            "/license/bsd-3-clause": "BSD-3-Clause",
            "/licenses/mit": "MIT",
            "/licenses/mit-license": "MIT",
            "/licenses/mit-license.php": "MIT",
            "/license/mit": "MIT",
            "/licenses/isc": "ISC",
            "/licenses/isc-license": "ISC",
            "/licenses/isc-license.txt": "ISC",
            "/license/isc": "ISC",
            "/licenses/zlib": "Zlib",
            "/licenses/zlib-license": "Zlib",
            "/licenses/zlib-license.php": "Zlib",
            "/license/zlib": "Zlib",
            "/licenses/bsl-1.0": "BSL-1.0",
            "/license/bsl-1-0": "BSL-1.0",
            "/licenses/unlicense": "Unlicense",
            "/license/unlicense": "Unlicense",
        }
        return opensource_paths.get(path)

    if host in ("bouncycastle.org", "www.bouncycastle.org"):
        if path in {"/licence", "/licence.html", "/license", "/license.html"}:
            return "MIT"
        return None

    if host in ("boost.org", "www.boost.org"):
        if path in {"/license_1_0.txt", "/users/license.html"}:
            return "BSL-1.0"
        return None

    if host in ("creativecommons.org", "www.creativecommons.org"):
        if path in {"/publicdomain/zero/1.0", "/publicdomain/zero/1.0/legalcode"}:
            return "CC0-1.0"
        return None

    if host in ("unlicense.org", "www.unlicense.org"):
        if path in {"", "/unlicense"}:
            return "Unlicense"
        return None

    if host in ("zlib.net", "www.zlib.net"):
        if path in {"/zlib_license.html", "/license.html"}:
            return "Zlib"
        return None

    return None


def normalize_pom_license_entry(name: str, url: str) -> str | None:
    """Normalize a single Maven POM `<license>` (`<name>`, `<url>`) to a canonical SPDX ID."""
    raw_name = " ".join(name.split()).strip()
    raw_url = " ".join(url.split()).strip()
    if not raw_name and not raw_url:
        return None

    by_name = _classify_pom_license_name(raw_name)
    by_url = _classify_pom_license_url(raw_url)

    if by_name in KNOWN_NONPERMISSIVE_SPDX:
        return by_name
    if by_url in KNOWN_NONPERMISSIVE_SPDX:
        return by_url
    return by_name or by_url


def parse_pom_licenses_and_parent(
    pom_path: Path,
) -> tuple[list[tuple[str, str]], tuple[str, str, str] | None]:
    """Extract `[(license_name, license_url), ...]` and optional `(group, artifact, version)` parent."""
    try:
        st = os.lstat(pom_path)
    except OSError as exc:
        raise ValueError(f"POM file missing or unreadable: {pom_path}") from exc
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise ValueError(f"POM path must be a regular file: {pom_path}")
    if st.st_size <= 0 or st.st_size > MAX_POM_BYTES:
        raise ValueError(f"POM size {st.st_size} outside bounds: {pom_path}")

    raw_xml = pom_path.read_text(encoding="utf-8", errors="replace")
    try:
        root = ET.fromstring(raw_xml)
    except ET.ParseError as exc:
        raise ValueError(f"malformed XML in POM {pom_path}: {exc}") from exc

    licenses: list[tuple[str, str]] = []
    parent: tuple[str, str, str] | None = None

    for child in root:
        tag = _local_tag(child.tag)
        if tag == "licenses":
            for lic_el in child:
                if _local_tag(lic_el.tag) != "license":
                    continue
                lic_name = ""
                lic_url = ""
                for field in lic_el:
                    ftag = _local_tag(field.tag)
                    if ftag == "name" and field.text:
                        lic_name = field.text.strip()
                    elif ftag == "url" and field.text:
                        lic_url = field.text.strip()
                if lic_name or lic_url:
                    licenses.append((lic_name, lic_url))
        elif tag == "parent":
            p_group = ""
            p_artifact = ""
            p_version = ""
            for p_field in child:
                ptag = _local_tag(p_field.tag)
                if ptag == "groupId" and p_field.text:
                    p_group = p_field.text.strip()
                elif ptag == "artifactId" and p_field.text:
                    p_artifact = p_field.text.strip()
                elif ptag == "version" and p_field.text:
                    p_version = p_field.text.strip()
            if p_group and p_artifact and p_version and "$" not in p_version:
                parent = (p_group, p_artifact, p_version)

    return licenses, parent


def _find_pom_in_gradle_cache(
    files_2_1_root: Path, group: str, artifact: str, version: str
) -> Path | None:
    version_dir = files_2_1_root / group / artifact / version
    if not version_dir.is_dir():
        return None
    expected_name = f"{artifact}-{version}.pom"
    candidates = sorted(version_dir.glob(f"*/{expected_name}"))
    for cand in candidates:
        if cand.is_file() and not cand.is_symlink():
            return cand
    return None


def resolve_spdx_from_pom_chain(
    coord_label: str,
    pom_paths: list[Path],
    files_2_1_root: Path | None = None,
    enforce_permissive: bool = True,
) -> str:
    """Walk `pom_paths` (and parent POMs in `files_2_1_root` if available) to resolve SPDX license."""
    if not pom_paths:
        raise ValueError(f"missing Maven POM metadata for {coord_label}")

    raw_licenses: list[tuple[str, str]] = []
    visited: set[Path] = set()
    queue: list[Path] = list(pom_paths)
    depth = 0

    while queue and depth < 8:
        current = queue.pop(0)
        resolved_cur = current.resolve()
        if resolved_cur in visited:
            continue
        visited.add(resolved_cur)
        depth += 1

        found_lics, parent_coord = parse_pom_licenses_and_parent(current)
        if found_lics:
            raw_licenses = found_lics
            break
        if parent_coord and not queue and files_2_1_root is not None:
            parent_pom = _find_pom_in_gradle_cache(files_2_1_root, *parent_coord)
            if parent_pom is not None:
                queue.append(parent_pom)

    if not raw_licenses:
        raise ValueError(f"no <licenses> declaration found in POM chain for {coord_label}")

    normalized_permissive: list[str] = []
    normalized_nonpermissive: list[str] = []
    unrecognized: list[str] = []

    for lic_name, lic_url in raw_licenses:
        spdx = normalize_pom_license_entry(lic_name, lic_url)
        if spdx is None:
            unrecognized.append(f"{lic_name!r} ({lic_url!r})")
        elif spdx in PERMISSIVE_SPDX:
            if spdx not in normalized_permissive:
                normalized_permissive.append(spdx)
        else:
            if spdx not in normalized_nonpermissive:
                normalized_nonpermissive.append(spdx)

    if normalized_permissive:
        # In Maven POMs, multiple <license> entries represent alternative licensing choices (OR).
        # If all choices are recognized by check-native-packaging.py, preserve full OR expression;
        # if a dual-licensed POM pairs a permissive choice with a non-SPDX-admitted alternative
        # (such as EPL-2.0), elect the permissive choice(s).
        if not unrecognized:
            combined_ids = normalized_permissive + normalized_nonpermissive
            return combined_ids[0] if len(combined_ids) == 1 else " OR ".join(combined_ids)
        return (
            normalized_permissive[0]
            if len(normalized_permissive) == 1
            else " OR ".join(normalized_permissive)
        )

    if normalized_nonpermissive:
        expr = (
            normalized_nonpermissive[0]
            if len(normalized_nonpermissive) == 1
            else " OR ".join(normalized_nonpermissive)
        )
        if enforce_permissive:
            raise ValueError(f"non-permissive license '{expr}' declared in POM for {coord_label}")
        return expr

    raise ValueError(f"unrecognized Maven POM license {unrecognized} for {coord_label}")


def resolve_android_components(
    resolved_artifacts_json: Path | None = None,
    gradle_user_home: Path | None = None,
    enforce_permissive: bool = True,
) -> list[dict[str, str]]:
    """Resolve runtime `.jar`/`.aar` binary SHA-256 digests and POM SPDX licenses."""
    files_2_1_root: Path | None = None
    if gradle_user_home is not None:
        candidate_cache = gradle_user_home / "caches" / "modules-2" / "files-2.1"
        if candidate_cache.is_dir():
            files_2_1_root = candidate_cache

    raw_records: list[dict[str, object]] = []
    if resolved_artifacts_json is not None:
        loaded = json.loads(resolved_artifacts_json.read_text(encoding="utf-8"))
        if not isinstance(loaded, list) or not loaded:
            raise ValueError(
                f"resolved Android runtime artifacts manifest is empty: {resolved_artifacts_json}"
            )
        for row in loaded:
            if not isinstance(row, dict):
                raise ValueError("resolved Android runtime artifact row must be an object")
            raw_records.append(row)
    elif files_2_1_root is not None:
        for group_dir in sorted(p for p in files_2_1_root.iterdir() if p.is_dir()):
            for artifact_dir in sorted(p for p in group_dir.iterdir() if p.is_dir()):
                for version_dir in sorted(p for p in artifact_dir.iterdir() if p.is_dir()):
                    group = group_dir.name
                    artifact = artifact_dir.name
                    version = version_dir.name
                    binaries = sorted(
                        p
                        for p in version_dir.glob("*/*")
                        if p.is_file()
                        and not p.is_symlink()
                        and p.suffix in {".jar", ".aar"}
                        and not p.name.endswith(("-sources.jar", "-javadoc.jar"))
                    )
                    if not binaries:
                        continue
                    pom = _find_pom_in_gradle_cache(files_2_1_root, group, artifact, version)
                    pom_list = [str(pom)] if pom is not None else []
                    for binary in binaries:
                        raw_records.append(
                            {
                                "group": group,
                                "artifact": artifact,
                                "version": version,
                                "artifact_path": str(binary),
                                "pom_paths": pom_list,
                            }
                        )
    else:
        default_home = Path(os.environ.get("GRADLE_USER_HOME", str(Path.home() / ".gradle")))
        default_files_2_1 = default_home / "caches" / "modules-2" / "files-2.1"
        raise ValueError(
            "either --resolved-artifacts-json or a populated --gradle-user-home "
            f"(checked {default_files_2_1}) is required to hash real Android runtime artifacts"
        )

    if not raw_records:
        raise ValueError("no resolved Android runtime .jar/.aar artifacts found in Gradle cache")

    # Group by coordinate to detect whether multiple distinct binaries share G:A:V.
    deduped_entries: list[tuple[str, str, str, Path, str, list[Path]]] = []
    seen_coord_digest: set[tuple[str, str, str, str]] = set()
    coord_counts: dict[tuple[str, str, str], int] = {}

    for rec in raw_records:
        group = str(rec.get("group", "")).strip()
        artifact = str(rec.get("artifact", "")).strip()
        version = str(rec.get("version", "")).strip()
        artifact_path_str = str(rec.get("artifact_path", "")).strip()
        if not (group and artifact and version and artifact_path_str):
            raise ValueError(f"incomplete Android runtime artifact record: {rec!r}")
        artifact_path = Path(artifact_path_str)
        if artifact_path.suffix not in {".jar", ".aar"}:
            continue

        digest = sha256_regular_file(artifact_path)
        dedup_key = (group, artifact, version, digest)
        if dedup_key in seen_coord_digest:
            continue
        seen_coord_digest.add(dedup_key)

        raw_poms = rec.get("pom_paths")
        pom_paths = (
            [Path(str(p)) for p in raw_poms if str(p).strip()]
            if isinstance(raw_poms, list)
            else []
        )
        if not pom_paths and files_2_1_root is not None:
            cached_pom = _find_pom_in_gradle_cache(files_2_1_root, group, artifact, version)
            if cached_pom is not None:
                pom_paths.append(cached_pom)

        coord_key = (group, artifact, version)
        coord_counts[coord_key] = coord_counts.get(coord_key, 0) + 1
        deduped_entries.append((group, artifact, version, artifact_path, digest, pom_paths))

    if not deduped_entries:
        raise ValueError("no .jar or .aar runtime binaries remained after filtering")

    items: list[dict[str, str]] = []
    used_refs: set[str] = set()
    for group, artifact, version, artifact_path, digest, pom_paths in deduped_entries:
        coord = f"{group}:{artifact}"
        coord_label = f"{coord}:{version}"
        spdx_license = resolve_spdx_from_pom_chain(
            coord_label,
            pom_paths,
            files_2_1_root=files_2_1_root,
            enforce_permissive=enforce_permissive,
        )
        base_ref = f"pkg:maven/{group}/{artifact}@{version}"
        if coord_counts[(group, artifact, version)] > 1:
            stem_suffix = artifact_path.stem
            prefix = f"{artifact}-{version}"
            qualifier = (
                stem_suffix[len(prefix) :].lstrip("-.")
                if stem_suffix.startswith(prefix)
                else stem_suffix
            )
            ext = artifact_path.suffix.lstrip(".")
            qual_part = qualifier or ext
            ref = f"{base_ref}?classifier={qual_part}"
            if ref in used_refs:
                ref = f"{base_ref}?sha256={digest[:12]}"
        else:
            ref = base_ref

        used_refs.add(ref)
        items.append(
            {
                "ref": ref,
                "name": coord,
                "version": version,
                "sha256": digest,
                "license": spdx_license,
            }
        )

    return sorted(items, key=lambda item: item["ref"])


def _cyclonedx_license_choice(spdx_expr: str) -> dict[str, object]:
    if " " in spdx_expr or "(" in spdx_expr or ")" in spdx_expr:
        return {"expression": spdx_expr}
    return {"license": {"id": spdx_expr}}


def stage_android_release_bundle(
    first_raw: Path,
    second_raw: Path,
    candidate_dir: Path,
    revision: str,
    out_apk: Path | None = None,
    resolved_artifacts_json: Path | None = None,
    gradle_user_home: Path | None = None,
    root: Path = ROOT,
    java_version_override: str | None = None,
    enforce_permissive: bool = True,
    require_configured_buildconfig: bool = False,
) -> dict[str, object]:
    if not REVISION_RE.fullmatch(revision):
        raise ValueError("revision must be a 40-character lowercase hex commit SHA")

    if require_configured_buildconfig:
        verify_apk_release_buildconfig(first_raw)
        verify_apk_release_buildconfig(second_raw)

    first_pkg = candidate_dir / "first" / "package.zip"
    second_pkg = candidate_dir / "second" / "package.zip"
    first_sha, first_size = canonicalize_apk_zip(first_raw, first_pkg)
    second_sha, second_size = canonicalize_apk_zip(second_raw, second_pkg)

    app_version = read_android_app_version(root)
    tools = read_android_toolchain_versions(root, java_version_override=java_version_override)
    env_hash = hashlib.sha256(json.dumps(tools, sort_keys=True).encode("utf-8")).hexdigest()
    toolchain_doc = {
        "schema_version": 1,
        "environment_sha256": env_hash,
        "tools": tools,
    }
    toolchain_bytes = (json.dumps(toolchain_doc, indent=2, sort_keys=True) + "\n").encode("utf-8")
    toolchain_path = candidate_dir / "toolchain-lock.json"
    toolchain_path.write_bytes(toolchain_bytes)
    toolchain_sha = hashlib.sha256(toolchain_bytes).hexdigest()

    inventory_items = resolve_android_components(
        resolved_artifacts_json=resolved_artifacts_json,
        gradle_user_home=gradle_user_home,
        enforce_permissive=enforce_permissive,
    )
    subject_ref = f"pkg:generic/kodera-android@{revision[:12]}"
    bom_components = [
        {
            "type": "library",
            "bom-ref": item["ref"],
            "name": item["name"],
            "version": item["version"],
            "purl": item["ref"],
            "hashes": [{"alg": "SHA-256", "content": item["sha256"]}],
            "licenses": [_cyclonedx_license_choice(item["license"])],
        }
        for item in inventory_items
    ]
    bom_dependencies = [
        {"ref": subject_ref, "dependsOn": [item["ref"] for item in inventory_items]},
        *[{"ref": item["ref"], "dependsOn": []} for item in inventory_items],
    ]
    sbom_doc = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "bom-ref": subject_ref,
                "name": "Kodera",
                "version": app_version,
                "hashes": [{"alg": "SHA-256", "content": first_sha}],
                "licenses": [{"license": {"id": "Apache-2.0"}}],
                "properties": [
                    {"name": "kodera:source-revision", "value": revision},
                    {"name": "kodera:target", "value": "android-apk"},
                ],
            }
        },
        "components": bom_components,
        "dependencies": bom_dependencies,
    }
    sbom_bytes = (json.dumps(sbom_doc, indent=2, sort_keys=True) + "\n").encode("utf-8")
    sbom_path = candidate_dir / "sbom.cdx.json"
    sbom_path.write_bytes(sbom_bytes)
    sbom_sha = hashlib.sha256(sbom_bytes).hexdigest()

    build_id_1 = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kodera:android-apk:{revision}:1"))
    build_id_2 = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kodera:android-apk:{revision}:2"))
    evidence_doc = {
        "schema_version": 1,
        "revision": revision,
        "target": "android-apk",
        "source_date_epoch": FIXED_SOURCE_DATE_EPOCH,
        "toolchain_sha256": toolchain_sha,
        "sbom_sha256": sbom_sha,
        "builds": [
            {
                "invocation_id": build_id_1,
                "artifact_sha256": first_sha,
                "artifact_size": first_size,
            },
            {
                "invocation_id": build_id_2,
                "artifact_sha256": second_sha,
                "artifact_size": second_size,
            },
        ],
        "inventory": inventory_items,
    }
    evidence_path = candidate_dir / "evidence.json"
    evidence_path.write_text(
        json.dumps(evidence_doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    result: dict[str, object] = {
        "buildconfig_verified": require_configured_buildconfig,
        "first_sha256": first_sha,
        "second_sha256": second_sha,
        "components": len(inventory_items),
        "sbom": str(sbom_path),
    }
    if out_apk is not None:
        out_apk.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(first_pkg, out_apk)
        result["out_apk"] = str(out_apk)
    return result


def _encode_uleb128(value: int) -> bytes:
    if value < 0:
        raise ValueError("ULEB128 requires non-negative integer")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _build_synthetic_buildconfig_dex(fields: dict[str, object]) -> bytes:
    type_descriptors = {"Lio/kodera/android/BuildConfig;", "Ljava/lang/Object;"}
    string_pool = set(type_descriptors)
    typed_fields: list[tuple[str, str, object]] = []
    for name, val in fields.items():
        string_pool.add(name)
        if isinstance(val, bool):
            desc = "Z"
        elif isinstance(val, int):
            desc = "I"
        elif isinstance(val, str):
            desc = "Ljava/lang/String;"
            string_pool.add(val)
        else:
            raise ValueError(f"unsupported synthetic field value {val!r}")
        type_descriptors.add(desc)
        string_pool.add(desc)
        typed_fields.append((name, desc, val))

    strings = sorted(string_pool)
    str_idx = {s: idx for idx, s in enumerate(strings)}
    types = sorted(type_descriptors, key=lambda d: str_idx[d])
    type_idx = {d: idx for idx, d in enumerate(types)}

    bc_type_idx = type_idx[BUILDCONFIG_DESCRIPTOR]
    obj_type_idx = type_idx["Ljava/lang/Object;"]

    sorted_fields = sorted(
        typed_fields,
        key=lambda item: (bc_type_idx, type_idx[item[1]], str_idx[item[0]]),
    )

    header_size = 112
    string_ids_off = header_size
    type_ids_off = string_ids_off + len(strings) * 4
    field_ids_off = type_ids_off + len(types) * 4
    class_defs_off = field_ids_off + len(sorted_fields) * 8
    data_off = class_defs_off + 32

    data = bytearray()
    string_data_offsets: list[int] = []
    for s in strings:
        string_data_offsets.append(data_off + len(data))
        raw = s.encode("utf-8")
        data.extend(_encode_uleb128(len(s)))
        data.extend(raw)
        data.append(0)

    class_data_off = data_off + len(data)
    data.extend(_encode_uleb128(len(sorted_fields)))
    data.extend(_encode_uleb128(0))
    data.extend(_encode_uleb128(0))
    data.extend(_encode_uleb128(0))
    for idx in range(len(sorted_fields)):
        delta = idx if idx == 0 else 1
        data.extend(_encode_uleb128(delta))
        data.extend(_encode_uleb128(0x0019))

    static_values_off = data_off + len(data)
    data.extend(_encode_uleb128(len(sorted_fields)))
    for _name, desc, val in sorted_fields:
        if desc == "Z":
            data.append(0x1F | ((1 if val else 0) << 5))
        elif desc == "I":
            data.extend(struct.pack("<Bi", 0x04 | (3 << 5), int(val)))  # type: ignore[arg-type]
        else:
            data.extend(struct.pack("<BI", 0x17 | (3 << 5), str_idx[str(val)]))

    while len(data) % 4 != 0:
        data.append(0)

    body = bytearray()
    for off in string_data_offsets:
        body.extend(struct.pack("<I", off))
    for desc in types:
        body.extend(struct.pack("<I", str_idx[desc]))
    for name, desc, _val in sorted_fields:
        body.extend(struct.pack("<HHI", bc_type_idx, type_idx[desc], str_idx[name]))
    body.extend(
        struct.pack(
            "<IIIIIIII",
            bc_type_idx,
            0x0011,
            obj_type_idx,
            0,
            0xFFFFFFFF,
            0,
            class_data_off,
            static_values_off,
        )
    )
    body.extend(data)

    file_size = header_size + len(body)
    header_tail = struct.pack(
        "<IIIIIIIIIIIIIIIIIIII",
        file_size,
        header_size,
        DEX_ENDIAN_CONSTANT,
        0,
        0,
        0,
        len(strings),
        string_ids_off,
        len(types),
        type_ids_off,
        0,
        0,
        len(sorted_fields),
        field_ids_off,
        0,
        0,
        1,
        class_defs_off,
        len(data),
        data_off,
    )
    sha1_digest = hashlib.sha1(header_tail + body).digest()
    adler = zlib.adler32(sha1_digest + header_tail + body) & 0xFFFFFFFF
    return b"dex\n035\x00" + struct.pack("<I", adler) + sha1_digest + header_tail + bytes(body)


def _write_synthetic_apk(
    path: Path,
    dex_suffix: bytes = b"035\x00payload",
    dex_bytes: bytes | None = None,
) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("AndroidManifest.xml", b"<manifest package='io.kodera.app'/>")
        archive.writestr(
            "classes.dex",
            dex_bytes if dex_bytes is not None else (b"dex\n" + dex_suffix),
        )


def _write_maven_cache_entry(
    gradle_home: Path,
    group: str,
    artifact: str,
    version: str,
    ext: str | None,
    binary_bytes: bytes | None,
    pom_xml: str,
) -> tuple[Path | None, Path]:
    base = (
        gradle_home
        / "caches"
        / "modules-2"
        / "files-2.1"
        / group
        / artifact
        / version
    )
    pom_dir = base / "1111111111111111111111111111111111111111"
    pom_dir.mkdir(parents=True, exist_ok=True)
    pom_path = pom_dir / f"{artifact}-{version}.pom"
    pom_path.write_text(pom_xml, encoding="utf-8")

    bin_path: Path | None = None
    if ext is not None and binary_bytes is not None:
        bin_dir = base / "2222222222222222222222222222222222222222"
        bin_dir.mkdir(parents=True, exist_ok=True)
        bin_path = bin_dir / f"{artifact}-{version}.{ext}"
        bin_path.write_bytes(binary_bytes)
    return bin_path, pom_path


def run_selftest() -> int:
    revision = "a" * 40
    with tempfile.TemporaryDirectory(prefix="kodera-android-pkg-selftest-") as scratch_str:
        scratch = Path(scratch_str)
        raw1 = scratch / "raw1.apk"
        raw2 = scratch / "raw2.apk"
        _write_synthetic_apk(raw1)
        _write_synthetic_apk(raw2)

        # 1. Synthetic Gradle Maven cache with real .aar/.jar bytes + Apache-2.0, MIT (BouncyCastle),
        #    and inherited parent-POM BSD-3-Clause licenses.
        gradle_home = scratch / "gradle-home"
        appauth_bytes = b"PK\x03\x04synthetic-appauth-aar-binary-payload-v0.11.1"
        bcprov_bytes = b"PK\x03\x04synthetic-bcprov-jar-binary-payload-v1.86"
        child_bytes = b"PK\x03\x04synthetic-bsd-child-jar-binary-payload-v1.2.0"

        appauth_bin, appauth_pom = _write_maven_cache_entry(
            gradle_home,
            "net.openid",
            "appauth",
            "0.11.1",
            "aar",
            appauth_bytes,
            """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <licenses>
    <license>
      <name>The Apache Software License, Version 2.0</name>
      <url>http://www.apache.org/licenses/LICENSE-2.0.txt</url>
    </license>
  </licenses>
</project>
""",
        )
        bcprov_bin, bcprov_pom = _write_maven_cache_entry(
            gradle_home,
            "org.bouncycastle",
            "bcprov-jdk18on",
            "1.86",
            "jar",
            bcprov_bytes,
            """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <licenses>
    <license>
      <name>Bouncy Castle Licence</name>
      <url>https://www.bouncycastle.org/licence.html</url>
    </license>
  </licenses>
</project>
""",
        )
        _, parent_pom = _write_maven_cache_entry(
            gradle_home,
            "com.example",
            "parent-pom",
            "1.0.0",
            None,
            None,
            """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <licenses>
    <license>
      <name>BSD 3-Clause License</name>
      <url>https://opensource.org/licenses/BSD-3-Clause</url>
    </license>
  </licenses>
</project>
""",
        )
        child_bin, child_pom = _write_maven_cache_entry(
            gradle_home,
            "com.example",
            "child-lib",
            "1.2.0",
            "jar",
            child_bytes,
            """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <parent>
    <groupId>com.example</groupId>
    <artifactId>parent-pom</artifactId>
    <version>1.0.0</version>
  </parent>
</project>
""",
        )

        candidate_dir = scratch / "candidate"
        stage_android_release_bundle(
            raw1,
            raw2,
            candidate_dir,
            revision,
            gradle_user_home=gradle_home,
            java_version_override="21.0.2",
        )

        sbom_loaded = json.loads((candidate_dir / "sbom.cdx.json").read_text(encoding="utf-8"))
        if sbom_loaded["metadata"]["component"]["version"] != read_android_app_version(ROOT):
            print("[FAIL] Android SBOM metadata.component.version drifted from app manifest", file=sys.stderr)
            return 1
        drift_root = scratch / "drift-root"
        (drift_root / "apps" / "android" / "app").mkdir(parents=True, exist_ok=True)
        (drift_root / "apps" / "android" / "app" / "build.gradle.kts").write_text(
            'versionName = "0.1.1"\n', encoding="utf-8"
        )
        (drift_root / "package.json").write_text('{"version": "0.1.0"}\n', encoding="utf-8")
        try:
            read_android_app_version(drift_root)
            print("[FAIL] read_android_app_version accepted drifted versionName", file=sys.stderr)
            return 1
        except ValueError:
            pass
        by_ref = {comp["bom-ref"]: comp for comp in sbom_loaded["components"]}
        expected_hashes = {
            "pkg:maven/net.openid/appauth@0.11.1": (
                hashlib.sha256(appauth_bytes).hexdigest(),
                "Apache-2.0",
            ),
            "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.86": (
                hashlib.sha256(bcprov_bytes).hexdigest(),
                "MIT",
            ),
            "pkg:maven/com.example/child-lib@1.2.0": (
                hashlib.sha256(child_bytes).hexdigest(),
                "BSD-3-Clause",
            ),
        }
        if set(by_ref) != set(expected_hashes):
            print(
                f"[FAIL] unexpected resolved component refs: {sorted(by_ref)}",
                file=sys.stderr,
            )
            return 1
        for ref, (want_sha, want_lic) in expected_hashes.items():
            comp = by_ref[ref]
            got_sha = comp["hashes"][0]["content"]
            got_lic = comp["licenses"][0]["license"]["id"]
            coord_fake_sha = hashlib.sha256(
                f"{comp['name']}:{comp['version']}".encode("utf-8")
            ).hexdigest()
            if got_sha != want_sha or got_sha == coord_fake_sha:
                print(
                    f"[FAIL] component {ref} did not hash real artifact bytes: got {got_sha}, want {want_sha}",
                    file=sys.stderr,
                )
                return 1
            if got_lic != want_lic:
                print(
                    f"[FAIL] component {ref} license mismatch: got {got_lic!r}, want {want_lic!r}",
                    file=sys.stderr,
                )
                return 1

        verify_ok = subprocess.run(
            [
                sys.executable,
                str(CHECK_NATIVE_PACKAGING),
                "--first",
                str(candidate_dir / "first" / "package.zip"),
                "--second",
                str(candidate_dir / "second" / "package.zip"),
                "--sbom",
                str(candidate_dir / "sbom.cdx.json"),
                "--evidence",
                str(candidate_dir / "evidence.json"),
                "--toolchain",
                str(candidate_dir / "toolchain-lock.json"),
                "--revision",
                revision,
                "--target",
                "android-apk",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if verify_ok.returncode != 0:
            print(
                f"[FAIL] expected matching APKs + real Maven SBOM to pass check-native-packaging: {verify_ok.stderr}",
                file=sys.stderr,
            )
            return 1

        # 2. Explicit --resolved-artifacts-json manifest mode must produce identical SBOM bytes.
        manifest_path = scratch / "android-runtime-artifacts.json"
        manifest_path.write_text(
            json.dumps(
                [
                    {
                        "group": "net.openid",
                        "artifact": "appauth",
                        "version": "0.11.1",
                        "artifact_path": str(appauth_bin),
                        "pom_paths": [str(appauth_pom)],
                    },
                    {
                        "group": "org.bouncycastle",
                        "artifact": "bcprov-jdk18on",
                        "version": "1.86",
                        "artifact_path": str(bcprov_bin),
                        "pom_paths": [str(bcprov_pom)],
                    },
                    {
                        "group": "com.example",
                        "artifact": "child-lib",
                        "version": "1.2.0",
                        "artifact_path": str(child_bin),
                        "pom_paths": [str(child_pom), str(parent_pom)],
                    },
                ],
                indent=2,
            ),
            encoding="utf-8",
        )
        manifest_cand = scratch / "candidate-from-json"
        stage_android_release_bundle(
            raw1,
            raw2,
            manifest_cand,
            revision,
            resolved_artifacts_json=manifest_path,
            java_version_override="21.0.2",
        )
        if (manifest_cand / "sbom.cdx.json").read_bytes() != (
            candidate_dir / "sbom.cdx.json"
        ).read_bytes():
            print(
                "[FAIL] --resolved-artifacts-json SBOM differed from --gradle-user-home SBOM",
                file=sys.stderr,
            )
            return 1

        # 3. Negative mutation: non-reproducible second APK must be refused by check-native-packaging.py.
        drifted_raw2 = scratch / "drifted-raw2.apk"
        _write_synthetic_apk(drifted_raw2, dex_suffix=b"035\x00drifted-bytes")
        bad_candidate_dir = scratch / "bad-candidate"
        stage_android_release_bundle(
            raw1,
            drifted_raw2,
            bad_candidate_dir,
            revision,
            resolved_artifacts_json=manifest_path,
            java_version_override="21.0.2",
        )
        verify_bad = subprocess.run(
            [
                sys.executable,
                str(CHECK_NATIVE_PACKAGING),
                "--first",
                str(bad_candidate_dir / "first" / "package.zip"),
                "--second",
                str(bad_candidate_dir / "second" / "package.zip"),
                "--sbom",
                str(bad_candidate_dir / "sbom.cdx.json"),
                "--evidence",
                str(bad_candidate_dir / "evidence.json"),
                "--toolchain",
                str(bad_candidate_dir / "toolchain-lock.json"),
                "--revision",
                revision,
                "--target",
                "android-apk",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if verify_bad.returncode == 0 or "not reproducible" not in verify_bad.stderr:
            print(
                f"[FAIL] expected drifted second APK to fail reproducibility gate, got rc={verify_bad.returncode} stderr={verify_bad.stderr!r}",
                file=sys.stderr,
            )
            return 1

        # 4. Negative mutation: copyleft GPL POM must be refused both by stage_android_release_bundle
        #    AND by check-native-packaging.py.
        gpl_home = scratch / "gradle-gpl"
        _write_maven_cache_entry(
            gpl_home,
            "org.copyleft",
            "viral-lib",
            "2.0.0",
            "jar",
            b"PK\x03\x04viral-jar-bytes",
            """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <licenses>
    <license>
      <name>GNU General Public License, Version 3</name>
      <url>https://www.gnu.org/licenses/gpl-3.0.txt</url>
    </license>
  </licenses>
</project>
""",
        )
        gpl_refused_direct = False
        try:
            stage_android_release_bundle(
                raw1,
                raw2,
                scratch / "gpl-direct",
                revision,
                gradle_user_home=gpl_home,
                java_version_override="21.0.2",
            )
        except ValueError as exc:
            gpl_refused_direct = "GPL-3.0-only" in str(exc) and "non-permissive" in str(exc)
        if not gpl_refused_direct:
            print("[FAIL] expected GPL POM to fail closed in stage_android_release_bundle", file=sys.stderr)
            return 1

        gpl_cand = scratch / "gpl-gate-candidate"
        stage_android_release_bundle(
            raw1,
            raw2,
            gpl_cand,
            revision,
            gradle_user_home=gpl_home,
            java_version_override="21.0.2",
            enforce_permissive=False,
        )
        verify_gpl = subprocess.run(
            [
                sys.executable,
                str(CHECK_NATIVE_PACKAGING),
                "--first",
                str(gpl_cand / "first" / "package.zip"),
                "--second",
                str(gpl_cand / "second" / "package.zip"),
                "--sbom",
                str(gpl_cand / "sbom.cdx.json"),
                "--evidence",
                str(gpl_cand / "evidence.json"),
                "--toolchain",
                str(gpl_cand / "toolchain-lock.json"),
                "--revision",
                revision,
                "--target",
                "android-apk",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if verify_gpl.returncode == 0 or "licence" not in verify_gpl.stderr:
            print(
                f"[FAIL] expected GPL POM SBOM to fail check-native-packaging.py, got rc={verify_gpl.returncode} stderr={verify_gpl.stderr!r}",
                file=sys.stderr,
            )
            return 1

        # 5. Negative mutation: POM missing <licenses> must fail closed.
        missing_lic_home = scratch / "gradle-no-license"
        _write_maven_cache_entry(
            missing_lic_home,
            "com.mystery",
            "unlicensed-lib",
            "0.1.0",
            "jar",
            b"PK\x03\x04unlicensed-jar-bytes",
            """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
</project>
""",
        )
        missing_refused = False
        try:
            stage_android_release_bundle(
                raw1,
                raw2,
                scratch / "no-lic-cand",
                revision,
                gradle_user_home=missing_lic_home,
                java_version_override="21.0.2",
            )
        except ValueError as exc:
            missing_refused = "no <licenses> declaration" in str(exc)
        if not missing_refused:
            print("[FAIL] expected POM without <licenses> to fail closed", file=sys.stderr)
            return 1

        # 6. Hostname-strict URL parsing: spoofed hostnames/paths containing canonical domains must never match.
        if normalize_pom_license_entry("", "https://unlicense.org/") != "Unlicense":
            print("[FAIL] expected https://unlicense.org/ to classify as Unlicense", file=sys.stderr)
            return 1
        for spoof_url in (
            "https://evil.example/unlicense.org",
            "https://unlicense.org.evil.example/",
            "https://evil.example/?u=https://opensource.org/licenses/MIT",
            "javascript://unlicense.org/%0aalert(1)",
        ):
            if normalize_pom_license_entry("", spoof_url) is not None:
                print(
                    f"[FAIL] spoofed license URL {spoof_url!r} must not classify as SPDX",
                    file=sys.stderr,
                )
                return 1

        # 7. Release BuildConfig DEX verification (--require-configured-buildconfig):
        #    accepts configured HTTPS release APKs and refuses empty, cleartext, debug, or missing BuildConfig.
        valid_fields: dict[str, object] = {
            "APPLICATION_ID": "io.kodera.app",
            "BUILD_TYPE": "release",
            "DEBUG": False,
            "VERSION_CODE": 1,
            "VERSION_NAME": "0.1.0",
            "KODERA_CLIENT_ID": "kodera-android",
            "KODERA_CONSOLE_ORIGIN": "https://community.kodera.io",
            "KODERA_CORE_ORIGIN": "https://api.kodera.io",
            "KODERA_ISSUER_ORIGINS": "https://auth.kodera.io",
            "KODERA_OFFLINE_ACCESS": "",
        }
        cfg_apk1 = scratch / "configured1.apk"
        cfg_apk2 = scratch / "configured2.apk"
        valid_dex = _build_synthetic_buildconfig_dex(valid_fields)
        _write_synthetic_apk(cfg_apk1, dex_bytes=valid_dex)
        _write_synthetic_apk(cfg_apk2, dex_bytes=valid_dex)
        stage_android_release_bundle(
            cfg_apk1,
            cfg_apk2,
            scratch / "configured-cand",
            revision,
            resolved_artifacts_json=manifest_path,
            java_version_override="21.0.2",
            require_configured_buildconfig=True,
        )

        # 7b. Visible-ASCII OAuth client IDs (e.g. URN form) supported by SignInConfiguration must pass.
        urn_apk = scratch / "configured-urn.apk"
        _write_synthetic_apk(
            urn_apk,
            dex_bytes=_build_synthetic_buildconfig_dex(
                {**valid_fields, "KODERA_CLIENT_ID": "urn:example:android"}
            ),
        )
        stage_android_release_bundle(
            urn_apk,
            urn_apk,
            scratch / "configured-urn-cand",
            revision,
            resolved_artifacts_json=manifest_path,
            java_version_override="21.0.2",
            require_configured_buildconfig=True,
        )

        bad_buildconfig_cases: list[tuple[str, dict[str, object] | None, str]] = [
            ("missing BuildConfig class", None, "does not contain Lio/kodera/android/BuildConfig;"),
            ("empty KODERA_CORE_ORIGIN", {**valid_fields, "KODERA_CORE_ORIGIN": ""}, "KODERA_CORE_ORIGIN is empty"),
            ("empty KODERA_ISSUER_ORIGINS", {**valid_fields, "KODERA_ISSUER_ORIGINS": ""}, "KODERA_ISSUER_ORIGINS is empty"),
            ("empty KODERA_CLIENT_ID", {**valid_fields, "KODERA_CLIENT_ID": ""}, "KODERA_CLIENT_ID must be a non-empty"),
            ("empty KODERA_CONSOLE_ORIGIN", {**valid_fields, "KODERA_CONSOLE_ORIGIN": ""}, "KODERA_CONSOLE_ORIGIN is empty"),
            ("cleartext loopback core origin", {**valid_fields, "KODERA_CORE_ORIGIN": "http://localhost:8000"}, "KODERA_CORE_ORIGIN must be a bare https:// DNS origin"),
            ("explicit port in core origin", {**valid_fields, "KODERA_CORE_ORIGIN": "https://api.kodera.io:443"}, "KODERA_CORE_ORIGIN must be a bare https:// DNS origin"),
            ("debug flag enabled", {**valid_fields, "DEBUG": True}, "BuildConfig.DEBUG must be False"),
            ("dev issuer leaked into release", {**valid_fields, "KODERA_DEV_ISSUER": "https://auth.kodera.io/realms/dev"}, "must never declare KODERA_DEV_ISSUER"),
        ]
        for idx, (label, bad_fields, expected_err) in enumerate(bad_buildconfig_cases):
            bad_apk = scratch / f"bad-bc-{idx}.apk"
            if bad_fields is None:
                _write_synthetic_apk(bad_apk, dex_bytes=_build_synthetic_buildconfig_dex({"ONLY_OTHER": "x"}).replace(b"Lio/kodera/android/BuildConfig;", b"Lio/kodera/android/OtherConfig;"))
            else:
                _write_synthetic_apk(bad_apk, dex_bytes=_build_synthetic_buildconfig_dex(bad_fields))
            refused = False
            try:
                stage_android_release_bundle(
                    bad_apk,
                    cfg_apk2,
                    scratch / f"bad-bc-cand-{idx}",
                    revision,
                    resolved_artifacts_json=manifest_path,
                    java_version_override="21.0.2",
                    require_configured_buildconfig=True,
                )
            except ValueError as exc:
                refused = expected_err in str(exc)
            if not refused:
                print(
                    f"[FAIL] BuildConfig negative case '{label}' did not fail with '{expected_err}'",
                    file=sys.stderr,
                )
                return 1

    print(
        "OK: package-android-release.py selftest passed "
        "(real Maven artifact SHA-256 + POM SPDX inheritance + drifted/GPL/missing-license refusals)."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--first-raw", type=Path)
    parser.add_argument("--second-raw", type=Path)
    parser.add_argument("--candidate-dir", type=Path)
    parser.add_argument("--out-apk", type=Path, default=None)
    parser.add_argument("--resolved-artifacts-json", type=Path, default=None)
    parser.add_argument("--gradle-user-home", type=Path, default=None)
    parser.add_argument("--revision", default="")
    parser.add_argument("--require-configured-buildconfig", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return run_selftest()

    if not (args.first_raw and args.second_raw and args.candidate_dir and args.revision):
        parser.error("--first-raw, --second-raw, --candidate-dir, and --revision are required")

    result = stage_android_release_bundle(
        args.first_raw,
        args.second_raw,
        args.candidate_dir,
        args.revision,
        out_apk=args.out_apk,
        resolved_artifacts_json=args.resolved_artifacts_json,
        gradle_user_home=args.gradle_user_home,
        require_configured_buildconfig=args.require_configured_buildconfig,
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
