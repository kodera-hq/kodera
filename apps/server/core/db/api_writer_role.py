"""The database grants the API role needs to record the staff intake (docs/specs/ORGANISATION_INTAKE.md §4),
to serve the workspace read and its initialisation (docs/specs/PILOT_WORKSPACE_ONBOARDING.md §9), to
administer the workspace's structure and channel access (docs/specs/ESPACE_STRUCTURE.md §11), to
administer memberships and enqueue their realm access deliveries
(docs/specs/MEMBERSHIP_LIFECYCLE.md §7), to open support tickets (docs/specs/SUPPORT_TICKETS.md), and
to serve the Agent API's member-set command loop (docs/adr/0016-engines-and-permission-intents.md).

The one list ORGANISATION_INTAKE.md §4 (its table and the paragraphs under it) and the tests
tests/test_intake_writer_role.py, tests/test_workspace_writer_role.py,
tests/test_membership_writer_role.py, tests/test_engine_intents_writer_role.py and
tests/test_support_writer_role.py read. Every privilege
is the narrowest the intake and workspace paths need, statement by statement, including the writes its triggers
make with the invoker's rights. Nothing here grants `TRUNCATE`, `REFERENCES`, `TRIGGER`, a
`DELETE` outside the replay store, an empty category and a policy's rules, or an `UPDATE` beyond
the named columns below.

These grants come on top of the customer reads' own (`dev/accept_customer_http.py`
`provision_reader`), and are applied by the operator who provisions the role; no CI job applies
them to a live database.
"""

import re

ROLE = re.compile(r"[a-z_][a-z0-9_]{0,62}\Z")

