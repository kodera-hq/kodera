/**
 * Docs (`docs.<tenant>.kodera.io`) collaborative document surface types.
 *
 * Aligns with Core ADR-0023 tenant host reservation rules and the console's
 * application rail (`AppCode = 'docs'`).
 */

export interface TenantDocsOriginOptions {
  readonly tenantSlug: string
  readonly baseDomain?: string | undefined
}

export interface ChannelDocsPadUrlOptions {
  readonly tenantSlug: string
  readonly channelId: string
  readonly channelName: string
  readonly docId?: string | undefined
  readonly baseDomain?: string | undefined
}

export interface ChannelDocsPadDescriptor {
  readonly id: string
  readonly title: string
  readonly channelId: string
  readonly channelName: string
  readonly padSlug: string
  readonly url: string
  readonly updatedAtLabel?: string | undefined
}

export type DocsPostMessageEventType =
  | 'docs:pad:ready'
  | 'docs:pad:title-updated'
  | 'docs:pad:share-to-channel'

export interface DocsPostMessagePayload {
  readonly type: DocsPostMessageEventType
  readonly padId: string
  readonly title?: string | undefined
  readonly padUrl?: string | undefined
}

export type DocsUrlValidationResult =
  | { readonly ok: true; readonly normalizedUrl: string; readonly origin: string }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid_url'
        | 'disallowed_protocol'
        | 'credentials_forbidden'
        | 'origin_mismatch'
        | 'path_traversal'
    }
