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
const COMPACT_IBAN_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const INLINE_IBAN_PREFIX = /\b[A-Z]/gi;
const DEFAULT_SAMPLE_IBAN = 'FR76 3000 6000 0112 3456 7890 189';

export const QONTO_TREASURY_EVENTS = Object.freeze([
  'transfer.incoming',
  'transfer.outgoing',
  'invoice.missing_attachment',
  'spend.threshold_exceeded',
]);

export const SUPPORTED_QONTO_SUBCOMMANDS = Object.freeze([
  'status',
  'alerts',
  'threshold',
  'missing-invoices',
]);

/**
 * Validates and normalizes the `qonto-treasury-feed` manifest against `@kodera/extension-sdk`.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateQontoManifest(input = rawManifest, options = {}) {
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

export const extensionManifest = validateQontoManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministically redacts a full IBAN to country + check digits + masked middle + last 4 characters,
 * grouped into 4-character blocks separated by spaces (e.g. `FR76 **** **** **** **** ***0 189`).
 *
 * @param {unknown} rawIban
 * @returns {string}
 */
export function maskIban(rawIban) {
  if (typeof rawIban !== 'string' || rawIban.length < 1 || rawIban.length > 128
    || !/^[A-Za-z0-9 -]+$/.test(rawIban)) {
    throw new ExtensionSdkError('INVALID_IBAN', 'IBAN must be a bounded ASCII string.');
  }

  const compact = rawIban.replace(/[\s-]+/g, '').toUpperCase();
  if (!COMPACT_IBAN_PATTERN.test(compact)) {
    throw new ExtensionSdkError(
      'INVALID_IBAN',
      'IBAN must start with 2 country letters + 2 check digits followed by 11-30 alphanumeric characters.'
    );
  }

  const prefix = compact.slice(0, 4);
  const suffix = compact.slice(-4);
  const middleLength = compact.length - 8;
  const maskedCompact = `${prefix}${'*'.repeat(middleLength)}${suffix}`;

  /** @type {string[]} */
  const groups = [];
  for (let i = 0; i < maskedCompact.length; i += 4) {
    groups.push(maskedCompact.slice(i, i + 4));
  }
  return groups.join(' ');
}

/**
 * Redacts any inline IBAN occurrence inside free-form text and sanitizes HTML/control characters.
 *
 * @param {unknown} rawValue
 * @param {string} fallback
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeTreasuryText(rawValue, fallback, maxLength = 180) {
  if (typeof rawValue !== 'string' || rawValue.length > 16_384) {
    return fallback;
  }

  const normalized = rawValue
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\p{Cf}/gu, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/\[([^\]]+)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, '$1')
    .replace(/[*_`~<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Markup/control removal can join previously separated account fragments.
  // Redact the final displayed text, before truncation can hide a matching suffix.
  let cleaned = '';
  let copiedUntil = 0;
  // Scan at most 128 raw characters and 34 account characters per candidate.
  // Arbitrary ASCII grouping must not hide an otherwise canonical account.
  for (const match of normalized.matchAll(INLINE_IBAN_PREFIX)) {
    const start = match.index;
    if (start < copiedUntil) continue;
    let end = start;
    let count = 0;
    let accountEnd = end;
    while (end < normalized.length && end - start < 128 && count < 34) {
      const character = normalized[end];
      if (/[A-Z0-9]/i.test(character)) {
        if ((count < 2 && !/[A-Z]/i.test(character))
          || (count >= 2 && count < 4 && !/[0-9]/.test(character))) break;
        count++;
        accountEnd = end + 1;
      } else if (character !== ' ' && character !== '-') break;
      end++;
    }
    if (count < 15) continue;
    cleaned += normalized.slice(copiedUntil, start) + maskIban(normalized.slice(start, accountEnd));
    copiedUntil = accountEnd;
  }
  cleaned += normalized.slice(copiedUntil);

  if (!cleaned) {
    return fallback;
  }
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/**
 * Formats a monetary amount in EUR (from integer cents or decimal euros).
 *
 * @param {unknown} amountCentsOrEur
 * @param {string} [currency]
 * @returns {string}
 */
export function formatTreasuryAmount(amountCentsOrEur, currency = 'EUR') {
  const num = Number(amountCentsOrEur ?? 0);
  if (!Number.isFinite(num) || num < 0) {
    throw new ExtensionSdkError('INVALID_TREASURY_AMOUNT', 'Treasury amount must be a non-negative number.');
  }
  const safeCurrency = /^[A-Z]{3}$/.test(String(currency)) ? String(currency) : 'EUR';
  const formatted = num.toFixed(2).replace('.', ',');
  return `${formatted} ${safeCurrency}`;
}

