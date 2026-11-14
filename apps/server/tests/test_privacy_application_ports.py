"""Owning-app export ports retain scope, bounded materialization and native completeness."""

import pytest
from django.db import transaction
from workspace_documents.test_services import native_engine as native_engine
from workspace_safety.test_moderation import world as world

from apps.audit.privacy_events import record_export_event
from apps.docs import privacy_selectors as documents, services
from apps.identity import privacy_selectors as identities
from apps.identity.models import Identity
from apps.workspaces import privacy_selectors as workspaces
from core.db.ids import new_uuid7

pytestmark = pytest.mark.django_db(transaction=True)


def test_identity_projection_port_cannot_cross_scope_and_never_returns_a_model(world):
    org, _, members, _ = world
    identity = Identity.objects.get(user=members[0].user, organisation=org)
    arguments = dict(identifier=identity.id, user_id=str(identity.user_id))
    assert identities.identity_export_permitted(
        **arguments, scope="workspace", organisation_id=org.id
    )
    assert not identities.identity_export_permitted(
        **arguments, scope="workspace", organisation_id=new_uuid7()
    )
    assert not identities.identity_export_permitted(
        identifier=identity.id,
        user_id=str(members[1].user_id),
        scope="account",
        organisation_id=None,
    )
    projected = tuple(
        identities.export_identities(
            scope="account", user_id=str(identity.user_id), organisation_id=None
        )
    )
    assert len(projected) == 1 and type(projected[0]) is dict
    assert projected[0]["id"] == identity.id
    assert (
        identities.current_export_organisation(
            identity_id=str(identity.id), user_id=str(members[1].user_id)
        )
        is None
    )


def test_materialized_bindings_refuse_overflow_instead_of_truncating(world):
    org, workspace, members, _ = world
    user_id = str(members[0].user_id)
    assert len(identities.export_identity_ids(user_id=user_id, max_entries=1)) == 1
    with pytest.raises(identities.PrivacyIdentityRefusalError, match="binding bound"):
        identities.export_identity_ids(user_id=user_id, max_entries=0)
    assert workspaces.export_workspace_ids(organisation_ids=(org.id,), max_entries=1) == (
        workspace.id,
    )
    with pytest.raises(workspaces.PrivacyWorkspaceRefusalError, match="binding bound"):
        workspaces.export_workspace_ids(organisation_ids=(org.id,), max_entries=0)
    assert workspaces.export_workspace_ids(organisation_ids=(new_uuid7(),), max_entries=0) == ()


def test_native_projection_port_keeps_transaction_disclosure_and_journal_checks(
    world, native_engine
):
    org, workspace, _, tokens = world
    created = services.create(
        verified=tokens[0],
        organisation_id=org.id,
        name="Export port",
        parent_id=None,
        template_key=None,
        request_id=str(new_uuid7()),
    )
    arguments = dict(
        scope="workspace", user_id="unused", workspace_ids=(workspace.id,), max_journal_entries=1000
    )
    with transaction.atomic():
        assert tuple(documents.document_export_parts(**arguments, permitted=lambda _: False)) == ()
        parts = tuple(documents.document_export_parts(**arguments, permitted=lambda _: True))
        assert len(parts) == 2 and isinstance(parts[1].value, bytes)
        assert str(parts[0].identifier) == created["id"]
        with pytest.raises(documents.PrivacySourceRefusalError, match="journal incomplete"):
            tuple(
                documents.document_export_parts(
                    **{**arguments, "max_journal_entries": -1}, permitted=lambda _: True
                )
            )


def test_export_audit_port_cannot_write_an_unrelated_action():
    with pytest.raises(ValueError, match="unsupported private export audit action"):
        record_export_event(
            action="invoice.issued",
            identity_id=str(new_uuid7()),
            organisation_id=None,
            export_id=str(new_uuid7()),
            scope="account",
        )
