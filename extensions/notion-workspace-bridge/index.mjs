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
  readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')
);

const REVERSE_DNS_ID_PREFIX = 'io.kodera.ext.';
const REVERSE_DNS_ID_PATTERN = /^io\.kodera\.ext\.([a-z0-9][a-z0-9-]{1,62})$/;
const SLUG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const NOTION_PAGE_ID_PATTERN = /^[A-Za-z0-9_.:-]{2,120}$/;

export const NOTION_BRIDGE_EVENTS = Object.freeze([
  'page.shared',
  'page.updated',
  'database.entry_synced',
]);

export const SUPPORTED_NOTION_SUBCOMMANDS = Object.freeze([
  'share',
  'sync',
  'database',
  'status',
]);

/**
 * Validates and normalizes the `notion-workspace-bridge` manifest against `@kodera/extension-sdk`.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateNotionManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateNotionManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Validates a Notion page or database entry identifier.
 *
 * @param {unknown} rawPageId
 * @returns {string}
 */
export function validateNotionPageId(rawPageId) {
  if (typeof rawPageId !== 'string' || !NOTION_PAGE_ID_PATTERN.test(rawPageId.trim())) {
    throw new ExtensionSdkError(
      'INVALID_NOTION_PAGE_ID',
      'Notion page or database identifier must be an alphanumeric slug/UUID (2-120 chars).'
    );
  }
  return rawPageId.trim();
}

/**
 * Validates a Notion or companion Docs HTTPS URL via `@kodera/extension-sdk`'s `validateEndpointUrl`.
 *
 * @param {unknown} rawUrl
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 * @returns {string}
 */
export function validateNotionUrl(rawUrl, options = {}) {
  return validateEndpointUrl(String(rawUrl ?? ''), {
    allowLocalhostHttp: Boolean(options.allowLocalhostHttp),
  });
}

const MARKUP_BLOCK_TAGS = Object.freeze(['script', 'style', 'iframe']);
const MARKUP_TAG_BOUNDARY = Object.freeze([' ', '\t', '\n', '\r', '\f', '\v', '>', '/']);

/**
 * Removes one forward pass of `<script>`, `<style>`, and `<iframe>` blocks — opening
 * tag, inner body, and closing tag — using case-insensitive `indexOf` scans only.
 * No HTML-tag regular expression is involved, so `<SCRIPT>`, `<script\n foo>`, and
 * `</script >` are all handled identically.
 *
 * @param {string} input
 * @returns {string}
 */
function removeMarkupBlocksOnce(input) {
  const lower = input.toLowerCase();
  let out = '';
  let copiedUntil = 0;
  let searchFrom = 0;

  while (searchFrom < input.length) {
    let start = -1;
    let name = '';
    for (const candidate of MARKUP_BLOCK_TAGS) {
      const at = lower.indexOf(`<${candidate}`, searchFrom);
      if (at !== -1 && (start === -1 || at < start)) {
        start = at;
        name = candidate;
      }
    }
    if (start === -1) {
      break;
    }

    const afterName = start + 1 + name.length;
    const boundary = input[afterName];
    if (boundary !== undefined && !MARKUP_TAG_BOUNDARY.includes(boundary)) {
      // `<scripted` opens no block; keep scanning just past this angle bracket.
      searchFrom = start + 1;
      continue;
    }

    let end = input.length;
    const closeAt = lower.indexOf(`</${name}`, afterName);
    if (closeAt !== -1) {
      const closeEnd = input.indexOf('>', closeAt + 2 + name.length);
      end = closeEnd === -1 ? input.length : closeEnd + 1;
    }

    out += input.slice(copiedUntil, start);
    copiedUntil = end;
    searchFrom = end;
  }

  return copiedUntil === 0 ? input : out + input.slice(copiedUntil);
}

/**
 * Strips every HTML construct from untrusted text in linear time: block tags go first
 * with their bodies, repeated until the result stops changing because splicing two
 * halves can reveal a fresh `<script`, then any remaining tag — and any stray angle
 * bracket — is dropped character by character.
 *
 * @param {string} input
 * @returns {string}
 */
