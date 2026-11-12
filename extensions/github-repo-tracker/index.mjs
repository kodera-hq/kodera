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
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;

export const GITHUB_REPO_EVENTS = Object.freeze([
  'issues',
  'pull_requests',
  'workflow_runs',
  'releases',
  'security_advisories',
]);

export const ALLOWED_GITHUB_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
]);

/**
 * Validates and normalizes the `github-repo-tracker` manifest against `@kodera/extension-sdk`.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateGithubTrackerManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateGithubTrackerManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Validates a GitHub `owner/repo` slug.
 *
 * @param {unknown} rawRepo
 * @returns {string}
 */
export function validateGithubRepository(rawRepo) {
  if (typeof rawRepo !== 'string' || !REPO_SLUG_PATTERN.test(rawRepo.trim())) {
    throw new ExtensionSdkError(
      'INVALID_GITHUB_REPO',
      'GitHub repository must match "owner/repo" (alphanumeric, hyphens, underscores, dots).'
    );
  }
  return rawRepo.trim();
}

/**
 * Validates a GitHub HTML or API endpoint URL via `@kodera/extension-sdk`'s `validateEndpointUrl`
 * and restricts the host to `https://github.com` or `https://api.github.com`.
 *
 * @param {unknown} rawUrl
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 * @returns {string}
 */
export function validateGithubEndpointUrl(rawUrl, options = {}) {
  const validated = validateEndpointUrl(String(rawUrl ?? ''), {
    allowLocalhostHttp: Boolean(options.allowLocalhostHttp),
  });
  const parsed = new URL(validated);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!ALLOWED_GITHUB_HOSTS.includes(host)) {
    throw new ExtensionSdkError(
      'UNTRUSTED_GITHUB_HOST',
      `GitHub endpoint host "${host}" is not allowed; expected github.com or api.github.com.`
    );
  }
  return validated;
}

/**
 * Validates and deduplicates tracked GitHub repository event categories.
 *
 * @param {unknown} rawEvents
 * @returns {readonly string[]}
 */
export function validateTrackedGithubEvents(rawEvents) {
  if (rawEvents === undefined || rawEvents === null || rawEvents === '') {
    return GITHUB_REPO_EVENTS;
  }

  /** @type {string[]} */
  const items = Array.isArray(rawEvents)
    ? rawEvents.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
    : typeof rawEvents === 'string'
      ? rawEvents
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean)
      : [];

  if (items.length === 0) {
    return GITHUB_REPO_EVENTS;
  }

  /** @type {string[]} */
  const normalized = [];
  for (const item of items) {
    if (!GITHUB_REPO_EVENTS.includes(item)) {
      throw new ExtensionSdkError(
        'UNSUPPORTED_GITHUB_EVENT',
        `Unsupported GitHub event category "${item}". Allowed: ${GITHUB_REPO_EVENTS.join(', ')}.`
      );
    }
    if (!normalized.includes(item)) {
      normalized.push(item);
    }
  }
  return Object.freeze(normalized);
}

/**
 * Sanitizes untrusted GitHub issue/PR/advisory text.
 *
 * @param {unknown} rawValue
 * @param {string} fallback
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeGithubText(rawValue, fallback, maxLength = 200) {
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
 * Executes `/github-track` slash command.
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleGithubTrackCommand(input = {}) {
  const channelId =
    typeof input.channelId === 'string' && input.channelId.trim()
      ? input.channelId.trim()
      : 'chan_devops';
  const actorId =
    typeof input.actorId === 'string' && input.actorId.trim()
      ? input.actorId.trim()
      : 'usr_membre';

  const rawCommandLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/github-track ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawCommandLine);
  const subcommand = parsed.subcommand ?? 'kodera-hq/kodera';
  const isActionSubcommand = ['subscribe', 'status', 'list'].includes(subcommand.toLowerCase());

  const rawRepo = isActionSubcommand
    ? String(parsed.flags.repo ?? parsed.args[0] ?? 'kodera-hq/kodera')
    : String(parsed.flags.repo ?? subcommand);

  const repository = validateGithubRepository(rawRepo);
  const events = validateTrackedGithubEvents(parsed.flags.events);

  const htmlUrl = validateGithubEndpointUrl(
    typeof parsed.flags.url === 'string'
      ? parsed.flags.url
      : `https://github.com/${repository}`
  );
  const apiUrl = validateGithubEndpointUrl(
    typeof parsed.flags.api === 'string'
      ? parsed.flags.api
      : `https://api.github.com/repos/${repository}`
  );

  const actionMode = isActionSubcommand ? subcommand.toLowerCase() : 'subscribe';
  const ephemeral = actionMode === 'status' || actionMode === 'list';

  return {
    text: `[GitHub Tracker] Suivi actif pour **${repository}** dans <#${channelId}> par <@${actorId}> — événements : \`${events.join(', ')}\` (${htmlUrl} • API : ${apiUrl})`,
    ephemeral,
    action: actionMode,
    repository,
    events,
    htmlUrl,
    apiUrl,
    channelId,
  };
}

export const githubTrackCommand = defineSlashCommand({
  name: '/github-track',
  description: "Configurer ou afficher le suivi d'un dépôt GitHub (owner/repo) dans le salon",
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) =>
    handleGithubTrackCommand({ args, channelId, actorId }),
});

/**
 * Builds a structured Espace notification card for a tracked GitHub repository event.
 *
 * @param {'issues' | 'pull_requests' | 'workflow_runs' | 'releases' | 'security_advisories'} category
 * @param {Record<string, unknown>} payload
 * @param {string} defaultChannelId
 */
