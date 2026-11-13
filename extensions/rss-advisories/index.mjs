import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MAX_SKEW_SECONDS,
  ExtensionSdkError,
  MANIFEST_SCHEMA_VERSION,
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_REPLAY_ENTRIES,
  SIGNATURE_HEADER,
  WebhookVerificationError,
  createExtensionClient,
  createWebhookHandler,
  defineSlashCommand,
  getHeaderValue,
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
const ADVISORY_SIG_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;
const CVE_PATTERN = /\bCVE-\d{4}-\d{4,7}\b/gi;
const GHSA_PATTERN = /\bGHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}\b/gi;
const CERTFR_PATTERN = /\bCERTFR-\d{4}-(?:AVI|ALE|ACT|DUR)-\d{3,5}\b/gi;
const VERSION_SEGMENT_PATTERN = /^(?:<=|>=|<|>|=|\^|~)?\s*v?\d+(?:\.[0-9A-Za-z_+-]+){0,5}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FEED_ENTRIES = 50;
const DEFAULT_MAX_SEEN_ENTRIES = 1024;

export const TRACKED_UPSTREAM_COMPONENTS = Object.freeze({
  synapse: 'Synapse',
  postgresql: 'PostgreSQL',
  keycloak: 'Keycloak',
  rust: 'Rust',
  nodejs: 'Node.js',
});

export const ADVISORIES_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'list',
  'sources',
  'status',
]);

/**
 * Validates and normalizes the `rss-advisories` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateRssAdvisoriesManifest(input = rawManifest, options = {}) {
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
    throw new ExtensionSdkError('INVALID_MANIFEST_ID', `Invalid RSS advisories manifest id "${rawId}".`);
  }

  const rawScopes = Array.isArray(input.scopes)
    ? input.scopes
    : Array.isArray(input.permissions)
      ? input.permissions
      : [];

  const rawCommands = Array.isArray(input.commands) ? input.commands : [];
  const normalizedCommands = rawCommands.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const rec = /** @type {Record<string, unknown>} */ (entry);
    return {
      ...rec,
      name: String(rec.name ?? rec.command ?? ''),
      description: String(rec.description ?? ''),
    };
  });

  const sdkValidated = validateManifest(
    {
      ...input,
      schemaVersion,
      id: slugId,
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
  });
}

export const extensionManifest = validateRssAdvisoriesManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Decodes standard XML entities (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&apos;`, and decimal/hex
 * numeric scalar references) in a single linear pass so double-encoded entities never cascade.
 *
 * @param {string} input
 * @returns {string}
 */
function decodeXmlEntitiesOnce(input) {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] === '&') {
      const semi = input.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 12) {
        const entity = input.slice(i + 1, semi);
        let decoded = null;
        if (entity === 'lt') decoded = '<';
        else if (entity === 'gt') decoded = '>';
        else if (entity === 'amp') decoded = '&';
        else if (entity === 'quot') decoded = '"';
        else if (entity === 'apos' || entity === '#39') decoded = "'";
        else if (entity === 'nbsp') decoded = ' ';
        else if (entity.startsWith('#x') || entity.startsWith('#X')) {
          const hex = entity.slice(2);
          if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
            const cp = Number.parseInt(hex, 16);
            if (cp >= 0x20 && cp !== 0x7f && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
              decoded = String.fromCodePoint(cp);
            }
          }
        } else if (entity.startsWith('#')) {
          const dec = entity.slice(1);
          if (/^\d{1,7}$/.test(dec)) {
            const cp = Number.parseInt(dec, 10);
            if (cp >= 0x20 && cp !== 0x7f && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
              decoded = String.fromCodePoint(cp);
            }
          }
        }
        if (decoded !== null) {
          out += decoded;
          i = semi + 1;
          continue;
        }
      }
    }
    out += input[i];
    i += 1;
  }
  return out;
}

/**
 * Deterministic character-by-character HTML/XML markup state-machine sanitizer.
 * Uses ZERO HTML-tag regular expressions (CodeQL `js/bad-tag-filter` compliant):
 * - Decodes XML entities in one pass first so RSS `&lt;script&gt;` payloads enter the state machine.
 * - Suppresses `<script>...</script>` and `<style>...</style>` element bodies completely.
 * - Drops all `<...>` markup and never emits `<` or `>` characters even on unclosed tags.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeAdvisoryText(rawValue, fallback = '', maxLength = 300) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const capped = rawValue.length > 16_384 ? rawValue.slice(0, 16_384) : rawValue;
  const decoded = decodeXmlEntitiesOnce(capped);

  let out = '';
  let inTag = false;
  let tagBuffer = '';
  /** @type {'script' | 'style' | null} */
  let suppressedTag = null;
  let lastSpace = true;

  for (let i = 0; i < decoded.length; i += 1) {
    const ch = decoded[i];
    const code = decoded.charCodeAt(i);

    if (inTag) {
      if (ch === '>') {
        const normalizedTag = tagBuffer.trim().toLowerCase();
        if (suppressedTag !== null) {
          if (
            normalizedTag === `/${suppressedTag}` ||
            normalizedTag.startsWith(`/${suppressedTag} `) ||
            normalizedTag.startsWith(`/${suppressedTag}\t`)
          ) {
            suppressedTag = null;
          }
        } else if (
          (normalizedTag === 'script' ||
            normalizedTag.startsWith('script ') ||
            normalizedTag.startsWith('script\t')) &&
          !normalizedTag.endsWith('/')
        ) {
          suppressedTag = 'script';
        } else if (
          (normalizedTag === 'style' ||
            normalizedTag.startsWith('style ') ||
            normalizedTag.startsWith('style\t')) &&
          !normalizedTag.endsWith('/')
        ) {
          suppressedTag = 'style';
        }
        inTag = false;
        tagBuffer = '';
      } else if (tagBuffer.length < 64) {
        tagBuffer += ch;
      }
      continue;
    }

    if (ch === '<') {
      inTag = true;
      tagBuffer = '';
      if (suppressedTag === null && !lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }

    if (suppressedTag !== null) {
      continue;
    }

    if (ch === '>') {
      continue;
    }

    if (code < 0x20 || code === 0x7f) {
      if ((ch === '\n' || ch === '\r' || ch === '\t') && !lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '`' || ch === '~' || ch === '[' || ch === ']') {
      continue;
    }

    if (ch === ' ') {
      if (!lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }

    out += ch;
    lastSpace = false;
  }

  let cleaned = out.trim();
  if (cleaned.includes(':')) {
    cleaned = cleaned
      .replaceAll(/javascript\s*:/gi, 'blocked-scheme:')
      .replaceAll(/vbscript\s*:/gi, 'blocked-scheme:')
      .replaceAll(/data\s*:/gi, 'blocked-scheme:');
  }
  if (!cleaned) {
    return fallback;
  }
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength)}…`;
  }
  return cleaned;
}

/**
 * Refuses XML `<!DOCTYPE`, `<!ENTITY`, `<!ATTLIST`, and `<!NOTATION` declarations (XXE / entity expansion defense).
 *
 * @param {string} xmlText
 */
export function assertSafeXmlFeed(xmlText) {
  if (typeof xmlText !== 'string' || xmlText.trim().length === 0) {
    throw new ExtensionSdkError('INVALID_XML_FEED', 'XML advisory feed must be a non-empty string.');
  }
  if (Buffer.byteLength(xmlText, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
    throw new ExtensionSdkError('BODY_TOO_LARGE', 'XML advisory feed exceeds maximum byte size.');
  }
  const upper = xmlText.toUpperCase();
  if (
    upper.includes('<!DOCTYPE') ||
    upper.includes('<!ENTITY') ||
    upper.includes('<!ATTLIST') ||
    upper.includes('<!NOTATION')
  ) {
    throw new ExtensionSdkError(
      'XML_ENTITY_FORBIDDEN',
      'XML DOCTYPE and ENTITY declarations are forbidden in advisory feeds.'
    );
  }
}

/**
 * Unwraps optional `<![CDATA[...]]>` sections using `indexOf` without regular expressions.
 *
 * @param {string} raw
 * @returns {string}
 */
function unwrapCdata(raw) {
  let result = '';
  let cursor = 0;
  const marker = '<![CDATA[';
  const endMarker = ']]>';
  while (cursor < raw.length) {
    const start = raw.indexOf(marker, cursor);
    if (start === -1) {
      result += raw.slice(cursor);
      break;
    }
    result += raw.slice(cursor, start);
    const close = raw.indexOf(endMarker, start + marker.length);
    if (close === -1) {
      throw new ExtensionSdkError('INVALID_XML_FEED', 'Unclosed CDATA section in XML feed.');
    }
    result += raw.slice(start + marker.length, close);
    cursor = close + endMarker.length;
  }
  return result;
}

/**
 * Checks whether a character is a valid XML tag boundary (`>`, `/`, or whitespace).
 *
 * @param {string | undefined} ch
 * @returns {boolean}
 */
function isTagBoundary(ch) {
  return ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Extracts all `<tagName ...>...</tagName>` element bodies via deterministic `indexOf` scanning.
 *
 * @param {string} xml
 * @param {string} tagName
 * @returns {string[]}
 */
function findXmlElementBlocks(xml, tagName) {
  const lower = xml.toLowerCase();
  const openToken = `<${tagName.toLowerCase()}`;
  const closeToken = `</${tagName.toLowerCase()}>`;
  const blocks = [];
  let pos = 0;

  while (pos < lower.length && blocks.length < MAX_FEED_ENTRIES) {
    const start = lower.indexOf(openToken, pos);
    if (start === -1) break;
    const nextChar = lower[start + openToken.length];
    if (!isTagBoundary(nextChar)) {
      pos = start + openToken.length;
      continue;
    }
    const openEnd = lower.indexOf('>', start + openToken.length);
    if (openEnd === -1) break;
    if (lower[openEnd - 1] === '/') {
      pos = openEnd + 1;
      continue;
    }
    const closeStart = lower.indexOf(closeToken, openEnd + 1);
    if (closeStart === -1) break;
    blocks.push(xml.slice(openEnd + 1, closeStart));
    pos = closeStart + closeToken.length;
  }
  return blocks;
}

/**
 * Extracts the inner text of the first `<tagName>` child inside an entry/item block.
 *
 * @param {string} block
 * @param {string} tagName
 * @returns {string | undefined}
 */
function extractFirstElementText(block, tagName) {
  const lower = block.toLowerCase();
  const openToken = `<${tagName.toLowerCase()}`;
  const closeToken = `</${tagName.toLowerCase()}>`;
  let pos = 0;

  while (pos < lower.length) {
    const start = lower.indexOf(openToken, pos);
    if (start === -1) return undefined;
    const boundary = lower[start + openToken.length];
    if (!isTagBoundary(boundary)) {
      pos = start + openToken.length;
      continue;
    }
    const openEnd = lower.indexOf('>', start + openToken.length);
    if (openEnd === -1) return undefined;
    if (lower[openEnd - 1] === '/') return '';
    const closeStart = lower.indexOf(closeToken, openEnd + 1);
    if (closeStart === -1) return undefined;
    return unwrapCdata(block.slice(openEnd + 1, closeStart)).trim();
  }
  return undefined;
}

/**
 * Extracts an Atom `<link href="..."/>` or RSS `<link>...</link>` URL from an entry/item block.
 *
 * @param {string} block
 * @returns {string | undefined}
 */
function extractFeedLink(block) {
  const textLink = extractFirstElementText(block, 'link');
  if (textLink) {
    return decodeXmlEntitiesOnce(textLink).trim();
  }
  const lower = block.toLowerCase();
  let pos = 0;
  while (pos < lower.length) {
    const start = lower.indexOf('<link', pos);
    if (start === -1) return undefined;
    if (!isTagBoundary(lower[start + 5])) {
      pos = start + 5;
      continue;
    }
    const end = lower.indexOf('>', start + 5);
    if (end === -1) return undefined;
    const tagSlice = block.slice(start + 5, end);
    const lowerSlice = tagSlice.toLowerCase();
    const hrefIdx = lowerSlice.indexOf('href=');
    if (hrefIdx !== -1) {
      const quote = tagSlice[hrefIdx + 5];
      if (quote === '"' || quote === "'") {
        const closeQuote = tagSlice.indexOf(quote, hrefIdx + 6);
        if (closeQuote !== -1) {
          return decodeXmlEntitiesOnce(tagSlice.slice(hrefIdx + 6, closeQuote)).trim();
        }
      }
    }
    pos = end + 1;
  }
  return undefined;
}

/**
 * Parses an Atom 1.0 or RSS 2.0 XML document into normalized advisory candidate objects.
 *
 * @param {string} xmlText
 * @returns {Record<string, unknown>[]}
 */
export function parseXmlAdvisoryFeed(xmlText) {
  assertSafeXmlFeed(xmlText);
  const atomEntries = findXmlElementBlocks(xmlText, 'entry');
  const rssItems = atomEntries.length > 0 ? [] : findXmlElementBlocks(xmlText, 'item');
  const rawBlocks = atomEntries.length > 0 ? atomEntries : rssItems;

  return rawBlocks.map((block, index) => {
    const guid =
      extractFirstElementText(block, 'guid') ??
      extractFirstElementText(block, 'id') ??
      `entry-${index + 1}`;
    const title = extractFirstElementText(block, 'title') ?? 'Security Advisory';
    const summary =
      extractFirstElementText(block, 'summary') ??
      extractFirstElementText(block, 'description') ??
      extractFirstElementText(block, 'content') ??
      '';
    const url = extractFeedLink(block);
    const publishedAt =
      extractFirstElementText(block, 'published') ??
      extractFirstElementText(block, 'updated') ??
      extractFirstElementText(block, 'pubDate') ??
      '';
    const category = extractFirstElementText(block, 'category') ?? '';

    return {
      guid: sanitizeAdvisoryText(guid, `entry-${index + 1}`, 160),
      title,
      summary,
      url,
      publishedAt: sanitizeAdvisoryText(publishedAt, '', 64),
      category: sanitizeAdvisoryText(category, '', 64),
    };
  });
}

/**
 * Extracts canonical `CVE`, `GHSA`, and `CERT-FR` identifiers from advisory fields.
 *
 * @param {string} combinedText
 * @returns {string[]}
 */
export function extractAdvisoryIdentifiers(combinedText) {
  const ids = new Set();
  for (const match of combinedText.matchAll(CVE_PATTERN)) {
    ids.add(match[0].toUpperCase());
  }
  for (const match of combinedText.matchAll(GHSA_PATTERN)) {
    ids.add(`GHSA-${match[0].slice(5).toLowerCase()}`);
  }
  for (const match of combinedText.matchAll(CERTFR_PATTERN)) {
    ids.add(match[0].toUpperCase());
  }
  return [...ids];
}

/**
 * Resolves a tracked upstream component (`Synapse`, `PostgreSQL`, `Keycloak`, `Rust`, `Node.js`)
 * from explicit component fields or title/summary keywords.
 *
 * @param {unknown} explicitComponent
 * @param {string} searchText
 * @returns {{ key: string, label: string }}
 */
export function resolveUpstreamComponent(explicitComponent, searchText = '') {
  const probe = `${String(explicitComponent ?? '')} ${searchText}`.toLowerCase();
  if (probe.includes('synapse')) return { key: 'synapse', label: 'Synapse' };
  if (probe.includes('postgres')) return { key: 'postgresql', label: 'PostgreSQL' };
  if (probe.includes('keycloak')) return { key: 'keycloak', label: 'Keycloak' };
  if (/\b(?:rust|rustc|cargo)\b/.test(probe)) return { key: 'rust', label: 'Rust' };
  if (/\b(?:nodejs|node\.js|node)\b/.test(probe)) return { key: 'nodejs', label: 'Node.js' };
  const fallback = sanitizeAdvisoryText(explicitComponent, 'upstream', 40);
  return { key: fallback.toLowerCase(), label: fallback };
}

/**
 * Formats CVSS v3/v4 score (`0.0..10.0`) and severity into a badge and SDK `IncidentSeverity`.
 *
 * @param {unknown} rawScore
 * @param {unknown} rawSeverity
 * @returns {{
 *   score: number | null,
 *   badge: string,
 *   severityLabel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO',
 *   incidentSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info',
 * }}
 */
export function formatCvssSeverity(rawScore, rawSeverity) {
  if (rawScore !== undefined && rawScore !== null && rawScore !== '') {
    const score = Number(rawScore);
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      throw new ExtensionSdkError('INVALID_CVSS_SCORE', 'CVSS score must be a number between 0.0 and 10.0.');
    }
    const fixed = Number(score.toFixed(1));
    const severityLabel =
      fixed >= 9.0
        ? 'CRITICAL'
        : fixed >= 7.0
          ? 'HIGH'
          : fixed >= 4.0
            ? 'MEDIUM'
            : fixed > 0
              ? 'LOW'
              : 'INFO';
    const incidentSeverity = /** @type {'critical' | 'high' | 'medium' | 'low' | 'info'} */ (
      severityLabel.toLowerCase()
    );
    return {
      score: fixed,
      badge: `${severityLabel} (CVSS ${fixed.toFixed(1)})`,
      severityLabel,
      incidentSeverity,
    };
  }

  const normalized = String(rawSeverity ?? 'info').trim().toUpperCase();
  if (normalized === 'CRITICAL') {
    return { score: null, badge: 'CRITICAL', severityLabel: 'CRITICAL', incidentSeverity: 'critical' };
  }
  if (normalized === 'HIGH' || normalized === 'IMPORTANT') {
    return { score: null, badge: 'HIGH', severityLabel: 'HIGH', incidentSeverity: 'high' };
  }
  if (normalized === 'MEDIUM' || normalized === 'MODERATE') {
    return { score: null, badge: 'MEDIUM', severityLabel: 'MEDIUM', incidentSeverity: 'medium' };
  }
  if (normalized === 'LOW') {
    return { score: null, badge: 'LOW', severityLabel: 'LOW', incidentSeverity: 'low' };
  }
  return { score: null, badge: 'INFO', severityLabel: 'INFO', incidentSeverity: 'info' };
}

/**
 * Validates comma-separated semantic version constraints (e.g. `>= 1.100.0, < 1.114.1`)
 * without permitting HTML tags or arbitrary prose.
 *
 * @param {unknown} rawVersions
 * @param {string} [fallback]
 * @returns {string}
 */
export function formatVersionConstraint(rawVersions, fallback = 'unspecified') {
  const list = Array.isArray(rawVersions)
    ? rawVersions.map((v) => String(v))
    : typeof rawVersions === 'string' && rawVersions.trim()
      ? rawVersions.split(',')
      : [];
  if (list.length === 0) return fallback;

  const validated = [];
  for (const item of list.slice(0, 8)) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!VERSION_SEGMENT_PATTERN.test(trimmed)) {
      throw new ExtensionSdkError(
        'INVALID_VERSION_CONSTRAINT',
        `Invalid version constraint segment "${trimmed}".`
      );
    }
    validated.push(trimmed.replace(/\s+/g, ' '));
  }
  return validated.length > 0 ? validated.join(', ') : fallback;
}

/**
 * Computes an `X-Advisory-Signature-256` (`sha256=<hex>`) header over raw JSON or XML bytes.
 *
 * @param {string} secret
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signAdvisoryWebhookPayload(secret, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Advisory webhook secret must be at least 16 characters.');
  }
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
}

/**
 * Executes the `/advisories` slash command (`list`, `sources`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 *   seenCount?: number,
 * }} input
 */
export function handleAdvisoriesCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_secops';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_secops';
  const seenCount = Number(input.seenCount ?? 0);

  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/advisories ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!ADVISORIES_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_ADVISORIES_SUBCOMMAND',
      `Unsupported /advisories subcommand "${subcommand}"; expected: ${ADVISORIES_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  if (subcommand === 'list') {
    const rawComponent = String(parsed.flags.component ?? 'all').toLowerCase();
    if (rawComponent !== 'all' && !Object.prototype.hasOwnProperty.call(TRACKED_UPSTREAM_COMPONENTS, rawComponent)) {
      throw new ExtensionSdkError(
        'INVALID_UPSTREAM_COMPONENT',
        `Unsupported upstream component "${rawComponent}"; expected: ${Object.keys(TRACKED_UPSTREAM_COMPONENTS).join(', ')}.`
      );
    }
    const minCvss = parsed.flags['min-cvss'] !== undefined ? Number(parsed.flags['min-cvss']) : 0;
    if (!Number.isFinite(minCvss) || minCvss < 0 || minCvss > 10) {
      throw new ExtensionSdkError('INVALID_CVSS_SCORE', '--min-cvss must be between 0.0 and 10.0.');
    }
    return {
      text: `[Security Advisories] Filter [component=${rawComponent}, min-cvss=${minCvss.toFixed(1)}] requested by <@${actorId}>.`,
      ephemeral: true,
      subcommand: 'list',
      component: rawComponent,
      minCvss,
    };
  }

  if (subcommand === 'sources') {
    const source = String(parsed.flags.source ?? 'all').toLowerCase();
    if (!['all', 'ghsa', 'cve', 'cert-fr', 'atom', 'rss'].includes(source)) {
      throw new ExtensionSdkError('INVALID_ADVISORY_SOURCE', `Unsupported advisory source "${source}".`);
    }
    return {
      text: `[Security Advisories] Configured formats [source=${source}] for Synapse, PostgreSQL, Keycloak, Rust, and Node.js.`,
      ephemeral: true,
      subcommand: 'sources',
      source,
    };
  }

  return {
    text: `[Security Advisories] Feed bridge ready in <#${channelId}> (${seenCount} deduplicated key${seenCount === 1 ? '' : 's'}) — tracked: Synapse, PostgreSQL, Keycloak, Rust, Node.js.`,
    ephemeral: true,
    subcommand: 'status',
    seenCount,
  };
}