/**
 * Executes `/qonto-feed` slash command.
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleQontoFeedCommand(input = {}) {
  const channelId =
    typeof input.channelId === 'string' && input.channelId.trim()
      ? input.channelId.trim()
      : 'chan_finance';
  const actorId =
    typeof input.actorId === 'string' && input.actorId.trim()
      ? input.actorId.trim()
      : 'usr_tresorerie';

  const rawCommandLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/qonto-feed ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawCommandLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!SUPPORTED_QONTO_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_QONTO_SUBCOMMAND',
      `Sous-commande /qonto-feed inconnue "${subcommand}". Attendu : ${SUPPORTED_QONTO_SUBCOMMANDS.join(', ')}.`
    );
  }

  const maskedAccountIban = maskIban(
    typeof parsed.flags.iban === 'string' ? parsed.flags.iban : DEFAULT_SAMPLE_IBAN
  );
  const accountLabel = sanitizeTreasuryText(
    parsed.flags.account ?? 'Compte courant principal Qonto',
    'Compte courant principal Qonto',
    80
  );
  const thresholdEur = Number(parsed.flags['threshold-eur'] ?? parsed.flags.threshold ?? 5000);
  if (!Number.isFinite(thresholdEur) || thresholdEur <= 0) {
    throw new ExtensionSdkError('INVALID_THRESHOLD', 'Spend threshold must be a positive number.');
  }

  const dashboardUrl = validateEndpointUrl(
    typeof parsed.flags.url === 'string'
      ? parsed.flags.url
      : 'https://app.qonto.com/organizations/kodera/transactions'
  );

  if (subcommand === 'missing-invoices') {
    return {
      text: `[Qonto Trésorerie] Rappel justificatifs manquants sur **${accountLabel}** (\`${maskedAccountIban}\`) demandé par <@${actorId}> — vérification active (${dashboardUrl}).`,
      ephemeral: false,
      subcommand,
      accountLabel,
      maskedIban: maskedAccountIban,
      thresholdEur,
      dashboardUrl,
    };
  }

  if (subcommand === 'threshold') {
    return {
      text: `[Qonto Trésorerie] Seuil d'alerte de dépense fixé à **${formatTreasuryAmount(thresholdEur)}** pour **${accountLabel}** (\`${maskedAccountIban}\`) dans <#${channelId}>.`,
      ephemeral: false,
      subcommand,
      accountLabel,
      maskedIban: maskedAccountIban,
      thresholdEur,
      dashboardUrl,
    };
  }

  return {
    text: `[Qonto Trésorerie] Flux actif pour **${accountLabel}** (\`${maskedAccountIban}\`) dans <#${channelId}> — seuil d'alerte : **${formatTreasuryAmount(thresholdEur)}** (${dashboardUrl}).`,
    ephemeral: subcommand === 'status',
    subcommand,
    accountLabel,
    maskedIban: maskedAccountIban,
    thresholdEur,
    dashboardUrl,
  };
}

export const qontoFeedCommand = defineSlashCommand({
  name: '/qonto-feed',
  description:
    'Consulter le flux de trésorerie Qonto, les seuils de dépense ou les justificatifs manquants',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) =>
    handleQontoFeedCommand({ args, channelId, actorId }),
});

/**
 * Formats a Qonto treasury activity notification card with deterministic IBAN redaction.
 *
 * @param {'transfer.incoming' | 'transfer.outgoing' | 'invoice.missing_attachment' | 'spend.threshold_exceeded'} eventName
 * @param {Record<string, unknown>} payload
 * @param {string} [defaultChannelId]
 */
