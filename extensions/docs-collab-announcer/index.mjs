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
const DOC_ID_PATTERN = /^[A-Za-z0-9_.:-]{2,120}$/;
const REVISION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SUPPORTED_DOC_SUBCOMMANDS = Object.freeze(['open', 'link', 'status']);

export const DOCS_LIFECYCLE_EVENTS = Object.freeze([
  'document.created',
  'document.published',
  'document.comment_resolved',
]);

/**
 * Normalizes a manifest object supporting both reverse-DNS (`io.kodera.ext.<slug>`)
 * and slug identifiers, `schema` / `schemaVersion`, `permissions` / `scopes`, and
 * `commands[].command` / `commands[].name`, then validates it with `@kodera/extension-sdk`.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateDocsManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateDocsManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Validates a Docs document identifier.
 *
 * @param {unknown} rawDocId
 * @returns {string}
 */
export function validateDocumentId(rawDocId) {
  if (typeof rawDocId !== 'string' || !DOC_ID_PATTERN.test(rawDocId.trim())) {
    throw new ExtensionSdkError(
      'INVALID_DOCUMENT_ID',
      'Document identifier must be an alphanumeric slug (2-120 chars).'
    );
  }
  return rawDocId.trim();
}

/**
 * Validates and normalizes a document revision identifier or number.
 *
 * @param {unknown} rawRevision
 * @returns {string}
 */
export function validateDocumentRevision(rawRevision) {
  if (rawRevision === undefined || rawRevision === null || rawRevision === '') {
    return '1';
  }
  const str = String(rawRevision).trim();
  if (!REVISION_PATTERN.test(str)) {
    throw new ExtensionSdkError(
      'INVALID_DOCUMENT_REVISION',
      `Invalid document revision "${str}".`
    );
  }
  return str;
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
 * Sanitizes untrusted document titles, authors, and comment excerpts against
 * control characters, HTML tags, script injection, and markdown link/formatting abuse.
 *
 * @param {unknown} rawValue
 * @param {string} fallback
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeDocText(rawValue, fallback, maxLength = 160) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }

  let cleaned = stripMarkupText(
    rawValue
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  )
    .replace(/\[\s*([^\]]+?)\s*\]\(\s*(?:javascript|data|vbscript):(?:\([^)]*\)|[^)])*\)/gi, '$1')
    .replace(/[*_`~[\]]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) {
    return fallback;
  }
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength)}…`;
  }
  return cleaned;
}

/**
 * Computes a deterministic idempotency key for a Docs lifecycle event:
 * `docs:<docId>:<event>:<revision>`.
 *
 * @param {string} docId
 * @param {string} event
 * @param {string | number} revision
 * @returns {string}
 */
export function computeDocsIdempotencyKey(docId, event, revision) {
  const safeDocId = validateDocumentId(docId);
  const safeRevision = validateDocumentRevision(revision);
  if (typeof event !== 'string' || !/^[a-z0-9._-]{3,64}$/.test(event)) {
    throw new ExtensionSdkError('INVALID_DOC_EVENT', `Invalid document lifecycle event "${String(event)}".`);
  }
  return `docs:${safeDocId}:${event}:${safeRevision}`;
}

/**
 * Executes the `/doc-pad` slash command supporting `open`, `link`, and `status`
 * subcommands as well as `--doc` and `--title` flags.
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleDocPadCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_docs_default';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_membre';

  const rawCommandLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/doc-pad ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawCommandLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'open';

  if (!SUPPORTED_DOC_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_DOC_SUBCOMMAND',
      `Sous-commande /doc-pad inconnue "${subcommand}". Attendu : ${SUPPORTED_DOC_SUBCOMMANDS.join(', ')}.`
    );
  }

  const rawDocFlag = parsed.flags.doc ?? parsed.args[0] ?? `pad-${channelId}`;
  const docId = validateDocumentId(String(rawDocFlag));
  const title = sanitizeDocText(
    parsed.flags.title ?? 'Notes collaboratives du salon',
    'Notes collaboratives du salon',
    120
  );
  const documentUrl = validateEndpointUrl(
    `https://docs.kodera.io/pads/${encodeURIComponent(docId)}`
  );

  if (subcommand === 'status') {
    return {
      text: `[Docs] État du pad **${title}** (\`${docId}\`) lié au salon <#${channelId}> — synchronisé (${documentUrl}).`,
      ephemeral: true,
      subcommand,
      docId,
      title,
      documentUrl,
    };
  }

  if (subcommand === 'link') {
    return {
      text: `[Docs] Document **${title}** (\`${docId}\`) associé au salon <#${channelId}> par <@${actorId}> : ${documentUrl}`,
      ephemeral: false,
      subcommand,
      docId,
      title,
      documentUrl,
    };
  }

  return {
    text: `[Docs] Pad collaboratif **${title}** (\`${docId}\`) ouvert par <@${actorId}> : ${documentUrl}`,
    ephemeral: false,
    subcommand: 'open',
    docId,
    title,
    documentUrl,
  };
}

export const docPadCommand = defineSlashCommand({
  name: '/doc-pad',
  description: 'Partager ou ouvrir un document collaboratif Docs lié au salon',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) =>
    handleDocPadCommand({ args, channelId, actorId }),
});

/**
 * Formats a French Espace announcement card for a Docs lifecycle event.
 *
 * @param {'document.created' | 'document.published' | 'document.comment_resolved'} eventName
 * @param {Record<string, unknown>} payload
 * @param {string} defaultChannelId
 */
