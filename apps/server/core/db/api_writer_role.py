"""The database grants the API role needs to record the staff intake (docs/specs/ORGANISATION_INTAKE.md §4),
to serve the workspace read and its initialisation (docs/specs/PILOT_WORKSPACE_ONBOARDING.md §9), to
administer the workspace's structure and channel access (docs/specs/ESPACE_STRUCTURE.md §11), to
administer memberships and enqueue their realm access deliveries
(docs/specs/MEMBERSHIP_LIFECYCLE.md §7), to open support tickets (docs/specs/SUPPORT_TICKETS.md),
to serve anonymous realm discovery and rolling quota admission (docs/specs/REALM_DISCOVERY.md), and
to serve the Agent API's member-set command loop (docs/adr/0016-engines-and-permission-intents.md).

The one list ORGANISATION_INTAKE.md §4 (its table and the paragraphs under it) and the tests
tests/test_intake_writer_role.py, tests/test_workspace_writer_role.py,
tests/test_membership_writer_role.py, tests/test_engine_intents_writer_role.py,
tests/test_support_writer_role.py and tests/test_discovery_writer_role.py read. Every privilege
is the narrowest the intake and workspace paths need, statement by statement, including the writes its triggers
make with the invoker's rights. Nothing here grants `TRUNCATE`, `REFERENCES`, `TRIGGER`, a
`DELETE` outside the replay store, rolling rate-limit horizons, an empty category and a policy's rules, or an `UPDATE` beyond
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
    "workspaces_workspacerole",
    "workspaces_workspacememberrole",
    "workspaces_workspacechannelroleoverride",
    "workspaces_workspacetemplateapplication",
    "workspaces_workspaceaipolicy",
    "workspaces_memberaiconsent",
    # Confidential transport stores public device keys and opaque ciphertext only.
    "e2ee_device",
    "e2ee_room",
    "e2ee_participant",
    "e2ee_keypackage",
    "e2ee_envelope",
    "workspaces_workspacequota",
    "docs_collection",
    "docs_collectionrow",
    "billing_billingartifact",
    "billing_viesconsultation",
    # Passport cross-workspace magic-link sign-in, anonymous realm discovery quotas, Stripe
    # webhook reconciliation, and EE billing.
    "identity_discoveryquotagate",
    "identity_discoveryquotaevent",
    "identity_passportmagiclinktoken",
    "identity_passportoutboxbinding",
    "identity_passportratelimitevent",
    "identity_passportworkspacecontext",
    "billing_stripewebhookdelivery",
    "billing_providerevent",
    "billing_invoice",
    "billing_payment",
    "billing_paymentlink",
    "billing_subscription",
    "billing_dunningcase",
    "ee_billing_sequences",
    "ee_billing_warm_pool_slots",
    "ee_billing_purchase_orders",
    # Workspace moderation, reports and bounded invite redemption.
    "workspaces_workspacemoderator",
    "workspaces_workspacememberrestriction",
    "workspaces_workspaceinvitelink",
    "workspaces_workspaceinviteredemption",
    "workspaces_workspaceabusereport",
    # Media attachment metadata, notification inbox and sealed push subscriptions/outbox enqueue.
    "media_attachment",
    "media_previewadmission",
    "notifications_notification",
    "notifications_pushsubscription",
    "notifications_pushoutbox",
    "notifications_presencelease",
    # Native workspace documents, per-document grants, wikilinks, compacted snapshots and updates.
    "docs_document",
    "docs_documentgrant",
    "docs_documentlink",
    "docs_documentsnapshot",
    "docs_documentupdate",
    # Workspace import dry-run/replay batches and bounded coexistence bridges.
    "extensions_workspacecutoff",
    "extensions_importbatch",
    "extensions_importedobject",
    "extensions_coexistencebridge",
    "extensions_coexistencereplayguard",
    "identity_user",
    "identity_identity",
    "identity_staffrole",
    "orgs_organisation",
    "orgs_membership",
    "orgs_slugreservation",
    "orgs_organisationintake",
    # Customer privacy lifecycle reads only; HTTP admission and delivery remain held.
    "orgs_privacyexport",
    "orgs_privacyerasure",
    "orgs_accounterasure",
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
    "support_bugreport",
    "support_bugreportrateevent",
    # Public billing catalogue reads (/api/v1/catalog/*) and createTenant (QUICK_WORKSPACE.md §4)
    # read published plans, packs, capacity tiers and offered prices: catalogue rows, no personal data.
    "billing_plan",
    "billing_pack",
    "billing_capacitytier",
    "billing_price",
    # C1 zero-trust /staff/v1/* records and append-only SHA-256 hash-chained staff audit entries.
    "staff_api_role_grant",
    "staff_api_deal_card",
    "staff_api_waitlist_cohort",
    "staff_api_feedback_item",
    "staff_api_sar_record",
    "staff_api_finops_snapshot",
    "staff_api_issuer_snapshot",
    "staff_api_audit_entry",
    # Enterprise Edition (`ee/`, KODERA_EDITION=enterprise): SAML 2.0 federation, SCIM 2.0
    # directory provisioning, append-only compliance audit ledger and verification public keys.
    "ee_saml_idp",
    "ee_saml_pending_request",
    "ee_saml_replay_assertion",
    "ee_saml_principal",
    "ee_scim_token",
    "ee_scim_user",
    "ee_scim_group",
    "ee_scim_group_member",
    "ee_scim_session",
    "ee_scim_deprovision",
    "ee_audit_ledger",
    "ee_audit_signing_key",
)
# The rows one intake writes: the organisation, its reservation and intake record, the job, its
# steps and audit rows, and the stored answer.
INSERT = (
    "workspaces_workspacerole",
    "workspaces_workspacememberrole",
    "workspaces_workspacechannelroleoverride",
    "workspaces_workspacetemplateapplication",
    "workspaces_workspaceaipolicy",
    "workspaces_memberaiconsent",
    "e2ee_device",
    "e2ee_room",
    "e2ee_participant",
    "e2ee_keypackage",
    "e2ee_envelope",
    "docs_collection",
    "docs_collectionrow",
    "billing_viesconsultation",
    "identity_discoveryquotaevent",
    "identity_passportmagiclinktoken",
    "identity_passportoutboxbinding",
    "identity_passportratelimitevent",
    "identity_passportworkspacecontext",
    "billing_stripewebhookdelivery",
    "billing_providerevent",
    "billing_payment",
    "ee_billing_sequences",
    "ee_billing_warm_pool_slots",
    "ee_billing_purchase_orders",
    "workspaces_workspacequota",
    # Workspace moderation, reports and bounded invite redemption.
    "workspaces_workspacemoderator",
    "workspaces_workspacememberrestriction",
    "workspaces_workspaceinvitelink",
    "workspaces_workspaceinviteredemption",
    "workspaces_workspaceabusereport",
    # Media attachment sessions, notification inbox entries, push subscriptions and wakeup outbox.
    "media_attachment",
    "media_previewadmission",
    "notifications_notification",
    "notifications_pushsubscription",
    "notifications_pushoutbox",
    "notifications_presencelease",
    # Native workspace documents, wikilinks, snapshots and journal updates (grants stay excluded).
    "docs_document",
    "docs_documentlink",
    "docs_documentsnapshot",
    "docs_documentupdate",
    # Workspace import batches/objects and bounded coexistence bridges/replay guards.
    "extensions_importbatch",
    "extensions_importedobject",
    "extensions_coexistencebridge",
    "extensions_coexistencereplayguard",
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
    "outbox_message",
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
    # `support_bugreport` is omitted from table-wide INSERT and governed strictly by INSERT_COLUMNS.
    "support_supportticket",
    "support_bugreportrateevent",
    # createTenant (QUICK_WORKSPACE.md §4): the tenant, its DPA and the acceptance of the CGV and
    # the DPA for it. Its `tenant.ordered` and `dpa.accepted` rows are audit rows, granted above.
    "tenancy_tenant",
    "legal_dpa",
    "legal_acceptance",
    # C1 zero-trust /staff/v1/* records and append-only SHA-256 hash-chained staff audit entries
    # (`staff_api_feedback_item` is triaged via UPDATE only, never inserted by `/staff/v1/*`).
    "staff_api_role_grant",
    "staff_api_deal_card",
    "staff_api_waitlist_cohort",
    "staff_api_sar_record",
    "staff_api_finops_snapshot",
    "staff_api_issuer_snapshot",
    "staff_api_audit_entry",
    # Enterprise Edition (`ee/`): SAML IdP config/requests/replays/principals, SCIM tokens/users/
    # groups/memberships/sessions/deprovision records, and append-only audit ledger + signing keys.
    "ee_saml_idp",
    "ee_saml_pending_request",
    "ee_saml_replay_assertion",
    "ee_saml_principal",
    "ee_scim_token",
    "ee_scim_user",
    "ee_scim_group",
    "ee_scim_group_member",
    "ee_scim_session",
    "ee_scim_deprovision",
    "ee_audit_ledger",
    "ee_audit_signing_key",
)
# One column each, and why:
# - identity_discoveryquotagate.singleton: `SELECT ... FOR UPDATE` on the single discovery quota
#   gate row needs UPDATE on one column; `singleton` is held to `true` by `NOT NULL` and
#   `discovery_gate_singleton` (`CHECK (singleton = true)`), while `id` is never granted.
# - identity_staffrole.created_at: `SELECT ... FOR SHARE` of the grant (current_staff_grant) needs
#   UPDATE on one column of the table. `created_at` is one the immutability trigger already
#   refuses to change (staffrole_immutable_grant); `revoked_at` is never granted.
# - identity_identity.id: `SELECT ... FOR SHARE` of customer and staff identities under Passport
#   and EE billing authority fences needs UPDATE on one column of `identity_identity`. `id` is
#   frozen by `customer_immutable('identity')`; `enabled` and `deleted_at` are never granted.
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
    ("workspaces_workspacerole", "name"),
    ("workspaces_workspacerole", "slug"),
    ("workspaces_workspacerole", "kind"),
    ("workspaces_workspacerole", "color"),
    ("workspaces_workspacerole", "icon"),
    ("workspaces_workspacerole", "position"),
    ("workspaces_workspacerole", "is_hoisted"),
    ("workspaces_workspacerole", "is_mentionable"),
    ("workspaces_workspacerole", "permissions"),
    ("workspaces_workspacerole", "updated_at"),
    ("workspaces_workspacememberrole", "updated_at"),
    ("workspaces_workspacechannelroleoverride", "allow"),
    ("workspaces_workspacechannelroleoverride", "deny"),
    ("workspaces_workspacechannelroleoverride", "updated_at"),
    ("workspaces_workspacetemplateapplication", "state"),
    ("workspaces_workspacetemplateapplication", "completed_steps"),
    ("workspaces_workspacetemplateapplication", "artefacts"),
    ("workspaces_workspacetemplateapplication", "last_error"),
    ("workspaces_workspacetemplateapplication", "completed_at"),
    ("workspaces_workspacetemplateapplication", "updated_at"),
    ("workspaces_workspaceaipolicy", "enabled"),
    ("workspaces_workspaceaipolicy", "provider"),
    ("workspaces_workspaceaipolicy", "provider_region"),
    ("workspaces_workspaceaipolicy", "eu_sovereign_only"),
    ("workspaces_workspaceaipolicy", "self_hosted_endpoint"),
    ("workspaces_workspaceaipolicy", "model"),
    ("workspaces_workspaceaipolicy", "sealed_byom_config"),
    ("workspaces_workspaceaipolicy", "monthly_budget_micros"),
    ("workspaces_workspaceaipolicy", "monthly_spent_micros"),
    ("workspaces_workspaceaipolicy", "budget_period"),
    ("workspaces_workspaceaipolicy", "updated_at"),
    ("workspaces_memberaiconsent", "enabled"),
    ("workspaces_memberaiconsent", "consented_at"),
    ("workspaces_memberaiconsent", "revoked_at"),
    ("workspaces_memberaiconsent", "updated_at"),
    ("workspaces_channel", "ai_enabled"),
    ("workspaces_workspace", "description"),
    ("workspaces_workspace", "banner_preset"),
    ("workspaces_workspace", "icon_mxc"),
    ("workspaces_workspace", "traits"),
    ("workspaces_workspace", "arrivals_channel_id"),
    ("workspaces_workspace", "rules_channel_id"),
    ("workspaces_workspace", "moderator_updates_channel_id"),
    ("workspaces_workspace", "security_alerts_channel_id"),
    ("workspaces_workspace", "invites_paused"),
    ("workspaces_workspace", "updated_at"),
    ("workspaces_workspaceinvitelink", "auto_role_ids"),
    # Revocation and single-use payload discard; public key bindings never change.
    ("e2ee_device", "revoked_at"),
    ("e2ee_device", "updated_at"),
    ("e2ee_room", "epoch"),
    ("e2ee_room", "head_sequence"),
    ("e2ee_room", "rekey_required"),
    ("e2ee_room", "updated_at"),
    ("e2ee_participant", "joined_epoch"),
    ("e2ee_participant", "left_epoch"),
    ("e2ee_participant", "updated_at"),
    ("e2ee_keypackage", "package"),
    ("e2ee_keypackage", "discarded_at"),
    ("e2ee_keypackage", "claimed_at"),
    ("e2ee_keypackage", "claimed_for_id"),
    ("e2ee_keypackage", "claimed_by_id"),
    ("e2ee_keypackage", "claimed_epoch"),
    ("e2ee_keypackage", "updated_at"),
    *(
        ("docs_collection", c)
        for c in (
            "title",
            "properties",
            "views",
            "revision",
            "deleted_at",
            "purge_after",
            "updated_at",
        )
    ),
    ("docs_collectionrow", "values"),
    ("docs_collectionrow", "updated_at"),
    ("billing_billingprofile", "vat_number_validated_at"),
    ("billing_billingprofile", "updated_at"),
    ("identity_passportmagiclinktoken", "consumed_at"),
    ("identity_passportmagiclinktoken", "updated_at"),
    ("identity_passportworkspacecontext", "active_organisation_id"),
    ("identity_passportworkspacecontext", "active_workspace_id"),
    ("identity_passportworkspacecontext", "updated_at"),
    ("billing_stripewebhookdelivery", "outcome"),
    ("billing_stripewebhookdelivery", "organisation_id"),
    ("billing_providerevent", "outcome"),
    ("billing_invoice", "amount_paid_minor"),
    ("billing_invoice", "state"),
    ("billing_invoice", "paid_at"),
    ("billing_invoice", "updated_at"),
    ("billing_order", "state"),
    ("billing_order", "updated_at"),
    ("billing_payment", "state"),
    ("billing_payment", "allocated"),
    ("billing_payment", "provider_customer_ref"),
    ("billing_payment", "last_event_at"),
    ("billing_payment", "updated_at"),
    ("billing_paymentlink", "state"),
    ("billing_paymentlink", "used_at"),
    ("billing_paymentlink", "updated_at"),
    ("ee_billing_sequences", "last_value"),
    ("ee_billing_warm_pool_slots", "state"),
    ("ee_billing_warm_pool_slots", "claimed_by_organisation_id"),
    ("ee_billing_warm_pool_slots", "checkout_id"),
    ("ee_billing_warm_pool_slots", "idempotency_key"),
    ("ee_billing_warm_pool_slots", "unhealthy_reason"),
    ("ee_billing_purchase_orders", "state"),
    ("ee_billing_purchase_orders", "issued_at"),
    ("ee_billing_purchase_orders", "countersigned_at"),
    ("ee_billing_purchase_orders", "countersigned_by"),
    ("ee_billing_purchase_orders", "countersigned_by_user_id"),
    ("ee_billing_purchase_orders", "invoice_ref"),
    ("ee_billing_purchase_orders", "invoiced_at"),
    ("ee_billing_purchase_orders", "payment_ref"),
    ("ee_billing_purchase_orders", "paid_at"),
    ("ee_billing_purchase_orders", "expired_at"),
    ("billing_subscription", "state"),
    ("billing_subscription", "cancelled_at"),
    ("billing_subscription", "updated_at"),
    ("billing_dunningcase", "state"),
    ("billing_dunningcase", "episode"),
    ("billing_dunningcase", "updated_at"),
    ("workspaces_workspacequota", "policy_ref"),
    ("workspaces_workspacequota", "seats"),
    ("workspaces_workspacequota", "updated_at"),
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
    # Attachment completion/cancellation, inbox read marks, and device subscription rotation/revocation;
    # checksums, sizes, MIME types, recipients, resource_ids and push outbox leases stay immutable.
    ("media_previewadmission", "expires_at"),
    ("media_previewadmission", "hits"),
    ("media_attachment", "completed_at"),
    ("media_attachment", "cancelled_at"),
    ("media_attachment", "updated_at"),
    ("notifications_notification", "read_at"),
    ("notifications_notification", "updated_at"),
    ("notifications_pushsubscription", "platform"),
    ("notifications_pushsubscription", "version"),
    ("notifications_pushsubscription", "endpoint_digest"),
    ("notifications_pushsubscription", "sealed_subscription"),
    ("notifications_pushsubscription", "revoked_at"),
    ("notifications_pushsubscription", "updated_at"),
    ("notifications_presencelease", "platform"),
    ("notifications_presencelease", "expires_at"),
    ("notifications_presencelease", "updated_at"),
    # Native workspace document tree/content mutations, soft-delete, snapshot compaction and links;
    # ownership, visibility, creator, channel binding and journal rows stay immutable.
    ("docs_document", "parent_id"),
    ("docs_document", "title"),
    ("docs_document", "title_key"),
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
    # Workspace import batch completion, `SELECT ... FOR UPDATE` on immutable imported objects,
    # coexistence bridge revocation + secret zeroization, and retryable coexistence queue leases.
    ("extensions_importbatch", "report"),
    ("extensions_importbatch", "state"),
    ("extensions_importbatch", "updated_at"),
    ("extensions_importedobject", "id"),
    ("extensions_coexistencebridge", "revoked_at"),
    ("extensions_coexistencebridge", "sealed_signing_secret"),
    ("extensions_coexistencebridge", "updated_at"),
    ("extensions_coexistencereplayguard", "state"),
    ("extensions_coexistencereplayguard", "lease_id"),
    ("extensions_coexistencereplayguard", "lease_expires_at"),
    ("extensions_coexistencereplayguard", "attempts"),
    ("extensions_coexistencereplayguard", "matrix_txn_id"),
    ("extensions_coexistencereplayguard", "matrix_event_id"),
    ("extensions_coexistencereplayguard", "sanitized_payload"),
    ("extensions_coexistencereplayguard", "updated_at"),
    ("identity_discoveryquotagate", "singleton"),
    ("identity_identity", "id"),
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
    # Zero-PII bug report deduplication coalesces only `occurrences` and `updated_at`; worker
    # dispatch fields (`dispatched_at`, `github_issue_number`, `dispatch_attempts`,
    # `last_dispatch_error`) and `support_bugreportcircuitstate` remain operator-only.
    ("support_bugreport", "occurrences"),
    ("support_bugreport", "updated_at"),
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
    # C1 /staff/v1/* mutable operational columns only; `staff_api_audit_entry`,
    # `staff_api_finops_snapshot` and `staff_api_waitlist_cohort` remain strictly append-only
    # (never UPDATE or DELETE).
    ("staff_api_role_grant", "revoked_at"),
    ("staff_api_role_grant", "revoked_by_identity_id"),
    ("staff_api_role_grant", "updated_at"),
    ("staff_api_deal_card", "stage"),
    ("staff_api_deal_card", "pack_code"),
    ("staff_api_deal_card", "capacity_tier_code"),
    ("staff_api_deal_card", "estimated_mrr_cents"),
    ("staff_api_deal_card", "owner_seat"),
    ("staff_api_deal_card", "next_step_code"),
    ("staff_api_deal_card", "updated_by_identity_id"),
    ("staff_api_deal_card", "updated_at"),
    ("staff_api_feedback_item", "status"),
    ("staff_api_feedback_item", "severity"),
    ("staff_api_feedback_item", "assigned_seat"),
    ("staff_api_feedback_item", "vote_count"),
    ("staff_api_feedback_item", "roadmap_milestone"),
    ("staff_api_feedback_item", "external_issue_ref"),
    ("staff_api_feedback_item", "updated_at"),
    ("staff_api_sar_record", "status"),
    ("staff_api_sar_record", "completed_at"),
    ("staff_api_sar_record", "evidence_ref"),
    ("staff_api_sar_record", "completed_by_identity_id"),
    ("staff_api_sar_record", "updated_at"),
    ("staff_api_issuer_snapshot", "issuer"),
    ("staff_api_issuer_snapshot", "expires_at_epoch"),
    ("staff_api_issuer_snapshot", "public_jwks"),
    ("staff_api_issuer_snapshot", "registered_by_identity_id"),
    ("staff_api_issuer_snapshot", "updated_at"),
    # Enterprise Edition (`ee/`): mutable IdP/principal/SCIM fields only; `ee_audit_ledger` and
    # `ee_audit_signing_key` receive zero UPDATE grants (strictly append-only for `kodera_api`).
    *(
        ("ee_saml_idp", c)
        for c in (
            "idp_entity_id",
            "idp_sso_url",
            "public_key_pem",
            "verified_domains_json",
            "group_role_mapping_json",
            "default_role",
            "want_assertions_signed",
            "clock_skew_seconds",
            "updated_at",
        )
    ),
    *(
        ("ee_saml_principal", c)
        for c in (
            "user_id",
            "principal_ref",
            "idp_id",
            "idp_entity_id",
            "assertion_id",
            "subject_name_id",
            "email",
            "display_name",
            "groups_json",
            "role",
            "return_path",
            "authenticated_at",
            "updated_at",
        )
    ),
    ("ee_scim_token", "revoked_at"),
    *(
        ("ee_scim_user", c)
        for c in (
            "user_id",
            "user_name",
            "user_name_lower",
            "external_id",
            "display_name",
            "given_name",
            "family_name",
            "emails_json",
            "active",
            "roles_json",
            "department",
            "member_state",
            "version",
            "updated_at",
            "deprovisioned_at",
        )
    ),
    *(
        ("ee_scim_group", c)
        for c in (
            "display_name",
            "display_name_lower",
            "external_id",
            "version",
            "updated_at",
        )
    ),
    ("ee_scim_group_member", "member_order"),
)
# An expired replay entry is replaced when its key returns (IDEMPOTENCY_REPLAY.md §2.2), for the
# intake and initialiseWorkspace alike. deleteCategory deletes an empty category, and a channel's
# access change deletes the rules it drops; a policy itself is never deleted. Native document
# Markdown replacement refreshes outgoing wikilinks and prunes snapshot-covered journal updates
# (trigger `docs_journal_guard` refuses deleting any uncovered update). Enterprise Edition operational
# deletes cover single-use SAML RelayState consumption, expired SAML replay pruning, SCIM RFC 7644 §3.6
# user/group deletion, group-membership unlinking, and active session revocation — never `ee_audit_ledger`
# or `ee_audit_signing_key`.
DELETE = (
    "workspaces_workspacerole",
    "workspaces_workspacememberrole",
    "workspaces_workspacechannelroleoverride",
    "workspaces_workspacemoderator",
    "docs_collectionrow",
    "identity_discoveryquotaevent",
    "identity_passportmagiclinktoken",
    "identity_passportratelimitevent",
    "idempotency_record",
    "workspaces_category",
    "workspaces_resourcepolicyrule",
    "docs_documentlink",
    "docs_documentupdate",
    "ee_saml_pending_request",
    "ee_saml_replay_assertion",
    "ee_scim_user",
    "ee_scim_group",
    "ee_scim_group_member",
    "ee_scim_session",
    "media_attachment",
    "media_previewadmission",
    "notifications_presencelease",
    "support_bugreportrateevent",
)
EXECUTE_FUNCTIONS = (
    "workspace_iam_permissions(jsonb)",
    "workspace_quota_usage(uuid)",
    "audit_workspace_resource_event(uuid, text, uuid, uuid, uuid, text)",
    "docs_document_role(uuid, uuid, uuid, uuid, text, text)",
    "staff_fence_caller(uuid, uuid, text, text, text[])",
    "staff_read_outbox_sre_summary(uuid)",
    "staff_sync_identity_bridge_role(uuid, uuid, text, text, uuid)",
    "staff_reconcile_job(uuid, uuid, jsonb, text)",
    "staff_reconcile_delivery(uuid, uuid, jsonb, text)",
    "ee_scim_sync_member_contact(uuid, uuid, text, text)",
)


# SQL column-level SELECT restriction: `legal_acceptance` grants only the linkage columns the
# guard reads (which documents were accepted, for which tenant and DPA), never personal or
# network attributes (`identity_id`, `accepted_by_name`, `accepted_by_role`, `source_ip_trunc`,
# `user_agent`). `orgs_realmreadiness` grants only the readiness predicate columns read by
# `counting_realm_ready` (`organisation_id`, `job_id`, `issuer`, `realm`, `revoked_at`), never
# staff recorder attributes (`id`, `recorded_by_identity_id`, `recorded_by_realm`, `recorded_at`).
# `billing_subscription` carries table-wide `SELECT` under the shared `kodera_api`
# role for customer `/api/v1/*` `Subscription.objects` reads and routed Stripe webhook
# reconciliation; `/staff/v1/*` FinOps enforces its aggregate-only MRR projection at the SQL
# query (`SELECT ... state, billing_period, total_excl_vat_minor` in `core/staff_api/services.py`)
# and HTTP serializer boundary (never exposing `organisation_id`, `order_id`, `tenant_id`,
# `subscription_id`, or `provider_*`).
SELECT_COLUMNS = (
    *(
        ("legal_acceptance", column)
        for column in ("id", "organisation_id", "order_id", "tenant_id", "document_id", "dpa_id")
    ),
    *(
        ("orgs_realmreadiness", column)
        for column in ("organisation_id", "job_id", "issuer", "realm", "revoked_at")
    ),
)

# SQL column-level INSERT restriction: `support_bugreport` grants `kodera_api` INSERT strictly on
# collector-owned diagnostic columns; worker-owned claim and GitHub dispatch columns (`claimed_at`,
# `claim_token`, `dispatched_at`, `github_issue_number`, `dispatch_attempts`, `last_dispatch_error`)
# populate from SQL DEFAULTs and cannot be forged by the HTTP API role.
INSERT_COLUMNS = (
    *(
        ("support_bugreport", column)
        for column in (
            "id",
            "created_at",
            "updated_at",
            "build_id",
            "component",
            "error_code",
            "device_class",
            "consent",
            "sanitized_note",
            "screenshot_content_type",
            "screenshot_bytes",
            "screenshot_sha256",
            "dedup_fingerprint",
            "occurrences",
        )
    ),
)


def revoke_broad_insert_statements(role: str) -> list[str]:
    """Revoke table-wide INSERT on column-scoped INSERT_COLUMNS tables before applying column grants."""
    if ROLE.fullmatch(role) is None:
        raise ValueError("a role name is a lower-case identifier")
    column_insert_tables = sorted({table for table, _ in INSERT_COLUMNS})
    return [f'REVOKE INSERT ON TABLE "{table}" FROM "{role}"' for table in column_insert_tables]


def grant_statements(role: str) -> list[str]:
    """The GRANT statements for `role`, a lower-case PostgreSQL identifier."""
    if ROLE.fullmatch(role) is None:
        raise ValueError("a role name is a lower-case identifier")
    column_insert_tables = {table for table, _ in INSERT_COLUMNS}
    statements = [f'GRANT USAGE ON SCHEMA public TO "{role}"']
    statements += [f'GRANT SELECT ON TABLE "{table}" TO "{role}"' for table in SELECT]
    statements += [
        f'GRANT SELECT ("{column}") ON TABLE "{table}" TO "{role}"'
        for table, column in SELECT_COLUMNS
    ]
    statements += revoke_broad_insert_statements(role)
    statements += [
        f'GRANT INSERT ON TABLE "{table}" TO "{role}"'
        for table in INSERT
        if table not in column_insert_tables
    ]
    statements += [
        f'GRANT INSERT ("{column}") ON TABLE "{table}" TO "{role}"'
        for table, column in INSERT_COLUMNS
    ]
    statements += [
        f'GRANT UPDATE ("{column}") ON TABLE "{table}" TO "{role}"'
        for table, column in UPDATE_COLUMNS
    ]
    statements += [f'GRANT DELETE ON TABLE "{table}" TO "{role}"' for table in DELETE]
    statements += [
        f'GRANT EXECUTE ON FUNCTION {signature} TO "{role}"' for signature in EXECUTE_FUNCTIONS
    ]
    return statements