export function buildQontoTreasuryCard(eventName, payload, defaultChannelId = 'chan_finance') {
  if (!QONTO_TREASURY_EVENTS.includes(eventName)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_QONTO_EVENT',
      `Unsupported Qonto treasury event "${String(eventName)}".`
    );
  }

  const transactionId = String(payload.transactionId ?? payload.id ?? 'tx_001').replace(
    /[^A-Za-z0-9_.-]/g,
    ''
  );
  if (!transactionId) {
    throw new ExtensionSdkError('INVALID_TRANSACTION_ID', 'Transaction identifier is required.');
  }

  const maskedAccountIban = maskIban(payload.iban ?? payload.accountIban ?? DEFAULT_SAMPLE_IBAN);
  const maskedCounterpartyIban =
    typeof payload.counterpartyIban === 'string' && payload.counterpartyIban.trim()
      ? maskIban(payload.counterpartyIban)
      : null;

  const counterparty = sanitizeTreasuryText(
    payload.counterparty ?? payload.beneficiary ?? payload.initiator ?? 'Fournisseur',
    'Contrepartie Qonto',
    100
  );
  const reference = sanitizeTreasuryText(
    payload.reference ?? payload.note ?? payload.label ?? 'Opération de trésorerie',
    'Opération de trésorerie',
    160
  );
  const amountFormatted = formatTreasuryAmount(
    payload.amountEur ?? payload.amount ?? 0,
    String(payload.currency ?? 'EUR')
  );
  const transactionUrl = validateEndpointUrl(
    String(
      payload.transactionUrl ??
        payload.url ??
        `https://app.qonto.com/organizations/kodera/transactions/${encodeURIComponent(transactionId)}`
    ),
    { allowLocalhostHttp: false }
  );
  const channelId = String(payload.channelId ?? defaultChannelId);
  const idempotencyKey = `qonto:${eventName}:${transactionId}`;

  const badges = {
    'transfer.incoming': '[QONTO VIREMENT ENTRANT]',
    'transfer.outgoing': '[QONTO VIREMENT SORTANT]',
    'invoice.missing_attachment': '[QONTO JUSTIFICATIF MANQUANT]',
    'spend.threshold_exceeded': '[QONTO ALERTE SEUIL DÉPENSE]',
  };

  const badge = badges[eventName];
  const counterpartyIbanSegment = maskedCounterpartyIban ? ` (\`${maskedCounterpartyIban}\`)` : '';
  const text = `${badge} **${amountFormatted}** — **${counterparty}**${counterpartyIbanSegment} sur compte \`${maskedAccountIban}\`\nRéférence : ${reference}\nLien Qonto : ${transactionUrl}`;

  const block = {
    type: 'qonto_treasury_card',
    event: eventName,
    transactionId,
    amountFormatted,
    counterparty,
    maskedIban: maskedAccountIban,
    ...(maskedCounterpartyIban ? { maskedCounterpartyIban } : {}),
    reference,
    transactionUrl,
  };

  return {
    channelId,
    event: eventName,
    transactionId,
    maskedIban: maskedAccountIban,
    maskedCounterpartyIban,
    amountFormatted,
    transactionUrl,
    idempotencyKey,
    text,
    blocks: [block],
  };
}

/**
 * Creates a replay-protected webhook handler for the Qonto Corporate Treasury Feed.
 *
 * @param {{
 *   secret: string,
 *   defaultChannelId?: string,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createQontoTreasuryWebhookHandler(config) {
  const defaultChannelId = config.defaultChannelId ?? 'chan_finance';
  const configuredClient = config.client;

  /**
   * @param {'transfer.incoming' | 'transfer.outgoing' | 'invoice.missing_attachment' | 'spend.threshold_exceeded'} eventName
   */
  function createTreasuryEventHandler(eventName) {
    /**
     * @param {Record<string, unknown>} payload
     * @param {{ client?: ReturnType<typeof createExtensionClient> }} ctx
     */
    return async (payload, { client }) => {
      const card = buildQontoTreasuryCard(eventName, payload, defaultChannelId);
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
          transactionId: card.transactionId,
          maskedIban: card.maskedIban,
          idempotencyKey: card.idempotencyKey,
          transactionUrl: card.transactionUrl,
          delivery,
        };
      }
      return {
        posted: false,
        event: eventName,
        transactionId: card.transactionId,
        maskedIban: card.maskedIban,
        idempotencyKey: card.idempotencyKey,
        transactionUrl: card.transactionUrl,
        text: card.text,
        blocks: card.blocks,
      };
    };
  }

  return createWebhookHandler({
    secret: config.secret,
    client: configuredClient,
    handlers: {
      'transfer.incoming': createTreasuryEventHandler('transfer.incoming'),
      'transfer.outgoing': createTreasuryEventHandler('transfer.outgoing'),
      'invoice.missing_attachment': createTreasuryEventHandler('invoice.missing_attachment'),
      'spend.threshold_exceeded': createTreasuryEventHandler('spend.threshold_exceeded'),
      'command.invoked': async (payload) => {
        return qontoFeedCommand.handler({
          command: 'qonto-feed',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_tresorerie'),
        });
      },
    },
  });
}

export default {
  manifest,
  extensionManifest,
  QONTO_TREASURY_EVENTS,
  maskIban,
  qontoFeedCommand,
  handleQontoFeedCommand,
  buildQontoTreasuryCard,
  createQontoTreasuryWebhookHandler,
};
