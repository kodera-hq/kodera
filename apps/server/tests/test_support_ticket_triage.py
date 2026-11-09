"""In-memory unit tests for support@kodera.io ticket triage, deduplication, and zero-PII builder."""

import io
import json
import uuid

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.support.management.commands.triage_support_tickets import run_triage_selftest
from apps.support.models import SupportTicket
from apps.support.triage import (
    TicketTriageInput,
    build_sanitized_github_issue,
    classify_support_ticket,
    compute_dedup_fingerprint,
    redact_pii,
)

ORG_A = uuid.UUID("018f1234-5678-7000-8000-000000000001")
ORG_B = uuid.UUID("018f1234-5678-7000-8000-000000000002")


def _make_input(**overrides: object) -> TicketTriageInput:
    defaults = {
        "ticket_id": uuid.uuid4(),
        "organisation_id": ORG_A,
        "category": "calls",
        "severity": "degraded",
        "subject": "Latence audio sur le pont LiveKit",
        "body": "Les participants constatent des coupures audio sur LiveKit.",
        "locale": "fr",
        "tenant_slug": "lumiere-prod",
        "pack_code": "pack-pro",
        "reply_to_email": "prod@lumiere.fr",
        "contact_email": "dsi@lumiere.fr",
    }
    defaults.update(overrides)
    return TicketTriageInput(**defaults)  # type: ignore[arg-type]


def test_classify_support_ticket_maps_outage_calls_to_p0_infra_sre() -> None:
    ticket = _make_input(
        category="calls",
        severity="outage",
        subject="Panne totale LiveKit et Synapse en salle de montage",
        body="Plus aucun salon vocal ni message Matrix ne passe depuis 10h.",
    )
    verdict = classify_support_ticket(ticket)
    assert verdict.priority == "P0"
    assert verdict.sla_target_minutes == 15
    assert verdict.queue == "infra-sre"
    assert set(verdict.detected_components) == {"matrix", "synapse", "livekit"}
    assert "priority:P0" in verdict.labels
    assert "queue:infra-sre" in verdict.labels
    assert "component:livekit" in verdict.labels


def test_classify_support_ticket_maps_keycloak_webauthn_to_identity_access() -> None:
    ticket = _make_input(
        category="login",
        severity="blocked",
        subject="Impossible d'enregistrer une clé WebAuthn sur Keycloak",
        body="L'authentification multifacteur refuse la clé YubiKey.",
    )
    verdict = classify_support_ticket(ticket)
    assert verdict.priority == "P1"
    assert verdict.sla_target_minutes == 60
    assert verdict.queue == "identity-access"
    assert set(verdict.detected_components) == {"keycloak", "webauthn"}


def test_classify_support_ticket_maps_security_and_urgency_escalation() -> None:
    sec_ticket = _make_input(
        category="security",
        severity="degraded",
        subject="Alerte de session suspecte",
        body="Vérification de journal d'accès demandée.",
    )
    sec_verdict = classify_support_ticket(sec_ticket)
    assert sec_verdict.priority == "P1"
    assert sec_verdict.queue == "security-incident"

    urgent_ticket = _make_input(
        category="documents",
        severity="degraded",
        subject="URGENCE: connecteur Frame.io bloqué avant livraison client",
        body="Les retours Frameio n'arrivent plus dans #post-production.",
    )
    urgent_verdict = classify_support_ticket(urgent_ticket)
    assert urgent_verdict.priority == "P1"
    assert urgent_verdict.queue == "product-engineering"
    assert "frameio" in urgent_verdict.detected_components


def test_classify_support_ticket_maps_billing_and_gdpr_compliance_queues() -> None:
    billing_ticket = _make_input(
        category="billing",
        severity="question",
        subject="Demande de duplicata de facture Stripe",
        body="Merci de nous transmettre la facture du mois dernier.",
    )
    billing_verdict = classify_support_ticket(billing_ticket)
    assert billing_verdict.priority == "P3"
    assert billing_verdict.sla_target_minutes == 1440
    assert billing_verdict.queue == "billing-ops"
    assert "billing" in billing_verdict.detected_components

    dpo_ticket = _make_input(
        category="other",
        severity="question",
        subject="Question RGPD et registre de sous-traitance GDPR",
        body="Pouvez-vous confirmer la durée de rétention des journaux ?",
    )
    dpo_verdict = classify_support_ticket(dpo_ticket)
    assert dpo_verdict.priority == "P3"
    assert dpo_verdict.queue == "compliance-dpo"
    assert "privacy-dpo" in dpo_verdict.detected_components


def test_classify_support_ticket_accepts_django_model_instance_without_db() -> None:
    model_instance = SupportTicket(
        id=uuid.uuid4(),
        organisation_id=ORG_A,
        category="capacity",
        severity="blocked",
        subject="Quota de salons vocaux atteint",
        body="Nous devons ouvrir 4 plateaux supplémentaires dès demain.",
        locale="fr",
        reply_to_email="admin@client.fr",
    )
    verdict = classify_support_ticket(model_instance)
    assert verdict.priority == "P1"
    assert verdict.queue == "infra-sre"


