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
              "room_state": "ready"
            },
            {
              "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd1",
              "kind": "text",
              "name": "general",
              "template_key": "general",
              "topic": "",
              "lifecycle": "active",
              "room_state": "ready"
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
              "room_state": "pending"
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
      "role": "viewer"
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
} satisfies Record<string, OperationExample>

export type OperationId = keyof typeof EXAMPLES