export const advisoriesCommand = defineSlashCommand({
  name: '/advisories',
  description: 'Inspect upstream security advisories, CVSS thresholds, or tracked components',
  scopes: ['messages:write', 'incidents:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleAdvisoriesCommand({ args, channelId, actorId }),
});

export const slashCommand = advisoriesCommand;

/**
 * Processes one normalized advisory entry, applying bounded FIFO deduplication across
 * feed GUID and `CVE`/`GHSA`/`CERT-FR` identifiers, and posting an incident card (CVSS >= 7.0)
 * or channel message.
 *
 * @param {Record<string, unknown>} entry
 * @param {{
 *   defaultChannelId: string,
 *   seenDedupeKeys: Set<string>,
 *   maxSeenEntries: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processSingleAdvisoryEntry(entry, state) {
  const { defaultChannelId, seenDedupeKeys, maxSeenEntries, client } = state;
  const channelId = String(entry.channelId ?? defaultChannelId);

  const rawTitle = String(entry.title ?? 'Security Advisory');
  const rawSummary = String(entry.summary ?? entry.description ?? '');
  const title = sanitizeAdvisoryText(rawTitle, 'Security Advisory', 160);
  const summaryText = sanitizeAdvisoryText(rawSummary, 'Upstream security update published.', 320);

  const explicitIds = [];
  for (const field of [entry.advisoryId, entry.cveId, entry.ghsaId, entry.certFrId]) {
    if (typeof field === 'string' && field.trim()) explicitIds.push(field.trim());
  }
  const detectedIds = extractAdvisoryIdentifiers(`${explicitIds.join(' ')} ${title} ${summaryText}`);
  const guid = sanitizeAdvisoryText(
    entry.guid ?? entry.id ?? detectedIds[0] ?? createHash('sha256').update(`${title}:${summaryText}`).digest('hex').slice(0, 16),
    'guid-unknown',
    160
  );
  const primaryId = detectedIds[0] ?? guid;

  const candidateKeys = [`guid:${guid}`, ...detectedIds.map((id) => `adv:${id}`)];
  for (const key of candidateKeys) {
    if (seenDedupeKeys.has(key)) {
      return {
        posted: false,
        deduplicated: true,
        advisoryId: primaryId,
        guid,
      };
    }
  }

  const component = resolveUpstreamComponent(entry.component ?? entry.ecosystem ?? entry.category, `${title} ${summaryText}`);
  const cvss = formatCvssSeverity(entry.cvssScore ?? entry.cvss, entry.severity);
  const affected = formatVersionConstraint(entry.affectedVersions ?? entry.vulnerableVersionRange, 'unspecified');
  const patched = formatVersionConstraint(entry.patchedVersions ?? entry.firstPatchedVersion, 'unspecified');
  const advisoryUrl = validateEndpointUrl(
    String(entry.url ?? entry.htmlUrl ?? 'https://advisories.example.org/item'),
    { allowLocalhostHttp: false }
  );

  // Commit keys to bounded FIFO set only after validation succeeds
  for (const key of candidateKeys) {
    if (seenDedupeKeys.size >= maxSeenEntries && !seenDedupeKeys.has(key)) {
      const oldest = seenDedupeKeys.values().next().value;
      if (oldest !== undefined) seenDedupeKeys.delete(oldest);
    }
    seenDedupeKeys.add(key);
  }

  const idListLabel = detectedIds.length > 0 ? detectedIds.join(' / ') : guid;
  const idempotencyKey = `advisory:${primaryId}`;

  if (cvss.incidentSeverity === 'critical' || cvss.incidentSeverity === 'high') {
    const cardTitle = `[${cvss.severityLabel}] ${component.label} — ${idListLabel}: ${title}`.slice(0, 200);
    const cardSummary =
      `Severity: ${cvss.badge} · Component: ${component.label}\n` +
      `Affected: ${affected} · Patched: ${patched}\n` +
      `${summaryText}\n` +
      `Advisory: ${advisoryUrl}`;

    if (client) {
      const delivery = await client.postIncidentCard({
        channelId,
        title: cardTitle,
        severity: cvss.incidentSeverity,
        summary: cardSummary,
        externalUrl: advisoryUrl,
        status: 'open',
        idempotencyKey,
      });
      return {
        posted: true,
        deduplicated: false,
        kind: 'incident',
        advisoryId: primaryId,
        identifiers: detectedIds,
        component: component.key,
        severity: cvss.badge,
        affected,
        patched,
        url: advisoryUrl,
        idempotencyKey,
        delivery,
      };
    }

    return {
      posted: false,
      deduplicated: false,
      kind: 'incident',
      advisoryId: primaryId,
      identifiers: detectedIds,
      component: component.key,
      severity: cvss.badge,
      affected,
      patched,
      url: advisoryUrl,
      idempotencyKey,
      summary: cardSummary,
    };
  }

  const messageText =
    `[ADVISORY · ${cvss.badge}] **${component.label}** (${idListLabel}) — ${title}\n` +
    `Affected: \`${affected}\` · Patched: \`${patched}\`\n` +
    `${summaryText}\n${advisoryUrl}`;
  const blocks = [
    {
      type: 'security_advisory_card',
      advisoryId: primaryId,
      identifiers: detectedIds,
      component: component.key,
      severity: cvss.badge,
      affected,
      patched,
      url: advisoryUrl,
    },
  ];

  if (client) {
    const delivery = await client.postChannelMessage({
      channelId,
      text: messageText,
      blocks,
      idempotencyKey,
    });
    return {
      posted: true,
      deduplicated: false,
      kind: 'message',
      advisoryId: primaryId,
      identifiers: detectedIds,
      component: component.key,
      severity: cvss.badge,
      affected,
      patched,
      url: advisoryUrl,
      idempotencyKey,
      delivery,
    };
  }

  return {
    posted: false,
    deduplicated: false,
    kind: 'message',
    advisoryId: primaryId,
    identifiers: detectedIds,
    component: component.key,
    severity: cvss.badge,
    affected,
    patched,
    url: advisoryUrl,
    idempotencyKey,
    text: messageText,
  };
}

/**
 * Dispatches either a single JSON advisory payload, a JSON `{ entries: [...] }` batch,
 * or an `{ xml: "..." }` envelope.
 *
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   seenDedupeKeys: Set<string>,
 *   maxSeenEntries: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processAdvisoryPayload(payload, state) {
  if (typeof payload.xml === 'string') {
    const parsedEntries = parseXmlAdvisoryFeed(payload.xml);
    const results = [];
    for (const item of parsedEntries) {
      results.push(
        await processSingleAdvisoryEntry(
          { ...item, channelId: payload.channelId },
          state
        )
      );
    }
    return { count: results.length, entries: results };
  }

  if (Array.isArray(payload.entries)) {
    const results = [];
    for (const rawEntry of payload.entries.slice(0, MAX_FEED_ENTRIES)) {
      if (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)) {
        results.push(
          await processSingleAdvisoryEntry(
            { channelId: payload.channelId, ...rawEntry },
            state
          )
        );
      }
    }
    return { count: results.length, entries: results };
  }

  return processSingleAdvisoryEntry(payload, state);
}

/**
 * Creates a webhook handler supporting canonical Kodera `x-kodera-signature-256` JSON deliveries
 * and `X-Advisory-Signature-256` (`HMAC-SHA256`) over raw JSON or Atom/RSS XML bodies.
 *
 * @param {{
 *   secret: string,
 *   advisorySecret?: string,
 *   defaultChannelId?: string,
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   maxSeenEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createRssAdvisoriesWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const advisorySecret = config.advisorySecret ?? config.secret;
  const defaultChannelId = config.defaultChannelId ?? 'chan_secops';
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;
  const maxSeenEntries = config.maxSeenEntries ?? DEFAULT_MAX_SEEN_ENTRIES;

  /** @type {Set<string>} */
  const seenDedupeKeys = new Set();
  /** @type {Map<string, number>} */
  const seenSignatures = new Map();

  const pruneReplay = (nowSec) => {
    for (const [sig, ts] of seenSignatures.entries()) {
      if (nowSec - ts > maxSkewSeconds) seenSignatures.delete(sig);
    }
  };

  const stateBase = {
    defaultChannelId,
    seenDedupeKeys,
    maxSeenEntries,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      'advisory.published': (payload, { client }) => processAdvisoryPayload(payload, { ...stateBase, client }),
      'feed.updated': (payload, { client }) => processAdvisoryPayload(payload, { ...stateBase, client }),
      'incident.opened': (payload, { client }) => processAdvisoryPayload(payload, { ...stateBase, client }),
      'release.published': (payload, { client }) => processAdvisoryPayload(payload, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        handleAdvisoriesCommand({
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_secops'),
          seenCount: seenDedupeKeys.size,
        }),
    },
  });

  return async function handleIncomingAdvisoryWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const advisorySig = getHeaderValue(req.headers, 'x-advisory-signature-256');

    if (koderaSig !== undefined || advisorySig === undefined) {
      return koderaHandler(req);
    }

    if (typeof req.rawBody !== 'string' && !(req.rawBody instanceof Uint8Array)) {
      throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
    }
    const bodyBuf = typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8') : Buffer.from(req.rawBody);
    if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
      throw new WebhookVerificationError('BODY_TOO_LARGE', 'Advisory webhook body is empty or exceeds the byte limit.');
    }

    const sigMatch = ADVISORY_SIG_PATTERN.exec(advisorySig.trim());
    if (!sigMatch) {
      throw new WebhookVerificationError('MISSING_SIGNATURE', 'Malformed X-Advisory-Signature-256 header.');
    }
    const expectedBuf = createHmac('sha256', advisorySecret).update(bodyBuf).digest();
    const actualBuf = Buffer.from(sigMatch[1], 'hex');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'X-Advisory-Signature-256 verification failed.');
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tsHeader = getHeaderValue(req.headers, 'x-advisory-timestamp');
    if (tsHeader !== undefined) {
      if (!/^(0|[1-9]\d{0,15})$/.test(tsHeader.trim())) {
        throw new WebhookVerificationError('MISSING_TIMESTAMP', 'Invalid X-Advisory-Timestamp header.');
      }
      const ts = Number(tsHeader.trim());
      if (!Number.isSafeInteger(ts) || Math.abs(nowSec - ts) > maxSkewSeconds) {
        throw new WebhookVerificationError('TIMESTAMP_OUT_OF_RANGE', 'Advisory webhook timestamp outside replay window.');
      }
    }

    const deliveryId = getHeaderValue(req.headers, 'x-advisory-delivery');
    if (deliveryId !== undefined && !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError('INVALID_DELIVERY_ID', 'X-Advisory-Delivery must be bounded.');
    }

    const sigHex = actualBuf.toString('hex');
    pruneReplay(nowSec);
    if (seenSignatures.has(sigHex)) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate advisory webhook delivery rejected.');
    }
    if (seenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'Advisory replay cache is full.');
    }
    seenSignatures.set(sigHex, nowSec);

    const decodedText = new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf);
    const trimmed = decodedText.trimStart();
    const activeClient = req.client ?? config.client;

    if (trimmed.startsWith('<')) {
      const result = await processAdvisoryPayload({ xml: decodedText }, { ...stateBase, client: activeClient });
      return {
        ok: true,
        status: 200,
        event: 'feed.xml',
        deliveryId,
        result,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(decodedText);
    } catch {
      throw new WebhookVerificationError('INVALID_JSON', 'Advisory webhook payload is neither XML nor valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'Advisory JSON payload must be an object.');
    }

    const result = await processAdvisoryPayload(
      /** @type {Record<string, unknown>} */ (parsed),
      { ...stateBase, client: activeClient }
    );
    return {
      ok: true,
      status: 200,
      event: 'advisory.published',
      deliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createRssAdvisoriesWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  advisoriesCommand,
  handleAdvisoriesCommand,
  createRssAdvisoriesWebhookHandler,
  createExtensionWebhookHandler,
};
