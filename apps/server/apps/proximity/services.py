"""Zero-GPS in-memory `#proximity` check-in & rotating HKDF beacon resolution broker.

Privacy-by-design invariants:
1. Zero GPS / coordinate persistence or acceptance: any payload or query parameter naming
   latitude, longitude, GPS, altitude, or geolocation fields is refused with HTTP 422.
2. Ephemeral in-memory storage only: records live exclusively in process memory with strict
   TTL <= 2 hours (default 30 minutes) and are purged lazily on every access and immediately
   on checkout.
3. Cryptographic rotating token verification: beacons use RFC 5869 HKDF-SHA256 15-minute
   rotating epochs (`KT\\x01` wire parity with `packages/kodera-rs/src/proximity.rs`) verified
   in constant time.
4. Mutual opt-in & workspace scope isolation: a principal can resolve or list nearby peers
   only while actively opted in within the exact same `(workspace_id, event_scope)`.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.core.exceptions import ObjectDoesNotExist

from apps.orgs.actor_selectors import TenantCaller
from apps.workspaces.moderation import RefusalError as WorkspaceRefusal, authorise_workspace
from apps.workspaces.selectors import workspace_organisation
from services.identity.access_tokens import VerifiedAccessToken

PROXIMITY_EPOCH_ROTATION_SECS = 15 * 60
PROXIMITY_EPOCH_CLOCK_SKEW_SECS = 60
PROXIMITY_EPHEMERAL_TOKEN_BYTES = 32
DEFAULT_TTL_SECONDS = 30 * 60
MIN_TTL_SECONDS = 60
MAX_TTL_SECONDS = 2 * 60 * 60
MAX_STATUS_NOTE_CHARS = 80
MAX_HANDLE_CHARS = 32
MAX_RESOLVE_TOKENS = 32
MAX_ACTIVE_CHECKINS = 8192

TOKEN_MAGIC = b"KT"
TOKEN_VERSION = 1

SCOPE_PATTERN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}\Z")
HANDLE_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{1,31}\Z")
HEX64_PATTERN = re.compile(r"[0-9a-fA-F]{64}\Z")

ALLOWED_TRANSPORTS = frozenset({"ble", "mdns_quic", "hybrid"})
ALLOWED_DISTANCE_BANDS = frozenset({"immediate", "near", "ambient"})

FORBIDDEN_COORDINATE_KEYS = frozenset(
    {
        "lat",
        "latitude",
        "lon",
        "lng",
        "long",
        "longitude",
        "gps",
        "gps_coords",
        "coord",
        "coords",
        "coordinates",
        "geo",
        "geolocation",
        "geo_location",
        "geo_point",
        "location_coords",
        "altitude",
        "accuracy_meters",
        "horizontal_accuracy",
        "heading",
        "bearing",
        "speed_mps",
        "bssid",
    }
)


class ProximityRefusalError(Exception):
    """Structured refusal mapped to RFC 9457 `application/problem+json`."""

    def __init__(
        self,
        status: int,
        *,
        kind: str | None = None,
        reason: str | None = None,
    ) -> None:
        super().__init__(reason or kind or str(status))
        self.status = status
        self.kind = kind
        self.reason = reason


def _normalize_key(raw_key: str) -> str:
    return re.sub(r"[\s.\-]+", "_", raw_key.strip().lower())


def assert_zero_gps_payload(value: Any, *, _depth: int = 0) -> None:
    """Recursively refuses (`422`) any dict/list payload carrying GPS or coordinate keys."""
    if _depth > 12:
        raise ProximityRefusalError(422, kind="validation-error", reason="payload_too_deep")
    if isinstance(value, Mapping):
        for raw_key, nested in value.items():
            if isinstance(raw_key, str):
                normalized = _normalize_key(raw_key)
                if normalized in FORBIDDEN_COORDINATE_KEYS or any(
                    part in {"latitude", "longitude", "gps", "geolocation", "coordinates"}
                    for part in normalized.split("_")
                ):
                    raise ProximityRefusalError(
                        422,
                        kind="gps-coordinates-forbidden",
                        reason="gps_coordinates_forbidden",
                    )
            assert_zero_gps_payload(nested, _depth=_depth + 1)
    elif isinstance(value, list | tuple):
        for item in value:
            assert_zero_gps_payload(item, _depth=_depth + 1)


def assert_zero_gps_query(params: Mapping[str, Any]) -> None:
    """Refuses (`422`) any query string carrying GPS or coordinate parameters."""
    assert_zero_gps_payload(dict(params))


# ---------------------------------------------------------------------------
# RFC 5869 HKDF-SHA256 & 32-Byte Rotating Token (`KT\x01` parity with Rust)
# ---------------------------------------------------------------------------


def hkdf_extract_sha256(salt: bytes, ikm: bytes) -> bytes:
    effective_salt = salt if salt else (b"\x00" * 32)
    return hmac.new(effective_salt, ikm, hashlib.sha256).digest()


def hkdf_expand_sha256(prk: bytes, info: bytes, length: int) -> bytes:
    if length < 0 or length > 255 * 32:
        raise ValueError("HKDF output length out of range")
    if length == 0:
        return b""
    blocks = (length + 31) // 32
    prev = b""
    out = bytearray()
    for index in range(1, blocks + 1):
        prev = hmac.new(prk, prev + info + bytes([index]), hashlib.sha256).digest()
        out.extend(prev)
    return bytes(out[:length])


def hkdf_sha256(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    prk = hkdf_extract_sha256(salt, ikm)
    return hkdf_expand_sha256(prk, info, length)


def proximity_epoch(unix_secs: int) -> int:
    return max(0, unix_secs) // PROXIMITY_EPOCH_ROTATION_SECS


def _candidate_epochs(now_unix_secs: int) -> list[int]:
    current = proximity_epoch(now_unix_secs)
    epochs = [current]
    offset = max(0, now_unix_secs) % PROXIMITY_EPOCH_ROTATION_SECS
    if offset < PROXIMITY_EPOCH_CLOCK_SKEW_SECS and current > 0:
        epochs.append(current - 1)
    if offset >= PROXIMITY_EPOCH_ROTATION_SECS - PROXIMITY_EPOCH_CLOCK_SKEW_SECS:
        epochs.append(current + 1)
    return epochs


def _derive_epoch_mac_key(
    workspace_master_key: bytes, workspace_id: UUID, event_scope: str, epoch: int
) -> bytes:
    salt = f"{workspace_id}:{event_scope}".encode("ascii")
    info = b"kodera.proximity.w9.epoch-mac.v1:" + epoch.to_bytes(4, "big")
    return hkdf_sha256(salt, workspace_master_key, info, 32)


def _derive_rolling_pseudonym(
    device_ephemeral_seed: bytes, workspace_id: UUID, event_scope: str, epoch: int
) -> bytes:
    info = f"kodera.proximity.w9.pseudonym.v1:{workspace_id}:{event_scope}".encode("ascii")
    return hkdf_sha256(epoch.to_bytes(4, "big"), device_ephemeral_seed, info, 8)


def _compute_token_mac(
    epoch_mac_key: bytes, workspace_id: UUID, event_scope: str, header_and_body: bytes
) -> bytes:
    org_bytes = str(workspace_id).encode("ascii")
    scope_bytes = event_scope.encode("ascii")
    transcript = (
        b"kodera.proximity.w9.token-mac.v1:"
        + bytes([len(org_bytes)])
        + org_bytes
        + bytes([len(scope_bytes)])
        + scope_bytes
        + header_and_body
    )
    return hmac.new(epoch_mac_key, transcript, hashlib.sha256).digest()[:12]


def mint_ephemeral_beacon_token(
    *,
    workspace_master_key: bytes,
    device_ephemeral_seed: bytes,
    workspace_id: UUID,
    event_scope: str,
    now_unix_secs: int,
    counter: int = 0,
) -> str:
    """Mints a 32-byte (`64`-hex) `KT\\x01` rotating HKDF proximity token matching `kodera-rs`."""
    if len(workspace_master_key) != 32 or len(device_ephemeral_seed) != 32:
        raise ValueError("keys must be 32 bytes")
    if hmac.compare_digest(workspace_master_key, device_ephemeral_seed):
        raise ValueError("device seed must be distinct from workspace master key")
    epoch = proximity_epoch(now_unix_secs)
    pseudonym = _derive_rolling_pseudonym(device_ephemeral_seed, workspace_id, event_scope, epoch)
    header_and_body = (
        TOKEN_MAGIC
        + bytes([TOKEN_VERSION, 0])
        + epoch.to_bytes(4, "big")
        + counter.to_bytes(4, "big")
        + pseudonym
    )
    epoch_mac_key = _derive_epoch_mac_key(workspace_master_key, workspace_id, event_scope, epoch)
    mac_tag = _compute_token_mac(epoch_mac_key, workspace_id, event_scope, header_and_body)
    return (header_and_body + mac_tag).hex()


@dataclass(frozen=True)
class VerifiedBeaconProof:
    token_hex: str
    epoch: int
    counter: int
    rolling_pseudonym_hex: str


def verify_ephemeral_beacon_token(
    token_hex: str,
    *,
    workspace_master_key: bytes,
    workspace_id: UUID,
    event_scope: str,
    now_unix_secs: int,
) -> VerifiedBeaconProof:
    """Verifies a 64-hex `KT\\x01` rotating HKDF beacon token in constant time."""
    if not isinstance(token_hex, str) or HEX64_PATTERN.fullmatch(token_hex) is None:
        raise ProximityRefusalError(422, kind="validation-error", reason="invalid_beacon_token")
    raw = bytes.fromhex(token_hex)
    if len(raw) != PROXIMITY_EPHEMERAL_TOKEN_BYTES or raw[0:2] != TOKEN_MAGIC or raw[3] != 0:
        raise ProximityRefusalError(422, kind="validation-error", reason="invalid_beacon_token")
    if raw[2] != TOKEN_VERSION:
        raise ProximityRefusalError(
            422, kind="validation-error", reason="unsupported_token_version"
        )

    token_epoch = int.from_bytes(raw[4:8], "big")
    counter = int.from_bytes(raw[8:12], "big")
    pseudonym_hex = raw[12:20].hex()
    supplied_mac = raw[20:32]

    if token_epoch not in _candidate_epochs(now_unix_secs):
        raise ProximityRefusalError(
            422, kind="expired-proximity-token", reason="token_epoch_expired"
        )

    epoch_mac_key = _derive_epoch_mac_key(
        workspace_master_key, workspace_id, event_scope, token_epoch
    )
    expected_mac = _compute_token_mac(epoch_mac_key, workspace_id, event_scope, raw[0:20])
    if not hmac.compare_digest(expected_mac, supplied_mac):
        raise ProximityRefusalError(
            422, kind="invalid-proximity-proof", reason="invalid_beacon_proof"
        )

    return VerifiedBeaconProof(
        token_hex=raw.hex(),
        epoch=token_epoch,
        counter=counter,
        rolling_pseudonym_hex=pseudonym_hex,
    )


# ---------------------------------------------------------------------------
# Voluntary Ephemeral Check-in Broker (In-Memory Only, Zero Persistence)
# ---------------------------------------------------------------------------


def validate_event_scope(raw: Any) -> str:
    if raw is None:
        return "default"
    if not isinstance(raw, str) or SCOPE_PATTERN.fullmatch(raw) is None:
        raise ProximityRefusalError(422, kind="validation-error", reason="invalid_event_scope")
    return raw


def validate_ttl_seconds(raw: Any) -> int:
    if raw is None:
        return DEFAULT_TTL_SECONDS
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ProximityRefusalError(422, kind="validation-error", reason="invalid_ttl_seconds")
    if raw < MIN_TTL_SECONDS or raw > MAX_TTL_SECONDS:
        raise ProximityRefusalError(422, kind="validation-error", reason="ttl_out_of_bounds")
    return raw


def validate_status_note(raw: Any) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise ProximityRefusalError(422, kind="validation-error", reason="invalid_status_note")
    trimmed = raw.strip()
    if len(trimmed) > MAX_STATUS_NOTE_CHARS:
        raise ProximityRefusalError(422, kind="validation-error", reason="status_note_too_long")
    if any(unicodedata.category(ch).startswith("C") for ch in trimmed):
        raise ProximityRefusalError(422, kind="validation-error", reason="invalid_status_note")
    return trimmed


def _derive_pseudonymous_handle(secret: bytes, workspace_id: UUID, principal_key: str) -> str:
    digest = hmac.new(
        secret,
        f"kodera.proximity.w9.handle.v1:{workspace_id}:{principal_key}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"prox-{digest[:8]}"


def validate_or_generate_handle(
    raw: Any, *, secret: bytes, workspace_id: UUID, principal_key: str
) -> str:
    if raw is None or raw == "":
        return _derive_pseudonymous_handle(secret, workspace_id, principal_key)
    if not isinstance(raw, str) or HANDLE_PATTERN.fullmatch(raw) is None:
        raise ProximityRefusalError(422, kind="validation-error", reason="invalid_handle")
    return raw


@dataclass(frozen=True)
class VoluntaryCheckInRecord:
    workspace_id: UUID
    event_scope: str
    principal_key: str
    handle: str
    status_note: str
    beacon_token_hex: str
    token_epoch: int
    rolling_pseudonym_hex: str
    transport: str
    distance_band: str
    checked_in_at: int
    expires_at: int

    def to_peer_summary(
        self,
        *,
        now_unix_secs: int,
        observed_band: str | None = None,
        observed_transport: str | None = None,
    ) -> dict[str, Any]:
        return {
            "handle": self.handle,
            "status_note": self.status_note,
            "rolling_pseudonym": self.rolling_pseudonym_hex,
            "transport": observed_transport or self.transport,
            "distance_band": observed_band or self.distance_band,
            "expires_in_seconds": max(0, self.expires_at - now_unix_secs),
            "expires_at": self.expires_at,
        }


def authorise_proximity_workspace(
    *, verified: VerifiedAccessToken, workspace_id: UUID
) -> TenantCaller:
    """Resolves `workspace_id` and enforces active tenant membership on every `#proximity` call."""
    try:
        organisation_id = workspace_organisation(workspace_id=workspace_id)
    except ObjectDoesNotExist:
        raise ProximityRefusalError(404, kind="not-found") from None
    try:
        return authorise_workspace(verified=verified, organisation_id=organisation_id)
    except WorkspaceRefusal as error:
        raise ProximityRefusalError(error.status, kind=error.kind) from None


class ProximityBroker:
    """Thread-safe, zero-persistence in-memory `#proximity` voluntary check-in broker."""

    def __init__(self, *, broker_secret: bytes | None = None) -> None:
        self._secret = (
            broker_secret if broker_secret and len(broker_secret) == 32 else secrets.token_bytes(32)
        )
        self._lock = threading.RLock()
        self._by_principal: dict[tuple[UUID, str, str], VoluntaryCheckInRecord] = {}
        self._by_token: dict[tuple[UUID, str, str], tuple[UUID, str, str]] = {}
        self._by_pseudonym: dict[tuple[UUID, str, int, str], tuple[UUID, str, str]] = {}

    def workspace_beacon_key(self, workspace_id: UUID, event_scope: str = "default") -> bytes:
        scope = validate_event_scope(event_scope)
        info = f"kodera.proximity.w9.ws-master.v1:{workspace_id}:{scope}".encode("ascii")
        return hkdf_sha256(bytes(workspace_id.bytes), self._secret, info, 32)

    def bootstrap(
        self,
        *,
        workspace_id: UUID,
        event_scope: str = "default",
        now_unix_secs: int | None = None,
    ) -> dict[str, Any]:
        now = int(time.time()) if now_unix_secs is None else now_unix_secs
        scope = validate_event_scope(event_scope)
        master = self.workspace_beacon_key(workspace_id, scope)
        return {
            "workspace_id": str(workspace_id),
            "event_scope": scope,
            "workspace_beacon_key": master.hex(),
            "epoch": proximity_epoch(now),
            "epoch_rotation_seconds": PROXIMITY_EPOCH_ROTATION_SECS,
        }

    def mint_client_token(
        self,
        *,
        workspace_id: UUID,
        event_scope: str = "default",
        device_seed: bytes,
        now_unix_secs: int | None = None,
        counter: int = 0,
    ) -> str:
        scope = validate_event_scope(event_scope)
        now = int(time.time()) if now_unix_secs is None else now_unix_secs
        master = self.workspace_beacon_key(workspace_id, scope)
        return mint_ephemeral_beacon_token(
            workspace_master_key=master,
            device_ephemeral_seed=device_seed,
            workspace_id=workspace_id,
            event_scope=scope,
            now_unix_secs=now,
            counter=counter,
        )

    def checkin(
        self,
        *,
        principal_key: str,
        workspace_id: UUID,
        beacon_token_hex: str,
        event_scope: str = "default",
        ttl_seconds: int | None = None,
        status_note: str | None = None,
        handle: str | None = None,
        transport: str = "hybrid",
        distance_band: str = "near",
        now_unix_secs: int | None = None,
    ) -> dict[str, Any]:
        now = int(time.time()) if now_unix_secs is None else now_unix_secs
        scope = validate_event_scope(event_scope)
        ttl = validate_ttl_seconds(ttl_seconds)
        note = validate_status_note(status_note)
        resolved_handle = validate_or_generate_handle(
            handle,
            secret=self._secret,
            workspace_id=workspace_id,
            principal_key=principal_key,
        )
        if transport not in ALLOWED_TRANSPORTS:
            raise ProximityRefusalError(422, kind="validation-error", reason="invalid_transport")
        if distance_band not in ALLOWED_DISTANCE_BANDS:
            raise ProximityRefusalError(
                422, kind="validation-error", reason="invalid_distance_band"
            )

        master = self.workspace_beacon_key(workspace_id, scope)
        verified = verify_ephemeral_beacon_token(
            beacon_token_hex,
            workspace_master_key=master,
            workspace_id=workspace_id,
            event_scope=scope,
            now_unix_secs=now,
        )

        record_key = (workspace_id, scope, principal_key)
        token_key = (workspace_id, scope, verified.token_hex)
        pseudonym_key = (workspace_id, scope, verified.epoch, verified.rolling_pseudonym_hex)

        with self._lock:
            self._purge_expired_locked(now)

            # Prevent another principal in the same workspace from reusing an already-bound token.
            existing_token_owner = self._by_token.get(token_key)
            if existing_token_owner is not None and existing_token_owner != record_key:
                raise ProximityRefusalError(
                    409, kind="conflict", reason="beacon_token_already_claimed"
                )
            existing_pseudo_owner = self._by_pseudonym.get(pseudonym_key)
            if existing_pseudo_owner is not None and existing_pseudo_owner != record_key:
                raise ProximityRefusalError(
                    409, kind="conflict", reason="beacon_pseudonym_already_claimed"
                )

            if (
                record_key not in self._by_principal
                and len(self._by_principal) >= MAX_ACTIVE_CHECKINS
            ):
                raise ProximityRefusalError(
                    503, kind="service-unavailable", reason="broker_capacity_reached"
                )

            self._remove_key_locked(record_key)
            record = VoluntaryCheckInRecord(
                workspace_id=workspace_id,
                event_scope=scope,
                principal_key=principal_key,
                handle=resolved_handle,
                status_note=note,
                beacon_token_hex=verified.token_hex,
                token_epoch=verified.epoch,
                rolling_pseudonym_hex=verified.rolling_pseudonym_hex,
                transport=transport,
                distance_band=distance_band,
                checked_in_at=now,
                expires_at=now + ttl,
            )
            self._by_principal[record_key] = record
            self._by_token[token_key] = record_key
            self._by_pseudonym[pseudonym_key] = record_key

        return {
            "workspace_id": str(workspace_id),
            "event_scope": scope,
            "handle": record.handle,
            "status_note": record.status_note,
            "rolling_pseudonym": record.rolling_pseudonym_hex,
            "epoch": record.token_epoch,
            "ttl_seconds": ttl,
            "expires_at": record.expires_at,
            "gps_persisted": False,
        }

    def resolve(
        self,
        *,
        principal_key: str,
        workspace_id: UUID,
        observed_tokens: list[dict[str, Any]],
        event_scope: str = "default",
        now_unix_secs: int | None = None,
    ) -> dict[str, Any]:
        now = int(time.time()) if now_unix_secs is None else now_unix_secs
        scope = validate_event_scope(event_scope)
        if not isinstance(observed_tokens, list) or len(observed_tokens) > MAX_RESOLVE_TOKENS:
            raise ProximityRefusalError(
                422, kind="validation-error", reason="invalid_observed_tokens"
            )

        master = self.workspace_beacon_key(workspace_id, scope)

        with self._lock:
            self._purge_expired_locked(now)
            caller_key = (workspace_id, scope, principal_key)
            if caller_key not in self._by_principal:
                raise ProximityRefusalError(
                    403, kind="opt-in-required", reason="caller_not_checked_in"
                )

            resolved_peers: list[dict[str, Any]] = []
            seen_principals: set[str] = {principal_key}

            for item in observed_tokens:
                if not isinstance(item, Mapping):
                    raise ProximityRefusalError(
                        422, kind="validation-error", reason="invalid_observed_token_entry"
                    )
                extra_keys = set(item.keys()) - {"beacon_token", "distance_band", "transport"}
                if extra_keys or "beacon_token" not in item:
                    raise ProximityRefusalError(
                        422, kind="validation-error", reason="invalid_observed_token_entry"
                    )
                raw_tok = item["beacon_token"]
                obs_band = item.get("distance_band")
                if obs_band is not None and obs_band not in ALLOWED_DISTANCE_BANDS:
                    raise ProximityRefusalError(
                        422, kind="validation-error", reason="invalid_distance_band"
                    )
                obs_transport = item.get("transport")
                if obs_transport is not None and obs_transport not in ALLOWED_TRANSPORTS:
                    raise ProximityRefusalError(
                        422, kind="validation-error", reason="invalid_transport"
                    )

                verified = verify_ephemeral_beacon_token(
                    raw_tok,
                    workspace_master_key=master,
                    workspace_id=workspace_id,
                    event_scope=scope,
                    now_unix_secs=now,
                )

                peer_record_key = self._by_token.get(
                    (workspace_id, scope, verified.token_hex)
                ) or self._by_pseudonym.get(
                    (workspace_id, scope, verified.epoch, verified.rolling_pseudonym_hex)
                )
                if peer_record_key is None:
                    continue
                peer = self._by_principal.get(peer_record_key)
                if peer is None or peer.principal_key in seen_principals:
                    continue
                seen_principals.add(peer.principal_key)
                resolved_peers.append(
                    peer.to_peer_summary(
                        now_unix_secs=now,
                        observed_band=obs_band,
                        observed_transport=obs_transport,
                    )
                )

        return {
            "workspace_id": str(workspace_id),
            "event_scope": scope,
            "peers": resolved_peers,
        }

    def nearby(
        self,
        *,
        principal_key: str,
        workspace_id: UUID,
        event_scope: str = "default",
        now_unix_secs: int | None = None,
    ) -> dict[str, Any]:
        now = int(time.time()) if now_unix_secs is None else now_unix_secs
        scope = validate_event_scope(event_scope)

        with self._lock:
            self._purge_expired_locked(now)
            caller_key = (workspace_id, scope, principal_key)
            caller = self._by_principal.get(caller_key)
            if caller is None:
                raise ProximityRefusalError(
                    403, kind="opt-in-required", reason="caller_not_checked_in"
                )
            peers = [
                record.to_peer_summary(now_unix_secs=now)
                for (ws_id, rec_scope, p_key), record in self._by_principal.items()
                if ws_id == workspace_id and rec_scope == scope and p_key != principal_key
            ]

        peers.sort(key=lambda item: str(item["handle"]))
        return {
            "workspace_id": str(workspace_id),
            "event_scope": scope,
            "self": {
                "handle": caller.handle,
                "status_note": caller.status_note,
                "expires_in_seconds": max(0, caller.expires_at - now),
                "expires_at": caller.expires_at,
            },
            "peers": peers,
        }

    def checkout(
        self,
        *,
        principal_key: str,
        workspace_id: UUID,
        event_scope: str | None = None,
        now_unix_secs: int | None = None,
    ) -> dict[str, Any]:
        now = int(time.time()) if now_unix_secs is None else now_unix_secs
        scope = validate_event_scope(event_scope) if event_scope is not None else None

        with self._lock:
            self._purge_expired_locked(now)
            targets = [
                key
                for key in self._by_principal
                if key[0] == workspace_id
                and key[2] == principal_key
                and (scope is None or key[1] == scope)
            ]
            for key in targets:
                self._remove_key_locked(key)

        return {
            "workspace_id": str(workspace_id),
            "checked_out": True,
            "purged_records": len(targets),
        }

    def clear(self) -> None:
        with self._lock:
            self._by_principal.clear()
            self._by_token.clear()
            self._by_pseudonym.clear()

    def _purge_expired_locked(self, now_unix_secs: int) -> None:
        expired = [
            key for key, record in self._by_principal.items() if record.expires_at <= now_unix_secs
        ]
        for key in expired:
            self._remove_key_locked(key)

    def _remove_key_locked(self, key: tuple[UUID, str, str]) -> None:
        record = self._by_principal.pop(key, None)
        if record is None:
            return
        self._by_token.pop((record.workspace_id, record.event_scope, record.beacon_token_hex), None)
        self._by_pseudonym.pop(
            (
                record.workspace_id,
                record.event_scope,
                record.token_epoch,
                record.rolling_pseudonym_hex,
            ),
            None,
        )


DEFAULT_BROKER = ProximityBroker()
