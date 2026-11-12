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

export const SOCIAL_NETWORKS = Object.freeze([
  'x',
  'mastodon',
  'instagram',
]);

export const SOCIAL_NETWORK_LABELS = Object.freeze({
  x: 'X / Twitter',
  mastodon: 'Mastodon / Fédiverse',
  instagram: 'Instagram',
});

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const TRACKING_QUERY_EXACT = new Set([
  'fbclid',
  'twclid',
  'igsh',
  'igshid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  'ref_url',
]);

/**
 * Validates and normalizes the `social-pulse-bridge` manifest against `@kodera/extension-sdk`.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateSocialManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateSocialManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Classifies a social media hostname/URL into `'x' | 'mastodon' | 'instagram'`.
 *
 * @param {string} hostname
 * @param {string} pathname
 * @param {unknown} [explicitNetwork]
 * @returns {'x' | 'mastodon' | 'instagram'}
 */
export function resolveSocialNetwork(hostname, pathname, explicitNetwork) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (X_HOSTS.has(host)) {
    return 'x';
  }
  if (INSTAGRAM_HOSTS.has(host)) {
    return 'instagram';
  }
  if (explicitNetwork !== undefined && explicitNetwork !== null && explicitNetwork !== '') {
    const net = String(explicitNetwork).trim().toLowerCase();
    if (net === 'x' || net === 'twitter') return 'x';
    if (net === 'instagram' || net === 'insta') return 'instagram';
    if (net === 'mastodon' || net === 'fediverse') return 'mastodon';
    throw new ExtensionSdkError(
      'UNSUPPORTED_SOCIAL_NETWORK',
      `Unsupported social network "${String(explicitNetwork)}". Expected x, mastodon, or instagram.`
    );
  }
  if (
    host === 'mastodon.social' ||
    host.endsWith('.social') ||
    pathname.startsWith('/@') ||
    pathname.startsWith('/users/') ||
    pathname.startsWith('/notes/') ||
    pathname.startsWith('/objects/')
  ) {
    return 'mastodon';
  }
  throw new ExtensionSdkError(
    'UNSUPPORTED_SOCIAL_HOST',
    `Social post URL host "${host}" must be x.com, twitter.com, instagram.com, or a Mastodon/Fediverse instance.`
  );
}

/**
 * Validates a social post URL via `@kodera/extension-sdk`'s `validateEndpointUrl`,
 * classifies the network (`x`, `mastodon`, `instagram`), and strips all tracking query
 * parameters (`utm_*`, `fbclid`, `twclid`, `igsh`, `igshid`, etc.), returning
 * `trackingStripped: true`.
 *
 * @param {unknown} rawUrl
 * @param {{ network?: string, allowLocalhostHttp?: boolean }} [options]
 */
export function sanitizeSocialPostUrl(rawUrl, options = {}) {
  const validated = validateEndpointUrl(String(rawUrl ?? ''), {
    allowLocalhostHttp: Boolean(options.allowLocalhostHttp),
  });
  const parsed = new URL(validated);
  const network = resolveSocialNetwork(parsed.hostname, parsed.pathname, options.network);

  /** @type {string[]} */
  const removedTrackingParams = [];
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_QUERY_EXACT.has(lower)) {
      removedTrackingParams.push(key);
      parsed.searchParams.delete(key);
    }
  }

  return Object.freeze({
    cleanUrl: parsed.toString(),
    network,
    networkLabel: SOCIAL_NETWORK_LABELS[network],
    trackingStripped: true,
    removedTrackingParams: Object.freeze(removedTrackingParams),
  });
}

/**
 * Sanitizes untrusted social media post text and author handles, removing HTML/scripts
 * and any embedded tracking pixel tags (`<img>`, `<iframe>`, `<script>`).
 *
 * @param {unknown} rawValue
 * @param {string} fallback
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeSocialText(rawValue, fallback, maxLength = 280) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const cleaned = rawValue
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
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
 * Executes `/social-post` slash command.
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleSocialPostCommand(input = {}) {
  const channelId =
    typeof input.channelId === 'string' && input.channelId.trim()
      ? input.channelId.trim()
      : 'chan_communication';
  const actorId =
    typeof input.actorId === 'string' && input.actorId.trim()
      ? input.actorId.trim()
      : 'usr_membre';

  const rawCommandLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/social-post ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawCommandLine);
  const candidateUrl =
    typeof parsed.flags.url === 'string'
      ? parsed.flags.url
      : parsed.subcommand && parsed.subcommand.startsWith('http')
        ? parsed.subcommand
        : parsed.args[0] && parsed.args[0].startsWith('http')
          ? parsed.args[0]
          : 'https://mastodon.social/@kodera/113400000000000001?utm_source=syndication&fbclid=track123';

  const explicitNetwork =
    typeof parsed.flags.network === 'string'
      ? parsed.flags.network
      : parsed.subcommand && !parsed.subcommand.startsWith('http')
        ? parsed.subcommand
        : undefined;

  const { cleanUrl, network, networkLabel, trackingStripped, removedTrackingParams } =
    sanitizeSocialPostUrl(candidateUrl, { network: explicitNetwork });

  const authorHandle = sanitizeSocialText(
    parsed.flags.author ?? '@kodera',
    '@kodera',
    64
  );
  const excerpt = sanitizeSocialText(
    parsed.flags.excerpt ?? parsed.flags.text ?? 'Publication syndiquée sans pistage tiers.',
    'Publication syndiquée sans pistage tiers.',
    280
  );

  return {
    text: `[Social Pulse • ${networkLabel}] Publication de **${authorHandle}** partagée dans <#${channelId}> par <@${actorId}> (zéro pixel tiers, \`trackingStripped: true\`) :\n« ${excerpt} »\nLien nettoyé : ${cleanUrl}`,
    ephemeral: false,
    network,
    networkLabel,
    authorHandle,
    excerpt,
    postUrl: cleanUrl,
    trackingStripped,
    removedTrackingParams,
  };
}

export const socialPostCommand = defineSlashCommand({
  name: '/social-post',
  description:
    'Partager une publication X / Twitter, Mastodon / Fédiverse ou Instagram nettoyée de tout pistage',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) =>
    handleSocialPostCommand({ args, channelId, actorId }),
});

/**
 * Builds a privacy-preserving social media syndication card with `trackingStripped: true`.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {string} [defaultChannelId]
 */
