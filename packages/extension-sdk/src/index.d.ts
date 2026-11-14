export const MANIFEST_SCHEMA_VERSION = 'kodera.extension.v1';
export const SIGNATURE_HEADER = 'x-kodera-signature-256';
export const TIMESTAMP_HEADER = 'x-kodera-timestamp';
export const EVENT_HEADER = 'x-kodera-event';
export const DELIVERY_ID_HEADER = 'x-kodera-delivery-id';
export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const DEFAULT_TOLERANCE_SECONDS = 300;
export const MAX_WEBHOOK_REPLAY_ENTRIES = 4096;
export const MAX_WEBHOOK_BODY_BYTES = 1048576;

export type ExtensionScope =
  | 'messages:write'
  | 'ephemeral:write'
  | 'channels:read'
  | 'webhooks:incoming'
  | 'incidents:write'
  | 'threads:write'
  | 'commands:register';

export type ExtensionEvent =
  | 'command.invoked'
  | 'message.created'
  | 'message.deleted'
  | 'release.published'
  | 'ci.workflow_failed'
  | 'incident.opened'
  | 'incident.acknowledged'
  | 'incident.resolved';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IncidentStatus = 'open' | 'investigating' | 'acknowledged' | 'mitigated' | 'resolved';

export const ALLOWED_EXTENSION_SCOPES: readonly ExtensionScope[];
export const EXTENSION_SCOPES: readonly ExtensionScope[];
export const EXTENSION_EVENTS: readonly ExtensionEvent[];
export const INCIDENT_SEVERITIES: readonly IncidentSeverity[];
export const INCIDENT_STATUSES: readonly IncidentStatus[];

export class WebhookVerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export class ExtensionSdkError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number);
}

export interface EndpointValidationOptions {
  allowLocalhostHttp?: boolean;
}

export function validateEndpointUrl(
  rawUrl: string,
  options?: EndpointValidationOptions
): string;

export interface ExtensionManifestCommand {
  readonly name: string;
  readonly description: string;
}

export interface ValidatedExtensionManifest {
  readonly schemaVersion: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly scopes: readonly ExtensionScope[];
  readonly events: readonly ExtensionEvent[];
  readonly webhookUrl?: string;
  readonly commands: readonly ExtensionManifestCommand[];
}

export function validateManifest(
  manifest: Record<string, unknown>,
  options?: EndpointValidationOptions
): ValidatedExtensionManifest;

export function getHeaderValue(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string
): string | undefined;

export function signWebhookPayload(
  secret: string,
  timestampUnixSeconds: number | string,
  rawBody: string | Uint8Array
): string;

export interface VerifyWebhookParams {
  secret: string;
  rawBody: string | Uint8Array;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  nowUnixSeconds?: number;
  maxSkewSeconds?: number;
}

export function verifyWebhookRequest(params: VerifyWebhookParams): Record<string, unknown>;

export interface VerifyWebhookSignatureParams {
  secret: string;
  rawBody?: string | Uint8Array;
  payload?: string | Uint8Array;
  signatureHeader?: string;
  signature?: string;
  timestampHeader?: string | number;
  timestamp?: string | number;
  nowUnixSeconds?: number;
  nowSeconds?: number;
  maxSkewSeconds?: number;
  toleranceSeconds?: number;
}

export function verifyWebhookSignature(params: VerifyWebhookSignatureParams): Record<string, unknown>;

export interface WebhookEventContext {
  event: string;
  deliveryId: string | undefined;
  timestamp: number;
  headers: Headers | Record<string, string | string[] | undefined>;
  client?: ExtensionClient;
}

export type WebhookEventHandler = (
  payload: Record<string, unknown>,
  ctx: WebhookEventContext
) => Promise<unknown> | unknown;

export interface WebhookHandlerOptions {
  secret: string;
  maxSkewSeconds?: number;
  toleranceSeconds?: number;
  maxReplayEntries?: number;
  handlers?: Record<string, WebhookEventHandler>;
  onEvent?: WebhookEventHandler;
  client?: ExtensionClient;
}

export interface IncomingWebhookRequest {
  rawBody: string | Uint8Array;
  headers: Headers | Record<string, string | string[] | undefined>;
  nowUnixSeconds?: number;
  nowSeconds?: number;
  client?: ExtensionClient;
}

export interface WebhookHandlerResponse {
  ok: boolean;
  status: number;
  event: string;
  deliveryId: string | undefined;
  result: unknown;
}

