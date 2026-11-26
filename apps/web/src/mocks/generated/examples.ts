// GENERATED FILE — DO NOT EDIT. Regenerate with: npm run api:generate

// One example response per operation, taken from the contract: the status and the
// headers it declares, and the example body of its first 2xx response. List
// envelopes are composed so `data` holds a row — the `CursorPage` example is an
// empty page, and a mock that answered it would make every collection screen
// render its empty state forever.

export interface OperationExample {
  readonly operationId: string
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  /** The contract path, still templated. */
  readonly path: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The example body, or `null` where the contract declares no content. */
  readonly body: unknown
  /** Whether the body is a `CursorPage` envelope. */
  readonly isList: boolean
  /** Whether the operation requires an `Idempotency-Key` request header. */
  readonly idempotent: boolean
  /** Whether the operation requires an `If-Match` request header — every `PATCH` today. */
  readonly requiresIfMatch: boolean
  readonly conditionalWrite?: boolean
}

export const EXAMPLES = {
  "listWorkspaceRoles": {
    operationId: "listWorkspaceRoles",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/roles",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000011",
          "workspace_id": "00000000-0000-7000-8000-000000000012",
          "organisation_id": "00000000-0000-7000-8000-000000000013",
          "name": "Builders",
          "slug": "builders",
          "kind": "role",
          "color": "#2563eb",
          "icon": "wrench",
          "position": 10,
          "is_hoisted": true,
          "is_mentionable": true,
          "permissions": [
            "channel.view",
            "message.post"
          ],
          "member_count": 1,
          "etag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
          "created_at": "2026-01-02T12:00:00Z",
          "updated_at": "2026-01-02T12:00:00Z"
        }
      ],
      "assignments": [
        {
          "membership_id": "00000000-0000-7000-8000-000000000014",
          "role_ids": [
            "00000000-0000-7000-8000-000000000011"
          ]
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createWorkspaceRole": {
    operationId: "createWorkspaceRole",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/roles",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000011",
      "workspace_id": "00000000-0000-7000-8000-000000000012",
      "organisation_id": "00000000-0000-7000-8000-000000000013",
      "name": "Builders",
      "slug": "builders",
      "kind": "role",
      "color": "#2563eb",
      "icon": "wrench",
      "position": 10,
      "is_hoisted": true,
      "is_mentionable": true,
      "permissions": [
        "channel.view",
        "message.post"
      ],
      "member_count": 1,
      "etag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "created_at": "2026-01-02T12:00:00Z",
      "updated_at": "2026-01-02T12:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "updateWorkspaceRole": {
    operationId: "updateWorkspaceRole",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/roles/{role_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000011",
      "workspace_id": "00000000-0000-7000-8000-000000000012",
      "organisation_id": "00000000-0000-7000-8000-000000000013",
      "name": "Builders",
      "slug": "builders",
      "kind": "role",
      "color": "#2563eb",
      "icon": "wrench",
      "position": 10,
      "is_hoisted": true,
      "is_mentionable": true,
      "permissions": [
        "channel.view",
        "message.post"
      ],
      "member_count": 1,
      "etag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "created_at": "2026-01-02T12:00:00Z",
      "updated_at": "2026-01-02T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "deleteWorkspaceRole": {
    operationId: "deleteWorkspaceRole",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/roles/{role_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "setWorkspaceMemberRoles": {
    operationId: "setWorkspaceMemberRoles",
    method: "put",
    path: "/organisations/{organisation_id}/workspace/members/{membership_id}/roles",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "membership_id": "00000000-0000-7000-8000-000000000014",
      "role_ids": [
        "00000000-0000-7000-8000-000000000011"
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getWorkspaceChannelOverrides": {
    operationId: "getWorkspaceChannelOverrides",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/overrides",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "role_id": "00000000-0000-7000-8000-000000000011",
          "allow": [
            "channel.view"
          ],
          "deny": [
            "message.post"
          ]
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "setWorkspaceChannelOverrides": {
    operationId: "setWorkspaceChannelOverrides",
    method: "put",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/overrides",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "role_id": "00000000-0000-7000-8000-000000000011",
          "allow": [
            "channel.view"
          ],
          "deny": [
            "message.post"
          ]
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getWorkspaceProfile": {
    operationId: "getWorkspaceProfile",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/profile",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "description": "Product and engineering workspace",
      "banner_preset": "cobalt",
      "icon_mxc": "",
      "traits": [
        {
          "icon": "shield",
          "label": "Verified"
        }
      ],
      "arrivals_channel_id": "00000000-0000-7000-8000-000000000015",
      "rules_channel_id": null,
      "moderator_updates_channel_id": null,
      "security_alerts_channel_id": null,
      "invites_paused": false
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "updateWorkspaceProfile": {
    operationId: "updateWorkspaceProfile",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/profile",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "description": "Product and engineering workspace",
      "banner_preset": "cobalt",
      "icon_mxc": "",
      "traits": [
        {
          "icon": "shield",
          "label": "Verified"
        }
      ],
      "arrivals_channel_id": "00000000-0000-7000-8000-000000000015",
      "rules_channel_id": null,
      "moderator_updates_channel_id": null,
      "security_alerts_channel_id": null,
      "invites_paused": false
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "listWorkspaceBans": {
    operationId: "listWorkspaceBans",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/bans",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000016",
          "membership_id": "00000000-0000-7000-8000-000000000017",
          "display_name": "Suspended Member",
          "email": "member@example.invalid",
          "updated_at": "2026-01-02T12:00:00Z"
        }
      ],
      "has_more": false,
      "next_cursor": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listWorkspaceAuditLogs": {
    operationId: "listWorkspaceAuditLogs",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/audit-logs",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000018",
          "occurred_at": "2026-01-02T12:00:00Z",
          "actor_id": "00000000-0000-7000-8000-000000000019",
          "actor_type": "tenant",
          "action": "workspace.role.created",
          "target_urn": "urn:kodera:workspace_role:00000000-0000-7000-8000-000000000011",
          "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
        }
      ],
      "has_more": false,
      "next_cursor": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getMe": {
    operationId: "getMe",
    method: "get",
    path: "/me",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "11111111-2222-4333-8444-555555555555",
      "email": "julie@acme.fr",
      "display_name": "Julie Marchand",
      "locale": "fr",
      "staff": false,
      "identities": [
        {
          "id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
          "issuer": "https://id.kodera.io/realms/acme-sa",
          "realm": "acme-sa",
          "subject": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          "email": "julie@acme.fr",
          "email_verified": true,
          "mfa_enrolled": true,
          "federated_with": null,
          "last_login_at": "2026-12-01T08:41:12Z"
        }
      ],
      "organisations": [
        {
          "organisation": {
            "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
            "slug": "acme-sa",
            "name": "ACME SAS",
            "realm": "acme-sa"
          },
          "membership_id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
          "role": "org_admin",
          "state": "active",
          "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
          "joined_at": "2026-11-04T14:02:00Z"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "patchMe": {
    operationId: "patchMe",
    method: "patch",
    path: "/me",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "11111111-2222-4333-8444-555555555555",
      "email": "julie@acme.fr",
      "display_name": "Julie Marchand",
      "locale": "fr",
      "staff": false,
      "identities": [
        {
          "id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
          "issuer": "https://id.kodera.io/realms/acme-sa",
          "realm": "acme-sa",
          "subject": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
          "email": "julie@acme.fr",
          "email_verified": true,
          "mfa_enrolled": true,
          "federated_with": null,
          "last_login_at": "2026-12-01T08:41:12Z"
        }
      ],
      "organisations": [
        {
          "organisation": {
            "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
            "slug": "acme-sa",
            "name": "ACME SAS",
            "realm": "acme-sa"
          },
          "membership_id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
          "role": "org_admin",
          "state": "active",
          "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
          "joined_at": "2026-11-04T14:02:00Z"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "requestPassportMagicLink": {
    operationId: "requestPassportMagicLink",
    method: "post",
    path: "/auth/passport/magic-link/request",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "status": "accepted",
      "expires_in_seconds": 600
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "verifyPassportMagicLink": {
    operationId: "verifyPassportMagicLink",
    method: "post",
    path: "/auth/passport/magic-link/verify",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "user": {
        "id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab784",
        "email": "camille.laurent@acme.fr",
        "display_name": "Camille Laurent"
      },
      "active_organisation_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab785",
      "active_workspace_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab787",
      "workspaces": [
        {
          "organisation_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab785",
          "organisation_slug": "acme-org",
          "organisation_name": "Acme SAS",
          "realm": "acme-org",
          "issuer": "https://id.kodera.io/realms/acme-org",
          "membership_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab786",
          "role": "org_owner",
          "workspace_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab787",
          "default_urls": {},
          "active": true
        }
      ],
      "session_token": "kp1.eyJleHAiOjE3NjMxNDAwMDAsImlhdCI6MTc2MzEzNjQwMCwib3JnIjoiMDE5NDY3YTMtMGY5ZC03ZWI1LWI5ZTQtM2JjNmEwNGFiNzg1Iiwic3ViIjoiMDE5NDY3YTMtMGY5ZC03ZWI1LWI5ZTQtM2JjNmEwNGFiNzg0IiwidiI6MX0.synthetic_signature",
      "expires_in_seconds": 3600
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listPassportWorkspaces": {
    operationId: "listPassportWorkspaces",
    method: "get",
    path: "/auth/passport/workspaces",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "user": {
        "id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab784",
        "email": "camille.laurent@acme.fr",
        "display_name": "Camille Laurent"
      },
      "active_organisation_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab785",
      "active_workspace_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab787",
      "workspaces": [
        {
          "organisation_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab785",
          "organisation_slug": "acme-org",
          "organisation_name": "Acme SAS",
          "realm": "acme-org",
          "issuer": "https://id.kodera.io/realms/acme-org",
          "membership_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab786",
          "role": "org_owner",
          "workspace_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab787",
          "default_urls": {},
          "active": true
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "switchPassportWorkspace": {
    operationId: "switchPassportWorkspace",
    method: "post",
    path: "/auth/passport/switch-workspace",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "active_organisation_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab785",
      "active_workspace_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab787",
      "workspace": {
        "organisation_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab785",
        "organisation_slug": "acme-org",
        "organisation_name": "Acme SAS",
        "realm": "acme-org",
        "issuer": "https://id.kodera.io/realms/acme-org",
        "membership_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab786",
        "role": "org_owner",
        "workspace_id": "019467a3-0f9d-7eb5-b9e4-3bc6a04ab787",
        "default_urls": {},
        "active": true
      },
      "session_token": "kp1.eyJleHAiOjE3NjMxNDAwMDAsImlhdCI6MTc2MzEzNjQwMCwib3JnIjoiMDE5NDY3YTMtMGY5ZC03ZWI1LWI5ZTQtM2JjNmEwNGFiNzg1Iiwic3ViIjoiMDE5NDY3YTMtMGY5ZC03ZWI1LWI5ZTQtM2JjNmEwNGFiNzg0IiwidiI6MX0.synthetic_signature",
      "expires_in_seconds": 3600
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "receiveStripeWebhook": {
    operationId: "receiveStripeWebhook",
    method: "post",
    path: "/billing/webhooks/stripe",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "received": true,
      "event_id": "evt_synthetic_0001",
      "event_type": "checkout.session.completed",
      "status": "applied"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "discoverRealm": {
    operationId: "discoverRealm",
    method: "post",
    path: "/auth/discover",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Cache-Control": "no-store"
    },
    body: {
      "realm": null,
      "issuer": null,
      "openid_configuration_url": null,
      "organisation": null,
      "candidates": []
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listOrganisations": {
    operationId: "listOrganisations",
    method: "get",
    path: "/organisations",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "slug": "acme-sa",
          "name": "ACME",
          "legal_name": "ACME SAS",
          "state": "active",
          "realm": "acme-sa",
          "country": "FR",
          "vat_number": "FR12345678901",
          "siren": "123456789",
          "vat_regime": "fr_standard",
          "billing_email": "compta@acme.fr",
          "billing_address": {
            "line1": "12 rue de la Paix",
            "line2": null,
            "postal_code": "75002",
            "city": "Paris",
            "country": "FR"
          },
          "email_domains": [
            "acme.fr"
          ],
          "locale": "fr",
          "created_at": "2026-11-04T13:55:00Z",
          "updated_at": "2026-12-01T09:12:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createOrganisation": {
    operationId: "createOrganisation",
    method: "post",
    path: "/organisations",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "X-Operation-Ref": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "Location": "/api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f"
    },
    body: {
      "organisation": {
        "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "slug": "acme-sa",
        "name": "ACME",
        "legal_name": "ACME SAS",
        "state": "prospect",
        "realm": null,
        "country": "FR",
        "vat_number": "FR12345678901",
        "siren": null,
        "vat_regime": "fr_standard",
        "billing_email": "compta@acme.fr",
        "billing_address": null,
        "email_domains": [
          "acme.fr"
        ],
        "locale": "fr",
        "created_at": "2026-11-04T13:55:00Z",
        "updated_at": "2026-11-04T13:55:00Z"
      },
      "bootstrap": {
        "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "slug": "acme-sa",
        "organisation_state": "prospect",
        "intake": {
          "instruction_ref": "SUP-0418",
          "recorded_at": "2026-11-04T13:55:00Z",
          "intended_owner_email_masked": "j***e@acme.fr"
        },
        "realm": {
          "state": "pending",
          "name": null,
          "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
        },
        "identity_mapping": {
          "state": "pending",
          "identity_id": null,
          "bound_at": null
        },
        "claim": {
          "state": "not_issued",
          "issued_at": null,
          "expires_at": null,
          "consumed_at": null,
          "revoked_at": null,
          "membership_id": null
        },
        "updated_at": "2026-11-04T13:55:00Z"
      }
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getOrganisation": {
    operationId: "getOrganisation",
    method: "get",
    path: "/organisations/{organisation_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "slug": "acme-sa",
      "name": "ACME",
      "legal_name": "ACME SAS",
      "state": "active",
      "realm": "acme-sa",
      "country": "FR",
      "vat_number": "FR12345678901",
      "siren": "123456789",
      "vat_regime": "fr_standard",
      "billing_email": "compta@acme.fr",
      "billing_address": {
        "line1": "12 rue de la Paix",
        "line2": null,
        "postal_code": "75002",
        "city": "Paris",
        "country": "FR"
      },
      "email_domains": [
        "acme.fr"
      ],
      "locale": "fr",
      "created_at": "2026-11-04T13:55:00Z",
      "updated_at": "2026-12-01T09:12:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "patchOrganisation": {
    operationId: "patchOrganisation",
    method: "patch",
    path: "/organisations/{organisation_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "slug": "acme-sa",
      "name": "ACME",
      "legal_name": "ACME SAS",
      "state": "active",
      "realm": "acme-sa",
      "country": "FR",
      "vat_number": "FR12345678901",
      "siren": "123456789",
      "vat_regime": "fr_standard",
      "billing_email": "compta@acme.fr",
      "billing_address": {
        "line1": "12 rue de la Paix",
        "line2": null,
        "postal_code": "75002",
        "city": "Paris",
        "country": "FR"
      },
      "email_domains": [
        "acme.fr"
      ],
      "locale": "fr",
      "created_at": "2026-11-04T13:55:00Z",
      "updated_at": "2026-12-01T09:12:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "getOrganisationBootstrap": {
    operationId: "getOrganisationBootstrap",
    method: "get",
    path: "/organisations/{organisation_id}/bootstrap",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "slug": "acme-sa",
      "organisation_state": "prospect",
      "intake": {
        "instruction_ref": "SUP-0418",
        "recorded_at": "2026-11-04T13:55:00Z",
        "intended_owner_email_masked": "j***e@acme.fr"
      },
      "realm": {
        "state": "ready",
        "name": "acme-sa",
        "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
      },
      "identity_mapping": {
        "state": "ready",
        "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
        "bound_at": "2026-11-04T14:20:00Z"
      },
      "claim": {
        "state": "issued",
        "issued_at": "2026-11-04T14:20:05Z",
        "expires_at": "2026-11-07T14:20:05Z",
        "consumed_at": null,
        "revoked_at": null,
        "membership_id": null
      },
      "updated_at": "2026-11-04T14:20:05Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getWorkspace": {
    operationId: "getWorkspace",
    method: "get",
    path: "/organisations/{organisation_id}/workspace",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "state": "initialised",
      "setup": {
        "state": "ready",
        "reason": null
      },
      "can_initialise": false,
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
      "categories": [
        {
          "id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
          "name": "General",
          "template_key": "general",
          "channels": [
            {
              "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
              "kind": "text",
              "name": "welcome",
              "template_key": "welcome",
              "topic": "",
              "lifecycle": "active",
              "room_state": "ready",
              "is_confidential": false
            },
            {
              "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd1",
              "kind": "text",
              "name": "general",
              "template_key": "general",
              "topic": "",
              "lifecycle": "active",
              "room_state": "ready",
              "is_confidential": false
            }
          ]
        },
        {
          "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcf",
          "name": "Team",
          "template_key": "team",
          "channels": [
            {
              "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd2",
              "kind": "audio",
              "name": "lounge",
              "template_key": "lounge",
              "topic": "",
              "lifecycle": "active",
              "room_state": "pending",
              "is_confidential": false
            }
          ]
        }
      ],
      "uncategorised_channels": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "instantClaimWorkspace": {
    operationId: "instantClaimWorkspace",
    method: "post",
    path: "/workspaces/instant-claim",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "workspaceId": "018f1234-5678-7000-8000-000000000030",
      "workspaceUrl": "https://studio.example.org",
      "invitationUrl": "https://studio.example.org/invite?signed=example",
      "channels": [
        {
          "id": "018f1234-5678-7000-8000-000000000031",
          "name": "production",
          "kind": "text"
        }
      ],
      "enabledConnectors": [
        "frameio-review-bridge"
      ],
      "offerMode": "cloud-shared"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "createSelfServeWorkspace": {
    operationId: "createSelfServeWorkspace",
    method: "post",
    path: "/workspaces/self-serve",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_id": "018f1234-5678-7000-8000-000000000090",
      "organisation_slug": "atelier-lumiere",
      "workspace_id": "018f1234-5678-7000-8000-000000000091",
      "tenant_id": "018f1234-5678-7000-8000-000000000092",
      "redirect_path": "/atelier-lumiere/workspace",
      "quota": {
        "policy_ref": "freemium:pme:seats-5",
        "seats": 5,
        "used": 1,
        "remaining": 4
      }
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "initialiseWorkspace": {
    operationId: "initialiseWorkspace",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/actions/initialise",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f/workspace"
    },
    body: {
      "state": "initialised"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "createCategory": {
    operationId: "createCategory",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/categories",
    status: 201,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
      "name": "General",
      "template_key": "general",
      "position": 0,
      "etag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "patchCategory": {
    operationId: "patchCategory",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/categories/{category_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
      "name": "General",
      "template_key": "general",
      "position": 0,
      "etag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "deleteCategory": {
    operationId: "deleteCategory",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/categories/{category_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createChannel": {
    operationId: "createChannel",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/channels",
    status: 201,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
      "category_id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
      "kind": "text",
      "name": "welcome",
      "template_key": "welcome",
      "topic": "",
      "position": 0,
      "lifecycle": "active",
      "room_state": "pending",
      "access": {
        "mode": "inherit"
      },
      "etag": "\"000000000000000000000000000000000000000000000000000000000000e7aa\""
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "patchChannel": {
    operationId: "patchChannel",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
      "category_id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
      "kind": "text",
      "name": "welcome",
      "template_key": "welcome",
      "topic": "",
      "position": 0,
      "lifecycle": "active",
      "room_state": "pending",
      "access": {
        "mode": "inherit"
      },
      "etag": "\"000000000000000000000000000000000000000000000000000000000000e7aa\""
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "archiveChannel": {
    operationId: "archiveChannel",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/actions/archive",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
      "category_id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
      "kind": "text",
      "name": "welcome",
      "template_key": "welcome",
      "topic": "",
      "position": 0,
      "lifecycle": "active",
      "room_state": "pending",
      "access": {
        "mode": "inherit"
      },
      "etag": "\"000000000000000000000000000000000000000000000000000000000000e7aa\""
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "unarchiveChannel": {
    operationId: "unarchiveChannel",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/actions/unarchive",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
      "category_id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
      "kind": "text",
      "name": "welcome",
      "template_key": "welcome",
      "topic": "",
      "position": 0,
      "lifecycle": "active",
      "room_state": "pending",
      "access": {
        "mode": "inherit"
      },
      "etag": "\"000000000000000000000000000000000000000000000000000000000000e7aa\""
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getChannelAccess": {
    operationId: "getChannelAccess",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/access",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "channel_id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
      "mode": "explicit",
      "visibility": "restricted",
      "allow_members": [
        "0192f3a4-5b6c-7d8e-9f01-23456789abe0"
      ],
      "deny_members": [],
      "read_only": true,
      "listen_only": false
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "patchChannelAccess": {
    operationId: "patchChannelAccess",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/access",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "channel_id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
      "mode": "explicit",
      "visibility": "restricted",
      "allow_members": [
        "0192f3a4-5b6c-7d8e-9f01-23456789abe0"
      ],
      "deny_members": [],
      "read_only": true,
      "listen_only": false
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "getWorkspaceAdministration": {
    operationId: "getWorkspaceAdministration",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/administration",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
      "categories": [
        {
          "id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
          "name": "General",
          "template_key": "general",
          "position": 0,
          "etag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
          "channels": [
            {
              "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
              "category_id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
              "kind": "text",
              "name": "welcome",
              "template_key": "welcome",
              "topic": "",
              "position": 0,
              "lifecycle": "active",
              "room_state": "pending",
              "access": {
                "mode": "inherit"
              },
              "etag": "\"000000000000000000000000000000000000000000000000000000000000e7aa\""
            }
          ]
        }
      ],
      "uncategorised_channels": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getNoticeContacts": {
    operationId: "getNoticeContacts",
    method: "get",
    path: "/organisations/{organisation_id}/notice-contacts",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "security_contact_email": "securite@acme.fr",
      "security_contact_defaults_to_owners": false,
      "privacy_contact_email": "dpo@acme.fr",
      "privacy_contact_defaults_to_owners": false,
      "subprocessor_notice_email": null,
      "subprocessor_notice_defaults_to_owners": true
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "patchNoticeContacts": {
    operationId: "patchNoticeContacts",
    method: "patch",
    path: "/organisations/{organisation_id}/notice-contacts",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "security_contact_email": "securite@acme.fr",
      "security_contact_defaults_to_owners": false,
      "privacy_contact_email": "dpo@acme.fr",
      "privacy_contact_defaults_to_owners": false,
      "subprocessor_notice_email": null,
      "subprocessor_notice_defaults_to_owners": true
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "listMemberships": {
    operationId: "listMemberships",
    method: "get",
    path: "/organisations/{organisation_id}/memberships",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "person_id": "11111111-2222-4333-8444-555555555555",
          "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
          "email": "julie@acme.fr",
          "display_name": "Julie Marchand",
          "role": "org_admin",
          "state": "active",
          "source": "invitation",
          "account_kind": "hosted",
          "mfa_enrolled": true,
          "last_seen_at": "2026-12-01T08:41:12Z",
          "created_at": "2026-11-04T14:02:00Z",
          "updated_at": "2026-12-01T08:41:12Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getMembership": {
    operationId: "getMembership",
    method: "get",
    path: "/organisations/{organisation_id}/memberships/{membership_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "person_id": "11111111-2222-4333-8444-555555555555",
      "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
      "email": "julie@acme.fr",
      "display_name": "Julie Marchand",
      "role": "org_owner",
      "state": "active",
      "source": "order",
      "account_kind": "hosted",
      "mfa_enrolled": true,
      "last_seen_at": "2026-12-01T08:41:12Z",
      "created_at": "2026-11-04T14:02:00Z",
      "updated_at": "2026-12-01T08:41:12Z",
      "can_change_role": false,
      "can_remove": false,
      "blocked_reason": "last_owner",
      "invitation_id": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "changeMembershipRole": {
    operationId: "changeMembershipRole",
    method: "patch",
    path: "/organisations/{organisation_id}/memberships/{membership_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "person_id": "11111111-2222-4333-8444-555555555555",
      "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
      "email": "julie@acme.fr",
      "display_name": "Julie Marchand",
      "role": "org_admin",
      "state": "active",
      "source": "invitation",
      "account_kind": "hosted",
      "mfa_enrolled": true,
      "last_seen_at": "2026-12-01T08:41:12Z",
      "created_at": "2026-11-04T14:02:00Z",
      "updated_at": "2026-12-01T08:41:12Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "removeMembership": {
    operationId: "removeMembership",
    method: "delete",
    path: "/organisations/{organisation_id}/memberships/{membership_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "person_id": "11111111-2222-4333-8444-555555555555",
      "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
      "email": "julie@acme.fr",
      "display_name": "Julie Marchand",
      "role": "org_admin",
      "state": "active",
      "source": "invitation",
      "account_kind": "hosted",
      "mfa_enrolled": true,
      "last_seen_at": "2026-12-01T08:41:12Z",
      "created_at": "2026-11-04T14:02:00Z",
      "updated_at": "2026-12-01T08:41:12Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listInvitations": {
    operationId: "listInvitations",
    method: "get",
    path: "/organisations/{organisation_id}/invitations",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "5d4c3b2a-1908-4776-8564-3a2b1c0d9e8f",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "email": "marc@acme.fr",
          "role": "org_member",
          "state": "pending",
          "realm": "acme-sa",
          "invited_by": "11111111-2222-4333-8444-555555555555",
          "expires_at": "2026-12-08T09:00:00Z",
          "accepted_at": null,
          "membership_id": null,
          "sent_count": 1,
          "last_sent_at": "2026-12-01T09:00:00Z",
          "created_at": "2026-12-01T09:00:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "inviteToOrganisation": {
    operationId: "inviteToOrganisation",
    method: "post",
    path: "/organisations/{organisation_id}/invitations",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "created": 1,
      "skipped": 1,
      "failed": 0,
      "seats_used_after": 118,
      "seats_included": 150,
      "results": [
        {
          "email": "marc@acme.fr",
          "outcome": "created",
          "invitation": null,
          "detail": null
        },
        {
          "email": "julie@acme.fr",
          "outcome": "already_member",
          "invitation": null,
          "detail": "Already an admin of this organisation."
        }
      ]
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "previewInvitation": {
    operationId: "previewInvitation",
    method: "post",
    path: "/invitations/preview",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_name": "Acme",
      "inviter_display_name": "Julie Martin",
      "role": "org_member",
      "expires_at": "2026-11-20T09:30:00.000Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "acceptInvitation": {
    operationId: "acceptInvitation",
    method: "post",
    path: "/invitations/accept",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "person_id": "11111111-2222-4333-8444-555555555555",
      "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
      "email": "julie@acme.fr",
      "display_name": "Julie Marchand",
      "role": "org_admin",
      "state": "active",
      "source": "invitation",
      "account_kind": "hosted",
      "mfa_enrolled": true,
      "last_seen_at": "2026-12-01T08:41:12Z",
      "created_at": "2026-11-04T14:02:00Z",
      "updated_at": "2026-12-01T08:41:12Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "consumeOwnerClaim": {
    operationId: "consumeOwnerClaim",
    method: "post",
    path: "/owner-claims/actions/consume",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation": {
        "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "slug": "acme-sa",
        "name": "ACME",
        "legal_name": "ACME SAS",
        "state": "active",
        "realm": "acme-sa",
        "country": "FR",
        "vat_number": "FR12345678901",
        "siren": null,
        "vat_regime": "fr_standard",
        "billing_email": "compta@acme.fr",
        "billing_address": null,
        "email_domains": [
          "acme.fr"
        ],
        "locale": "fr",
        "created_at": "2026-11-04T13:55:00Z",
        "updated_at": "2026-11-05T09:12:00Z"
      },
      "membership": {
        "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
        "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "person_id": "11111111-2222-4333-8444-555555555555",
        "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
        "email": "julie@acme.fr",
        "display_name": "Julie Marchand",
        "role": "org_owner",
        "state": "active",
        "source": "owner_claim",
        "account_kind": "hosted",
        "mfa_enrolled": true,
        "last_seen_at": "2026-11-05T09:12:00Z",
        "created_at": "2026-11-05T09:12:00Z",
        "updated_at": "2026-11-05T09:12:00Z"
      }
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listEnrolmentTokens": {
    operationId: "listEnrolmentTokens",
    method: "get",
    path: "/organisations/{organisation_id}/enrolment-tokens",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "2f3e4d5c-6b7a-4980-8172-635445362718",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "label": "Welcome day, room B",
          "role": "org_member",
          "state": "active",
          "max_uses": 120,
          "uses": 37,
          "require_email_domain": "acme.fr",
          "fingerprint": "4a1b2c3d4e5f6071",
          "expires_at": "2026-12-02T18:00:00Z",
          "created_by": "11111111-2222-4333-8444-555555555555",
          "created_at": "2026-12-01T09:30:00Z",
          "revoked_at": null
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createEnrolmentToken": {
    operationId: "createEnrolmentToken",
    method: "post",
    path: "/organisations/{organisation_id}/enrolment-tokens",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "2f3e4d5c-6b7a-4980-8172-635445362718",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "label": "Welcome day, room B",
      "role": "org_member",
      "state": "active",
      "max_uses": 120,
      "uses": 0,
      "require_email_domain": "acme.fr",
      "fingerprint": "4a1b2c3d4e5f6071",
      "expires_at": "2026-12-02T18:00:00Z",
      "created_by": "11111111-2222-4333-8444-555555555555",
      "created_at": "2026-12-01T09:30:00Z",
      "revoked_at": null,
      "secret": "enr_EXAMPLE00000000000000000000000",
      "enrolment_url": "https://app.kodera.io/enrol#enr_EXAMPLE00000000000000000000000",
      "qr_svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 33 33\"></svg>"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "revokeEnrolmentToken": {
    operationId: "revokeEnrolmentToken",
    method: "delete",
    path: "/organisations/{organisation_id}/enrolment-tokens/{enrolment_token_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listPlans": {
    operationId: "listPlans",
    method: "get",
    path: "/catalog/plans",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "code": "essentiel",
          "version": 3,
          "name": "Essentiel",
          "description": "Visio and Docs for an organisation that wants one login and hosting in the European Union.",
          "state": "published",
          "packs": [
            "visio",
            "visio-docs"
          ],
          "support_tier": "standard",
          "published_at": "2026-11-15T00:00:00Z",
          "retired_at": null
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listPacks": {
    operationId: "listPacks",
    method: "get",
    path: "/catalog/packs",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "code": "visio-docs",
          "name": "Visio + Docs",
          "description": "Video meetings and collaborative documents on one tenant, one login.",
          "apps": [
            "visio",
            "docs"
          ],
          "profile_ref": "visio-docs/1.4",
          "capacity_tier_codes": [
            "S",
            "M",
            "L"
          ],
          "available": true
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listCapacityTiers": {
    operationId: "listCapacityTiers",
    method: "get",
    path: "/catalog/capacity-tiers",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "code": "M",
          "name": "Moyen",
          "description": "Up to 150 people, 50 in one meeting.",
          "seats_included": 150,
          "concurrent_participants_included": 50,
          "storage_included_bytes": 536870912000,
          "vm_shape": "PRO2-M",
          "media_ip_dedicated": true,
          "available": true
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listPrices": {
    operationId: "listPrices",
    method: "get",
    path: "/catalog/prices",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
          "plan_code": "essentiel",
          "plan_version": 3,
          "pack_code": "visio-docs",
          "capacity_tier_code": "M",
          "billing_period": "yearly",
          "amount_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "setup_fee_excl_vat": null,
          "valid_from": "2026-11-15T00:00:00Z",
          "valid_to": null
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listOrders": {
    operationId: "listOrders",
    method: "get",
    path: "/organisations/{organisation_id}/orders",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "state": "awaiting_payment",
          "pack_code": "visio-docs",
          "capacity_tier_code": "M",
          "apps": [
            "visio",
            "docs"
          ],
          "billing_period": "yearly",
          "price_snapshot": {
            "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
            "plan_code": "essentiel",
            "plan_version": 3,
            "pack_code": "visio-docs",
            "capacity_tier_code": "M",
            "billing_period": "yearly",
            "unit_amount_excl_vat": {
              "amount_minor": 448800,
              "currency": "EUR"
            },
            "quantity": 1,
            "vat_regime": "fr_standard",
            "vat_rate_bp": 2000,
            "total_excl_vat": {
              "amount_minor": 448800,
              "currency": "EUR"
            },
            "vat_amount": {
              "amount_minor": 89760,
              "currency": "EUR"
            },
            "total_incl_vat": {
              "amount_minor": 538560,
              "currency": "EUR"
            },
            "captured_at": "2026-12-01T09:41:07Z"
          },
          "dpa_id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
          "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
          "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "purchase_order_ref": "BC-2026-118",
          "placed_by": "11111111-2222-4333-8444-555555555555",
          "created_at": "2026-12-01T09:41:07Z",
          "updated_at": "2026-12-01T09:41:09Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "placeOrder": {
    operationId: "placeOrder",
    method: "post",
    path: "/organisations/{organisation_id}/orders",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/orders/a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f"
    },
    body: {
      "order": {
        "id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
        "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "state": "awaiting_payment",
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "apps": [
          "visio",
          "docs"
        ],
        "billing_period": "yearly",
        "price_snapshot": {
          "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
          "plan_code": "essentiel",
          "plan_version": 3,
          "pack_code": "visio-docs",
          "capacity_tier_code": "M",
          "billing_period": "yearly",
          "unit_amount_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "quantity": 1,
          "vat_regime": "fr_standard",
          "vat_rate_bp": 2000,
          "total_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "vat_amount": {
            "amount_minor": 89760,
            "currency": "EUR"
          },
          "total_incl_vat": {
            "amount_minor": 538560,
            "currency": "EUR"
          },
          "captured_at": "2026-12-01T09:41:07Z"
        },
        "dpa_id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
        "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
        "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
        "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
        "purchase_order_ref": "BC-2026-118",
        "placed_by": "11111111-2222-4333-8444-555555555555",
        "created_at": "2026-12-01T09:41:07Z",
        "updated_at": "2026-12-01T09:41:09Z"
      },
      "subscription": {
        "id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
        "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
        "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
        "state": "active",
        "plan_code": "essentiel",
        "plan_version": 3,
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "billing_period": "yearly",
        "price_snapshot": {
          "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
          "plan_code": "essentiel",
          "plan_version": 3,
          "pack_code": "visio-docs",
          "capacity_tier_code": "M",
          "billing_period": "yearly",
          "unit_amount_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "quantity": 1,
          "vat_regime": "fr_standard",
          "vat_rate_bp": 2000,
          "total_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "vat_amount": {
            "amount_minor": 89760,
            "currency": "EUR"
          },
          "total_incl_vat": {
            "amount_minor": 538560,
            "currency": "EUR"
          },
          "captured_at": "2026-12-01T09:41:07Z"
        },
        "current_period_start": "2026-12-01T00:00:00Z",
        "current_period_end": "2027-12-01T00:00:00Z",
        "cancel_at_period_end": false,
        "cancelled_at": null,
        "next_invoice_at": "2027-12-01T00:00:00Z",
        "price_change_notice_days": 90,
        "created_at": "2026-12-01T09:41:07Z",
        "updated_at": "2026-12-03T11:20:00Z"
      },
      "tenant": {
        "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
        "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "slug": "acme",
        "name": "ACME",
        "status": "ordered",
        "status_changed_at": "2026-12-01T09:41:07Z",
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "apps": [
          "visio",
          "docs"
        ],
        "region": "fr-par",
        "realm": null,
        "profile_ref": null,
        "profile_commit": null,
        "instance_id": null,
        "default_urls": {},
        "observed": {
          "last_heartbeat_at": null,
          "heartbeat_seq": null,
          "stale": false,
          "agent_version": null,
          "profile": null,
          "drift_detected_at": null,
          "drift_summary": null,
          "maintenance": false
        },
        "locale": "fr",
        "created_at": "2026-12-01T09:41:07Z",
        "updated_at": "2026-12-01T09:41:07Z"
      },
      "invoice": {
        "id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
        "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
        "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
        "number": "INV-2026-0142",
        "state": "issued",
        "currency": "EUR",
        "vat_regime": "fr_standard",
        "lines": [
          {
            "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
            "quantity": 1,
            "unit_amount_excl_vat": {
              "amount_minor": 448800,
              "currency": "EUR"
            },
            "total_excl_vat": {
              "amount_minor": 448800,
              "currency": "EUR"
            },
            "vat_rate_bp": 2000,
            "period_start": "2026-12-01T00:00:00Z",
            "period_end": "2027-12-01T00:00:00Z"
          }
        ],
        "total_excl_vat": {
          "amount_minor": 448800,
          "currency": "EUR"
        },
        "vat_amount": {
          "amount_minor": 89760,
          "currency": "EUR"
        },
        "total_incl_vat": {
          "amount_minor": 538560,
          "currency": "EUR"
        },
        "amount_due": {
          "amount_minor": 538560,
          "currency": "EUR"
        },
        "issued_at": "2026-12-01T09:42:00Z",
        "due_at": "2026-12-31T23:59:59Z",
        "paid_at": null,
        "pdf_available": true,
        "external_ref": "inv_ext_9RJ2K",
        "created_at": "2026-12-01T09:41:07Z",
        "updated_at": "2026-12-01T09:42:00Z"
      },
      "payment_link": {
        "id": "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081",
        "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
        "provider": "stripe",
        "url": "https://pay.example.invalid/xJ8kQ2mR7t",
        "state": "active",
        "amount": {
          "amount_minor": 538560,
          "currency": "EUR"
        },
        "expires_at": "2026-12-31T23:59:59Z",
        "used_at": null,
        "created_at": "2026-12-01T09:42:05Z"
      },
      "dpa": {
        "id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
        "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "tenant_id": null,
        "version": "2026.11",
        "state": "accepted",
        "locale": "fr",
        "pack_code": "visio-docs",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000d9a",
        "sub_processors": [
          {
            "name": "Scaleway",
            "role": "Hosting and infrastructure",
            "location": "Paris",
            "country": "FR"
          }
        ],
        "annexes": [
          "A",
          "B",
          "C",
          "D"
        ],
        "generated_at": "2026-12-01T09:38:00Z",
        "accepted_at": "2026-12-01T09:40:52Z",
        "accepted_by": {
          "person_id": "11111111-2222-4333-8444-555555555555",
          "name": "Julie Marchand",
          "email": "julie@acme.fr",
          "role_title": "Présidente"
        },
        "superseded_by": null
      },
      "billing_pending": false
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getOrder": {
    operationId: "getOrder",
    method: "get",
    path: "/orders/{order_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "state": "awaiting_payment",
      "pack_code": "visio-docs",
      "capacity_tier_code": "M",
      "apps": [
        "visio",
        "docs"
      ],
      "billing_period": "yearly",
      "price_snapshot": {
        "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
        "plan_code": "essentiel",
        "plan_version": 3,
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "billing_period": "yearly",
        "unit_amount_excl_vat": {
          "amount_minor": 448800,
          "currency": "EUR"
        },
        "quantity": 1,
        "vat_regime": "fr_standard",
        "vat_rate_bp": 2000,
        "total_excl_vat": {
          "amount_minor": 448800,
          "currency": "EUR"
        },
        "vat_amount": {
          "amount_minor": 89760,
          "currency": "EUR"
        },
        "total_incl_vat": {
          "amount_minor": 538560,
          "currency": "EUR"
        },
        "captured_at": "2026-12-01T09:41:07Z"
      },
      "dpa_id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
      "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
      "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "purchase_order_ref": "BC-2026-118",
      "placed_by": "11111111-2222-4333-8444-555555555555",
      "created_at": "2026-12-01T09:41:07Z",
      "updated_at": "2026-12-01T09:41:09Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "cancelOrder": {
    operationId: "cancelOrder",
    method: "post",
    path: "/orders/{order_id}/actions/cancel",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "state": "awaiting_payment",
      "pack_code": "visio-docs",
      "capacity_tier_code": "M",
      "apps": [
        "visio",
        "docs"
      ],
      "billing_period": "yearly",
      "price_snapshot": {
        "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
        "plan_code": "essentiel",
        "plan_version": 3,
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "billing_period": "yearly",
        "unit_amount_excl_vat": {
          "amount_minor": 448800,
          "currency": "EUR"
        },
        "quantity": 1,
        "vat_regime": "fr_standard",
        "vat_rate_bp": 2000,
        "total_excl_vat": {
          "amount_minor": 448800,
          "currency": "EUR"
        },
        "vat_amount": {
          "amount_minor": 89760,
          "currency": "EUR"
        },
        "total_incl_vat": {
          "amount_minor": 538560,
          "currency": "EUR"
        },
        "captured_at": "2026-12-01T09:41:07Z"
      },
      "dpa_id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
      "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
      "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "purchase_order_ref": "BC-2026-118",
      "placed_by": "11111111-2222-4333-8444-555555555555",
      "created_at": "2026-12-01T09:41:07Z",
      "updated_at": "2026-12-01T09:41:09Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listSubscriptions": {
    operationId: "listSubscriptions",
    method: "get",
    path: "/organisations/{organisation_id}/subscriptions",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
          "state": "active",
          "plan_code": "essentiel",
          "plan_version": 3,
          "pack_code": "visio-docs",
          "capacity_tier_code": "M",
          "billing_period": "yearly",
          "price_snapshot": {
            "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
            "plan_code": "essentiel",
            "plan_version": 3,
            "pack_code": "visio-docs",
            "capacity_tier_code": "M",
            "billing_period": "yearly",
            "unit_amount_excl_vat": {
              "amount_minor": 448800,
              "currency": "EUR"
            },
            "quantity": 1,
            "vat_regime": "fr_standard",
            "vat_rate_bp": 2000,
            "total_excl_vat": {
              "amount_minor": 448800,
              "currency": "EUR"
            },
            "vat_amount": {
              "amount_minor": 89760,
              "currency": "EUR"
            },
            "total_incl_vat": {
              "amount_minor": 538560,
              "currency": "EUR"
            },
            "captured_at": "2026-12-01T09:41:07Z"
          },
          "current_period_start": "2026-12-01T00:00:00Z",
          "current_period_end": "2027-12-01T00:00:00Z",
          "cancel_at_period_end": false,
          "cancelled_at": null,
          "next_invoice_at": "2027-12-01T00:00:00Z",
          "price_change_notice_days": 90,
          "created_at": "2026-12-01T09:41:07Z",
          "updated_at": "2026-12-03T11:20:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getSubscription": {
    operationId: "getSubscription",
    method: "get",
    path: "/subscriptions/{subscription_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
      "state": "active",
      "plan_code": "essentiel",
      "plan_version": 3,
      "pack_code": "visio-docs",
      "capacity_tier_code": "M",
      "billing_period": "yearly",
      "price_snapshot": {
        "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
        "plan_code": "essentiel",
        "plan_version": 3,
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "billing_period": "yearly",
        "unit_amount_excl_vat": {
          "amount_minor": 448800,
          "currency": "EUR"
        },
        "quantity": 1,
        "vat_regime": "fr_standard",
        "vat_rate_bp": 2000,
        "total_excl_vat": {
          "amount_minor": 448800,
          "currency": "EUR"
        },
        "vat_amount": {
          "amount_minor": 89760,
          "currency": "EUR"
        },
        "total_incl_vat": {
          "amount_minor": 538560,
          "currency": "EUR"
        },
        "captured_at": "2026-12-01T09:41:07Z"
      },
      "current_period_start": "2026-12-01T00:00:00Z",
      "current_period_end": "2027-12-01T00:00:00Z",
      "cancel_at_period_end": false,
      "cancelled_at": null,
      "next_invoice_at": "2027-12-01T00:00:00Z",
      "price_change_notice_days": 90,
      "created_at": "2026-12-01T09:41:07Z",
      "updated_at": "2026-12-03T11:20:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listInvoices": {
    operationId: "listInvoices",
    method: "get",
    path: "/organisations/{organisation_id}/invoices",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
          "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
          "number": "INV-2026-0142",
          "state": "issued",
          "currency": "EUR",
          "vat_regime": "fr_standard",
          "lines": [
            {
              "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
              "quantity": 1,
              "unit_amount_excl_vat": {
                "amount_minor": 448800,
                "currency": "EUR"
              },
              "total_excl_vat": {
                "amount_minor": 448800,
                "currency": "EUR"
              },
              "vat_rate_bp": 2000,
              "period_start": "2026-12-01T00:00:00Z",
              "period_end": "2027-12-01T00:00:00Z"
            }
          ],
          "total_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "vat_amount": {
            "amount_minor": 89760,
            "currency": "EUR"
          },
          "total_incl_vat": {
            "amount_minor": 538560,
            "currency": "EUR"
          },
          "amount_due": {
            "amount_minor": 538560,
            "currency": "EUR"
          },
          "issued_at": "2026-12-01T09:42:00Z",
          "due_at": "2026-12-31T23:59:59Z",
          "paid_at": null,
          "pdf_available": true,
          "external_ref": "inv_ext_9RJ2K",
          "created_at": "2026-12-01T09:41:07Z",
          "updated_at": "2026-12-01T09:42:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getInvoice": {
    operationId: "getInvoice",
    method: "get",
    path: "/invoices/{invoice_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
      "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
      "number": "INV-2026-0142",
      "state": "issued",
      "currency": "EUR",
      "vat_regime": "fr_standard",
      "lines": [
        {
          "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
          "quantity": 1,
          "unit_amount_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "total_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "vat_rate_bp": 2000,
          "period_start": "2026-12-01T00:00:00Z",
          "period_end": "2027-12-01T00:00:00Z"
        }
      ],
      "total_excl_vat": {
        "amount_minor": 448800,
        "currency": "EUR"
      },
      "vat_amount": {
        "amount_minor": 89760,
        "currency": "EUR"
      },
      "total_incl_vat": {
        "amount_minor": 538560,
        "currency": "EUR"
      },
      "amount_due": {
        "amount_minor": 538560,
        "currency": "EUR"
      },
      "issued_at": "2026-12-01T09:42:00Z",
      "due_at": "2026-12-31T23:59:59Z",
      "paid_at": null,
      "pdf_available": true,
      "external_ref": "inv_ext_9RJ2K",
      "created_at": "2026-12-01T09:41:07Z",
      "updated_at": "2026-12-01T09:42:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listCreditNotes": {
    operationId: "listCreditNotes",
    method: "get",
    path: "/organisations/{organisation_id}/credit-notes",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
          "invoice_number": "INV-2026-00142",
          "number": "AV-INV-2026-00007",
          "issued_at": "2026-12-03T10:12:44Z",
          "reason": "customer_cancellation",
          "currency": "EUR",
          "vat_regime": "fr_standard",
          "lines": [
            {
              "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
              "quantity": 1,
              "unit_amount_excl_vat": {
                "amount_minor": 448800,
                "currency": "EUR"
              },
              "total_excl_vat": {
                "amount_minor": 448800,
                "currency": "EUR"
              },
              "vat_rate_bp": 2000,
              "period_start": "2026-12-01T00:00:00Z",
              "period_end": "2027-12-01T00:00:00Z"
            }
          ],
          "total_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "vat_amount": {
            "amount_minor": 89760,
            "currency": "EUR"
          },
          "total_incl_vat": {
            "amount_minor": 538560,
            "currency": "EUR"
          }
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getCreditNote": {
    operationId: "getCreditNote",
    method: "get",
    path: "/credit-notes/{credit_note_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
      "invoice_number": "INV-2026-00142",
      "number": "AV-INV-2026-00007",
      "issued_at": "2026-12-03T10:12:44Z",
      "reason": "customer_cancellation",
      "currency": "EUR",
      "vat_regime": "fr_standard",
      "lines": [
        {
          "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
          "quantity": 1,
          "unit_amount_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "total_excl_vat": {
            "amount_minor": 448800,
            "currency": "EUR"
          },
          "vat_rate_bp": 2000,
          "period_start": "2026-12-01T00:00:00Z",
          "period_end": "2027-12-01T00:00:00Z"
        }
      ],
      "total_excl_vat": {
        "amount_minor": 448800,
        "currency": "EUR"
      },
      "vat_amount": {
        "amount_minor": 89760,
        "currency": "EUR"
      },
      "total_incl_vat": {
        "amount_minor": 538560,
        "currency": "EUR"
      }
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getInvoiceDownloadLink": {
    operationId: "getInvoiceDownloadLink",
    method: "get",
    path: "/invoices/{invoice_id}/download",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "url": "https://s3.fr-par.scw.cloud/kodera-invoices/2026/INV-2026-0142.pdf?X-Amz-Signature=redacted",
      "expires_at": "2026-12-01T10:05:00Z",
      "content_type": "application/pdf",
      "filename": "INV-2026-0142.pdf",
      "sha256": "000000000000000000000000000000000000000000000000000000000000d10c",
      "size_bytes": 48213
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getPaymentLink": {
    operationId: "getPaymentLink",
    method: "get",
    path: "/invoices/{invoice_id}/payment-link",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081",
      "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
      "provider": "stripe",
      "url": "https://pay.example.invalid/xJ8kQ2mR7t",
      "state": "active",
      "amount": {
        "amount_minor": 538560,
        "currency": "EUR"
      },
      "expires_at": "2026-12-31T23:59:59Z",
      "used_at": null,
      "created_at": "2026-12-01T09:42:05Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createPaymentLink": {
    operationId: "createPaymentLink",
    method: "post",
    path: "/invoices/{invoice_id}/payment-link",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081",
      "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
      "provider": "stripe",
      "url": "https://pay.example.invalid/xJ8kQ2mR7t",
      "state": "active",
      "amount": {
        "amount_minor": 538560,
        "currency": "EUR"
      },
      "expires_at": "2026-12-31T23:59:59Z",
      "used_at": null,
      "created_at": "2026-12-01T09:42:05Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "generateDpa": {
    operationId: "generateDpa",
    method: "post",
    path: "/organisations/{organisation_id}/dpa",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "tenant_id": null,
      "version": "2026.11",
      "state": "accepted",
      "locale": "fr",
      "pack_code": "visio-docs",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000d9a",
      "sub_processors": [
        {
          "name": "Scaleway",
          "role": "Hosting and infrastructure",
          "location": "Paris",
          "country": "FR"
        }
      ],
      "annexes": [
        "A",
        "B",
        "C",
        "D"
      ],
      "generated_at": "2026-12-01T09:38:00Z",
      "accepted_at": "2026-12-01T09:40:52Z",
      "accepted_by": {
        "person_id": "11111111-2222-4333-8444-555555555555",
        "name": "Julie Marchand",
        "email": "julie@acme.fr",
        "role_title": "Présidente"
      },
      "superseded_by": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getDpa": {
    operationId: "getDpa",
    method: "get",
    path: "/organisations/{organisation_id}/dpa/{dpa_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "tenant_id": null,
      "version": "2026.11",
      "state": "accepted",
      "locale": "fr",
      "pack_code": "visio-docs",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000d9a",
      "sub_processors": [
        {
          "name": "Scaleway",
          "role": "Hosting and infrastructure",
          "location": "Paris",
          "country": "FR"
        }
      ],
      "annexes": [
        "A",
        "B",
        "C",
        "D"
      ],
      "generated_at": "2026-12-01T09:38:00Z",
      "accepted_at": "2026-12-01T09:40:52Z",
      "accepted_by": {
        "person_id": "11111111-2222-4333-8444-555555555555",
        "name": "Julie Marchand",
        "email": "julie@acme.fr",
        "role_title": "Présidente"
      },
      "superseded_by": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "acceptDpa": {
    operationId: "acceptDpa",
    method: "post",
    path: "/organisations/{organisation_id}/dpa/{dpa_id}/accept",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "tenant_id": null,
      "version": "2026.11",
      "state": "accepted",
      "locale": "fr",
      "pack_code": "visio-docs",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000d9a",
      "sub_processors": [
        {
          "name": "Scaleway",
          "role": "Hosting and infrastructure",
          "location": "Paris",
          "country": "FR"
        }
      ],
      "annexes": [
        "A",
        "B",
        "C",
        "D"
      ],
      "generated_at": "2026-12-01T09:38:00Z",
      "accepted_at": "2026-12-01T09:40:52Z",
      "accepted_by": {
        "person_id": "11111111-2222-4333-8444-555555555555",
        "name": "Julie Marchand",
        "email": "julie@acme.fr",
        "role_title": "Présidente"
      },
      "superseded_by": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getDpaPdfLink": {
    operationId: "getDpaPdfLink",
    method: "get",
    path: "/organisations/{organisation_id}/dpa/{dpa_id}/pdf",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "url": "https://s3.fr-par.scw.cloud/kodera-invoices/2026/INV-2026-0142.pdf?X-Amz-Signature=redacted",
      "expires_at": "2026-12-01T10:05:00Z",
      "content_type": "application/pdf",
      "filename": "INV-2026-0142.pdf",
      "sha256": "000000000000000000000000000000000000000000000000000000000000d10c",
      "size_bytes": 48213
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listTenants": {
    operationId: "listTenants",
    method: "get",
    path: "/organisations/{organisation_id}/tenants",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "slug": "acme",
          "name": "ACME",
          "status": "active",
          "status_changed_at": "2026-12-02T16:04:00Z",
          "pack_code": "visio-docs",
          "capacity_tier_code": "M",
          "apps": [
            "visio",
            "docs"
          ],
          "region": "fr-par",
          "realm": "acme-sa",
          "profile_ref": "visio-docs/1.4",
          "profile_commit": "000000000000000000000000000000000000c0de",
          "instance_id": "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b",
          "default_urls": {
            "visio": "https://acme.visio.kodera.io",
            "docs": "https://acme.docs.kodera.io"
          },
          "observed": {
            "last_heartbeat_at": "2026-12-03T11:19:42Z",
            "heartbeat_seq": 84213,
            "stale": false,
            "agent_version": "0.4.2",
            "profile": {
              "app": "visio-docs",
              "version": "1.4",
              "compose_digest": "sha256:000000000000000000000000000000000000000000000000000000000000d16e"
            },
            "drift_detected_at": null,
            "drift_summary": null,
            "maintenance": false
          },
          "locale": "fr",
          "created_at": "2026-12-01T09:41:07Z",
          "updated_at": "2026-12-03T11:19:42Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createTenant": {
    operationId: "createTenant",
    method: "post",
    path: "/organisations/{organisation_id}/tenants",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/tenants/2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b"
    },
    body: {
      "tenant": {
        "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
        "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
        "slug": "acme",
        "name": "ACME",
        "status": "ordered",
        "status_changed_at": "2026-12-02T16:04:00Z",
        "pack_code": "workspace",
        "capacity_tier_code": "S",
        "apps": [
          "visio",
          "messaging"
        ],
        "region": "fr-par",
        "realm": "acme-sa",
        "profile_ref": "workspace/1.0",
        "locale": "fr",
        "created_at": "2026-12-02T16:04:00Z",
        "updated_at": "2026-12-02T16:04:00Z"
      },
      "workspace_id": "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getTenant": {
    operationId: "getTenant",
    method: "get",
    path: "/tenants/{tenant_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "slug": "acme",
      "name": "ACME",
      "status": "active",
      "status_changed_at": "2026-12-02T16:04:00Z",
      "pack_code": "visio-docs",
      "capacity_tier_code": "M",
      "apps": [
        "visio",
        "docs"
      ],
      "region": "fr-par",
      "realm": "acme-sa",
      "profile_ref": "visio-docs/1.4",
      "profile_commit": "000000000000000000000000000000000000c0de",
      "instance_id": "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b",
      "default_urls": {
        "visio": "https://acme.visio.kodera.io",
        "docs": "https://acme.docs.kodera.io"
      },
      "observed": {
        "last_heartbeat_at": "2026-12-03T11:19:42Z",
        "heartbeat_seq": 84213,
        "stale": false,
        "agent_version": "0.4.2",
        "profile": {
          "app": "visio-docs",
          "version": "1.4",
          "compose_digest": "sha256:000000000000000000000000000000000000000000000000000000000000d16e"
        },
        "drift_detected_at": null,
        "drift_summary": null,
        "maintenance": false
      },
      "locale": "fr",
      "created_at": "2026-12-01T09:41:07Z",
      "updated_at": "2026-12-03T11:19:42Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getTenantStatus": {
    operationId: "getTenantStatus",
    method: "get",
    path: "/tenants/{tenant_id}/status",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "status": "active",
      "status_changed_at": "2026-12-02T16:04:00Z",
      "message_key": "status.tenant.active",
      "provisioning_steps": [
        {
          "key": "preflight",
          "customer_label_key": "accounts",
          "title": "Preflight config, stack and public",
          "status": "succeeded",
          "started_at": "2026-12-02T15:58:10Z",
          "ended_at": "2026-12-02T16:03:41Z",
          "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
          "detail": "14 checks green, including no credential on this host resolves outside project acme."
        }
      ],
      "current_job": null,
      "apps": [
        {
          "code": "visio",
          "name": "Visio",
          "url": "https://visio.acme.fr",
          "default_url": "https://acme.visio.kodera.io",
          "custom_domain": "visio.acme.fr",
          "state": "live",
          "version": "1.4"
        }
      ],
      "capacity": {
        "seats": {
          "used": 118,
          "included": 150,
          "pct": 78.7
        },
        "participants": {
          "used": 46,
          "included": 50,
          "pct": 92
        },
        "storage": {
          "used": 429496729600,
          "included": 536870912000,
          "pct": 80
        },
        "threshold_pct": 90,
        "upgrade_prompt": true,
        "suggested_capacity_tier_code": "L",
        "measured_at": "2026-12-03T11:19:42Z"
      },
      "components": [
        {
          "id": "0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f",
          "scope": "tenant",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "key": "calls",
          "name": "Calls",
          "state": "degraded",
          "since": "2026-12-03T10:58:00Z",
          "message_key": "status.calls.degraded",
          "incident_ref": "INC-2026-014"
        }
      ],
      "agent": {
        "stale": false,
        "last_heartbeat_at": "2026-12-03T11:19:42Z",
        "agent_version": "0.4.2",
        "maintenance": false
      },
      "domains": [
        {
          "id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "fqdn": "visio.acme.fr",
          "kind": "subdomain",
          "role": "web",
          "app": "visio",
          "state": "dns_pending",
          "is_canonical": false,
          "verification": {
            "record_name": "_kodera-verify.visio.acme.fr",
            "record_type": "TXT",
            "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
            "issued_at": "2026-12-03T09:00:00Z",
            "verified_at": "2026-12-03T09:14:22Z",
            "checked_at": "2026-12-03T09:31:05Z",
            "attempts": 3,
            "failure_code": null,
            "resolvers_agreeing": 3
          },
          "target": {
            "record_name": "visio.acme.fr",
            "record_type": "CNAME",
            "record_value": "acme.visio.kodera.io.",
            "observed_value": null
          },
          "certificate": null,
          "created_at": "2026-12-03T08:59:58Z",
          "updated_at": "2026-12-03T09:31:05Z"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listDomains": {
    operationId: "listDomains",
    method: "get",
    path: "/tenants/{tenant_id}/domains",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "fqdn": "visio.acme.fr",
          "kind": "subdomain",
          "role": "web",
          "app": "visio",
          "state": "dns_pending",
          "is_canonical": false,
          "verification": {
            "record_name": "_kodera-verify.visio.acme.fr",
            "record_type": "TXT",
            "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
            "issued_at": "2026-12-03T09:00:00Z",
            "verified_at": "2026-12-03T09:14:22Z",
            "checked_at": "2026-12-03T09:31:05Z",
            "attempts": 3,
            "failure_code": null,
            "resolvers_agreeing": 3
          },
          "target": {
            "record_name": "visio.acme.fr",
            "record_type": "CNAME",
            "record_value": "acme.visio.kodera.io.",
            "observed_value": null
          },
          "certificate": null,
          "created_at": "2026-12-03T08:59:58Z",
          "updated_at": "2026-12-03T09:31:05Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "addDomain": {
    operationId: "addDomain",
    method: "post",
    path: "/tenants/{tenant_id}/domains",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/domains/b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c"
    },
    body: {
      "id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "fqdn": "visio.acme.fr",
      "kind": "subdomain",
      "role": "web",
      "app": "visio",
      "state": "dns_pending",
      "is_canonical": false,
      "verification": {
        "record_name": "_kodera-verify.visio.acme.fr",
        "record_type": "TXT",
        "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
        "issued_at": "2026-12-03T09:00:00Z",
        "verified_at": "2026-12-03T09:14:22Z",
        "checked_at": "2026-12-03T09:31:05Z",
        "attempts": 3,
        "failure_code": null,
        "resolvers_agreeing": 3
      },
      "target": {
        "record_name": "visio.acme.fr",
        "record_type": "CNAME",
        "record_value": "acme.visio.kodera.io.",
        "observed_value": null
      },
      "certificate": null,
      "created_at": "2026-12-03T08:59:58Z",
      "updated_at": "2026-12-03T09:31:05Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getDomain": {
    operationId: "getDomain",
    method: "get",
    path: "/domains/{domain_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "fqdn": "visio.acme.fr",
      "kind": "subdomain",
      "role": "web",
      "app": "visio",
      "state": "dns_pending",
      "is_canonical": false,
      "verification": {
        "record_name": "_kodera-verify.visio.acme.fr",
        "record_type": "TXT",
        "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
        "issued_at": "2026-12-03T09:00:00Z",
        "verified_at": "2026-12-03T09:14:22Z",
        "checked_at": "2026-12-03T09:31:05Z",
        "attempts": 3,
        "failure_code": null,
        "resolvers_agreeing": 3
      },
      "target": {
        "record_name": "visio.acme.fr",
        "record_type": "CNAME",
        "record_value": "acme.visio.kodera.io.",
        "observed_value": null
      },
      "certificate": null,
      "created_at": "2026-12-03T08:59:58Z",
      "updated_at": "2026-12-03T09:31:05Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "patchDomain": {
    operationId: "patchDomain",
    method: "patch",
    path: "/domains/{domain_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "fqdn": "visio.acme.fr",
      "kind": "subdomain",
      "role": "web",
      "app": "visio",
      "state": "dns_pending",
      "is_canonical": false,
      "verification": {
        "record_name": "_kodera-verify.visio.acme.fr",
        "record_type": "TXT",
        "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
        "issued_at": "2026-12-03T09:00:00Z",
        "verified_at": "2026-12-03T09:14:22Z",
        "checked_at": "2026-12-03T09:31:05Z",
        "attempts": 3,
        "failure_code": null,
        "resolvers_agreeing": 3
      },
      "target": {
        "record_name": "visio.acme.fr",
        "record_type": "CNAME",
        "record_value": "acme.visio.kodera.io.",
        "observed_value": null
      },
      "certificate": null,
      "created_at": "2026-12-03T08:59:58Z",
      "updated_at": "2026-12-03T09:31:05Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "deleteDomain": {
    operationId: "deleteDomain",
    method: "delete",
    path: "/domains/{domain_id}",
    status: 202,
    headers: {
      "Location": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "kind": "realm_update",
      "status": "queued",
      "job_url": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "verifyDomain": {
    operationId: "verifyDomain",
    method: "post",
    path: "/domains/{domain_id}/actions/verify",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    body: {
      "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "kind": "realm_update",
      "status": "queued",
      "job_url": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "createCommunitySupportTicket": {
    operationId: "createCommunitySupportTicket",
    method: "post",
    path: "/community/support/tickets",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "11111111-1111-4111-8111-111111111111",
      "state": "open",
      "priority": "P1",
      "queue": "identity-access",
      "confirmation": "ticket-created"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "createBugReport": {
    operationId: "createBugReport",
    method: "post",
    path: "/organisations/{organisation_id}/support/bug-reports",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "01900000-0000-7000-8000-000000000099",
      "status": "queued",
      "dedup_fingerprint": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "occurrences": 1,
      "created_at": "2026-11-23T00:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listSupportTickets": {
    operationId: "listSupportTickets",
    method: "get",
    path: "/support/tickets",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "subject": "Participants dropped from the call after ten minutes",
          "category": "calls",
          "severity": "degraded",
          "state": "open",
          "sla": {
            "support_tier": "standard",
            "first_response_target_minutes": 240,
            "first_response_due_at": "2026-12-03T15:31:00Z",
            "first_response_at": null,
            "next_response_due_at": "2026-12-03T15:31:00Z",
            "business_hours_label": "09:00-18:00 Europe/Paris, lundi au vendredi"
          },
          "tenant_context": {
            "tenant_slug": "acme",
            "tenant_status": "active",
            "pack_code": "visio-docs",
            "capacity_tier_code": "M",
            "agent_stale": false,
            "open_incident_component_keys": [
              "calls"
            ],
            "last_job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
          },
          "message_count": 1,
          "last_message_at": "2026-12-03T11:31:00Z",
          "created_by": "11111111-2222-4333-8444-555555555555",
          "external_ref": "ZMD-4471",
          "created_at": "2026-12-03T11:31:00Z",
          "updated_at": "2026-12-03T11:31:02Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createSupportTicket": {
    operationId: "createSupportTicket",
    method: "post",
    path: "/support/tickets",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/support/tickets/f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c"
    },
    body: {
      "id": "f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "subject": "Participants dropped from the call after ten minutes",
      "category": "calls",
      "severity": "degraded",
      "state": "open",
      "sla": {
        "support_tier": "standard",
        "first_response_target_minutes": 240,
        "first_response_due_at": "2026-12-03T15:31:00Z",
        "first_response_at": null,
        "next_response_due_at": "2026-12-03T15:31:00Z",
        "business_hours_label": "09:00-18:00 Europe/Paris, lundi au vendredi"
      },
      "tenant_context": {
        "tenant_slug": "acme",
        "tenant_status": "active",
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "agent_stale": false,
        "open_incident_component_keys": [
          "calls"
        ],
        "last_job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
      },
      "message_count": 1,
      "last_message_at": "2026-12-03T11:31:00Z",
      "created_by": "11111111-2222-4333-8444-555555555555",
      "external_ref": "ZMD-4471",
      "created_at": "2026-12-03T11:31:00Z",
      "updated_at": "2026-12-03T11:31:02Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getSupportTicket": {
    operationId: "getSupportTicket",
    method: "get",
    path: "/support/tickets/{ticket_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "subject": "Participants dropped from the call after ten minutes",
      "category": "calls",
      "severity": "degraded",
      "state": "open",
      "sla": {
        "support_tier": "standard",
        "first_response_target_minutes": 240,
        "first_response_due_at": "2026-12-03T15:31:00Z",
        "first_response_at": null,
        "next_response_due_at": "2026-12-03T15:31:00Z",
        "business_hours_label": "09:00-18:00 Europe/Paris, lundi au vendredi"
      },
      "tenant_context": {
        "tenant_slug": "acme",
        "tenant_status": "active",
        "pack_code": "visio-docs",
        "capacity_tier_code": "M",
        "agent_stale": false,
        "open_incident_component_keys": [
          "calls"
        ],
        "last_job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
      },
      "message_count": 1,
      "last_message_at": "2026-12-03T11:31:00Z",
      "created_by": "11111111-2222-4333-8444-555555555555",
      "external_ref": "ZMD-4471",
      "created_at": "2026-12-03T11:31:00Z",
      "updated_at": "2026-12-03T11:31:02Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listStatusComponents": {
    operationId: "listStatusComponents",
    method: "get",
    path: "/status/components",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f",
          "scope": "tenant",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "key": "calls",
          "name": "Calls",
          "state": "degraded",
          "since": "2026-12-03T10:58:00Z",
          "message_key": "status.calls.degraded",
          "incident_ref": "INC-2026-014"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listJobs": {
    operationId: "listJobs",
    method: "get",
    path: "/jobs",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "kind": "provision",
          "status": "succeeded",
          "idempotency_key": "0000000000000000000000000000000000000000000000000000000000000001",
          "desired_spec_hash": "00000000000000000000000000000000000000000000000000000000000005ec",
          "attempt": 1,
          "lease_expires_at": null,
          "steps": [
            {
              "index": 8,
              "key": "preflight",
              "title": "Run preflight config, stack and public",
              "status": "succeeded",
              "attempt": 1,
              "started_at": "2026-12-02T15:58:10Z",
              "ended_at": "2026-12-02T16:03:41Z",
              "output_ref": "jobs/8b1f6d2e/steps/08-preflight.log",
              "error_code": null
            }
          ],
          "progress_pct": 100,
          "actor": {
            "type": "staff",
            "id": "sylvain",
            "email": "sylvain@kodera.io"
          },
          "parent_job_id": null,
          "error": null,
          "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
          "created_at": "2026-12-02T15:31:00Z",
          "started_at": "2026-12-02T15:31:04Z",
          "ended_at": "2026-12-02T16:04:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getJob": {
    operationId: "getJob",
    method: "get",
    path: "/jobs/{job_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "kind": "provision",
      "status": "succeeded",
      "idempotency_key": "0000000000000000000000000000000000000000000000000000000000000001",
      "desired_spec_hash": "00000000000000000000000000000000000000000000000000000000000005ec",
      "attempt": 1,
      "lease_expires_at": null,
      "steps": [
        {
          "index": 8,
          "key": "preflight",
          "title": "Run preflight config, stack and public",
          "status": "succeeded",
          "attempt": 1,
          "started_at": "2026-12-02T15:58:10Z",
          "ended_at": "2026-12-02T16:03:41Z",
          "output_ref": "jobs/8b1f6d2e/steps/08-preflight.log",
          "error_code": null
        }
      ],
      "progress_pct": 100,
      "actor": {
        "type": "staff",
        "id": "sylvain",
        "email": "sylvain@kodera.io"
      },
      "parent_job_id": null,
      "error": null,
      "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "created_at": "2026-12-02T15:31:00Z",
      "started_at": "2026-12-02T15:31:04Z",
      "ended_at": "2026-12-02T16:04:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "triggerTenantJob": {
    operationId: "triggerTenantJob",
    method: "post",
    path: "/tenants/{tenant_id}/jobs",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    body: {
      "id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "kind": "provision",
      "status": "succeeded",
      "idempotency_key": "0000000000000000000000000000000000000000000000000000000000000001",
      "desired_spec_hash": "00000000000000000000000000000000000000000000000000000000000005ec",
      "attempt": 1,
      "lease_expires_at": null,
      "steps": [
        {
          "index": 8,
          "key": "preflight",
          "title": "Run preflight config, stack and public",
          "status": "succeeded",
          "attempt": 1,
          "started_at": "2026-12-02T15:58:10Z",
          "ended_at": "2026-12-02T16:03:41Z",
          "output_ref": "jobs/8b1f6d2e/steps/08-preflight.log",
          "error_code": null
        }
      ],
      "progress_pct": 100,
      "actor": {
        "type": "staff",
        "id": "sylvain",
        "email": "sylvain@kodera.io"
      },
      "parent_job_id": null,
      "error": null,
      "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "created_at": "2026-12-02T15:31:00Z",
      "started_at": "2026-12-02T15:31:04Z",
      "ended_at": "2026-12-02T16:04:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getInstanceLogs": {
    operationId: "getInstanceLogs",
    method: "get",
    path: "/instances/{instance_id}/logs",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "at": "2026-12-02T16:03:41Z",
          "level": "info",
          "unit": "kodera-preflight",
          "command_id": "c0ffee00-1111-4222-8333-444455556666",
          "log_ref": "commands/c0ffee00/preflight.log",
          "message": "preflight public: 14 checks, 14 green"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listAuditEvents": {
    operationId: "listAuditEvents",
    method: "get",
    path: "/audit-events",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "aa11bb22-cc33-4d44-8e55-ff6600771188",
          "occurred_at": "2026-12-02T15:31:00Z",
          "action": "tenant.provision_requested",
          "actor": {
            "type": "staff",
            "id": "sylvain",
            "email": "sylvain@kodera.io",
            "realm": "kodera-staff",
            "ip": "192.0.2.0",
            "user_agent": "Mozilla/5.0"
          },
          "target": {
            "type": "tenant",
            "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b"
          },
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
          "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
          "outcome": "success",
          "metadata": {
            "pack_code": "visio-docs",
            "capacity_tier_code": "M"
          }
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createAgentEnrolmentToken": {
    operationId: "createAgentEnrolmentToken",
    method: "post",
    path: "/tenants/{tenant_id}/agent-enrolment-tokens",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "1a2b3c4d-5e6f-4708-8192-a3b4c5d6e7f8",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "instance_id": "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b",
      "secret": "aen_EXAMPLE00000000000000000000000",
      "credential": "mtls",
      "agent_api_url": "https://agent.kodera.io/agent/v1",
      "ca_fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000cae",
      "fingerprint": "8c0e2b4d6f8a0c2e",
      "expires_at": "2026-12-02T16:30:00Z",
      "created_by": "sylvain",
      "created_at": "2026-12-02T15:30:12Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "checkSlugAvailability": {
    operationId: "checkSlugAvailability",
    method: "get",
    path: "/slug-availability",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "slug": "acme",
      "available": false,
      "reason": "taken",
      "suggestions": [
        "acme-fr",
        "acme-group",
        "acme-2027"
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listLegalDocuments": {
    operationId: "listLegalDocuments",
    method: "get",
    path: "/legal-documents",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "code": "sla",
          "version": "2026.11",
          "locale": "fr",
          "title": "Engagements de service",
          "pack_code": "visio-docs",
          "html_url": "https://kodera.io/legal/sla/2026.11",
          "text_url": "https://api.kodera.io/api/v1/legal-documents/sla/2026.11/fr",
          "sha256": "0000000000000000000000000000000000000000000000000000000000001e9a",
          "download": null,
          "published_at": "2026-11-02T09:00:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getLegalDocumentText": {
    operationId: "getLegalDocumentText",
    method: "get",
    path: "/legal-documents/{code}/{version}/{locale}",
    status: 200,
    headers: {
      "Content-Type": "text/plain",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: "# Conditions générales de vente\n\n## Article 1 — Parties et objet\n",
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listEntitlements": {
    operationId: "listEntitlements",
    method: "get",
    path: "/organisations/{organisation_id}/entitlements",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "code": "federation",
          "enabled": false,
          "required_pack_code": "visio-docs-pro",
          "required_capacity_tier_code": null,
          "limit": null,
          "used": null
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getOrganisationStatusSummary": {
    operationId: "getOrganisationStatusSummary",
    method: "get",
    path: "/organisations/{organisation_id}/status-summary",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "billing_enabled": true,
      "workspace_pack_code": null,
      "overall": "degraded",
      "components": [
        {
          "id": "0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f",
          "scope": "tenant",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "key": "calls",
          "name": "Calls",
          "state": "degraded",
          "since": "2026-12-03T10:58:00Z",
          "message_key": "status.calls.degraded",
          "incident_ref": "INC-2026-014"
        }
      ],
      "capacity": null,
      "billing": {
        "dunning_state": "current",
        "oldest_overdue_invoice_id": null,
        "amount_due": null
      },
      "maintenance": null,
      "open_incident_ids": [
        "3c4d5e6f-7a8b-49c0-8d1e-2f3a4b5c6d7e"
      ],
      "measured_at": "2026-12-03T11:19:42Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getDunning": {
    operationId: "getDunning",
    method: "get",
    path: "/organisations/{organisation_id}/dunning",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "state": "notice",
      "ladder": "invoice",
      "oldest_overdue_invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
      "days_overdue": 12,
      "amount_due": {
        "amount_minor": 538560,
        "currency": "EUR"
      },
      "hold_until": null,
      "steps": [
        {
          "state": "past_due",
          "due_at": "2027-01-01T00:00:00Z",
          "done": true,
          "message_key": "dunning.past_due"
        },
        {
          "state": "notice",
          "due_at": "2027-01-08T00:00:00Z",
          "done": true,
          "message_key": "dunning.notice"
        },
        {
          "state": "formal_notice",
          "due_at": "2027-02-05T00:00:00Z",
          "done": false,
          "message_key": "dunning.formal_notice"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "countMemberships": {
    operationId: "countMemberships",
    method: "get",
    path: "/organisations/{organisation_id}/memberships/count",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "count": 118,
      "counted_at": "2026-12-03T11:19:42Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "revokeInvitation": {
    operationId: "revokeInvitation",
    method: "delete",
    path: "/invitations/{invitation_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "resendInvitation": {
    operationId: "resendInvitation",
    method: "post",
    path: "/invitations/{invitation_id}/actions/resend",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "5d4c3b2a-1908-4776-8564-3a2b1c0d9e8f",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "email": "marc@acme.fr",
      "role": "org_member",
      "state": "pending",
      "realm": "acme-sa",
      "invited_by": "11111111-2222-4333-8444-555555555555",
      "expires_at": "2026-12-08T09:00:00Z",
      "accepted_at": null,
      "membership_id": null,
      "sent_count": 1,
      "last_sent_at": "2026-12-01T09:00:00Z",
      "created_at": "2026-12-01T09:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listMemberImports": {
    operationId: "listMemberImports",
    method: "get",
    path: "/organisations/{organisation_id}/member-imports",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
          "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
          "state": "partially_failed",
          "filename": "equipe.csv",
          "row_count": 124,
          "has_header_row": true,
          "detected_columns": [
            {
              "index": 0,
              "header": "Prénom",
              "sample": "Julie"
            },
            {
              "index": 1,
              "header": "Nom",
              "sample": "Marchand"
            },
            {
              "index": 2,
              "header": "Email",
              "sample": "julie@acme.fr"
            }
          ],
          "column_mapping": {
            "email": 2,
            "given_name": 0,
            "family_name": 1,
            "role": null
          },
          "default_role": "org_member",
          "summary": {
            "ready": 118,
            "already_member": 4,
            "already_invited": 0,
            "duplicate": 2,
            "invalid": 0,
            "invited": 114,
            "failed": 4
          },
          "seats_used_after": 118,
          "seats_included": 150,
          "rows": [
            {
              "line": 27,
              "email": "paul@acme.fr",
              "role": "org_member",
              "status": "failed",
              "reason_code": "mail_provider_rejected",
              "invitation_id": null
            }
          ],
          "created_by": "11111111-2222-4333-8444-555555555555",
          "staging_expires_at": "2026-12-10T10:02:00Z",
          "created_at": "2026-12-03T10:02:00Z",
          "updated_at": "2026-12-03T10:06:41Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createMemberImport": {
    operationId: "createMemberImport",
    method: "post",
    path: "/organisations/{organisation_id}/member-imports",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/member-imports/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d"
    },
    body: {
      "id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "state": "partially_failed",
      "filename": "equipe.csv",
      "row_count": 124,
      "has_header_row": true,
      "detected_columns": [
        {
          "index": 0,
          "header": "Prénom",
          "sample": "Julie"
        },
        {
          "index": 1,
          "header": "Nom",
          "sample": "Marchand"
        },
        {
          "index": 2,
          "header": "Email",
          "sample": "julie@acme.fr"
        }
      ],
      "column_mapping": {
        "email": 2,
        "given_name": 0,
        "family_name": 1,
        "role": null
      },
      "default_role": "org_member",
      "summary": {
        "ready": 118,
        "already_member": 4,
        "already_invited": 0,
        "duplicate": 2,
        "invalid": 0,
        "invited": 114,
        "failed": 4
      },
      "seats_used_after": 118,
      "seats_included": 150,
      "rows": [
        {
          "line": 27,
          "email": "paul@acme.fr",
          "role": "org_member",
          "status": "failed",
          "reason_code": "mail_provider_rejected",
          "invitation_id": null
        }
      ],
      "created_by": "11111111-2222-4333-8444-555555555555",
      "staging_expires_at": "2026-12-10T10:02:00Z",
      "created_at": "2026-12-03T10:02:00Z",
      "updated_at": "2026-12-03T10:06:41Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getMemberImport": {
    operationId: "getMemberImport",
    method: "get",
    path: "/member-imports/{member_import_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "state": "partially_failed",
      "filename": "equipe.csv",
      "row_count": 124,
      "has_header_row": true,
      "detected_columns": [
        {
          "index": 0,
          "header": "Prénom",
          "sample": "Julie"
        },
        {
          "index": 1,
          "header": "Nom",
          "sample": "Marchand"
        },
        {
          "index": 2,
          "header": "Email",
          "sample": "julie@acme.fr"
        }
      ],
      "column_mapping": {
        "email": 2,
        "given_name": 0,
        "family_name": 1,
        "role": null
      },
      "default_role": "org_member",
      "summary": {
        "ready": 118,
        "already_member": 4,
        "already_invited": 0,
        "duplicate": 2,
        "invalid": 0,
        "invited": 114,
        "failed": 4
      },
      "seats_used_after": 118,
      "seats_included": 150,
      "rows": [
        {
          "line": 27,
          "email": "paul@acme.fr",
          "role": "org_member",
          "status": "failed",
          "reason_code": "mail_provider_rejected",
          "invitation_id": null
        }
      ],
      "created_by": "11111111-2222-4333-8444-555555555555",
      "staging_expires_at": "2026-12-10T10:02:00Z",
      "created_at": "2026-12-03T10:02:00Z",
      "updated_at": "2026-12-03T10:06:41Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "patchMemberImport": {
    operationId: "patchMemberImport",
    method: "patch",
    path: "/member-imports/{member_import_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
      "state": "partially_failed",
      "filename": "equipe.csv",
      "row_count": 124,
      "has_header_row": true,
      "detected_columns": [
        {
          "index": 0,
          "header": "Prénom",
          "sample": "Julie"
        },
        {
          "index": 1,
          "header": "Nom",
          "sample": "Marchand"
        },
        {
          "index": 2,
          "header": "Email",
          "sample": "julie@acme.fr"
        }
      ],
      "column_mapping": {
        "email": 2,
        "given_name": 0,
        "family_name": 1,
        "role": null
      },
      "default_role": "org_member",
      "summary": {
        "ready": 118,
        "already_member": 4,
        "already_invited": 0,
        "duplicate": 2,
        "invalid": 0,
        "invited": 114,
        "failed": 4
      },
      "seats_used_after": 118,
      "seats_included": 150,
      "rows": [
        {
          "line": 27,
          "email": "paul@acme.fr",
          "role": "org_member",
          "status": "failed",
          "reason_code": "mail_provider_rejected",
          "invitation_id": null
        }
      ],
      "created_by": "11111111-2222-4333-8444-555555555555",
      "staging_expires_at": "2026-12-10T10:02:00Z",
      "created_at": "2026-12-03T10:02:00Z",
      "updated_at": "2026-12-03T10:06:41Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "deleteMemberImport": {
    operationId: "deleteMemberImport",
    method: "delete",
    path: "/member-imports/{member_import_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "executeMemberImport": {
    operationId: "executeMemberImport",
    method: "post",
    path: "/member-imports/{member_import_id}/actions/execute",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "created": 1,
      "skipped": 1,
      "failed": 0,
      "seats_used_after": 118,
      "seats_included": 150,
      "results": [
        {
          "email": "marc@acme.fr",
          "outcome": "created",
          "invitation": null,
          "detail": null
        },
        {
          "email": "julie@acme.fr",
          "outcome": "already_member",
          "invitation": null,
          "detail": "Already an admin of this organisation."
        }
      ]
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listTenantAvailability": {
    operationId: "listTenantAvailability",
    method: "get",
    path: "/tenants/{tenant_id}/availability",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "date": "2026-12-03",
          "components": [
            {
              "key": "calls",
              "state": "degraded",
              "degraded_minutes": 42,
              "down_minutes": 0
            },
            {
              "key": "web",
              "state": "operational",
              "degraded_minutes": 0,
              "down_minutes": 0
            }
          ]
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listIncidents": {
    operationId: "listIncidents",
    method: "get",
    path: "/status/incidents",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "3c4d5e6f-7a8b-49c0-8d1e-2f3a4b5c6d7e",
          "reference": "INC-2026-014",
          "scope": "tenant",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "state": "open",
          "severity": "major",
          "component_keys": [
            "calls"
          ],
          "title_key": "incident.calls.degraded",
          "impact_key": "incident.impact.calls_drop",
          "started_at": "2026-12-03T10:58:00Z",
          "resolved_at": null,
          "next_update_at": "2026-12-03T12:00:00Z",
          "updates": [
            {
              "at": "2026-12-03T11:05:00Z",
              "body_key": "incident.update.investigating"
            }
          ]
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "reissueDomainNonce": {
    operationId: "reissueDomainNonce",
    method: "post",
    path: "/domains/{domain_id}/actions/reissue-nonce",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    body: {
      "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "kind": "realm_update",
      "status": "queued",
      "job_url": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "activateDomain": {
    operationId: "activateDomain",
    method: "post",
    path: "/domains/{domain_id}/actions/activate",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    body: {
      "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "kind": "realm_update",
      "status": "queued",
      "job_url": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getDomainInstructions": {
    operationId: "getDomainInstructions",
    method: "get",
    path: "/domains/{domain_id}/instructions",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "domain_id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
      "fqdn": "visio.acme.fr",
      "records": [
        {
          "purpose": "ownership",
          "record_type": "TXT",
          "record_name": "_kodera-verify.visio.acme.fr",
          "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
          "ttl_s": 300,
          "published": true
        },
        {
          "purpose": "web_target",
          "record_type": "CNAME",
          "record_name": "visio.acme.fr",
          "record_value": "acme.visio.kodera.io.",
          "ttl_s": 300,
          "published": false
        }
      ],
      "steps": [
        {
          "index": 1,
          "body_key": "domain.instructions.publish_txt",
          "record_purpose": "ownership"
        },
        {
          "index": 2,
          "body_key": "domain.instructions.publish_target",
          "record_purpose": "web_target"
        }
      ],
      "nonce_expires_at": "2026-12-06T09:00:00Z",
      "download": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "shareDomainInstructions": {
    operationId: "shareDomainInstructions",
    method: "post",
    path: "/domains/{domain_id}/instruction-shares",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "6d7e8f90-a1b2-4c3d-8e4f-5a6b7c8d9e0f",
      "recipient_email": "it@acme.fr",
      "sent_at": "2026-12-03T10:02:11Z",
      "sent_by": "11111111-2222-4333-8444-555555555555"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getHelpContext": {
    operationId: "getHelpContext",
    method: "get",
    path: "/support/help-context",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "area": "domain",
      "screen": "verify",
      "articles": [
        {
          "id": "dns-txt",
          "title": "Publier un enregistrement TXT",
          "url": "https://aide.kodera.io/dns-txt"
        }
      ],
      "sla": {
        "support_tier": "standard",
        "first_response_target_minutes": 240,
        "business_hours_label": "09:00-18:00 Europe/Paris, lundi au vendredi",
        "business_hours_timezone": "Europe/Paris",
        "next_response_due_at": "2026-12-03T15:31:00Z"
      },
      "incident": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getTicketContext": {
    operationId: "getTicketContext",
    method: "get",
    path: "/support/ticket-context",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "area": "domain",
      "screen": "verify",
      "items": [
        {
          "code": "organisation",
          "label_key": "support.context.organisation",
          "value_summary": "ACME",
          "removable": false
        },
        {
          "code": "last_request_id",
          "label_key": "support.context.request_id",
          "value_summary": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
          "removable": true
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "reportSignInProblem": {
    operationId: "reportSignInProblem",
    method: "post",
    path: "/support/sign-in-problems",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listTicketMessages": {
    operationId: "listTicketMessages",
    method: "get",
    path: "/support/tickets/{ticket_id}/messages",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "7f8a9b0c-1d2e-4f30-8a41-5b6c7d8e9f01",
          "ticket_id": "f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c",
          "author_kind": "staff",
          "author_name": "Support Kodera",
          "body": "Nous avons identifié la cause et déployons un correctif.",
          "attachments": [],
          "created_at": "2026-12-03T12:04:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "replyToTicket": {
    operationId: "replyToTicket",
    method: "post",
    path: "/support/tickets/{ticket_id}/messages",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "7f8a9b0c-1d2e-4f30-8a41-5b6c7d8e9f01",
      "ticket_id": "f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c",
      "author_kind": "staff",
      "author_name": "Support Kodera",
      "body": "Nous avons identifié la cause et déployons un correctif.",
      "attachments": [],
      "created_at": "2026-12-03T12:04:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "attachToTicket": {
    operationId: "attachToTicket",
    method: "post",
    path: "/support/tickets/{ticket_id}/attachments",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "8a9b0c1d-2e3f-4041-8b52-6c7d8e9f0a12",
      "filename": "capture.png",
      "content_type": "image/png",
      "size_bytes": 184213,
      "state": "available",
      "rejection_code": null,
      "download": null,
      "created_at": "2026-12-03T11:32:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listFederationProviders": {
    operationId: "listFederationProviders",
    method: "get",
    path: "/tenants/{tenant_id}/federation-providers",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
          "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
          "provider": "microsoft",
          "state": "configured",
          "label": "Microsoft ACME",
          "login_mode": "both",
          "allowed_email_domains": [
            "acme.fr"
          ],
          "domain_checks": [
            {
              "domain": "acme.fr",
              "verified": true,
              "checked_at": "2026-12-03T09:14:22Z",
              "failure_code": null
            }
          ],
          "values": {
            "application_name": "Kodera — ACME",
            "redirect_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint",
            "logout_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint/logout",
            "scopes": [
              "openid",
              "profile",
              "email"
            ],
            "account_types_label_key": "federation.microsoft.account_types.single_tenant",
            "issuer_url": "https://login.microsoftonline.com/common/v2.0",
            "entity_id": null,
            "acs_url": null
          },
          "client_id": "4f2a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e",
          "secret_set": true,
          "secret_expires_on": "2027-06-30",
          "last_test": {
            "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
            "result": "failed",
            "at": "2026-12-03T11:02:00Z"
          },
          "hosted_account_count": 14,
          "job_id": null,
          "activated_at": null,
          "disabled_at": null,
          "created_at": "2026-12-03T10:40:00Z",
          "updated_at": "2026-12-03T11:02:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createFederationProvider": {
    operationId: "createFederationProvider",
    method: "post",
    path: "/tenants/{tenant_id}/federation-providers",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/federation-providers/9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20"
    },
    body: {
      "id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "provider": "microsoft",
      "state": "configured",
      "label": "Microsoft ACME",
      "login_mode": "both",
      "allowed_email_domains": [
        "acme.fr"
      ],
      "domain_checks": [
        {
          "domain": "acme.fr",
          "verified": true,
          "checked_at": "2026-12-03T09:14:22Z",
          "failure_code": null
        }
      ],
      "values": {
        "application_name": "Kodera — ACME",
        "redirect_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint",
        "logout_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint/logout",
        "scopes": [
          "openid",
          "profile",
          "email"
        ],
        "account_types_label_key": "federation.microsoft.account_types.single_tenant",
        "issuer_url": "https://login.microsoftonline.com/common/v2.0",
        "entity_id": null,
        "acs_url": null
      },
      "client_id": "4f2a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e",
      "secret_set": true,
      "secret_expires_on": "2027-06-30",
      "last_test": {
        "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
        "result": "failed",
        "at": "2026-12-03T11:02:00Z"
      },
      "hosted_account_count": 14,
      "job_id": null,
      "activated_at": null,
      "disabled_at": null,
      "created_at": "2026-12-03T10:40:00Z",
      "updated_at": "2026-12-03T11:02:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getFederationProvider": {
    operationId: "getFederationProvider",
    method: "get",
    path: "/federation-providers/{federation_provider_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "provider": "microsoft",
      "state": "configured",
      "label": "Microsoft ACME",
      "login_mode": "both",
      "allowed_email_domains": [
        "acme.fr"
      ],
      "domain_checks": [
        {
          "domain": "acme.fr",
          "verified": true,
          "checked_at": "2026-12-03T09:14:22Z",
          "failure_code": null
        }
      ],
      "values": {
        "application_name": "Kodera — ACME",
        "redirect_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint",
        "logout_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint/logout",
        "scopes": [
          "openid",
          "profile",
          "email"
        ],
        "account_types_label_key": "federation.microsoft.account_types.single_tenant",
        "issuer_url": "https://login.microsoftonline.com/common/v2.0",
        "entity_id": null,
        "acs_url": null
      },
      "client_id": "4f2a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e",
      "secret_set": true,
      "secret_expires_on": "2027-06-30",
      "last_test": {
        "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
        "result": "failed",
        "at": "2026-12-03T11:02:00Z"
      },
      "hosted_account_count": 14,
      "job_id": null,
      "activated_at": null,
      "disabled_at": null,
      "created_at": "2026-12-03T10:40:00Z",
      "updated_at": "2026-12-03T11:02:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "patchFederationProvider": {
    operationId: "patchFederationProvider",
    method: "patch",
    path: "/federation-providers/{federation_provider_id}",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
      "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      "provider": "microsoft",
      "state": "configured",
      "label": "Microsoft ACME",
      "login_mode": "both",
      "allowed_email_domains": [
        "acme.fr"
      ],
      "domain_checks": [
        {
          "domain": "acme.fr",
          "verified": true,
          "checked_at": "2026-12-03T09:14:22Z",
          "failure_code": null
        }
      ],
      "values": {
        "application_name": "Kodera — ACME",
        "redirect_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint",
        "logout_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint/logout",
        "scopes": [
          "openid",
          "profile",
          "email"
        ],
        "account_types_label_key": "federation.microsoft.account_types.single_tenant",
        "issuer_url": "https://login.microsoftonline.com/common/v2.0",
        "entity_id": null,
        "acs_url": null
      },
      "client_id": "4f2a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e",
      "secret_set": true,
      "secret_expires_on": "2027-06-30",
      "last_test": {
        "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
        "result": "failed",
        "at": "2026-12-03T11:02:00Z"
      },
      "hosted_account_count": 14,
      "job_id": null,
      "activated_at": null,
      "disabled_at": null,
      "created_at": "2026-12-03T10:40:00Z",
      "updated_at": "2026-12-03T11:02:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "disableFederationProvider": {
    operationId: "disableFederationProvider",
    method: "delete",
    path: "/federation-providers/{federation_provider_id}",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    body: {
      "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "kind": "realm_update",
      "status": "queued",
      "job_url": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "setFederationCredentials": {
    operationId: "setFederationCredentials",
    method: "patch",
    path: "/federation-providers/{federation_provider_id}/credentials",
    status: 200,
    headers: {
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "federation_provider_id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
      "client_id": "4f2a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e",
      "secret_set": true,
      "secret_expires_on": "2027-06-30",
      "state": "configured",
      "updated_at": "2026-12-03T10:52:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "listFederationTests": {
    operationId: "listFederationTests",
    method: "get",
    path: "/federation-providers/{federation_provider_id}/tests",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
          "federation_provider_id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
          "state": "completed",
          "authorization_url": null,
          "result": "failed",
          "subject_email_masked": "m****e@acme.fr",
          "display_name": "Marc Dubois",
          "domain_allowed": true,
          "failure_code": "redirect_uri_mismatch",
          "provider_message_key": "federation.error.redirect_uri_mismatch",
          "started_by": "11111111-2222-4333-8444-555555555555",
          "completed_at": "2026-12-03T11:02:00Z",
          "created_at": "2026-12-03T11:01:12Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "startFederationTest": {
    operationId: "startFederationTest",
    method: "post",
    path: "/federation-providers/{federation_provider_id}/tests",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/federation-tests/a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70"
    },
    body: {
      "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
      "federation_provider_id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
      "state": "completed",
      "authorization_url": null,
      "result": "failed",
      "subject_email_masked": "m****e@acme.fr",
      "display_name": "Marc Dubois",
      "domain_allowed": true,
      "failure_code": "redirect_uri_mismatch",
      "provider_message_key": "federation.error.redirect_uri_mismatch",
      "started_by": "11111111-2222-4333-8444-555555555555",
      "completed_at": "2026-12-03T11:02:00Z",
      "created_at": "2026-12-03T11:01:12Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getFederationTest": {
    operationId: "getFederationTest",
    method: "get",
    path: "/federation-tests/{federation_test_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
      "federation_provider_id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
      "state": "completed",
      "authorization_url": null,
      "result": "failed",
      "subject_email_masked": "m****e@acme.fr",
      "display_name": "Marc Dubois",
      "domain_allowed": true,
      "failure_code": "redirect_uri_mismatch",
      "provider_message_key": "federation.error.redirect_uri_mismatch",
      "started_by": "11111111-2222-4333-8444-555555555555",
      "completed_at": "2026-12-03T11:02:00Z",
      "created_at": "2026-12-03T11:01:12Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "activateFederationProvider": {
    operationId: "activateFederationProvider",
    method: "post",
    path: "/federation-providers/{federation_provider_id}/actions/activate",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "Location": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    body: {
      "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
      "kind": "realm_update",
      "status": "queued",
      "job_url": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getFederationRunbook": {
    operationId: "getFederationRunbook",
    method: "get",
    path: "/federation-providers/{federation_provider_id}/runbook",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "federation_provider_id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
      "provider": "microsoft",
      "locale": "fr",
      "steps": [
        {
          "index": 1,
          "body_key": "federation.microsoft.runbook.open_entra",
          "value_ref": null,
          "caution_key": null
        },
        {
          "index": 2,
          "body_key": "federation.microsoft.runbook.new_registration",
          "value_ref": "application_name",
          "caution_key": null
        },
        {
          "index": 3,
          "body_key": "federation.microsoft.runbook.paste_redirect",
          "value_ref": "redirect_uri",
          "caution_key": "federation.microsoft.runbook.caution_trailing_slash"
        }
      ],
      "estimated_duration_s": 900,
      "download": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "shareFederationRunbook": {
    operationId: "shareFederationRunbook",
    method: "post",
    path: "/federation-providers/{federation_provider_id}/runbook-shares",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "6d7e8f90-a1b2-4c3d-8e4f-5a6b7c8d9e0f",
      "recipient_email": "it@acme.fr",
      "sent_at": "2026-12-03T10:02:11Z",
      "sent_by": "11111111-2222-4333-8444-555555555555"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "moderateWorkspaceMember": {
    operationId: "moderateWorkspaceMember",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/moderation",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "membershipId": "00000000-0000-7000-8000-000000000002",
      "action": "mute",
      "expiresAt": "2026-01-02T12:00:00Z",
      "createdAt": "2026-01-01T12:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "revokeWorkspaceModerator": {
    operationId: "revokeWorkspaceModerator",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/moderators/{membership_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listAbuseReports": {
    operationId: "listAbuseReports",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/reports",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000001",
          "membershipId": "00000000-0000-7000-8000-000000000002",
          "reason": "Unwanted messages",
          "status": "open",
          "resolution": null,
          "createdAt": "2026-01-01T12:00:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createAbuseReport": {
    operationId: "createAbuseReport",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/reports",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "membershipId": "00000000-0000-7000-8000-000000000002",
      "reason": "Unwanted messages",
      "status": "open",
      "resolution": null,
      "createdAt": "2026-01-01T12:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "resolveAbuseReport": {
    operationId: "resolveAbuseReport",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/reports/{report_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "membershipId": "00000000-0000-7000-8000-000000000002",
      "reason": "Unwanted messages",
      "status": "open",
      "resolution": null,
      "createdAt": "2026-01-01T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "listWorkspaceInviteLinks": {
    operationId: "listWorkspaceInviteLinks",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/invite-links",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000001",
          "expiresAt": "2026-01-02T12:00:00Z",
          "maxUses": 10,
          "usesCount": 0,
          "revokedAt": null,
          "channelId": null,
          "role": "org_member"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createWorkspaceInviteLink": {
    operationId: "createWorkspaceInviteLink",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/invite-links",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "link": {
        "id": "00000000-0000-7000-8000-000000000001",
        "expiresAt": "2026-01-02T12:00:00Z",
        "maxUses": 10,
        "usesCount": 0,
        "revokedAt": null,
        "channelId": null,
        "role": "org_member"
      },
      "code": "example-invite-code-do-not-redeem"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "revokeWorkspaceInviteLink": {
    operationId: "revokeWorkspaceInviteLink",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/invite-links/{invite_link_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "previewWorkspaceInvite": {
    operationId: "previewWorkspaceInvite",
    method: "post",
    path: "/workspace-invites/preview",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisationName": "Example workspace",
      "role": "org_member",
      "expiresAt": "2026-01-02T12:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "redeemWorkspaceInvite": {
    operationId: "redeemWorkspaceInvite",
    method: "post",
    path: "/workspace-invites/redeem",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisationId": "00000000-0000-7000-8000-000000000001",
      "membershipId": "00000000-0000-7000-8000-000000000002"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "createAttachmentUpload": {
    operationId: "createAttachmentUpload",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/attachments/uploads",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "attachmentId": "00000000-0000-7000-8000-000000000001",
      "uploadUrl": "https://storage.example.org/upload",
      "method": "PUT",
      "headers": {
        "Content-Type": "image/png"
      },
      "expiresAt": "2026-01-01T12:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "completeAttachmentUpload": {
    operationId: "completeAttachmentUpload",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/attachments/{attachment_id}/complete",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "filename": "example.png",
      "contentType": "image/png",
      "sizeBytes": 1234,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "downloadUrl": "https://storage.example.org/download",
      "expiresAt": "2026-01-01T12:00:00Z",
      "disposition": "inline"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getAttachment": {
    operationId: "getAttachment",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/attachments/{attachment_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "filename": "example.png",
      "contentType": "image/png",
      "sizeBytes": 1234,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "downloadUrl": "https://storage.example.org/download",
      "expiresAt": "2026-01-01T12:00:00Z",
      "disposition": "inline"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "cancelAttachmentUpload": {
    operationId: "cancelAttachmentUpload",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/attachments/{attachment_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "unfurlUrl": {
    operationId: "unfurlUrl",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/unfurl",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "url": "https://example.org/article",
      "canonicalUrl": "https://example.org/article",
      "title": "Example article",
      "description": "A public article.",
      "siteName": "Example"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listNotifications": {
    operationId: "listNotifications",
    method: "get",
    path: "/notifications",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000001",
          "kind": "document",
          "resourceId": "00000000-0000-7000-8000-000000000002",
          "createdAt": "2026-01-01T12:00:00Z",
          "readAt": null
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "markNotificationsRead": {
    operationId: "markNotificationsRead",
    method: "post",
    path: "/notifications/read",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getPushPublicKey": {
    operationId: "getPushPublicKey",
    method: "get",
    path: "/push/public-key",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "publicKey": "example-public-key-placeholder",
      "payloadMode": "empty"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "putNotificationPresence": {
    operationId: "putNotificationPresence",
    method: "put",
    path: "/notifications/presence/{device_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "deviceId": "0195c000-0000-7000-8000-000000000001",
      "platform": "desktop",
      "expiresAt": "2026-11-23T00:01:00Z",
      "ttlSeconds": 60
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "deleteNotificationPresence": {
    operationId: "deleteNotificationPresence",
    method: "delete",
    path: "/notifications/presence/{device_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "putPushSubscription": {
    operationId: "putPushSubscription",
    method: "put",
    path: "/push/subscriptions/{device_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "deletePushSubscription": {
    operationId: "deletePushSubscription",
    method: "delete",
    path: "/push/subscriptions/{device_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listWorkspaceDocuments": {
    operationId: "listWorkspaceDocuments",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/documents",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000001",
          "parentId": null,
          "title": "Example specification",
          "markdown": "# Example specification\n",
          "role": "editor",
          "updatedAt": "2026-01-01T12:00:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createWorkspaceDocument": {
    operationId: "createWorkspaceDocument",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/documents",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "parentId": null,
      "title": "Example specification",
      "markdown": "# Example specification\n",
      "role": "editor",
      "updatedAt": "2026-01-01T12:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getWorkspaceDocument": {
    operationId: "getWorkspaceDocument",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/documents/{document_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "parentId": null,
      "title": "Example specification",
      "markdown": "# Example specification\n",
      "role": "editor",
      "updatedAt": "2026-01-01T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "updateWorkspaceDocument": {
    operationId: "updateWorkspaceDocument",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/documents/{document_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "parentId": null,
      "title": "Example specification",
      "markdown": "# Example specification\n",
      "role": "editor",
      "updatedAt": "2026-01-01T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "deleteWorkspaceDocument": {
    operationId: "deleteWorkspaceDocument",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/documents/{document_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listDocumentRoleGrants": {
    operationId: "listDocumentRoleGrants",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/documents/{document_id}/role-grants",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "Cache-Control": "no-store"
    },
    body: {
      "revision": 2,
      "data": [
        {
          "workspaceRoleId": "00000000-0000-7000-8000-000000000002",
          "name": "Engineering",
          "slug": "engineering",
          "role": "editor"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "putDocumentRoleGrant": {
    operationId: "putDocumentRoleGrant",
    method: "put",
    path: "/organisations/{organisation_id}/workspace/documents/{document_id}/role-grants/{role_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "Cache-Control": "no-store"
    },
    body: {
      "revision": 2,
      "data": [
        {
          "workspaceRoleId": "00000000-0000-7000-8000-000000000002",
          "name": "Engineering",
          "slug": "engineering",
          "role": "editor"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "revokeDocumentRoleGrant": {
    operationId: "revokeDocumentRoleGrant",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/documents/{document_id}/role-grants/{role_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
      "Cache-Control": "no-store"
    },
    body: {
      "revision": 2,
      "data": [
        {
          "workspaceRoleId": "00000000-0000-7000-8000-000000000002",
          "name": "Engineering",
          "slug": "engineering",
          "role": "editor"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "listDocumentBacklinks": {
    operationId: "listDocumentBacklinks",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/documents/{document_id}/backlinks",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "documentId": "00000000-0000-7000-8000-000000000001",
          "title": "Example specification"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createDocumentCollabSession": {
    operationId: "createDocumentCollabSession",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/documents/{document_id}/collab-session",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "wsUrl": "wss://api.example.org/documents/collab",
      "token": "example-ticket-placeholder",
      "expiresAt": "2026-01-01T12:00:00Z",
      "role": "viewer",
      "confidential": false,
      "epoch": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "searchWorkspace": {
    operationId: "searchWorkspace",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/search",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000001",
          "kind": "document",
          "title": "Example specification",
          "excerpt": "Example"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listWorkspaceCollections": {
    operationId: "listWorkspaceCollections",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/collections",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000001",
          "title": "Project tasks",
          "properties": [
            {
              "id": "status",
              "name": "Status",
              "type": "select",
              "options": [
                {
                  "id": "todo",
                  "label": "To do"
                }
              ]
            }
          ],
          "views": [
            {
              "id": "board",
              "name": "Board",
              "type": "board",
              "groupByPropertyId": "status",
              "showEmptyGroups": true
            }
          ],
          "role": "editor",
          "updatedAt": "2026-11-13T12:00:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createWorkspaceCollection": {
    operationId: "createWorkspaceCollection",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/collections",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "title": "Project tasks",
      "properties": [
        {
          "id": "status",
          "name": "Status",
          "type": "select",
          "options": [
            {
              "id": "todo",
              "label": "To do"
            }
          ]
        }
      ],
      "views": [
        {
          "id": "board",
          "name": "Board",
          "type": "board",
          "groupByPropertyId": "status",
          "showEmptyGroups": true
        }
      ],
      "role": "editor",
      "updatedAt": "2026-11-13T12:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getWorkspaceCollection": {
    operationId: "getWorkspaceCollection",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/collections/{collection_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "title": "Project tasks",
      "properties": [
        {
          "id": "status",
          "name": "Status",
          "type": "select",
          "options": [
            {
              "id": "todo",
              "label": "To do"
            }
          ]
        }
      ],
      "views": [
        {
          "id": "board",
          "name": "Board",
          "type": "board",
          "groupByPropertyId": "status",
          "showEmptyGroups": true
        }
      ],
      "role": "editor",
      "updatedAt": "2026-11-13T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "updateWorkspaceCollection": {
    operationId: "updateWorkspaceCollection",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/collections/{collection_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "title": "Project tasks",
      "properties": [
        {
          "id": "status",
          "name": "Status",
          "type": "select",
          "options": [
            {
              "id": "todo",
              "label": "To do"
            }
          ]
        }
      ],
      "views": [
        {
          "id": "board",
          "name": "Board",
          "type": "board",
          "groupByPropertyId": "status",
          "showEmptyGroups": true
        }
      ],
      "role": "editor",
      "updatedAt": "2026-11-13T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "deleteWorkspaceCollection": {
    operationId: "deleteWorkspaceCollection",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/collections/{collection_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "queryWorkspaceCollection": {
    operationId: "queryWorkspaceCollection",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/collections/{collection_id}/query",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "documentId": "00000000-0000-7000-8000-000000000001",
          "values": {
            "status": {
              "type": "select",
              "value": "todo"
            }
          },
          "updatedAt": "2026-11-13T12:00:00Z"
        }
      ],
      "next_cursor": null,
      "has_more": false
    },
    isList: true,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getWorkspaceCollectionRow": {
    operationId: "getWorkspaceCollectionRow",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "documentId": "00000000-0000-7000-8000-000000000001",
      "values": {
        "status": {
          "type": "select",
          "value": "todo"
        }
      },
      "updatedAt": "2026-11-13T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "putWorkspaceCollectionRow": {
    operationId: "putWorkspaceCollectionRow",
    method: "put",
    path: "/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "documentId": "00000000-0000-7000-8000-000000000001",
      "values": {
        "status": {
          "type": "select",
          "value": "todo"
        }
      },
      "updatedAt": "2026-11-13T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
    conditionalWrite: true,
  },
  "deleteWorkspaceCollectionRow": {
    operationId: "deleteWorkspaceCollectionRow",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/collections/{collection_id}/rows/{document_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getWorkspaceQuotaUsage": {
    operationId: "getWorkspaceQuotaUsage",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/quotas/usage",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "usage": {
        "seats": 4,
        "mediaBytes": 1024,
        "pages": 12
      },
      "limits": {
        "seats": 10,
        "mediaBytes": 1073741824,
        "pages": 100
      },
      "measuredAt": "2026-11-13T12:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getWorkspaceQuotaLimits": {
    operationId: "getWorkspaceQuotaLimits",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/quotas/limits",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "seats": 10,
      "mediaBytes": 1073741824,
      "pages": 100
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getCreditNoteDownloadLink": {
    operationId: "getCreditNoteDownloadLink",
    method: "get",
    path: "/credit-notes/{credit_note_id}/download",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "url": "https://s3.fr-par.scw.cloud/kodera-invoices/2026/INV-2026-0142.pdf?X-Amz-Signature=redacted",
      "expires_at": "2026-12-01T10:05:00Z",
      "content_type": "application/pdf",
      "filename": "INV-2026-0142.pdf",
      "sha256": "000000000000000000000000000000000000000000000000000000000000d10c",
      "size_bytes": 48213
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getBillingVatStatus": {
    operationId: "getBillingVatStatus",
    method: "get",
    path: "/organisations/{organisation_id}/billing/vat-status",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "vat_number": null,
      "country_code": null,
      "status": "not_checked",
      "checked_at": null,
      "next_check_at": null,
      "evidence_id": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "validateBillingVat": {
    operationId: "validateBillingVat",
    method: "post",
    path: "/organisations/{organisation_id}/billing/vat-status",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "vat_number": null,
      "country_code": null,
      "status": "not_checked",
      "checked_at": null,
      "next_check_at": null,
      "evidence_id": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "requestWorkspaceExport": {
    operationId: "requestWorkspaceExport",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/privacy/exports",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "scope": "workspace",
      "kind": "export",
      "status": "queued",
      "requestedAt": "2026-11-13T12:00:00Z",
      "updatedAt": "2026-11-13T12:00:00Z",
      "expiresAt": null,
      "purgeAfter": null,
      "failureCode": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getWorkspaceExport": {
    operationId: "getWorkspaceExport",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/privacy/exports/{request_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "scope": "workspace",
      "kind": "export",
      "status": "queued",
      "requestedAt": "2026-11-13T12:00:00Z",
      "updatedAt": "2026-11-13T12:00:00Z",
      "expiresAt": null,
      "purgeAfter": null,
      "failureCode": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getWorkspaceExportDownloadLink": {
    operationId: "getWorkspaceExportDownloadLink",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/privacy/exports/{request_id}/download",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "url": "https://s3.fr-par.scw.cloud/kodera-invoices/2026/INV-2026-0142.pdf?X-Amz-Signature=redacted",
      "expires_at": "2026-12-01T10:05:00Z",
      "content_type": "application/pdf",
      "filename": "INV-2026-0142.pdf",
      "sha256": "000000000000000000000000000000000000000000000000000000000000d10c",
      "size_bytes": 48213
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "requestWorkspaceDeletion": {
    operationId: "requestWorkspaceDeletion",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/privacy/deletions",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "scope": "workspace",
      "kind": "deletion",
      "status": "queued",
      "requestedAt": "2026-11-13T12:00:00Z",
      "updatedAt": "2026-11-13T12:00:00Z",
      "expiresAt": null,
      "purgeAfter": null,
      "failureCode": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getWorkspaceDeletion": {
    operationId: "getWorkspaceDeletion",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/privacy/deletions/{request_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "scope": "workspace",
      "kind": "deletion",
      "status": "queued",
      "requestedAt": "2026-11-13T12:00:00Z",
      "updatedAt": "2026-11-13T12:00:00Z",
      "expiresAt": null,
      "purgeAfter": null,
      "failureCode": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "requestAccountExport": {
    operationId: "requestAccountExport",
    method: "post",
    path: "/me/privacy/exports",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "scope": "account",
      "kind": "export",
      "status": "queued",
      "requestedAt": "2026-11-13T12:00:00Z",
      "updatedAt": "2026-11-13T12:00:00Z",
      "expiresAt": null,
      "purgeAfter": null,
      "failureCode": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getAccountExport": {
    operationId: "getAccountExport",
    method: "get",
    path: "/me/privacy/exports/{request_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "scope": "account",
      "kind": "export",
      "status": "queued",
      "requestedAt": "2026-11-13T12:00:00Z",
      "updatedAt": "2026-11-13T12:00:00Z",
      "expiresAt": null,
      "purgeAfter": null,
      "failureCode": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getAccountExportDownloadLink": {
    operationId: "getAccountExportDownloadLink",
    method: "get",
    path: "/me/privacy/exports/{request_id}/download",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "url": "https://s3.fr-par.scw.cloud/kodera-invoices/2026/INV-2026-0142.pdf?X-Amz-Signature=redacted",
      "expires_at": "2026-12-01T10:05:00Z",
      "content_type": "application/pdf",
      "filename": "INV-2026-0142.pdf",
      "sha256": "000000000000000000000000000000000000000000000000000000000000d10c",
      "size_bytes": 48213
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "requestAccountDeletion": {
    operationId: "requestAccountDeletion",
    method: "post",
    path: "/me/privacy/deletions",
    status: 202,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "scope": "account",
      "kind": "deletion",
      "status": "queued",
      "requestedAt": "2026-11-13T12:00:00Z",
      "updatedAt": "2026-11-13T12:00:00Z",
      "expiresAt": null,
      "purgeAfter": null,
      "failureCode": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getAccountDeletion": {
    operationId: "getAccountDeletion",
    method: "get",
    path: "/me/privacy/deletions/{request_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000001",
      "scope": "account",
      "kind": "deletion",
      "status": "queued",
      "requestedAt": "2026-11-13T12:00:00Z",
      "updatedAt": "2026-11-13T12:00:00Z",
      "expiresAt": null,
      "purgeAfter": null,
      "failureCode": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "bootstrapProximity": {
    operationId: "bootstrapProximity",
    method: "post",
    path: "/proximity/bootstrap",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "workspace_id": "01950000-0000-7000-8000-0000000000a1",
      "event_scope": "default",
      "epoch": 2000000,
      "epoch_mac_key": "0000000000000000000000000000000000000000000000000000000000000000",
      "epoch_expires_at": 1800000900,
      "epoch_rotation_seconds": 900
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "checkInProximity": {
    operationId: "checkInProximity",
    method: "post",
    path: "/proximity/checkin",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "workspace_id": "01950000-0000-7000-8000-0000000000a1",
      "event_scope": "default",
      "handle": "nearby-person",
      "status_note": "",
      "rolling_pseudonym": "7e5f21610c812e05",
      "epoch": 2000000,
      "ttl_seconds": 1800,
      "expires_at": 1800001900,
      "gps_persisted": false
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "resolveProximityTokens": {
    operationId: "resolveProximityTokens",
    method: "post",
    path: "/proximity/resolve",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "workspace_id": "01950000-0000-7000-8000-0000000000a1",
      "event_scope": "default",
      "peers": [
        {
          "handle": "nearby-person",
          "status_note": "",
          "rolling_pseudonym": "7e5f21610c812e05",
          "transport": "hybrid",
          "distance_band": "near",
          "expires_in_seconds": 1800,
          "expires_at": 1800001900
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getNearbyProximity": {
    operationId: "getNearbyProximity",
    method: "get",
    path: "/proximity/nearby",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "workspace_id": "01950000-0000-7000-8000-0000000000a1",
      "event_scope": "default",
      "self": {
        "handle": "nearby-person",
        "status_note": "",
        "expires_in_seconds": 1800,
        "expires_at": 1800001900
      },
      "peers": [
        {
          "handle": "nearby-person",
          "status_note": "",
          "rolling_pseudonym": "7e5f21610c812e05",
          "transport": "hybrid",
          "distance_band": "near",
          "expires_in_seconds": 1800,
          "expires_at": 1800001900
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "checkOutProximity": {
    operationId: "checkOutProximity",
    method: "post",
    path: "/proximity/checkout",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "workspace_id": "01950000-0000-7000-8000-0000000000a1",
      "checked_out": true,
      "purged_records": 1
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "registerConfidentialDevice": {
    operationId: "registerConfidentialDevice",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/devices",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "deviceId": "01950000-0000-7000-8000-0000000000a2",
      "signingKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "revokeConfidentialDevice": {
    operationId: "revokeConfidentialDevice",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/devices/revoke",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "deviceId": "01950000-0000-7000-8000-0000000000a2",
      "revoked": true
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "publishConfidentialKeyPackage": {
    operationId: "publishConfidentialKeyPackage",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/key-packages",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "keyPackageId": "01950000-0000-7000-8000-0000000000a1",
      "reference": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "expiresAt": "2030-01-08T00:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "createConfidentialRoom": {
    operationId: "createConfidentialRoom",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/rooms",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "roomId": "01950000-0000-7000-8000-0000000000a1",
      "algorithm": "io.kodera.mls.v1",
      "epoch": 0,
      "deviceIds": [
        "01950000-0000-7000-8000-0000000000a2"
      ]
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "claimConfidentialKeyPackage": {
    operationId: "claimConfidentialKeyPackage",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/rooms/{room_id}/key-packages/claims",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "keyPackageId": "01950000-0000-7000-8000-0000000000a1",
      "deviceId": "01950000-0000-7000-8000-0000000000a2",
      "signingKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "keyPackage": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "epoch": 0
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "commitConfidentialEpoch": {
    operationId: "commitConfidentialEpoch",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/rooms/{room_id}/commits",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "epoch": 1,
      "commitEnvelopeId": "01950000-0000-7000-8000-0000000000c1",
      "commitSequence": 1,
      "headSequence": 1,
      "deviceIds": [
        "01950000-0000-7000-8000-0000000000a2"
      ]
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "retireConfidentialParticipant": {
    operationId: "retireConfidentialParticipant",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/rooms/{room_id}/participants/retire",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "epoch": 0,
      "rekeyRequired": true
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listConfidentialEnvelopes": {
    operationId: "listConfidentialEnvelopes",
    method: "get",
    path: "/organisations/{organisation_id}/confidential/rooms/{room_id}/envelopes",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "roomId": "01950000-0000-7000-8000-0000000000a1",
      "algorithm": "io.kodera.mls.v1",
      "epoch": 0,
      "rekeyRequired": false,
      "hasMore": false,
      "nextAfter": 1,
      "devices": [
        {
          "deviceId": "01950000-0000-7000-8000-0000000000a2",
          "signingKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        }
      ],
      "envelopes": [
        {
          "id": "01950000-0000-7000-8000-0000000000a1",
          "kind": "application",
          "epoch": 0,
          "sequence": 1,
          "senderDeviceId": "01950000-0000-7000-8000-0000000000a2",
          "ciphertext": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "sendConfidentialEnvelope": {
    operationId: "sendConfidentialEnvelope",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/rooms/{room_id}/envelopes",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "envelopeId": "01950000-0000-7000-8000-0000000000a1",
      "sequence": 1,
      "epoch": 0
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getWorkspaceAiPolicy": {
    operationId: "getWorkspaceAiPolicy",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/ai/policy",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "gatewayEnabled": false,
      "enabled": false,
      "provider": "mistral",
      "providerRegion": "eu",
      "euSovereignOnly": true,
      "selfHostedEndpoint": "",
      "model": "mistral-small-latest",
      "hasByomConfig": false,
      "monthlyBudgetMicros": 50000000,
      "monthlySpentMicros": 0,
      "memberConsent": {
        "enabled": false,
        "consentedAt": null,
        "revokedAt": null
      }
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "putWorkspaceAiPolicy": {
    operationId: "putWorkspaceAiPolicy",
    method: "put",
    path: "/organisations/{organisation_id}/workspace/ai/policy",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "gatewayEnabled": false,
      "enabled": false,
      "provider": "mistral",
      "providerRegion": "eu",
      "euSovereignOnly": true,
      "selfHostedEndpoint": "",
      "model": "mistral-small-latest",
      "hasByomConfig": false,
      "monthlyBudgetMicros": 50000000,
      "monthlySpentMicros": 0,
      "memberConsent": {
        "enabled": false,
        "consentedAt": null,
        "revokedAt": null
      }
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "putChannelAiPolicy": {
    operationId: "putChannelAiPolicy",
    method: "put",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/ai",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "channelId": "00000000-0000-7000-8000-000000000001",
      "aiEnabled": false
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "putMemberAiConsent": {
    operationId: "putMemberAiConsent",
    method: "put",
    path: "/organisations/{organisation_id}/workspace/ai/consent",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "enabled": false,
      "consentedAt": null,
      "revokedAt": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "transcribeVoiceNote": {
    operationId: "transcribeVoiceNote",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/attachments/{attachment_id}/actions/transcribe",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "attachmentId": "00000000-0000-7000-8000-000000000001",
      "channelId": "00000000-0000-7000-8000-000000000002",
      "text": "Bonjour tout le monde",
      "language": "fr",
      "provider": "mistral",
      "model": "voxtral-mini-latest"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "previewWorkspaceImport": {
    operationId: "previewWorkspaceImport",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/imports/preview",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "source": "slack",
      "archive_sha256": "000000000000000000000000000000000000000000000000000000000000a1b2",
      "dry_run": true,
      "counts": {
        "channels_total": 2,
        "channels_existing": 1,
        "channels_to_create": 1,
        "messages_total": 14,
        "thread_replies_total": 3,
        "docs_pages_total": 2,
        "collections_total": 0,
        "collection_rows_total": 0,
        "members_matched": 2,
        "members_unmatched": 1,
        "already_imported_reused": 0,
        "omitted_assets": 0
      },
      "member_mappings": [
        {
          "external_id": "U01ALICE",
          "display_name": "Alice Martin",
          "matched_membership_id": "01950000-0000-7000-8000-0000000000b1",
          "local_role_preserved": true
        }
      ],
      "warnings": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "executeWorkspaceImport": {
    operationId: "executeWorkspaceImport",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/imports/execute",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "batch_id": "01950000-0000-7000-8000-0000000000b2",
      "source": "slack",
      "state": "complete",
      "imported": 2,
      "reused": 0,
      "remaining": 0,
      "omitted_assets": 0,
      "replayed_messages": 14,
      "reused_messages": 0,
      "warnings": []
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listCoexistenceBridges": {
    operationId: "listCoexistenceBridges",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/coexistence/bridges",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "bridges": [
        {
          "id": "01950000-0000-7000-8000-0000000000c1",
          "workspaceId": "01950000-0000-7000-8000-0000000000c2",
          "channelId": "01950000-0000-7000-8000-0000000000c3",
          "creatorMembershipId": "01950000-0000-7000-8000-0000000000c4",
          "source": "slack",
          "externalWorkspaceId": "T01EXTERNAL",
          "externalChannelId": "C01GENERAL",
          "outboundEndpoint": "https://hooks.example.com/services/bridge",
          "active": true,
          "revokedAt": null,
          "createdAt": "2026-11-23T00:00:00Z",
          "updatedAt": "2026-11-23T00:00:00Z"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createCoexistenceBridge": {
    operationId: "createCoexistenceBridge",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/coexistence/bridges",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "01950000-0000-7000-8000-0000000000c1",
      "workspaceId": "01950000-0000-7000-8000-0000000000c2",
      "channelId": "01950000-0000-7000-8000-0000000000c3",
      "creatorMembershipId": "01950000-0000-7000-8000-0000000000c4",
      "source": "slack",
      "externalWorkspaceId": "T01EXTERNAL",
      "externalChannelId": "C01GENERAL",
      "outboundEndpoint": "https://hooks.example.com/services/bridge",
      "active": true,
      "revokedAt": null,
      "createdAt": "2026-11-23T00:00:00Z",
      "updatedAt": "2026-11-23T00:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "revokeCoexistenceBridge": {
    operationId: "revokeCoexistenceBridge",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/coexistence/bridges/{bridge_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "receiveCoexistenceEvent": {
    operationId: "receiveCoexistenceEvent",
    method: "post",
    path: "/coexistence/bridges/{bridge_id}/events",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "accepted": true,
      "queued": true,
      "status": "queued",
      "bridgeId": "01950000-0000-7000-8000-0000000000c1",
      "channelId": "01950000-0000-7000-8000-0000000000c3",
      "externalEventId": "Ev01EXTERNAL",
      "matrixEventId": null,
      "matrixTxnId": "kodera-coex-00000000000000000000000000000001",
      "validatedAttachmentMimes": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getWorkspaceMonetization": {
    operationId: "getWorkspaceMonetization",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/monetization",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "workspace_id": "00000000-0000-7000-8000-000000000010",
      "boost_packs": [],
      "hosting_credits": [],
      "vip_tiers": [],
      "connect_account": null,
      "dac7_summary": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createWorkspaceBoostCheckout": {
    operationId: "createWorkspaceBoostCheckout",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/monetization/boosts/checkout",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "boost_grant_id": "00000000-0000-7000-8000-000000000021",
      "invoice_id": "00000000-0000-7000-8000-000000000022",
      "invoice_number": "KODERA-2026-00001",
      "vat_regime": "fr_standard",
      "vat_rate_bp": 2000,
      "net_amount_minor": 2900,
      "vat_amount_minor": 580,
      "gross_amount_minor": 3480,
      "checkout_session_id": "cs_fake_000001",
      "checkout_url": "https://pay.fake.invalid/checkout/cs_fake_000001"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "startCreatorConnectOnboarding": {
    operationId: "startCreatorConnectOnboarding",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/monetization/connect/onboarding",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "connect_account_id": "00000000-0000-7000-8000-000000000031",
      "stripe_connect_account_id": "acct_fake000001",
      "onboarding_state": "onboarding_link_issued",
      "onboarding_url": "https://connect.fake.invalid/setup/acct_fake000001",
      "expires_at": "2026-06-15T12:15:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "createVipTierOffer": {
    operationId: "createVipTierOffer",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/monetization/vip-tiers",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000041",
      "code": "vip-gold",
      "name": "Salon VIP Or",
      "description": null,
      "billing_period": "monthly",
      "currency": "EUR",
      "price_excl_vat_minor": 1500,
      "granted_workspace_role_id": "00000000-0000-7000-8000-000000000042",
      "granted_channel_ids": [
        "00000000-0000-7000-8000-000000000043"
      ],
      "active": true
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "createVipPassCheckout": {
    operationId: "createVipPassCheckout",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/monetization/vip-passes/checkout",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "vip_entitlement_id": "00000000-0000-7000-8000-000000000051",
      "tier_id": "00000000-0000-7000-8000-000000000041",
      "vat_regime": "fr_standard",
      "vat_rate_bp": 2000,
      "gross_excl_vat_minor": 1500,
      "vat_amount_minor": 300,
      "total_incl_vat_minor": 1800,
      "application_fee_amount_minor": 150,
      "reserved_recovery_minor": 0,
      "creator_net_minor": 1350,
      "checkout_session_id": "cs_fake_000002",
      "checkout_url": "https://pay.fake.invalid/checkout/cs_fake_000002"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "exportWorkspaceDac7Report": {
    operationId: "exportWorkspaceDac7Report",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/monetization/dac7-report",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "directive": "2021/514/EU",
      "reporting_year": 2026,
      "sellers": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getChannelGovernance": {
    operationId: "getChannelGovernance",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/channel-governance",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "enforcementReady": false,
      "agreements": [],
      "guests": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "proposePartnerChannelAgreement": {
    operationId: "proposePartnerChannelAgreement",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/partner-agreements",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "01950000-0000-7000-8000-0000000000a1",
      "organisationId": "01950000-0000-7000-8000-0000000000a1",
      "partnerOrganisationId": "01950000-0000-7000-8000-0000000000a2",
      "channelId": "01950000-0000-7000-8000-0000000000a1",
      "partnerChannelId": "01950000-0000-7000-8000-0000000000a2",
      "localHomeserver": "local.example.org",
      "partnerHomeserver": "peer.example.org",
      "matrixRoomId": "!shared:local.example.org",
      "federationMode": "partner",
      "state": "proposed",
      "revision": 1,
      "replicatedHistoryErasable": false,
      "historyNotice": "Matrix history already replicated to the partner homeserver cannot be remotely erased."
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "transitionPartnerChannelAgreement": {
    operationId: "transitionPartnerChannelAgreement",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/partner-agreements/{agreement_id}/actions/transition",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "01950000-0000-7000-8000-0000000000a1",
      "organisationId": "01950000-0000-7000-8000-0000000000a1",
      "partnerOrganisationId": "01950000-0000-7000-8000-0000000000a2",
      "channelId": "01950000-0000-7000-8000-0000000000a1",
      "partnerChannelId": "01950000-0000-7000-8000-0000000000a2",
      "localHomeserver": "local.example.org",
      "partnerHomeserver": "peer.example.org",
      "matrixRoomId": "!shared:local.example.org",
      "federationMode": "partner",
      "state": "proposed",
      "revision": 1,
      "replicatedHistoryErasable": false,
      "historyNotice": "Matrix history already replicated to the partner homeserver cannot be remotely erased."
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "grantSingleChannelGuest": {
    operationId: "grantSingleChannelGuest",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/guest-grants",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "01950000-0000-7000-8000-0000000000a1",
      "guestIdentityId": "01950000-0000-7000-8000-0000000000a2",
      "channelId": "01950000-0000-7000-8000-0000000000a1",
      "matrixUserId": "@guest:peer.example.org",
      "matrixRoomId": "!guest:local.example.org",
      "role": "single_channel_guest",
      "expiresAt": "2026-12-01T12:00:00Z",
      "allowCalls": false,
      "revokedAt": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "revokeSingleChannelGuest": {
    operationId: "revokeSingleChannelGuest",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/guest-grants/{grant_id}/actions/revoke",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "01950000-0000-7000-8000-0000000000a1",
      "guestIdentityId": "01950000-0000-7000-8000-0000000000a2",
      "channelId": "01950000-0000-7000-8000-0000000000a1",
      "matrixUserId": "@guest:peer.example.org",
      "matrixRoomId": "!guest:local.example.org",
      "role": "single_channel_guest",
      "expiresAt": "2026-12-01T12:00:00Z",
      "allowCalls": false,
      "revokedAt": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getSingleGuestChannel": {
    operationId: "getSingleGuestChannel",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/guest-channel",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "channelId": "01950000-0000-7000-8000-0000000000a1",
      "name": "Partner channel",
      "kind": "text",
      "matrixRoomId": "!guest:local.example.org",
      "allowCalls": false,
      "expiresAt": "2026-12-01T12:00:00Z",
      "role": "single_channel_guest"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "discoverConfidentialRoom": {
    operationId: "discoverConfidentialRoom",
    method: "get",
    path: "/organisations/{organisation_id}/confidential/rooms/{room_id}/discovery",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "roomId": "01950000-0000-7000-8000-0000000000a1",
      "channelId": "01950000-0000-7000-8000-0000000000a1",
      "epoch": 0,
      "algorithm": "io.kodera.mls.v1",
      "rekeyRequired": false,
      "deviceIds": [
        "01950000-0000-7000-8000-0000000000a1"
      ],
      "commitSequence": 0,
      "commitDigest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "acceptedAt": "2026-11-23T12:00:00Z",
      "verificationBundles": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "publishDeviceVerificationBundle": {
    operationId: "publishDeviceVerificationBundle",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/verification-bundles",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "deviceId": "01950000-0000-7000-8000-0000000000a1",
      "revision": 1
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getConfidentialKeyBackup": {
    operationId: "getConfidentialKeyBackup",
    method: "get",
    path: "/organisations/{organisation_id}/confidential/key-backup",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "backupEpoch": 1,
      "kdfKind": "recovery-key",
      "iterations": 0,
      "capsuleSha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "sourceDeviceId": "01950000-0000-7000-8000-0000000000a2",
      "publishedAt": "2026-06-08T10:00:00Z",
      "capsule": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "publishConfidentialKeyBackup": {
    operationId: "publishConfidentialKeyBackup",
    method: "post",
    path: "/organisations/{organisation_id}/confidential/key-backup",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "backupEpoch": 1,
      "kdfKind": "recovery-key",
      "iterations": 0,
      "capsuleSha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "sourceDeviceId": "01950000-0000-7000-8000-0000000000a2",
      "publishedAt": "2026-06-08T10:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "discardConfidentialKeyBackup": {
    operationId: "discardConfidentialKeyBackup",
    method: "delete",
    path: "/organisations/{organisation_id}/confidential/key-backup",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listCalendarEvents": {
    operationId: "listCalendarEvents",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/calendar/events",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000101",
          "uid": "00000000-0000-7000-8000-000000000101@kodera.calendar",
          "title": "Synchronisation produit hebdomadaire",
          "description": "Revue de feuille de route et arbitrages.",
          "location": "Salle Givre",
          "startsAt": "2026-06-08T09:00:00Z",
          "endsAt": "2026-06-08T09:45:00Z",
          "timezone": "Europe/Paris",
          "rrule": "FREQ=WEEKLY;BYDAY=MO",
          "status": "confirmed",
          "visibility": "workspace",
          "attendees": [],
          "alarmMinutesBefore": 15,
          "visioUrl": "https://visio.kodera.io/hebdo-produit",
          "agendaDocUrl": "",
          "sourceId": null,
          "revision": 1,
          "updatedAt": "2026-06-01T08:00:00Z"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createCalendarEvent": {
    operationId: "createCalendarEvent",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/calendar/events",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000101",
      "uid": "00000000-0000-7000-8000-000000000101@kodera.calendar",
      "title": "Synchronisation produit hebdomadaire",
      "description": "Revue de feuille de route et arbitrages.",
      "location": "Salle Givre",
      "startsAt": "2026-06-08T09:00:00Z",
      "endsAt": "2026-06-08T09:45:00Z",
      "timezone": "Europe/Paris",
      "rrule": "FREQ=WEEKLY;BYDAY=MO",
      "status": "confirmed",
      "visibility": "workspace",
      "attendees": [
        {
          "email": "camille@kodera.io",
          "name": "Camille Laurent",
          "partstat": "ACCEPTED",
          "role": "REQ-PARTICIPANT"
        }
      ],
      "alarmMinutesBefore": 15,
      "visioUrl": "https://visio.kodera.io/hebdo-produit",
      "agendaDocUrl": "https://console.kodera.io/docs/00000000-0000-7000-8000-000000000201",
      "sourceId": null,
      "revision": 1,
      "updatedAt": "2026-06-01T08:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "updateCalendarEvent": {
    operationId: "updateCalendarEvent",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/calendar/events/{event_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000101",
      "uid": "00000000-0000-7000-8000-000000000101@kodera.calendar",
      "title": "Synchronisation produit hebdomadaire",
      "description": "Revue de feuille de route et arbitrages.",
      "location": "Salle Givre",
      "startsAt": "2026-06-08T09:00:00Z",
      "endsAt": "2026-06-08T09:45:00Z",
      "timezone": "Europe/Paris",
      "rrule": "FREQ=WEEKLY;BYDAY=MO",
      "status": "confirmed",
      "visibility": "workspace",
      "attendees": [
        {
          "email": "camille@kodera.io",
          "name": "Camille Laurent",
          "partstat": "ACCEPTED",
          "role": "REQ-PARTICIPANT"
        }
      ],
      "alarmMinutesBefore": 15,
      "visioUrl": "https://visio.kodera.io/hebdo-produit",
      "agendaDocUrl": "https://console.kodera.io/docs/00000000-0000-7000-8000-000000000201",
      "sourceId": null,
      "revision": 1,
      "updatedAt": "2026-06-01T08:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "deleteCalendarEvent": {
    operationId: "deleteCalendarEvent",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/calendar/events/{event_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "exportCalendarIcs": {
    operationId: "exportCalendarIcs",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/calendar/events.ics",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "filename": "kodera-workspace-calendar.ics",
      "ics": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kodera//Sovereign Smart Calendar//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nEND:VCALENDAR\r\n"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listCaldavSources": {
    operationId: "listCaldavSources",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/calendar/sources",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000102",
          "name": "Agenda La Suite Numerique",
          "provider": "lasuite",
          "calendarUrl": "https://agenda.numerique.gouv.fr/caldav/equipe/",
          "principalUsername": "equipe@kodera.io",
          "enabled": true,
          "hasSyncToken": true,
          "lastSyncedAt": "2026-06-01T08:05:00Z",
          "lastErrorCode": null,
          "createdAt": "2026-06-01T08:00:00Z"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createCaldavSource": {
    operationId: "createCaldavSource",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/calendar/sources",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000102",
      "name": "Agenda La Suite Numerique",
      "provider": "lasuite",
      "calendarUrl": "https://agenda.numerique.gouv.fr/caldav/equipe/",
      "principalUsername": "equipe@kodera.io",
      "enabled": true,
      "hasSyncToken": true,
      "lastSyncedAt": "2026-06-01T08:05:00Z",
      "lastErrorCode": null,
      "createdAt": "2026-06-01T08:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "deleteCaldavSource": {
    operationId: "deleteCaldavSource",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/calendar/sources/{source_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "syncCaldavSource": {
    operationId: "syncCaldavSource",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/calendar/sources/{source_id}/actions/sync",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "sourceId": "00000000-0000-7000-8000-000000000102",
      "upserted": 3,
      "removed": 0,
      "fullResync": false,
      "syncedAt": "2026-06-01T08:10:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listBookingPages": {
    operationId: "listBookingPages",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/calendar/booking-pages",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "data": [
        {
          "id": "00000000-0000-7000-8000-000000000103",
          "slug": "echange-architecture-kodera",
          "title": "Point architecture souveraine",
          "description": "Creneau de 30 minutes avec lien Kodera Visio automatique.",
          "timezone": "Europe/Paris",
          "durationMinutes": 30,
          "bufferMinutes": 10,
          "availabilityWindows": [
            {
              "weekday": 0,
              "start": "09:00",
              "end": "17:00"
            }
          ],
          "visioUrl": "https://visio.kodera.io/point-architecture",
          "agendaDocUrl": "",
          "active": true,
          "revision": 1,
          "createdAt": "2026-06-01T08:00:00Z"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createBookingPage": {
    operationId: "createBookingPage",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/calendar/booking-pages",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000103",
      "slug": "echange-architecture-kodera",
      "title": "Point architecture souveraine",
      "description": "Creneau de 30 minutes avec lien Kodera Visio automatique.",
      "timezone": "Europe/Paris",
      "durationMinutes": 30,
      "bufferMinutes": 10,
      "availabilityWindows": [
        {
          "weekday": 0,
          "start": "09:00",
          "end": "17:00"
        }
      ],
      "visioUrl": "https://visio.kodera.io/point-architecture",
      "agendaDocUrl": "",
      "active": true,
      "revision": 1,
      "createdAt": "2026-06-01T08:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "deleteBookingPage": {
    operationId: "deleteBookingPage",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/calendar/booking-pages/{booking_page_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getPublicBookingPage": {
    operationId: "getPublicBookingPage",
    method: "get",
    path: "/booking/{booking_slug}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "slug": "echange-architecture-kodera",
      "title": "Point architecture souveraine",
      "description": "Creneau de 30 minutes avec lien Kodera Visio automatique.",
      "timezone": "Europe/Paris",
      "durationMinutes": 30,
      "visioAvailable": true,
      "slots": [
        {
          "startsAt": "2026-06-08T10:00:00Z",
          "endsAt": "2026-06-08T10:30:00Z"
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "reservePublicBookingSlot": {
    operationId: "reservePublicBookingSlot",
    method: "post",
    path: "/booking/{booking_slug}/reservations",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "reservationId": "00000000-0000-7000-8000-000000000104",
      "slug": "echange-architecture-kodera",
      "title": "Point architecture souveraine",
      "startsAt": "2026-06-08T10:00:00Z",
      "endsAt": "2026-06-08T10:30:00Z",
      "timezone": "Europe/Paris",
      "visioUrl": "https://visio.kodera.io/point-architecture",
      "agendaDocUrl": "",
      "status": "confirmed",
      "cancellationToken": "bkc_00000000000000000000000000000000",
      "ics": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kodera//Sovereign Smart Calendar//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "cancelPublicBookingReservation": {
    operationId: "cancelPublicBookingReservation",
    method: "post",
    path: "/booking/{booking_slug}/reservations/{reservation_id}/actions/cancel",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "reservationId": "00000000-0000-7000-8000-000000000104",
      "status": "cancelled",
      "cancelledAt": "2026-06-02T09:00:00Z",
      "ics": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kodera//Sovereign Smart Calendar//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:CANCEL\r\nEND:VCALENDAR\r\n"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getWorkspaceSecurityPosture": {
    operationId: "getWorkspaceSecurityPosture",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/security-posture",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "organisation_id": "00000000-0000-7000-8000-000000000001",
      "workspace_id": "00000000-0000-7000-8000-000000000002",
      "score": 85,
      "max_score": 100,
      "grade": "B",
      "passing_checks": 5,
      "total_checks": 6,
      "fixable_checks": 1,
      "checks": [
        {
          "id": "invite_hygiene",
          "status": "pass",
          "earned_points": 20,
          "max_points": 20,
          "remediation_action": "cap_unbounded_invites",
          "fix_available": false,
          "affected_count": 0
        },
        {
          "id": "sovereign_ai_boundary",
          "status": "pass",
          "earned_points": 20,
          "max_points": 20,
          "remediation_action": "enforce_eu_sovereign_ai",
          "fix_available": false,
          "affected_count": 0
        },
        {
          "id": "security_alert_routing",
          "status": "warn",
          "earned_points": 0,
          "max_points": 15,
          "remediation_action": "provision_security_alerts_channel",
          "fix_available": true,
          "affected_count": 1
        },
        {
          "id": "extension_secret_rotation",
          "status": "pass",
          "earned_points": 15,
          "max_points": 15,
          "remediation_action": "rotate_stale_extension_keys",
          "fix_available": false,
          "affected_count": 0
        },
        {
          "id": "least_privilege_roles",
          "status": "pass",
          "earned_points": 15,
          "max_points": 15,
          "remediation_action": "strip_excess_role_permissions",
          "fix_available": false,
          "affected_count": 0
        },
        {
          "id": "confidential_room_readiness",
          "status": "pass",
          "earned_points": 15,
          "max_points": 15,
          "remediation_action": "provision_confidential_channel",
          "fix_available": false,
          "affected_count": 0
        }
      ]
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "remediateWorkspaceSecurityPosture": {
    operationId: "remediateWorkspaceSecurityPosture",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/security-posture/actions/remediate",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "requested_action": "fix_all_safe",
      "applied_actions": [
        "provision_security_alerts_channel"
      ],
      "score_before": 85,
      "posture": {
        "organisation_id": "00000000-0000-7000-8000-000000000001",
        "workspace_id": "00000000-0000-7000-8000-000000000002",
        "score": 100,
        "max_score": 100,
        "grade": "A",
        "passing_checks": 6,
        "total_checks": 6,
        "fixable_checks": 0,
        "checks": [
          {
            "id": "invite_hygiene",
            "status": "pass",
            "earned_points": 20,
            "max_points": 20,
            "remediation_action": "cap_unbounded_invites",
            "fix_available": false,
            "affected_count": 0
          },
          {
            "id": "sovereign_ai_boundary",
            "status": "pass",
            "earned_points": 20,
            "max_points": 20,
            "remediation_action": "enforce_eu_sovereign_ai",
            "fix_available": false,
            "affected_count": 0
          },
          {
            "id": "security_alert_routing",
            "status": "pass",
            "earned_points": 15,
            "max_points": 15,
            "remediation_action": "provision_security_alerts_channel",
            "fix_available": false,
            "affected_count": 0
          },
          {
            "id": "extension_secret_rotation",
            "status": "pass",
            "earned_points": 15,
            "max_points": 15,
            "remediation_action": "rotate_stale_extension_keys",
            "fix_available": false,
            "affected_count": 0
          },
          {
            "id": "least_privilege_roles",
            "status": "pass",
            "earned_points": 15,
            "max_points": 15,
            "remediation_action": "strip_excess_role_permissions",
            "fix_available": false,
            "affected_count": 0
          },
          {
            "id": "confidential_room_readiness",
            "status": "pass",
            "earned_points": 15,
            "max_points": 15,
            "remediation_action": "provision_confidential_channel",
            "fix_available": false,
            "affected_count": 0
          }
        ]
      }
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "translateChannelMessage": {
    operationId: "translateChannelMessage",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/actions/translate-message",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "channelId": "00000000-0000-7000-8000-000000000002",
      "eventId": "$event_demo_001",
      "translatedText": "Deployment confirmed for Thursday.",
      "targetLanguage": "en",
      "sourceLanguage": "fr",
      "provider": "mistral",
      "model": "mistral-small-latest",
      "ephemeral": true
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "getLiveCallCaptionSession": {
    operationId: "getLiveCallCaptionSession",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/call-captions/session",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "session": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "updateLiveCallCaptionSession": {
    operationId: "updateLiveCallCaptionSession",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/call-captions/session",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "session": null
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "transcribeLiveCallChunk": {
    operationId: "transcribeLiveCallChunk",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/call-captions/chunks",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "sessionId": "00000000-0000-7000-8000-000000000210",
      "channelId": "00000000-0000-7000-8000-000000000002",
      "sourceText": "Bonjour a toute l equipe.",
      "translatedText": "Hello to the whole team.",
      "sourceLanguage": "fr",
      "targetLanguage": "en",
      "provider": "mistral",
      "model": "voxtral-mini-latest",
      "ephemeral": true
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listMarketplaceExtensions": {
    operationId: "listMarketplaceExtensions",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/extensions/marketplace",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "billingEnabled": true,
      "listings": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "publishMarketplaceExtension": {
    operationId: "publishMarketplaceExtension",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/extensions/marketplace",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000301",
      "workspaceId": "00000000-0000-7000-8000-000000000001",
      "slug": "release-assistant",
      "title": "Release Assistant",
      "summary": "Interactive deployment status and release approvals.",
      "pricingMode": "free",
      "priceExclVatMinor": 0,
      "currency": "EUR",
      "manifest": {
        "schemaVersion": "kodera.extension.v1",
        "slug": "release-assistant",
        "name": "Release Assistant",
        "version": "0.1.0",
        "description": "Interactive deployment status and release approvals.",
        "scopes": [
          "commands:register",
          "widgets:write"
        ],
        "events": [
          "command.invoked",
          "widget.action"
        ],
        "commands": [],
        "widgets": [],
        "endpoint": "https://extensions.example.eu/kodera/webhook"
      },
      "publishedAt": "2026-06-08T10:00:00Z",
      "entitlementState": "active",
      "entitlementId": "00000000-0000-7000-8000-000000000302",
      "installed": true,
      "installationId": "00000000-0000-7000-8000-000000000303"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "checkoutMarketplaceExtension": {
    operationId: "checkoutMarketplaceExtension",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/extensions/marketplace/{listing_id}/checkout",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "entitlementId": "00000000-0000-7000-8000-000000000302",
      "listingId": "00000000-0000-7000-8000-000000000301",
      "pricingMode": "free",
      "state": "active",
      "checkoutRequired": false,
      "checkoutSessionId": null,
      "checkoutUrl": null,
      "grossExclVatMinor": 0,
      "vatAmountMinor": 0,
      "totalInclVatMinor": 0,
      "applicationFeeAmountMinor": 0,
      "currency": "EUR",
      "replayed": false
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "installMarketplaceExtension": {
    operationId: "installMarketplaceExtension",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/extensions/marketplace/{listing_id}/install",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "installationId": "00000000-0000-7000-8000-000000000303",
      "entitlementId": "00000000-0000-7000-8000-000000000302",
      "listingId": "00000000-0000-7000-8000-000000000301",
      "slug": "release-assistant",
      "endpoint": "https://extensions.example.eu/kodera/webhook",
      "events": [
        "command.invoked",
        "widget.action"
      ],
      "keyGeneration": "1",
      "replayed": false
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "invokeChannelWidgetAction": {
    operationId: "invokeChannelWidgetAction",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/channels/{channel_id}/widgets/{widget_id}/actions",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "receiptId": "00000000-0000-7000-8000-000000000304",
      "installationId": "00000000-0000-7000-8000-000000000303",
      "channelId": "00000000-0000-7000-8000-000000000002",
      "widgetId": "release-gate",
      "actionId": "deploy_approve",
      "state": "delivered",
      "responseStatus": 200,
      "card": null,
      "replayed": false
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "listWorkspaceCustomEmojis": {
    operationId: "listWorkspaceCustomEmojis",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/emojis",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "items": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createWorkspaceCustomEmoji": {
    operationId: "createWorkspaceCustomEmoji",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/emojis",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000401",
      "shortcode": "ship_it",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "width": 64,
      "height": 64,
      "animated": false,
      "creatorMembershipId": "00000000-0000-7000-8000-000000000010",
      "createdAt": "2026-06-08T10:00:00Z",
      "blobPath": "/api/v1/organisations/00000000-0000-7000-8000-000000000001/workspace/emojis/00000000-0000-7000-8000-000000000401/blob"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "deleteWorkspaceCustomEmoji": {
    operationId: "deleteWorkspaceCustomEmoji",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/emojis/{emoji_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getWorkspaceCustomEmojiBlob": {
    operationId: "getWorkspaceCustomEmojiBlob",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/emojis/{emoji_id}/blob",
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=",
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listScheduledMessages": {
    operationId: "listScheduledMessages",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/scheduled-messages",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "items": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createScheduledMessage": {
    operationId: "createScheduledMessage",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/scheduled-messages",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000410",
      "channelId": "00000000-0000-7000-8000-000000000002",
      "roomId": "!general:acme.kodera.io",
      "body": "Bonjour a toute l equipe !",
      "mentions": [],
      "threadRootEventId": null,
      "deliverAt": "2026-06-09T09:00:00Z",
      "matrixTxnId": "kodera-sched-0123456789abcdef0123456789abcdef",
      "matrixEventId": null,
      "state": "pending",
      "failureReason": null,
      "createdAt": "2026-06-08T10:00:00Z",
      "updatedAt": "2026-06-08T10:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "updateScheduledMessage": {
    operationId: "updateScheduledMessage",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/scheduled-messages/{scheduled_message_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000410",
      "channelId": "00000000-0000-7000-8000-000000000002",
      "roomId": "!general:acme.kodera.io",
      "body": "Bonjour a toute l equipe !",
      "mentions": [],
      "threadRootEventId": null,
      "deliverAt": "2026-06-09T09:00:00Z",
      "matrixTxnId": "kodera-sched-0123456789abcdef0123456789abcdef",
      "matrixEventId": null,
      "state": "pending",
      "failureReason": null,
      "createdAt": "2026-06-08T10:00:00Z",
      "updatedAt": "2026-06-08T10:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "cancelScheduledMessage": {
    operationId: "cancelScheduledMessage",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/scheduled-messages/{scheduled_message_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "listPersonalReminders": {
    operationId: "listPersonalReminders",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/reminders",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: {
      "items": []
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "createPersonalReminder": {
    operationId: "createPersonalReminder",
    method: "post",
    path: "/organisations/{organisation_id}/workspace/reminders",
    status: 201,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000420",
      "channelId": "00000000-0000-7000-8000-000000000002",
      "roomId": "!general:acme.kodera.io",
      "targetEventId": "$event_demo_001",
      "note": "Relire le compte-rendu",
      "remindAt": "2026-06-09T09:00:00Z",
      "state": "pending",
      "notificationId": null,
      "createdAt": "2026-06-08T10:00:00Z",
      "updatedAt": "2026-06-08T10:00:00Z"
    },
    isList: false,
    idempotent: true,
    requiresIfMatch: false,
  },
  "updatePersonalReminder": {
    operationId: "updatePersonalReminder",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/reminders/{reminder_id}",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "id": "00000000-0000-7000-8000-000000000420",
      "channelId": "00000000-0000-7000-8000-000000000002",
      "roomId": "!general:acme.kodera.io",
      "targetEventId": "$event_demo_001",
      "note": "Relire le compte-rendu",
      "remindAt": "2026-06-09T09:00:00Z",
      "state": "pending",
      "notificationId": null,
      "createdAt": "2026-06-08T10:00:00Z",
      "updatedAt": "2026-06-08T10:00:00Z"
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
  "deletePersonalReminder": {
    operationId: "deletePersonalReminder",
    method: "delete",
    path: "/organisations/{organisation_id}/workspace/reminders/{reminder_id}",
    status: 204,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562"
    },
    body: null,
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "getMyWorkspacePreferences": {
    operationId: "getMyWorkspacePreferences",
    method: "get",
    path: "/organisations/{organisation_id}/workspace/preferences/me",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "labsFlags": {
        "send_later": true,
        "custom_emojis": true,
        "personal_reminders": true,
        "waiting_room_ambience": true
      },
      "waitingRoomAmbience": false,
      "updatedAt": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: false,
  },
  "updateMyWorkspacePreferences": {
    operationId: "updateMyWorkspacePreferences",
    method: "patch",
    path: "/organisations/{organisation_id}/workspace/preferences/me",
    status: 200,
    headers: {
      "X-Request-Id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
      "ETag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
    },
    body: {
      "labsFlags": {
        "send_later": true,
        "custom_emojis": true,
        "personal_reminders": true,
        "waiting_room_ambience": true
      },
      "waitingRoomAmbience": false,
      "updatedAt": null
    },
    isList: false,
    idempotent: false,
    requiresIfMatch: true,
  },
} satisfies Record<string, OperationExample>

export type OperationId = keyof typeof EXAMPLES
