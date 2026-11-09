"""Published contractual documents and their acceptance: contract `LegalDocument` and `Dpa`.

A document is published once per `(code, version, locale, pack)` and never edited: a change is a
new version. An acceptance records who accepted which version, when, for which organisation, and
from where (a truncated address, the user agent), and is never changed or deleted. A DPA is the
data processing agreement generated for one organisation and pack from the DPA template in force;
it is accepted inside the order that relies on it, and superseded when the template changes.
"""

from django.db import models
from django.db.models import Q

from core.db.models import StoredModel

CODES = ("cgv", "dpa", "sla", "aup")
LOCALES = ("fr", "en")
DPA_STATES = ("generated", "accepted", "superseded")
SHA256 = r"^[0-9a-f]{64}$"


class LegalDocument(StoredModel):
    code = models.TextField()
    version = models.TextField()
    locale = models.TextField()
    title = models.TextField()
    pack_code = models.TextField(null=True, blank=True)  # noqa: DJ001 - null for every pack
    html_url = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    # Every document carries the digest of its text: an acceptance names exactly what was read.
    sha256 = models.TextField()
    # The text itself, the UTF-8 bytes `sha256` covers (the database checks it), served at its
    # permanent URL. Null only on a row published before Core kept the texts.
    text = models.TextField(null=True, blank=True)  # noqa: DJ001 - null before Core kept texts
    # Annex C of a DPA template, as data: [{name, role, location, country}].
    sub_processors = models.JSONField(default=list, blank=True)
    published_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.CheckConstraint(name="legal_document_code_valid", condition=Q(code__in=CODES)),
            models.CheckConstraint(
                name="legal_document_locale_valid", condition=Q(locale__in=LOCALES)
            ),
            models.CheckConstraint(
                name="legal_document_version_valid",
                condition=Q(version__regex=r"^[0-9A-Za-z.-]{1,20}$"),
            ),
            models.CheckConstraint(
                name="legal_document_sha256_valid", condition=Q(sha256__regex=SHA256)
            ),
            # A version names one text per code and locale, whichever pack it serves: an acceptance
            # of `{code, version, locale}` names exactly the document the customer read.
            models.UniqueConstraint(
                fields=["code", "version", "locale"], name="legal_document_version_unique"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} {self.version} {self.locale}"


class Dpa(StoredModel):
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    template = models.ForeignKey(LegalDocument, on_delete=models.RESTRICT, related_name="+")
    tenant_id = models.UUIDField(null=True, blank=True)
    pack_code = models.TextField()
    locale = models.TextField()
    version = models.TextField()
    sha256 = models.TextField()
    sub_processors = models.JSONField(default=list, blank=True)
    state = models.TextField(default="generated")
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_by_identity_id = models.UUIDField(null=True, blank=True)
    accepted_by_person_id = models.UUIDField(null=True, blank=True)
    accepted_by_name = models.TextField(null=True, blank=True)  # noqa: DJ001 - set on acceptance
    accepted_by_email = models.TextField(null=True, blank=True)  # noqa: DJ001 - set on acceptance
    accepted_by_role = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional title
    superseded_by = models.ForeignKey(
        "self", on_delete=models.RESTRICT, null=True, blank=True, related_name="+"
    )

    class Meta:
        constraints = [
            models.CheckConstraint(name="legal_dpa_state_valid", condition=Q(state__in=DPA_STATES)),
            models.CheckConstraint(name="legal_dpa_locale_valid", condition=Q(locale__in=LOCALES)),
            models.CheckConstraint(
                name="legal_dpa_sha256_valid", condition=Q(sha256__regex=SHA256)
            ),
            models.CheckConstraint(
                name="legal_dpa_accepted_valid",
                # Generated: never accepted. Accepted: who and when. Superseded: either, as it was.
                condition=Q(state="generated", accepted_at__isnull=True)
                | (
                    Q(state__in=("accepted", "superseded"))
                    & Q(accepted_at__isnull=False, accepted_by_identity_id__isnull=False)
                    & Q(accepted_by_person_id__isnull=False)
                    & Q(accepted_by_name__isnull=False, accepted_by_email__isnull=False)
                )
                | Q(state="superseded", accepted_at__isnull=True),
            ),
        ]
        indexes = [models.Index(fields=["organisation", "-created_at"], name="legal_dpa_org_idx")]
        constraints = [
            *constraints,
            # One unaccepted DPA per organisation, pack and locale: two generates do not race.
            models.UniqueConstraint(
                fields=["organisation", "pack_code", "locale"],
                condition=Q(state="generated"),
                name="legal_dpa_one_generated",
            ),
        ]

    def __str__(self) -> str:
        return f"dpa {self.version} of {self.organisation_id} {self.state}"


class Acceptance(StoredModel):
    """One person's acceptance of one document version for one organisation, either in one order
    (`order_id`) or, on a deployment that does not bill, for the one tenant it was created with
    (`tenant_id`, docs/specs/QUICK_WORKSPACE.md §3): exactly one of the two, never both, and a
    document version once per tenant."""

    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    document = models.ForeignKey(LegalDocument, on_delete=models.RESTRICT, related_name="+")
    dpa = models.ForeignKey(Dpa, on_delete=models.RESTRICT, null=True, blank=True, related_name="+")
    identity_id = models.UUIDField()
    order_id = models.UUIDField(null=True, blank=True)
    tenant_id = models.UUIDField(null=True, blank=True)
    accepted_at = models.DateTimeField()
    accepted_by_name = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional
    accepted_by_role = models.TextField(null=True, blank=True)  # noqa: DJ001 - optional
    source_ip_trunc = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(null=True, blank=True)  # noqa: DJ001 - not every client sends one

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["order_id", "document"], name="legal_acceptance_once_per_order"
            ),
            models.UniqueConstraint(
                fields=["tenant_id", "document"], name="legal_acceptance_once_per_tenant"
            ),
            models.CheckConstraint(
                name="legal_acceptance_order_or_tenant",
                condition=Q(order_id__isnull=False, tenant_id__isnull=True)
                | Q(order_id__isnull=True, tenant_id__isnull=False),
            ),
            models.CheckConstraint(
                name="legal_acceptance_user_agent_valid",
                condition=Q(user_agent__isnull=True) | Q(user_agent__length__lte=500),
            ),
        ]

    def __str__(self) -> str:
        return f"acceptance of {self.document_id} for {self.organisation_id}"
