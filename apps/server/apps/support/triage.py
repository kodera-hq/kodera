"""Automated support@kodera.io ticket triage, deduplication, and zero-PII issue builder."""

import hashlib
import re
from dataclasses import dataclass
from ipaddress import IPv6Address
from typing import Any
from uuid import UUID

from .models import CATEGORIES, SEVERITIES, SupportTicket

PRIORITIES = ("P0", "P1", "P2", "P3")
QUEUES = (
    "security-incident",
    "infra-sre",
    "identity-access",
    "billing-ops",
    "product-engineering",
    "compliance-dpo",
)
SLA_TARGETS_MINUTES: dict[str, int] = {
    "P0": 15,
    "P1": 60,
    "P2": 240,
    "P3": 1440,
}

# Regex patterns for zero-PII redaction and subject normalization.
_JWT_OR_BEARER_RE = re.compile(
    r"(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b)",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(
    r"\b[\w.%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b"
)
_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
_IPV4_RE = re.compile(
    r"\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b"
)
_IPV6_RE = re.compile(r"(?<![\w:])(?:[0-9a-fA-F]*:){2,}[0-9a-fA-F:.]*(?:%[A-Za-z0-9_-]+)?(?![\w:])")
_PHONE_RE = re.compile(r"(?<!\w)\+?\d(?:[ .()/-]*\d){6,14}(?!\w)")
_DIGITS_AND_PUNCT_RE = re.compile(r"[\d#/:;,.!?()\[\]{}\"'`~<>+=|\\\r\n\t-]+")

# Ordered component keyword detectors: (component_id, regex).
_COMPONENT_DETECTORS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("keycloak", re.compile(r"\bkeycloak\b", re.IGNORECASE)),
    ("webauthn", re.compile(r"\bwebauthn\b", re.IGNORECASE)),
    ("matrix", re.compile(r"\bmatrix\b", re.IGNORECASE)),
    ("synapse", re.compile(r"\bsynapse\b", re.IGNORECASE)),
    ("livekit", re.compile(r"\blivekit\b", re.IGNORECASE)),
    ("frameio", re.compile(r"\bframe\.?io\b", re.IGNORECASE)),
    ("billing", re.compile(r"\b(?:stripe|facture|facturation)\b", re.IGNORECASE)),
    ("privacy-dpo", re.compile(r"\b(?:rgpd|gdpr)\b", re.IGNORECASE)),
)
_URGENCY_RE = re.compile(r"\b(?:urgence|urgent)\b", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class TicketTriageInput:
    ticket_id: UUID
    organisation_id: UUID
    category: str
    severity: str
    subject: str
    body: str
    locale: str = "fr"
    tenant_slug: str | None = None
    pack_code: str | None = None
    reply_to_email: str | None = None
    contact_email: str | None = None


@dataclass(frozen=True, slots=True)
class TriageVerdict:
    ticket_id: UUID
    priority: str
    queue: str
    labels: tuple[str, ...]
    sla_target_minutes: int
    dedup_fingerprint: str
    detected_components: tuple[str, ...]


def to_triage_input(ticket: SupportTicket | TicketTriageInput) -> TicketTriageInput:
    """Convert a SupportTicket model row or TicketTriageInput into TicketTriageInput."""
    if isinstance(ticket, TicketTriageInput):
        return ticket
    return TicketTriageInput(
        ticket_id=ticket.id,
        organisation_id=ticket.organisation_id,
        category=ticket.category,
        severity=ticket.severity,
        subject=ticket.subject,
        body=ticket.body,
        locale=ticket.locale,
        tenant_slug=ticket.tenant_slug,
        pack_code=ticket.pack_code,
        reply_to_email=ticket.reply_to_email,
        contact_email=ticket.contact_email,
    )


def redact_pii(text: str, tenant_slug: str | None = None) -> str:
    """Mask recognized identifiers; free text is never safe for issue export."""
    if not text:
        return ""
    sanitized = _JWT_OR_BEARER_RE.sub("[REDACTED_TOKEN]", text)
    sanitized = _EMAIL_RE.sub("[REDACTED_EMAIL]", sanitized)
    sanitized = _UUID_RE.sub("[REDACTED_UUID]", sanitized)

    def ipv6(match: re.Match[str]) -> str:
        address = match.group().rstrip(".")
        try:
            IPv6Address(address)
        except ValueError:
            return match.group()
        return "[REDACTED_IP]" + match.group()[len(address) :]

    sanitized = _IPV6_RE.sub(ipv6, sanitized)
    sanitized = _IPV4_RE.sub("[REDACTED_IP]", sanitized)
    sanitized = _PHONE_RE.sub("[REDACTED_PHONE]", sanitized)
    if tenant_slug:
        sanitized = re.sub(re.escape(tenant_slug), "[REDACTED_TENANT]", sanitized, flags=re.I)
    return sanitized


def _normalize_subject_for_dedup(subject: str) -> str:
    """Normalize a ticket subject by stripping PII, UUIDs, IPs, digits, and collapsing spaces."""
    without_pii = _JWT_OR_BEARER_RE.sub(" ", subject)
    without_pii = _EMAIL_RE.sub(" ", without_pii)
    without_pii = _UUID_RE.sub(" ", without_pii)
    without_pii = _IPV4_RE.sub(" ", without_pii)
    cleaned = _DIGITS_AND_PUNCT_RE.sub(" ", without_pii.lower())
    return " ".join(cleaned.split())


def compute_dedup_fingerprint(organisation_id: UUID, category: str, subject: str) -> str:
    """Compute a deterministic SHA-256 deduplication fingerprint scoped to the organisation."""
    normalized = _normalize_subject_for_dedup(subject)
    payload = f"{organisation_id}:{category.strip().lower()}:{normalized}".encode()
    digest = hashlib.sha256(payload).hexdigest()
    return f"sha256:{digest[:24]}"


def _detect_components(combined_text: str) -> tuple[str, ...]:
    detected: list[str] = []
    for component, pattern in _COMPONENT_DETECTORS:
        if pattern.search(combined_text):
            detected.append(component)
    return tuple(detected)


def _resolve_queue(category: str, severity: str, components: tuple[str, ...]) -> str:
    component_set = set(components)
    if "privacy-dpo" in component_set and (category != "security" or severity == "question"):
        return "compliance-dpo"
    if category == "security":
        return "security-incident"
    if category == "login" or component_set & {"keycloak", "webauthn"}:
        return "identity-access"
    if category == "billing" or "billing" in component_set:
        return "billing-ops"
    if (
        category in {"capacity", "domain"}
        or (category == "calls" and severity in {"outage", "blocked"})
        or (
            bool(component_set & {"synapse", "livekit", "matrix"})
            and severity in {"outage", "blocked"}
        )
    ):
        return "infra-sre"
    return "product-engineering"


def _resolve_priority(category: str, severity: str, combined_text: str) -> str:
    base_map = {
        "outage": "P0",
        "blocked": "P1",
        "degraded": "P2",
        "question": "P3",
    }
    priority = base_map.get(severity, "P3")

    if category == "security":
        if severity in {"outage", "blocked"}:
            return "P0"
        if severity == "degraded":
            return "P1"

    if _URGENCY_RE.search(combined_text):
        if priority == "P2":
            priority = "P1"
        elif priority == "P3":
            priority = "P2"

    return priority


def classify_support_ticket(ticket: SupportTicket | TicketTriageInput) -> TriageVerdict:
    """Classify a support ticket into priority, queue, SLA target, components, and dedup hash."""
    item = to_triage_input(ticket)
    category = item.category if item.category in CATEGORIES else "other"
    severity = item.severity if item.severity in SEVERITIES else "question"

    combined_text = f"{item.subject}\n{item.body}"
    components = _detect_components(combined_text)
    queue = _resolve_queue(category, severity, components)
    priority = _resolve_priority(category, severity, combined_text)
    sla_target_minutes = SLA_TARGETS_MINUTES[priority]
    fingerprint = compute_dedup_fingerprint(item.organisation_id, category, item.subject)

    labels: list[str] = [
        f"priority:{priority}",
        f"queue:{queue}",
        f"category:{category}",
        f"severity:{severity}",
    ]
    for component in components:
        labels.append(f"component:{component}")

    return TriageVerdict(
        ticket_id=item.ticket_id,
        priority=priority,
        queue=queue,
        labels=tuple(labels),
        sla_target_minutes=sla_target_minutes,
        dedup_fingerprint=fingerprint,
        detected_components=components,
    )


def build_sanitized_github_issue(
    ticket: SupportTicket | TicketTriageInput, verdict: TriageVerdict
) -> dict[str, Any]:
    """Build a zero-PII engineering issue payload from a triaged ticket."""
    item = to_triage_input(ticket)
    # Recompute the verdict from the ticket: no caller-supplied label, queue or hash is exported.
    verdict = classify_support_ticket(item)
    category = item.category if item.category in CATEGORIES else "other"
    severity = item.severity if item.severity in SEVERITIES else "question"
    fields = {
        "category": category,
        "severity": severity,
        "dedup_fingerprint": verdict.dedup_fingerprint,
        "matched_signals": list(verdict.detected_components),
        "redaction_summary": "Unstructured text and customer identifiers omitted",
        "recommended_queue": verdict.queue,
    }
    return {
        "title": f"Support triage: {category} / {severity}",
        "body": "\n".join(f"- {key}: {value}" for key, value in fields.items()),
        "labels": list(verdict.labels),
        "fingerprint": verdict.dedup_fingerprint,
        "priority": verdict.priority,
        "queue": verdict.queue,
    }
