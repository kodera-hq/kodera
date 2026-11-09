import { readFileSync } from 'node:fs';
import {
  ExtensionSdkError,
  MANIFEST_SCHEMA_VERSION,
  createExtensionClient,
  createWebhookHandler,
  defineSlashCommand,
  parseCommandInvocation,
  validateEndpointUrl,
  validateManifest,
} from '@kodera/extension-sdk';

const rawManifest = JSON.parse(
  readFileSync(new URL('./extension.json', import.meta.url), 'utf8')
);

const REVERSE_DNS_ID_PREFIX = 'io.kodera.ext.';
const REVERSE_DNS_ID_PATTERN = /^io\.kodera\.ext\.([a-z0-9][a-z0-9-]{1,62})$/;
const SLUG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_.-]{3,128}$/;

export const GDRIVE_ACCESS_MODES = Object.freeze([
  'lecture',
  'commentaire',
  'édition',
]);

export const GDRIVE_ACCESS_BADGES = Object.freeze({
  lecture: '[ACCÈS : LECTURE]',
  commentaire: '[ACCÈS : COMMENTAIRE]',
  édition: '[ACCÈS : ÉDITION]',
});

export const ALLOWED_GDRIVE_HOSTS = Object.freeze([
  'drive.google.com',
  'docs.google.com',
]);

/**
 * Validates and normalizes the `gdrive-document-share` manifest against `@kodera/extension-sdk`.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateGdriveManifest(input = rawManifest, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExtensionSdkError('INVALID_MANIFEST', 'Extension manifest must be a non-null JSON object.');
  }

  const schemaVersion = String(input.schemaVersion ?? input.schema ?? MANIFEST_SCHEMA_VERSION);
  const rawId = typeof input.id === 'string' ? input.id.trim() : '';
  let slugId = rawId;
  let canonicalId = rawId;

  const reverseMatch = REVERSE_DNS_ID_PATTERN.exec(rawId);
  if (reverseMatch) {
    slugId = reverseMatch[1];
    canonicalId = rawId;
  } else if (SLUG_ID_PATTERN.test(rawId)) {
    slugId = rawId;
    canonicalId = `${REVERSE_DNS_ID_PREFIX}${rawId}`;
  } else {
    throw new ExtensionSdkError(
      'INVALID_MANIFEST_ID',
      `Manifest "id" must be a reverse-DNS identifier ("io.kodera.ext.<slug>") or lowercase slug (received "${rawId}").`
    );
  }

  const rawScopes = Array.isArray(input.scopes)
    ? input.scopes
    : Array.isArray(input.permissions)
      ? input.permissions
      : [];

  const rawCommands = Array.isArray(input.commands) ? input.commands : [];
  const normalizedCommands = rawCommands.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }
    const cmdRecord = /** @type {Record<string, unknown>} */ (entry);
    return {
      ...cmdRecord,
      name: String(cmdRecord.name ?? cmdRecord.command ?? ''),
      description: String(cmdRecord.description ?? ''),
    };
  });

  const description =
    typeof input.description === 'string' && input.description.trim().length > 0
      ? input.description.trim()
      : `${String(input.name ?? slugId)} extension`;

  const sdkValidated = validateManifest(
    {
      ...input,
      schemaVersion,
      id: slugId,
      description,
      scopes: rawScopes,
      commands: normalizedCommands,
    },
    options
  );

  return Object.freeze({
    ...sdkValidated,
    schema: schemaVersion,
    canonicalId,
    slug: slugId,
    permissions: sdkValidated.scopes,
    commands: Object.freeze(
      sdkValidated.commands.map((cmd) =>
        Object.freeze({
          name: cmd.name,
          command: `/${cmd.name}`,
          description: cmd.description,
        })
      )
    ),
  });
}

export const extensionManifest = validateGdriveManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Normalizes a Google Drive access mode into one of `'lecture' | 'commentaire' | 'édition'`.
 *
 * @param {unknown} rawMode
 * @returns {'lecture' | 'commentaire' | 'édition'}
 */
export function normalizeGdriveAccessMode(rawMode) {
  if (rawMode === undefined || rawMode === null || rawMode === '') {
    return 'lecture';
  }
  const value = String(rawMode).trim().toLowerCase();
  if (value === 'lecture' || value === 'read' || value === 'view' || value === 'reader') {
    return 'lecture';
  }
  if (value === 'commentaire' || value === 'comment' || value === 'commenter') {
    return 'commentaire';
  }
  if (
    value === 'édition' ||
    value === 'edition' ||
    value === 'edit' ||
    value === 'write' ||
    value === 'editor'
  ) {
    return 'édition';
  }
  throw new ExtensionSdkError(
    'INVALID_GDRIVE_ACCESS_MODE',
    `Invalid Google Drive access mode "${String(rawMode)}". Expected one of: ${GDRIVE_ACCESS_MODES.join(', ')}.`
  );
}