def test_compute_dedup_fingerprint_normalizes_numbers_uuids_and_emails() -> None:
    fp_1 = compute_dedup_fingerprint(
        ORG_A,
        "calls",
        "Incident #1042 sur plateau (user1@studio.fr) - ref 018f1234-5678-7000-8000-000000000099",
    )
    fp_2 = compute_dedup_fingerprint(
        ORG_A,
        "calls",
        "  incident   #9988 sur PLATEAU (user2@studio.fr) - ref 11111111-2222-3333-4444-555555555555 ",
    )
    fp_other_org = compute_dedup_fingerprint(
        ORG_B,
        "calls",
        "Incident #1042 sur plateau",
    )
    assert fp_1.startswith("sha256:")
    assert len(fp_1) == len("sha256:") + 24
    assert fp_1 == fp_2
    assert fp_1 != fp_other_org


def test_redact_pii_strips_emails_uuids_jwts_bearer_tokens_and_ipv4() -> None:
    raw = (
        "Client jean.dupont+test@agence-cinema.fr (IP 185.22.14.9) "
        "org 018f1234-5678-7000-8000-000000000001 "
        "token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sign12345 "
        "and standalone jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJrb2RlcmEifQ.sig98765"
    )
    redacted = redact_pii(raw)
    assert "jean.dupont" not in redacted
    assert "agence-cinema.fr" not in redacted
    assert "185.22.14.9" not in redacted
    assert "018f1234-5678-7000-8000-000000000001" not in redacted
    assert "eyJhbGci" not in redacted
    assert "[REDACTED_EMAIL]" in redacted
    assert "[REDACTED_IP]" in redacted
    assert "[REDACTED_UUID]" in redacted
    assert "[REDACTED_TOKEN]" in redacted


def test_build_sanitized_github_issue_never_leaks_customer_pii_or_org_id() -> None:
    ticket = _make_input(
        subject="Crash Frame.io pour réalisateur@studio.fr sur org 018f1234-5678-7000-8000-000000000001",
        body=(
            "Bonjour, depuis 10.24.0.12 le jeton Bearer secret_token_abc123 "
            "échoue pour dsi@lumiere.fr et prod@lumiere.fr."
        ),
    )
    verdict = classify_support_ticket(ticket)
    issue = build_sanitized_github_issue(ticket, verdict)

    combined = f"{issue['title']}\n{issue['body']}"
    for forbidden in (
        "réalisateur@studio.fr",
        "dsi@lumiere.fr",
        "prod@lumiere.fr",
        str(ORG_A),
        "10.24.0.12",
        "secret_token_abc123",
    ):
        assert forbidden not in combined
    assert issue["priority"] == verdict.priority
    assert issue["queue"] == verdict.queue
    assert issue["fingerprint"] == verdict.dedup_fingerprint
    assert issue["labels"] == list(verdict.labels)


def test_triage_management_command_selftest_and_limit_guard() -> None:
    report = run_triage_selftest()
    assert report["status"] == "ok"
    assert report["redacted_verified"] is True

    stdout = io.StringIO()
    call_command("triage_support_tickets", "--selftest", "--json", stdout=stdout)
    parsed = json.loads(stdout.getvalue())
    assert parsed["status"] == "ok"

    with pytest.raises(CommandError, match="--limit must be 1 to 500"):
        call_command("triage_support_tickets", "--selftest", "--limit=0")


AUDIT_PROBE = "Camille Test, téléphone +33 6 00 00 00 01, poste 2001:db8::72, tenant atelier-test"


def test_audit_probe_never_enters_issue_or_selftest_output():
    ticket = _make_input(subject=AUDIT_PROBE, body=AUDIT_PROBE, tenant_slug="atelier-test")
    exported = json.dumps(
        build_sanitized_github_issue(ticket, classify_support_ticket(ticket)), ensure_ascii=False
    )
    stdout = io.StringIO()
    call_command("triage_support_tickets", "--selftest", "--json", stdout=stdout)
    for forbidden in ("Camille Test", "+33 6 00 00 00 01", "2001:db8::72", "atelier-test"):
        assert forbidden not in exported
        assert forbidden not in stdout.getvalue()
    redacted = redact_pii(AUDIT_PROBE, tenant_slug="atelier-test")
    assert "[REDACTED_PHONE]" in redacted
    assert "[REDACTED_IP]" in redacted
    assert "[REDACTED_TENANT]" in redacted


@pytest.mark.parametrize(
    "phone", ["+33 6 00 00 00 01", "06 00 00 00 01", "+1 (202) 555-0123", "020 7946 0958"]
)
def test_phone_redaction(phone):
    assert phone not in redact_pii(phone)


@pytest.mark.parametrize(
    "ip", ["2001:db8::72", "2001:db8::72.", "::1", "::ffff:192.0.2.1", "fe80::1%eth0"]
)
def test_ipv6_redaction(ip):
    assert ip not in redact_pii(ip)


def test_export_drops_unstructured_metadata_and_unknown_categories():
    ticket = _make_input(
        subject="Private Name",
        body="Private Name",
        locale="Private Name",
        pack_code="Private Name",
        category="Private Name",
        severity="Private Name",
    )
    issue = build_sanitized_github_issue(ticket, classify_support_ticket(ticket))
    assert "Private Name" not in json.dumps(issue)
    assert "category: other" in issue["body"]