export function buildSocialPulseCard(eventName, payload, defaultChannelId = 'chan_communication') {
  const rawUrl = String(
    payload.postUrl ??
      payload.url ??
      'https://mastodon.social/@kodera/113400000000000001'
  );
  const explicitNetwork =
    typeof payload.network === 'string' ? payload.network : undefined;

  const { cleanUrl, network, networkLabel, trackingStripped, removedTrackingParams } =
    sanitizeSocialPostUrl(rawUrl, { network: explicitNetwork });

  const postId = String(payload.postId ?? payload.id ?? 'post_001').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!postId) {
    throw new ExtensionSdkError('INVALID_SOCIAL_POST_ID', 'Social post identifier is required.');
  }

  const author = sanitizeSocialText(payload.author ?? payload.handle ?? '@kodera', '@kodera', 80);
  const content = sanitizeSocialText(
    payload.content ?? payload.excerpt ?? payload.text ?? 'Publication sociale',
    'Publication sociale',
    280
  );
  const channelId = String(payload.channelId ?? defaultChannelId);
  const idempotencyKey = `social:${network}:${postId}`;

  const badges = {
    x: '[SOCIAL X / TWITTER]',
    mastodon: '[SOCIAL MASTODON / FÉDIVERSE]',
    instagram: '[SOCIAL INSTAGRAM]',
  };

  const badge = badges[network];
  const text = `${badge} **${author}** — « ${content} »\nLien nettoyé (\`trackingStripped: true\`) : ${cleanUrl}`;

  const block = {
    type: 'social_pulse_card',
    event: eventName,
    network,
    networkLabel,
    postId,
    author,
    content,
    postUrl: cleanUrl,
    trackingStripped,
  };

  return {
    channelId,
    event: eventName,
    network,
    networkLabel,
    postId,
    author,
    content,
    postUrl: cleanUrl,
    trackingStripped,
    removedTrackingParams,
    idempotencyKey,
    text,
    blocks: [block],
  };
}

/**
 * Creates a replay-protected webhook handler for the Social Pulse Syndication Bridge.
 *
 * @param {{
 *   secret: string,
 *   defaultChannelId?: string,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createSocialPulseWebhookHandler(config) {
  const defaultChannelId = config.defaultChannelId ?? 'chan_communication';
  const configuredClient = config.client;

  /**
   * @param {string} eventName
   */
  function createSocialEventHandler(eventName) {
    /**
     * @param {Record<string, unknown>} payload
     * @param {{ client?: ReturnType<typeof createExtensionClient> }} ctx
     */
    return async (payload, { client }) => {
      const card = buildSocialPulseCard(eventName, payload, defaultChannelId);
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
          network: card.network,
          postId: card.postId,
          postUrl: card.postUrl,
          trackingStripped: card.trackingStripped,
          removedTrackingParams: card.removedTrackingParams,
          idempotencyKey: card.idempotencyKey,
          delivery,
        };
      }
      return {
        posted: false,
        event: eventName,
        network: card.network,
        postId: card.postId,
        postUrl: card.postUrl,
        trackingStripped: card.trackingStripped,
        removedTrackingParams: card.removedTrackingParams,
        idempotencyKey: card.idempotencyKey,
        text: card.text,
        blocks: card.blocks,
      };
    };
  }

  return createWebhookHandler({
    secret: config.secret,
    client: configuredClient,
    handlers: {
      'social.post_curated': createSocialEventHandler('social.post_curated'),
      'social.x_posted': createSocialEventHandler('social.x_posted'),
      'social.mastodon_boosted': createSocialEventHandler('social.mastodon_boosted'),
      'social.instagram_published': createSocialEventHandler('social.instagram_published'),
      'message.created': createSocialEventHandler('message.created'),
      'command.invoked': async (payload) => {
        return socialPostCommand.handler({
          command: 'social-post',
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
  SOCIAL_NETWORKS,
  SOCIAL_NETWORK_LABELS,
  socialPostCommand,
  handleSocialPostCommand,
  sanitizeSocialPostUrl,
  sanitizeSocialText,
  buildSocialPulseCard,
  createSocialPulseWebhookHandler,
};