/**
 * Validates a Google Drive file or folder URL via `@kodera/extension-sdk`'s `validateEndpointUrl`
 * (HTTPS only, SSRF-safe) and restricts the host to `drive.google.com` or `docs.google.com`.
 *
 * @param {unknown} rawUrl
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 * @returns {string}
 */
export function validateGdriveUrl(rawUrl, options = {}) {
  const validated = validateEndpointUrl(String(rawUrl ?? ''), {
    allowLocalhostHttp: Boolean(options.allowLocalhostHttp),
  });
  const parsed = new URL(validated);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!ALLOWED_GDRIVE_HOSTS.includes(host)) {
    throw new ExtensionSdkError(
      'UNTRUSTED_GDRIVE_HOST',
      `Google Drive host "${host}" is not allowed; expected drive.google.com or docs.google.com.`
    );
  }
  return validated;
}

/**
 * Sanitizes untrusted Google Drive file names and descriptions.
 *
 * @param {unknown} rawValue
 * @param {string} fallback
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeGdriveText(rawValue, fallback, maxLength = 160) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const cleaned = rawValue
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/\[([^\]]+)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, '$1')
    .replace(/[*_`~<>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) {
    return fallback;
  }
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/**
 * Executes `/gdrive-share` slash command.
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleGdriveShareCommand(input = {}) {
  const channelId =
    typeof input.channelId === 'string' && input.channelId.trim()
      ? input.channelId.trim()
      : 'chan_documents';
  const actorId =
    typeof input.actorId === 'string' && input.actorId.trim()
      ? input.actorId.trim()
      : 'usr_membre';

  const rawCommandLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/gdrive-share ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawCommandLine);
  const accessMode = normalizeGdriveAccessMode(
    parsed.flags.mode ?? parsed.flags.access ?? parsed.subcommand ?? 'lecture'
  );
  const accessBadge = GDRIVE_ACCESS_BADGES[accessBadgeKey(accessMode)];
  const resourceKind =
    String(parsed.flags.kind ?? 'file').toLowerCase() === 'folder' ? 'folder' : 'file';
  const rawFileId = String(parsed.flags.id ?? parsed.args[0] ?? '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
  if (!FILE_ID_PATTERN.test(rawFileId)) {
    throw new ExtensionSdkError('INVALID_GDRIVE_ID', 'Invalid Google Drive file or folder ID.');
  }

  const title = sanitizeGdriveText(
    parsed.flags.title ?? (resourceKind === 'folder' ? 'Dossier partagé Google Drive' : 'Document Google Drive'),
    'Document Google Drive',
    120
  );

  const defaultUrl =
    resourceKind === 'folder'
      ? `https://drive.google.com/drive/folders/${encodeURIComponent(rawFileId)}`
      : `https://drive.google.com/file/d/${encodeURIComponent(rawFileId)}/view`;

  const resourceUrl = validateGdriveUrl(
    typeof parsed.flags.url === 'string' ? parsed.flags.url : defaultUrl
  );

  const kindLabel = resourceKind === 'folder' ? 'Dossier' : 'Fichier';

  return {
    text: `[Google Drive] ${accessBadge} ${kindLabel} **${title}** (\`mode: ${accessMode}\`) partagé dans <#${channelId}> par <@${actorId}> : ${resourceUrl}`,
    ephemeral: false,
    accessMode,
    accessBadge,
    resourceKind,
    fileId: rawFileId,
    title,
    resourceUrl,
  };
}

/**
 * @param {'lecture' | 'commentaire' | 'édition'} mode
 */
function accessBadgeKey(mode) {
  return mode;
}

export const gdriveShareCommand = defineSlashCommand({
  name: '/gdrive-share',
  description:
    'Partager un fichier ou dossier Google Drive avec badge de permission (lecture, commentaire, édition)',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) =>
    handleGdriveShareCommand({ args, channelId, actorId }),
});

/**
 * Builds a structured Google Drive share card with access-mode badge (`lecture`, `commentaire`, `édition`).
 *
 * @param {'file.shared' | 'folder.shared' | 'permission.updated'} eventName
 * @param {Record<string, unknown>} payload
 * @param {string} [defaultChannelId]
 */