export function createWebhookHandler(
  options: WebhookHandlerOptions
): (req: IncomingWebhookRequest) => Promise<WebhookHandlerResponse>;

export interface SlashCommandContext {
  command: string;
  args: string;
  channelId: string;
  actorId: string;
}

export interface SlashCommandResponse {
  text: string;
  ephemeral?: boolean;
}

export interface SlashCommandDefinition {
  name: string;
  description: string;
  scopes?: readonly ExtensionScope[];
  handler: (ctx: SlashCommandContext) => Promise<SlashCommandResponse> | SlashCommandResponse;
}

export function defineSlashCommand(
  definition: SlashCommandDefinition
): Readonly<Required<SlashCommandDefinition>>;

export interface ParsedCommandInvocation {
  readonly command: string;
  readonly subcommand: string | null;
  readonly args: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseCommandInvocation(rawText: string): ParsedCommandInvocation;

export interface ExtensionClientConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  allowLocalhostHttp?: boolean;
}

export interface PostChannelMessageParams {
  channelId: string;
  text: string;
  blocks?: readonly Record<string, unknown>[];
  idempotencyKey?: string;
}

export interface PostThreadReplyParams {
  channelId: string;
  threadRootId: string;
  text: string;
  blocks?: readonly Record<string, unknown>[];
  idempotencyKey?: string;
}

export interface PostIncidentCardParams {
  channelId: string;
  title: string;
  severity: IncidentSeverity;
  summary: string;
  externalUrl?: string;
  status?: IncidentStatus;
  idempotencyKey?: string;
}

export interface ExtensionClient {
  postChannelMessage(params: PostChannelMessageParams): Promise<Record<string, unknown>>;
  postThreadReply(params: PostThreadReplyParams): Promise<Record<string, unknown>>;
  postIncidentCard(params: PostIncidentCardParams): Promise<Record<string, unknown>>;
}

export function createExtensionClient(config: ExtensionClientConfig): ExtensionClient;

export interface RecordedClientCall {
  id: string;
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  idempotencyKey: string;
  timestamp: number;
}

export interface TestHarnessDelivery {
  event?: string;
  payload: Record<string, unknown>;
  deliveryId?: string;
  timestampSeconds?: number;
  secretOverride?: string;
  rawBodyOverride?: string;
  headersOverride?: Record<string, string>;
}

export interface TestHarnessDeliveryResult {
  deliveryId: string;
  timestamp: number;
  signature: string;
  headers: Record<string, string>;
  rawBody: string;
  response: unknown;
}

export interface ExtensionTestHarness {
  readonly client: ExtensionClient;
  readonly recordedCalls: RecordedClientCall[];
  readonly calls: RecordedClientCall[];
  readonly outbox: RecordedClientCall[];
  getNow(): number;
  advanceTime(seconds: number): number;
  setTime(unixSeconds: number): number;
  clearRecordedCalls(): void;
  sendWebhook(delivery: TestHarnessDelivery): Promise<TestHarnessDeliveryResult>;
  deliver(delivery: TestHarnessDelivery): Promise<TestHarnessDeliveryResult>;
}

export interface ExtensionTestHarnessOptions {
  secret?: string;
  handler: (req: {
    secret: string;
    rawBody: string;
    headers: Record<string, string>;
    nowUnixSeconds: number;
    nowSeconds: number;
    client: ExtensionClient;
  }) => Promise<unknown> | unknown;
  nowSeconds?: number;
  nowUnixSeconds?: number;
  baseUrl?: string;
  token?: string;
}

export function createExtensionTestHarness(
  options: ExtensionTestHarnessOptions
): ExtensionTestHarness;

/** Additive v2 body bindings with the unchanged v1 HMAC transcript. */
export interface RotationConfiguration {
  organisationId: string;
  installationId: string;
  current: { generation: string; secret?: string };
  previous?: { generation: string; secret: string; expiresAt: number };
  nowUnixSeconds?: number;
  maxSkewSeconds?: number;
}
export interface RotatingWebhookRequest extends RotationConfiguration {
  rawBody: string | Uint8Array;
  signatureHeader?: string;
  previousSignatureHeader?: string;
  timestampHeader?: string;
  eventHeader?: string;
  deliveryIdHeader?: string;
}
export function verifyRotatingWebhookRequest(options: RotatingWebhookRequest): Record<string, unknown>;
export function createRotatingWebhookVerifier(configuration: RotationConfiguration): (
  options: Omit<RotatingWebhookRequest, keyof RotationConfiguration> & Partial<RotationConfiguration>
) => Record<string, unknown>;