# Read by the intake path itself, or by an `INSERT ... RETURNING` of a column with a database
# default, or by the deferred constraint triggers of orgs.0002 that run at commit.
SELECT = (
    "billing_billingartifact",
    "billing_viesconsultation",
    # Workspace moderation, reports and bounded invite redemption.
    "workspaces_workspacemoderator",
    "workspaces_workspacememberrestriction",
    "workspaces_workspaceinvitelink",
    "workspaces_workspaceinviteredemption",
    "workspaces_workspaceabusereport",
    # Media attachment metadata, notification inbox and sealed push subscriptions/outbox enqueue.
    "media_attachment",
    "notifications_notification",
    "notifications_pushsubscription",
    "notifications_pushoutbox",
    # Native workspace documents, per-document grants, wikilinks, compacted snapshots and updates.
    "docs_document",
    "docs_documentgrant",
    "docs_documentlink",
    "docs_documentsnapshot",
    "docs_documentupdate",
    "identity_user",
    "identity_identity",
    "identity_staffrole",
    "orgs_organisation",
    "orgs_membership",
    "orgs_slugreservation",
    "orgs_organisationintake",
    "jobs_job",
    "jobs_jobstep",
    "audit_auditevent",
    "idempotency_record",
    # getWorkspace reads the structure and its policies; initialiseWorkspace checks for a
    # workspace and reads back the rows it creates.
    "workspaces_workspace",
    "workspaces_category",
    "workspaces_channel",
    "workspaces_resourcepolicy",
    "workspaces_resourcepolicyrule",
    # The structure administration stores a self-grant's pending notice, unique while pending.
    "workspaces_channelnotice",
    # Both workspace operations ask whether the organisation has a committed order: one not
    # cancelled whose DPA is accepted (apps/billing/selectors.py has_committed_order).
    "billing_order",
    "legal_dpa",
    # ...or whether the CGV and the DPA were accepted with no order, for a tenant of its own
    # (has_accepted_agreements, QUICK_WORKSPACE.md §3): the code of each accepted document, public
    # and append-only. The acceptances it reads are granted by column below, the tenants below.
    "legal_legaldocument",
    # The Agent API loop authenticates a credential, finds the organisation's latest set and the
    # credential's commands, and reads the set a command delivers.
    "engine_intents_credential",
    "engine_intents_head",
    "engine_intents_member_set",
    "engine_intents_command",
    # A membership change records the next member set: it resolves each leaver's subject from
    # what earlier sets recorded (ADR-0016).
    "engine_intents_known_subject",
    # The channel set (ADR-0018): its head, and the set a command delivers.
    "engine_intents_channel_head",
    "engine_intents_channel_set",
    # The invitations (INVITATIONS.md §7): the rows themselves, and the account the realm worker
    # recorded for one, which accepting it compares with the caller's subject.
    "orgs_invitation",
    "outbox_realmaccount",
    # createSupportTicket (SUPPORT_TICKETS.md §§3, 4): the tenant the ticket is about, and the
    # caller's and the organisation's recent tickets, which the creation limits count.
    "tenancy_tenant",
    "support_supportticket",
    # createTenant (QUICK_WORKSPACE.md §4) reads the unbilled pack and its tier: catalogue rows,
    # no personal data.
    "billing_pack",
    "billing_capacitytier",
)
# The rows one intake writes: the organisation, its reservation and intake record, the job, its
# steps and audit rows, and the stored answer.
INSERT = (
    "billing_viesconsultation",
    # Workspace moderation, reports and bounded invite redemption.
    "workspaces_workspacemoderator",
    "workspaces_workspacememberrestriction",
    "workspaces_workspaceinvitelink",
    "workspaces_workspaceinviteredemption",
    "workspaces_workspaceabusereport",
    # Media attachment sessions, notification inbox entries, push subscriptions and wakeup outbox.
    "media_attachment",
    "notifications_notification",
    "notifications_pushsubscription",
    "notifications_pushoutbox",
    # Native workspace documents, wikilinks, snapshots and journal updates (grants stay excluded).
    "docs_document",
    "docs_documentlink",
    "docs_documentsnapshot",
    "docs_documentupdate",
    "orgs_organisation",
    "orgs_slugreservation",
    "orgs_organisationintake",
    "jobs_job",
    "jobs_jobstep",
    "audit_auditevent",
    "idempotency_record",
    # The starter workspace of initialiseWorkspace: the workspace, its default policy, two
    # categories and two channels. Its `workspace.initialised` and `authz.denied` rows are audit
    # rows, and its stored answer a replay row, both already granted above.
    "workspaces_workspace",
    "workspaces_resourcepolicy",
    "workspaces_category",
    "workspaces_channel",
    # The structure administration: a channel's own policy's rules, and a self-grant's notice.
    "workspaces_resourcepolicyrule",
    "workspaces_channelnotice",
    # A command for the latest set when an agent never received it or applied it a day ago, and
    # the next attempt after a retryable failure; and one per agent for each new member set.
    "engine_intents_command",
    # Suspending, removing or reactivating a member records the organisation's next member set:
    # its head row the first time, the set, and the realm subjects it names for the first time.
    "engine_intents_head",
    "engine_intents_member_set",
    "engine_intents_known_subject",
    # A workspace change records the organisation's next channel set (ADR-0018): its head row the
    # first time, and the set.
    "engine_intents_channel_head",
    "engine_intents_channel_set",
    # Suspending, reactivating or removing a member enqueues its realm access delivery: the
    # delivery and its payload, nothing else of the outbox (MEMBERSHIP_LIFECYCLE.md §§6.1, 7).
    "outbox_outboxdelivery",
    "outbox_realmaccess",
    # An invitation, its realm account delivery's payload, and on acceptance the person, their
    # identity and their membership (INVITATIONS.md §7).
    "orgs_invitation",
    "outbox_realmaccount",
    "identity_user",
    "identity_identity",
    "orgs_membership",
    # A support ticket (SUPPORT_TICKETS.md): the row only. Its mail mark is the operator's to set,
    # so no column of it is granted for UPDATE; its audit row and stored answer are granted above.
    "support_supportticket",
    # createTenant (QUICK_WORKSPACE.md §4): the tenant, its DPA and the acceptance of the CGV and
    # the DPA for it. Its `tenant.ordered` and `dpa.accepted` rows are audit rows, granted above.
    "tenancy_tenant",
    "legal_dpa",
    "legal_acceptance",
)
# One column each, and why:
# - identity_staffrole.created_at: `SELECT ... FOR SHARE` of the grant (current_staff_grant) needs
#   UPDATE on one column of the table. `created_at` is one the immutability trigger already
#   refuses to change (staffrole_immutable_grant); `revoked_at` is never granted.
# - orgs_organisation.owner_guard_revision: written by the reservation's insert trigger
#   (customer_touch_owner_guard), which runs with the invoker's rights.
# - jobs_job.lock_requested_at: the enqueue's placement of a job claimable now (JOB_QUEUE.md §5.3).
# - workspaces_workspace.default_policy_id: initialiseWorkspace binds the new workspace's default
#   policy once the policy exists (PILOT_WORKSPACE_ONBOARDING.md §2).
# - orgs_membership.role, .state, .updated_at: changeMembershipRole and removeMembership
#   (MEMBERSHIP_LIFECYCLE.md §7).
# - identity_user.enabled and orgs_organisation.authority_revision: written with the invoker's
#   rights by the membership authority triggers (member-authority-revision.md), which lock the
#   person and rewrite `enabled` to itself. The grant also lets the role disable or re-enable a
#   person; no narrower grant serves those triggers (MEMBERSHIP_LIFECYCLE.md §7 names the follow-up).
# - orgs_organisation's three notice addresses and updated_at: patchNoticeContacts
#   (ORGANISATION_NOTICE_CONTACTS.md §4); the update also covers its `SELECT ... FOR NO KEY UPDATE`.
# - engine_intents_credential.last_seen_at and .last_boot_id: what a request and an ack tell of
#   the agent; `last_seen_at` also covers the pull's `SELECT ... FOR UPDATE` of the credential.
# - engine_intents_command.state, .dispatched_at, .accepted_at, .finished_at, .error_code and
#   .artefacts: dispatch, ack, result, and the supersession of an undelivered older command. A
#   command's set, credential, attempt and issue time are never granted.
# - engine_intents_head.revision: the member set's next revision, under the row lock its
#   `SELECT ... FOR UPDATE` takes, which the same grant covers; .refused_at and .refused_problem:
#   a refused emission, recorded after its rollback and cleared by the next set.
# - the structure administration (ESPACE_STRUCTURE.md §11): the workspace's structure_revision,
#   which every structural write takes first; a category's name, template key, position, version
#   and updated_at; a channel's category, name, template key, topic, position, version, access
#   binding, lifecycle and updated_at; a policy's visibility, and its revision, which the rule
#   trigger rewrites with the invoker's rights. Never a channel's kind or room state, which only
#   an agent's acknowledgement will write, and never a binding the immutability triggers guard.
# - engine_intents_channel_head.revision: the channel set's next revision, under its row lock.
# - engine_intents_known_subject.erased_at: an explicit erasure's mark (`mark_erased`, ADR-0011),
#   in the erasure's own transaction; once set, the mark is final (migration 0009). Never a
#   subject, its person or its organisation.
# - the channel set's result (ESPACE_STRUCTURE.md §13.3), which the Agent API's result path applies:
#   a channel's room_state, applied_access_etag and room_state_revision, and a notice's
#   acknowledged_at. Never anything else of a channel or a notice. The membership hooks lock the
#   workspace row with `SELECT ... FOR UPDATE`, which the structure_revision grant covers.
# - orgs_invitation's state, expiry, send and acceptance columns (INVITATIONS.md §7): expiring,
#   resending, revoking and accepting; never its address, role, token or inviter.
# - orgs_membership.accepted_at: accepting revives a removed membership of the same person.
UPDATE_COLUMNS = (
    ("billing_billingprofile", "vat_number_validated_at"),
    ("billing_billingprofile", "updated_at"),
    # Moderation changes only mutable facts; invite codes and report evidence stay immutable.
    ("workspaces_workspacememberrestriction", "banned"),
    ("workspaces_workspacememberrestriction", "kicked"),
    ("workspaces_workspacememberrestriction", "muted_until"),
    ("workspaces_workspacememberrestriction", "updated_at"),
    ("workspaces_workspaceinvitelink", "uses_count"),
    ("workspaces_workspaceinvitelink", "revoked_at"),
    ("workspaces_workspaceinvitelink", "updated_at"),
    ("workspaces_workspaceabusereport", "status"),
    ("workspaces_workspaceabusereport", "resolution"),
    ("workspaces_workspaceabusereport", "resolved_by_id"),
    ("workspaces_workspaceabusereport", "updated_at"),
    # Attachment completion, inbox read marks, and device subscription rotation/revocation;
    # checksums, sizes, MIME types, recipients, resource_ids and push outbox leases stay immutable.
    ("media_attachment", "completed_at"),
    ("media_attachment", "updated_at"),
    ("notifications_notification", "read_at"),
    ("notifications_notification", "updated_at"),
    ("notifications_pushsubscription", "version"),
    ("notifications_pushsubscription", "endpoint_digest"),
    ("notifications_pushsubscription", "sealed_subscription"),
    ("notifications_pushsubscription", "revoked_at"),
    ("notifications_pushsubscription", "updated_at"),
    # Native workspace document tree/content mutations, soft-delete, snapshot compaction and links;
    # ownership, visibility, creator, channel binding and journal rows stay immutable.
    ("docs_document", "parent_id"),
    ("docs_document", "title"),
    ("docs_document", "markdown"),
    ("docs_document", "revision"),
    ("docs_document", "deleted_at"),
    ("docs_document", "purge_after"),
    ("docs_document", "updated_at"),
    ("docs_documentsnapshot", "sequence"),
    ("docs_documentsnapshot", "head_sequence"),
    ("docs_documentsnapshot", "state"),
    ("docs_documentsnapshot", "updated_at"),
    ("docs_documentlink", "target_id"),
    ("docs_documentlink", "updated_at"),
    ("identity_staffrole", "created_at"),
    ("orgs_organisation", "owner_guard_revision"),
    ("jobs_job", "lock_requested_at"),
    ("workspaces_workspace", "default_policy_id"),
    ("orgs_membership", "role"),
    ("orgs_membership", "state"),
    ("orgs_membership", "updated_at"),
    ("identity_user", "enabled"),
    ("orgs_organisation", "authority_revision"),
    ("orgs_organisation", "security_contact_email"),
    ("orgs_organisation", "privacy_contact_email"),
    ("orgs_organisation", "subprocessor_notice_email"),
    ("orgs_organisation", "updated_at"),
    ("engine_intents_credential", "last_seen_at"),
    ("engine_intents_credential", "last_boot_id"),
    ("engine_intents_command", "state"),
    ("engine_intents_command", "dispatched_at"),
    ("engine_intents_command", "accepted_at"),
    ("engine_intents_command", "finished_at"),
    ("engine_intents_command", "error_code"),
    ("engine_intents_command", "artefacts"),
    ("engine_intents_head", "revision"),
    ("engine_intents_channel_head", "revision"),
    ("engine_intents_known_subject", "erased_at"),
    ("engine_intents_head", "refused_at"),
    ("engine_intents_head", "refused_problem"),
    ("workspaces_workspace", "structure_revision"),
    ("workspaces_category", "name"),
    ("workspaces_category", "template_key"),
    ("workspaces_category", "position"),
    ("workspaces_category", "version"),
    ("workspaces_category", "updated_at"),
    ("workspaces_channel", "category_id"),
    ("workspaces_channel", "name"),
    ("workspaces_channel", "template_key"),
    ("workspaces_channel", "topic"),
    ("workspaces_channel", "position"),
    ("workspaces_channel", "version"),
    ("workspaces_channel", "policy_mode"),
    ("workspaces_channel", "explicit_policy_id"),
    ("workspaces_channel", "lifecycle"),
    ("workspaces_channel", "updated_at"),
    ("workspaces_channel", "room_state"),
    ("workspaces_channel", "applied_access_etag"),
    ("workspaces_channel", "room_state_revision"),
    ("workspaces_channelnotice", "acknowledged_at"),
    ("workspaces_resourcepolicy", "visibility"),
    ("workspaces_resourcepolicy", "revision"),
    ("orgs_invitation", "state"),
    ("orgs_invitation", "sent_count"),
    ("orgs_invitation", "last_sent_at"),
    ("orgs_invitation", "accepted_at"),
    ("orgs_invitation", "membership_id"),
    ("orgs_invitation", "revoked_at"),
    ("orgs_invitation", "updated_at"),
    ("orgs_membership", "accepted_at"),
    # createTenant supersedes an older unaccepted DPA, and accepts the one it records (legal
    # services prepare_dpa and record_agreements); the update also covers their
    # `SELECT ... FOR UPDATE` of the DPA rows.
    ("legal_dpa", "state"),
    ("legal_dpa", "superseded_by_id"),
    ("legal_dpa", "tenant_id"),
    ("legal_dpa", "accepted_at"),
    ("legal_dpa", "accepted_by_identity_id"),
    ("legal_dpa", "accepted_by_person_id"),
    ("legal_dpa", "accepted_by_name"),
    ("legal_dpa", "accepted_by_email"),
    ("legal_dpa", "accepted_by_role"),
    ("legal_dpa", "updated_at"),
)
# An expired replay entry is replaced when its key returns (IDEMPOTENCY_REPLAY.md §2.2), for the
# intake and initialiseWorkspace alike. deleteCategory deletes an empty category, and a channel's
# access change deletes the rules it drops; a policy itself is never deleted. Native document
# Markdown replacement refreshes outgoing wikilinks and prunes snapshot-covered journal updates
# (trigger `docs_journal_guard` refuses deleting any uncovered update).
DELETE = (
    "idempotency_record",
    "workspaces_category",
    "workspaces_resourcepolicyrule",
    "docs_documentlink",
    "docs_documentupdate",
)
EXECUTE_FUNCTIONS = (
    "audit_workspace_resource_event(uuid, text, uuid, uuid, uuid, text)",
    "docs_document_role(uuid, uuid, uuid, uuid, text, text)",
)