function stripMarkupText(input) {
  let text = input;
  for (;;) {
    const next = removeMarkupBlocksOnce(text);
    if (next === text) {
      break;
    }
    text = next;
  }

  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '>') {
      continue;
    }
    if (char !== '<') {
      out += char;
      continue;
    }
    const next = text[i + 1] ?? '';
    const opensTag =
      next === '/'
      || next === '!'
      || next === '?'
      || (next >= 'a' && next <= 'z')
      || (next >= 'A' && next <= 'Z');
    const tagEnd = opensTag ? text.indexOf('>', i + 1) : -1;
    if (tagEnd !== -1) {
      i = tagEnd;
    }
  }
  return out;
}

/**
 * Sanitizes untrusted Notion page titles, database names, and status properties.
 *
 * @param {unknown} rawValue
 * @param {string} fallback
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeNotionText(rawValue, fallback, maxLength = 160) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const cleaned = stripMarkupText(
    rawValue
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  )
    .replace(/\[([^\]]+)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) {
    return fallback;
  }
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/**
 * Executes `/notion-page` slash command.
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleNotionPageCommand(input = {}) {
  const channelId =
    typeof input.channelId === 'string' && input.channelId.trim()
      ? input.channelId.trim()
      : 'chan_productivite';
  const actorId =
    typeof input.actorId === 'string' && input.actorId.trim()
      ? input.actorId.trim()
      : 'usr_membre';

  const rawCommandLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/notion-page ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawCommandLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'share';
  if (!SUPPORTED_NOTION_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_NOTION_SUBCOMMAND',
      `Sous-commande /notion-page inconnue "${subcommand}". Attendu : ${SUPPORTED_NOTION_SUBCOMMANDS.join(', ')}.`
    );
  }

  const pageId = validateNotionPageId(
    String(parsed.flags.page ?? parsed.args[0] ?? `notion-page-${channelId}`)
  );
  const title = sanitizeNotionText(
    parsed.flags.title ?? 'Base de connaissances & suivi projet',
    'Base de connaissances & suivi projet',
    120
  );
  const databaseName = sanitizeNotionText(
    parsed.flags.database ?? 'Roadmap Produit',
    'Roadmap Produit',
    80
  );

  const pageUrl = validateNotionUrl(
    typeof parsed.flags.url === 'string'
      ? parsed.flags.url
      : `https://www.notion.so/kodera/${encodeURIComponent(pageId)}`
  );
  const docsCompanionUrl = validateNotionUrl(
    typeof parsed.flags['docs-url'] === 'string'
      ? parsed.flags['docs-url']
      : `https://docs.kodera.io/pads/${encodeURIComponent(pageId)}`
  );

  return {
    text: `[Notion × Docs] Page **${title}** (\`${pageId}\`, base : *${databaseName}*) partagée dans <#${channelId}> par <@${actorId}> — Notion : ${pageUrl} • Pad Docs compagnon : ${docsCompanionUrl}`,
    ephemeral: subcommand === 'status',
    subcommand,
    pageId,
    title,
    databaseName,
    pageUrl,
    docsCompanionUrl,
  };
}

export const notionPageCommand = defineSlashCommand({
  name: '/notion-page',
  description:
    'Partager ou synchroniser une page ou entrée de base Notion aux côtés de Docs',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) =>
    handleNotionPageCommand({ args, channelId, actorId }),
});

/**
 * Builds a structured channel card for a Notion page or database entry alongside Docs.
 *
 * @param {'page.shared' | 'page.updated' | 'database.entry_synced'} eventName
 * @param {Record<string, unknown>} payload
 * @param {string} [defaultChannelId]
 */