export function buildGdriveShareCard(eventName, payload, defaultChannelId = 'chan_documents') {
  const accessMode = normalizeGdriveAccessMode(payload.accessMode ?? payload.mode ?? 'lecture');
  const accessBadge = GDRIVE_ACCESS_BADGES[accessMode];
  const resourceKind =
    eventName === 'folder.shared' || payload.kind === 'folder' ? 'folder' : 'file';
  const fileId = String(payload.fileId ?? payload.id ?? 'gdrive_item_01').replace(
    /[^A-Za-z0-9_.-]/g,
    ''
  );
  if (!FILE_ID_PATTERN.test(fileId)) {
    throw new ExtensionSdkError('INVALID_GDRIVE_ID', 'Invalid Google Drive file or folder ID.');
  }

  const title = sanitizeGdriveText(payload.title ?? payload.name ?? 'Fichier Google Drive', 'Fichier Google Drive', 160);
  const sharedBy = sanitizeGdriveText(payload.sharedBy ?? payload.actor ?? 'Équipe Kodera', 'Équipe Kodera', 80);
  const mimeType = sanitizeGdriveText(
    payload.mimeType ?? (resourceKind === 'folder' ? 'application/vnd.google-apps.folder' : 'application/pdf'),
    'application/octet-stream',
    80
  );

  const defaultUrl =
    resourceKind === 'folder'
      ? `https://drive.google.com/drive/folders/${encodeURIComponent(fileId)}`
      : `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

  const resourceUrl = validateGdriveUrl(payload.url ?? payload.resourceUrl ?? defaultUrl);
  const channelId = String(payload.channelId ?? defaultChannelId);
  const idempotencyKey = `gdrive:${eventName}:${fileId}:${accessMode}`;

  const kindLabel = resourceKind === 'folder' ? 'Dossier Google Drive' : 'Fichier Google Drive';
  const text = `[GOOGLE DRIVE] ${accessBadge} **${title}** (${kindLabel} • droit : \`${accessMode}\`) partagé par **${sharedBy}**\nLien : ${resourceUrl}`;

  const block = {
    type: 'gdrive_share_card',
    event: eventName,
    fileId,
    resourceKind,
    title,
    accessMode,
    accessBadge,
    sharedBy,
    mimeType,
    resourceUrl,
  };

  return {
    channelId,
    event: eventName,
    fileId,
    resourceKind,
    title,
    accessMode,
    accessBadge,
    resourceUrl,
    idempotencyKey,
    text,
    blocks: [block],
  };
}

/**
 * Creates a replay-protected webhook handler for Google Drive Document & Folder Share.
 *
 * @param {{
 *   secret: string,
 *   defaultChannelId?: string,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createGdriveShareWebhookHandler(config) {
  const defaultChannelId = config.defaultChannelId ?? 'chan_documents';
  const configuredClient = config.client;

  /**
   * @param {'file.shared' | 'folder.shared' | 'permission.updated'} eventName
   */
  function createShareEventHandler(eventName) {
    /**
     * @param {Record<string, unknown>} payload
     * @param {{ client?: ReturnType<typeof createExtensionClient> }} ctx
     */
    return async (payload, { client }) => {
      const card = buildGdriveShareCard(eventName, payload, defaultChannelId);
      const activeClient = client ?? configuredClient;
      if (activeClient) {
        const delivery = await activeClient.postChannelMessage({
          channelId: card.channelId,
          text: card.text,
          blocks: card.blocks,
          idempotencyKey: card.idempotencyKey,
        });
        return {
          posted: true,
          event: eventName,
          fileId: card.fileId,
          accessMode: card.accessMode,
          accessBadge: card.accessBadge,
          idempotencyKey: card.idempotencyKey,
          resourceUrl: card.resourceUrl,
          delivery,
        };
      }
      return {
        posted: false,
        event: eventName,
        fileId: card.fileId,
        accessMode: card.accessMode,
        accessBadge: card.accessBadge,
        idempotencyKey: card.idempotencyKey,
        resourceUrl: card.resourceUrl,
        text: card.text,
        blocks: card.blocks,
      };
    };
  }

  return createWebhookHandler({
    secret: config.secret,
    client: configuredClient,
    handlers: {
      'file.shared': createShareEventHandler('file.shared'),
      'folder.shared': createShareEventHandler('folder.shared'),
      'permission.updated': createShareEventHandler('permission.updated'),
      'command.invoked': async (payload) => {
        return gdriveShareCommand.handler({
          command: 'gdrive-share',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_membre'),
        });
      },
    },
  });
}

export default {
  manifest,
  extensionManifest,
  GDRIVE_ACCESS_MODES,
  GDRIVE_ACCESS_BADGES,
  gdriveShareCommand,
  handleGdriveShareCommand,
  normalizeGdriveAccessMode,
  validateGdriveUrl,
  buildGdriveShareCard,
  createGdriveShareWebhookHandler,
};