# Read by column only: the guard reads which documents were accepted, for which tenant and DPA,
# never who accepted them or from where (identity, name, role, IP, user agent).
SELECT_COLUMNS = tuple(
    ("legal_acceptance", column)
    for column in ("id", "organisation_id", "order_id", "tenant_id", "document_id", "dpa_id")
)


def grant_statements(role: str) -> list[str]:
    """The GRANT statements for `role`, a lower-case PostgreSQL identifier."""
    if ROLE.fullmatch(role) is None:
        raise ValueError("a role name is a lower-case identifier")
    statements = [f'GRANT USAGE ON SCHEMA public TO "{role}"']
    statements += [f'GRANT SELECT ON TABLE "{table}" TO "{role}"' for table in SELECT]
    statements += [
        f'GRANT SELECT ("{column}") ON TABLE "{table}" TO "{role}"'
        for table, column in SELECT_COLUMNS
    ]
    statements += [f'GRANT INSERT ON TABLE "{table}" TO "{role}"' for table in INSERT]
    statements += [
        f'GRANT UPDATE ("{column}") ON TABLE "{table}" TO "{role}"'
        for table, column in UPDATE_COLUMNS
    ]
    statements += [f'GRANT DELETE ON TABLE "{table}" TO "{role}"' for table in DELETE]
    statements += [
        f'GRANT EXECUTE ON FUNCTION {signature} TO "{role}"' for signature in EXECUTE_FUNCTIONS
    ]
    return statements
