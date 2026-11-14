"""Scoped document trees, explicit grants and a compactable binary Yjs journal."""

from django.db import models

from core.db.models import RetainedModel, StoredModel


class Document(RetainedModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    parent = models.ForeignKey("self", on_delete=models.RESTRICT, null=True, blank=True)
    creator = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    channel = models.ForeignKey(
        "workspaces.Channel", on_delete=models.RESTRICT, null=True, blank=True
    )
    visibility = models.TextField(default="workspace")
    title = models.TextField()
    markdown = models.TextField(default="")
    revision = models.BigIntegerField(default=1)

    class Meta(RetainedModel.Meta):
        abstract = False
        constraints = [
            *RetainedModel.Meta.constraints,
            models.CheckConstraint(
                condition=models.Q(visibility__in=["workspace", "restricted"]),
                name="docs_visibility_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(title__length__range=(1, 255), title__regex=r"\S"),
                name="docs_title_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(markdown__length__lte=262144), name="docs_markdown_bound"
            ),
            models.CheckConstraint(condition=models.Q(revision__gte=1), name="docs_revision_valid"),
            models.CheckConstraint(
                condition=~models.Q(parent_id=models.F("id")), name="docs_parent_not_self"
            ),
            models.UniqueConstraint(
                models.Func("title", function="lower"),
                "workspace",
                condition=models.Q(deleted_at__isnull=True),
                name="docs_active_title_unique",
            ),
            models.UniqueConstraint(fields=["id", "workspace"], name="docs_workspace_binding"),
        ]
        indexes = [
            models.Index(fields=["workspace", "parent", "-id"], name="docs_tree_page"),
        ]


class DocumentGrant(StoredModel):
    document = models.ForeignKey(Document, on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    role = models.TextField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["document", "membership"], name="docs_grant_unique"),
            models.CheckConstraint(
                condition=models.Q(role__in=["editor", "viewer"]), name="docs_grant_role_valid"
            ),
        ]


class DocumentLink(StoredModel):
    source = models.ForeignKey(Document, on_delete=models.RESTRICT, related_name="outgoing_links")
    target = models.ForeignKey(
        Document, on_delete=models.RESTRICT, null=True, blank=True, related_name="incoming_links"
    )
    target_title = models.TextField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["source", "target_title"], name="docs_link_unique"),
            models.CheckConstraint(
                condition=models.Q(target_title__length__range=(1, 255)),
                name="docs_link_title_bound",
            ),
        ]
        indexes = [models.Index(fields=["target", "-id"], name="docs_backlinks")]


class DocumentSnapshot(StoredModel):
    document = models.OneToOneField(Document, on_delete=models.RESTRICT)
    sequence = models.BigIntegerField(default=0)
    head_sequence = models.BigIntegerField(default=0)
    state = models.BinaryField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(sequence__gte=0, head_sequence__gte=models.F("sequence")),
                name="docs_snapshot_sequence_valid",
            ),
        ]


class DocumentUpdate(StoredModel):
    document = models.ForeignKey(Document, on_delete=models.RESTRICT)
    sequence = models.BigIntegerField()
    actor = models.ForeignKey("identity.Identity", on_delete=models.RESTRICT)
    state = models.BinaryField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["document", "sequence"], name="docs_update_sequence_unique"
            ),
            models.CheckConstraint(
                condition=models.Q(sequence__gte=1), name="docs_update_sequence_valid"
            ),
        ]


class CollaborationTicket(models.Model):
    """Only redeemed nonces are retained, until their signed expiry."""

    nonce = models.UUIDField(primary_key=True)
    expires = models.BigIntegerField(db_index=True)

    def __str__(self) -> str:
        return "Redeemed collaboration ticket"


class Collection(RetainedModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    creator = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    title = models.TextField()
    properties = models.JSONField(default=list)
    views = models.JSONField(default=list)
    revision = models.BigIntegerField(default=1)

    class Meta(RetainedModel.Meta):
        abstract = False
        constraints = [
            *RetainedModel.Meta.constraints,
            models.CheckConstraint(
                condition=models.Q(revision__gte=1), name="docs_collection_revision"
            ),
            models.CheckConstraint(
                condition=models.Q(title__length__range=(1, 255)), name="docs_collection_title"
            ),
        ]
        indexes = [models.Index(fields=["workspace", "-id"], name="docs_collection_workspace")]


class CollectionRow(StoredModel):
    collection = models.ForeignKey(Collection, on_delete=models.RESTRICT)
    document = models.ForeignKey(Document, on_delete=models.RESTRICT)
    values = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["collection", "document"], name="docs_collection_document_unique"
            )
        ]