export function buildNotionBridgeCard(eventName, payload, defaultChannelId = 'chan_productivite') {
  if (!NOTION_BRIDGE_EVENTS.includes(eventName)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_NOTION_EVENT',
      `Unsupported Notion bridge event "${String(eventName)}".`
    );
  }

  const pageId = validateNotionPageId(payload.pageId ?? payload.id ?? 'notion-entry-01');
  const title = sanitizeNotionText(payload.title ?? 'Page Notion sans titre', 'Page Notion sans titre', 160);
  const workspaceName = sanitizeNotionText(
    payload.workspaceName ?? payload.workspace ?? 'Espace Notion',
    'Espace Notion',
    80
  );
  const databaseName = sanitizeNotionText(payload.databaseName ?? payload.database ?? '', '', 80);
  const statusProperty = sanitizeNotionText(payload.status ?? 'En cours', 'En cours', 40);
  const author = sanitizeNotionText(payload.author ?? payload.actor, 'Équipe Kodera', 80);
  const pageUrl = validateNotionUrl(
    payload.pageUrl ?? payload.url ?? `https://www.notion.so/kodera/${encodeURIComponent(pageId)}`
  );
  const docsCompanionUrl =
    payload.docsCompanionUrl !== undefined
      ? validateNotionUrl(payload.docsCompanionUrl)
      : `https://docs.kodera.io/pads/${encodeURIComponent(pageId)}`;
  const channelId = String(payload.channelId ?? defaultChannelId);
  const revision = String(payload.revision ?? payload.lastEditedTime ?? '1').replace(/[^A-Za-z0-9_.:-]/g, '');
  const idempotencyKey = `notion:${pageId}:${eventName}:${revision}`;

  const badges = {
    'page.shared': '[NOTION PAGE PARTAGÉE]',
    'page.updated': '[NOTION PAGE MISE À JOUR]',
    'database.entry_synced': '[NOTION ENTRÉE BASE SYNCHRONISÉE]',
  };

  const badge = badges[eventName];
  const dbSegment = databaseName ? ` (base : **${databaseName}**, statut : \`${statusProperty}\`)` : '';
  const text = `${badge} **${title}** (\`${pageId}\`) dans *${workspaceName}*${dbSegment} par **${author}**\nLien Notion : ${pageUrl}\nPad Docs associé : ${docsCompanionUrl}`;

  const block = {
    type: 'notion_workspace_card',
    event: eventName,
    pageId,
    title,
    workspaceName,
    ...(databaseName ? { databaseName, status: statusProperty } : {}),
    author,
    pageUrl,
    docsCompanionUrl,
  };

  return {
    channelId,
    event: eventName,
    pageId,
    title,
    pageUrl,
    docsCompanionUrl,
    idempotencyKey,
    text,
    blocks: [block],
  };
}

/**
 * Creates a replay-protected webhook handler for the Notion Workspace Bridge.
 *
 * @param {{
 *   secret: string,
 *   defaultChannelId?: string,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createNotionWorkspaceWebhookHandler(config) {
  const defaultChannelId = config.defaultChannelId ?? 'chan_productivite';
  const configuredClient = config.client;

  /**
   * @param {'page.shared' | 'page.updated' | 'database.entry_synced'} eventName
   */
  function createNotionEventHandler(eventName) {
    /**
     * @param {Record<string, unknown>} payload
     * @param {{ client?: ReturnType<typeof createExtensionClient> }} ctx
     */
    return async (payload, { client }) => {
      const card = buildNotionBridgeCard(eventName, payload, defaultChannelId);
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
          pageId: card.pageId,
          idempotencyKey: card.idempotencyKey,
          pageUrl: card.pageUrl,
          docsCompanionUrl: card.docsCompanionUrl,
          delivery,
        };
      }
      return {
        posted: false,
        event: eventName,
        pageId: card.pageId,
        idempotencyKey: card.idempotencyKey,
        pageUrl: card.pageUrl,
        docsCompanionUrl: card.docsCompanionUrl,
        text: card.text,
        blocks: card.blocks,
      };
    };
  }

  return createWebhookHandler({
    secret: config.secret,
    client: configuredClient,
    handlers: {
      'page.shared': createNotionEventHandler('page.shared'),
      'page.updated': createNotionEventHandler('page.updated'),
      'database.entry_synced': createNotionEventHandler('database.entry_synced'),
      'command.invoked': async (payload) => {
        return notionPageCommand.handler({
          command: 'notion-page',
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
  NOTION_BRIDGE_EVENTS,
  notionPageCommand,
  handleNotionPageCommand,
  validateNotionPageId,
  validateNotionUrl,
  buildNotionBridgeCard,
  createNotionWorkspaceWebhookHandler,
};