export function buildGithubRepoEventCard(category, payload, defaultChannelId = 'chan_devops') {
  if (!GITHUB_REPO_EVENTS.includes(category)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_GITHUB_EVENT',
      `Unsupported GitHub event category "${String(category)}".`
    );
  }

  const repository = validateGithubRepository(payload.repository ?? payload.repo);
  const channelId = String(payload.channelId ?? defaultChannelId);
  const action = sanitizeGithubText(payload.action ?? 'opened', 'updated', 40);
  const title = sanitizeGithubText(
    payload.title ?? payload.name ?? payload.tag ?? 'Activité GitHub',
    'Activité GitHub',
    160
  );
  const actor = sanitizeGithubText(payload.actor ?? payload.sender ?? payload.author, 'github-bot', 80);
  const summary = sanitizeGithubText(payload.summary ?? payload.body ?? '', '', 320);
  const itemNumber = String(payload.number ?? payload.id ?? payload.tag ?? '1').replace(/[^A-Za-z0-9_.-]/g, '');

  const htmlUrl = validateGithubEndpointUrl(
    payload.htmlUrl ?? payload.url ?? `https://github.com/${repository}`
  );
  const apiUrl = validateGithubEndpointUrl(
    payload.apiUrl ?? `https://api.github.com/repos/${repository}`
  );

  const labels = {
    issues: '[GITHUB ISSUE]',
    pull_requests: '[GITHUB PR]',
    workflow_runs: '[GITHUB WORKFLOW]',
    releases: '[GITHUB RELEASE]',
    security_advisories: '[GITHUB SECURITY ADVISORY]',
  };

  const badge = labels[category];
  const idempotencyKey = `github-track:${repository}:${category}:${itemNumber}:${action}`;
  const summaryLine = summary ? `\n${summary}` : '';
  const text = `${badge} **${repository}** (${action}) — **${title}** par **${actor}**${summaryLine}\nLien : ${htmlUrl}`;

  const block = {
    type: 'github_repo_tracker_card',
    category,
    repository,
    action,
    title,
    actor,
    itemNumber,
    htmlUrl,
    apiUrl,
    ...(summary ? { summary } : {}),
  };

  return {
    channelId,
    category,
    repository,
    action,
    title,
    actor,
    htmlUrl,
    apiUrl,
    idempotencyKey,
    text,
    blocks: [block],
  };
}

/**
 * Creates a replay-protected webhook handler for the GitHub Repository Activity Tracker.
 *
 * @param {{
 *   secret: string,
 *   defaultChannelId?: string,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createGithubRepoTrackerWebhookHandler(config) {
  const defaultChannelId = config.defaultChannelId ?? 'chan_devops';
  const configuredClient = config.client;

  /**
   * @param {'issues' | 'pull_requests' | 'workflow_runs' | 'releases' | 'security_advisories'} category
   */
  function createCategoryHandler(category) {
    /**
     * @param {Record<string, unknown>} payload
     * @param {{ client?: ReturnType<typeof createExtensionClient> }} ctx
     */
    return async (payload, { client }) => {
      const card = buildGithubRepoEventCard(category, payload, defaultChannelId);
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
          category,
          repository: card.repository,
          idempotencyKey: card.idempotencyKey,
          htmlUrl: card.htmlUrl,
          apiUrl: card.apiUrl,
          delivery,
        };
      }
      return {
        posted: false,
        category,
        repository: card.repository,
        idempotencyKey: card.idempotencyKey,
        htmlUrl: card.htmlUrl,
        apiUrl: card.apiUrl,
        text: card.text,
        blocks: card.blocks,
      };
    };
  }

  return createWebhookHandler({
    secret: config.secret,
    client: configuredClient,
    handlers: {
      issues: createCategoryHandler('issues'),
      pull_requests: createCategoryHandler('pull_requests'),
      workflow_runs: createCategoryHandler('workflow_runs'),
      releases: createCategoryHandler('releases'),
      security_advisories: createCategoryHandler('security_advisories'),
      'release.published': createCategoryHandler('releases'),
      'ci.workflow_failed': createCategoryHandler('workflow_runs'),
      'command.invoked': async (payload) => {
        return githubTrackCommand.handler({
          command: 'github-track',
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
   GITHUB_REPO_EVENTS,
  githubTrackCommand,
  handleGithubTrackCommand,
  validateGithubRepository,
  validateGithubEndpointUrl,
  validateTrackedGithubEvents,
  createGithubRepoTrackerWebhookHandler,
};