function buildDocsLifecycleAnnouncement(eventName, payload, defaultChannelId) {
  const docId = validateDocumentId(payload.docId ?? payload.documentId ?? payload.id);
  const revision = validateDocumentRevision(payload.revision ?? payload.rev ?? 1);
  const rawUrl = String(payload.documentUrl ?? payload.url ?? '');
  const documentUrl = validateEndpointUrl(rawUrl, { allowLocalhostHttp: false });
  const channelId = String(payload.channelId ?? defaultChannelId);
  const title = sanitizeDocText(payload.title, 'Document sans titre', 160);
  const author = sanitizeDocText(payload.author ?? payload.actor, 'Équipe Kodera', 80);
  const commentSummary = sanitizeDocText(payload.commentSummary ?? payload.summary ?? '', '', 280);
  const idempotencyKey = computeDocsIdempotencyKey(docId, eventName, revision);

  let headerLabel = '[NOUVEAU PAD DOCS]';
  let actionPhrase = `créé par **${author}**`;
  if (eventName === 'document.published') {
    headerLabel = '[DOCUMENT PUBLIÉ]';
    actionPhrase = `publié par **${author}**`;
  } else if (eventName === 'document.comment_resolved') {
    headerLabel = '[COMMENTAIRE RÉSOLU]';
    actionPhrase = `fil de discussion résolu par **${author}**`;
  }

  const summaryLine = commentSummary ? `\nRésumé : ${commentSummary}` : '';
  const text = `${headerLabel} **${title}** (\`${docId}\`, rév. ${revision}) — ${actionPhrase}${summaryLine}\nLien Docs : ${documentUrl}`;

  const block = {
    type: 'docs_collab_card',
    event: eventName,
    docId,
    revision,
    title,
    author,
    documentUrl,
    ...(commentSummary ? { commentSummary } : {}),
  };

  return {
    channelId,
    docId,
    revision,
    title,
    author,
    documentUrl,
    idempotencyKey,
    text,
    blocks: [block],
  };
}

/**
 * Creates a replay-protected webhook handler for the Docs Collaborative Pad Announcer.
 *
 * @param {{
 *   secret: string,
 *   defaultChannelId?: string,
 *   client?: ReturnType<typeof createExtensionClient>,
 *   apiBaseUrl?: string,
 *   apiToken?: string,
 *   fetchImpl?: typeof globalThis.fetch,
 * }} config
 */
export function createDocsCollabWebhookHandler(config) {
  const defaultChannelId = config.defaultChannelId ?? 'chan_docs';
  const configuredClient =
    config.client ??
    (config.apiBaseUrl && config.apiToken
      ? createExtensionClient({
          baseUrl: config.apiBaseUrl,
          token: config.apiToken,
          fetchImpl: config.fetchImpl,
        })
      : undefined);

  /**
   * @param {'document.created' | 'document.published' | 'document.comment_resolved'} eventName
   */
  function createLifecycleEventHandler(eventName) {
    /**
     * @param {Record<string, unknown>} payload
     * @param {{ client?: ReturnType<typeof createExtensionClient> }} ctx
     */
    return async (payload, { client }) => {
      const announcement = buildDocsLifecycleAnnouncement(eventName, payload, defaultChannelId);
      const activeClient = client ?? configuredClient;

      if (activeClient) {
        const delivery = await activeClient.postChannelMessage({
          channelId: announcement.channelId,
          text: announcement.text,
          blocks: announcement.blocks,
          idempotencyKey: announcement.idempotencyKey,
        });
        return {
          posted: true,
          event: eventName,
          docId: announcement.docId,
          revision: announcement.revision,
          idempotencyKey: announcement.idempotencyKey,
          documentUrl: announcement.documentUrl,
          delivery,
        };
      }

      return {
        posted: false,
        event: eventName,
        docId: announcement.docId,
        revision: announcement.revision,
        idempotencyKey: announcement.idempotencyKey,
        documentUrl: announcement.documentUrl,
        text: announcement.text,
        blocks: announcement.blocks,
      };
    };
  }

  return createWebhookHandler({
    secret: config.secret,
    client: configuredClient,
    handlers: {
      'document.created': createLifecycleEventHandler('document.created'),
      'document.published': createLifecycleEventHandler('document.published'),
      'document.comment_resolved': createLifecycleEventHandler('document.comment_resolved'),
      'command.invoked': async (payload) => {
        return docPadCommand.handler({
          command: 'doc-pad',
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
  docPadCommand,
  handleDocPadCommand,
  createDocsCollabWebhookHandler,
};
