import { createHmac, timingSafeEqual } from 'node:crypto';
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
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9_./-]{1,128}$/;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9_.:/-]{1,50}$/;
const SAFE_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}(?:\[bot\])?$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const GITHUB_SIG_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;
const MAX_PR_THREADS = 1024;

export const GITHUB_SUPPORTED_SUBCOMMANDS = Object.freeze([
  'pr',
  'checks',
  'triage',
  'status',
]);

export const DEFAULT_ALLOWED_GITHUB_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
]);

/**
 * Validates and normalizes the `github` extension manifest.
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ allowLocalhostHttp?: boolean }} [options]
 */
export function validateGithubManifest(input = rawManifest, options = {}) {
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
      `Manifest "id" must be "io.kodera.ext.<slug>" or a lowercase slug (received "${rawId}").`
    );
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

export const extensionManifest = validateGithubManifest(rawManifest);
export const manifest = extensionManifest;

/**
 * Deterministic linear-time plain-text sanitizer without HTML-tag regular expressions.
 *
 * @param {unknown} rawValue
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeGithubText(rawValue, fallback = '', maxLength = 240) {
  if (typeof rawValue !== 'string') {
    return fallback;
  }
  const bounded = rawValue.length > 16_384 ? rawValue.slice(0, 16_384) : rawValue;
  let out = '';
  let inTag = false;
  let lastSpace = true;

  for (let i = 0; i < bounded.length; i += 1) {
    const ch = bounded[i];
    const code = bounded.charCodeAt(i);
    if (ch === '<') {
      inTag = true;
      if (!lastSpace && out.length > 0) {
        out += ' ';
        lastSpace = true;
      }
      continue;
    }
    if (ch === '>') {
      inTag = false;
      continue;
    }
    if (inTag) {
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
 * Validates a GitHub `owner/repo` slug.
 *
 * @param {unknown} rawRepo
 * @returns {string}
 */
export function validateGithubRepoSlug(rawRepo) {
  if (typeof rawRepo !== 'string') {
    throw new ExtensionSdkError('INVALID_GITHUB_REPO', 'GitHub repository must match "owner/repo".');
  }
  const trimmed = rawRepo.trim();
  if (!REPO_SLUG_PATTERN.test(trimmed) || trimmed.includes('..')) {
    throw new ExtensionSdkError('INVALID_GITHUB_REPO', `Invalid GitHub repository slug "${trimmed}".`);
  }
  return trimmed;
}

/**
 * Validates a GitHub HTTPS link against SSRF vectors and an explicit host allowlist.
 *
 * @param {unknown} rawUrl
 * @param {readonly string[]} [allowedHosts]
 * @returns {string}
 */
export function validateGithubUrl(rawUrl, allowedHosts = DEFAULT_ALLOWED_GITHUB_HOSTS) {
  const validated = validateEndpointUrl(String(rawUrl ?? ''), { allowLocalhostHttp: false });
  const parsed = new URL(validated);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const normalizedAllowlist = allowedHosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
  if (!normalizedAllowlist.includes(host)) {
    throw new ExtensionSdkError(
      'UNTRUSTED_GITHUB_HOST',
      `GitHub URL host "${host}" is outside the configured allowlist.`
    );
  }
  return validated;
}

/**
 * Computes a GitHub `X-Hub-Signature-256` (`sha256=<hex>`) header for tests and fixtures.
 *
 * @param {string} secret
 * @param {string | Uint8Array} rawBody
 * @returns {string}
 */
export function signGithubWebhookPayload(secret, rawBody) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'GitHub webhook secret must be at least 16 characters.');
  }
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  return `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
}

/**
 * Verifies a native GitHub `X-Hub-Signature-256` header over exact raw bytes in constant time
 * and cross-checks `X-GitHub-Event` against the authenticated JSON payload shape.
 *
 * @param {{
 *   secret: string,
 *   rawBody: string | Uint8Array,
 *   signatureHeader: string | undefined,
 *   eventHeader: string | undefined,
 * }} params
 */
export function verifyGithubWebhookSignature({ secret, rawBody, signatureHeader, eventHeader }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'GitHub webhook secret must be at least 16 characters.');
  }
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new WebhookVerificationError('INVALID_BODY', 'Webhook rawBody must be a string or Uint8Array.');
  }
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bodyBuf.byteLength === 0 || bodyBuf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookVerificationError('BODY_TOO_LARGE', 'Webhook body is empty or exceeds the byte limit.');
  }

  const sigMatch = typeof signatureHeader === 'string' ? GITHUB_SIG_PATTERN.exec(signatureHeader.trim()) : null;
  if (!sigMatch) {
    throw new WebhookVerificationError('MISSING_SIGNATURE', 'Missing or malformed X-Hub-Signature-256 header.');
  }

  const expectedBuf = createHmac('sha256', secret).update(bodyBuf).digest();
  const actualBuf = Buffer.from(sigMatch[1], 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new WebhookVerificationError('SIGNATURE_MISMATCH', 'GitHub X-Hub-Signature-256 verification failed.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBuf));
  } catch {
    throw new WebhookVerificationError('INVALID_JSON', 'GitHub webhook body is not valid UTF-8 JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebhookVerificationError('INVALID_JSON_OBJECT', 'GitHub webhook payload must be a JSON object.');
  }

  const inferred = inferGithubEventFromPayload(payload);
  const normalizedHeader = typeof eventHeader === 'string' ? eventHeader.trim() : '';
  if (!normalizedHeader || !inferred || normalizedHeader !== inferred) {
    throw new WebhookVerificationError(
      'INVALID_EVENT',
      'X-GitHub-Event header must match the authenticated payload structure.'
    );
  }

  return {
    event: inferred,
    payload: /** @type {Record<string, unknown>} */ (payload),
    signature: `sha256=${actualBuf.toString('hex')}`,
  };
}

/**
 * Infers the GitHub event type from the signed JSON payload so an unsigned header cannot spoof routing.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
function inferGithubEventFromPayload(payload) {
  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (isObj(payload.pull_request) && isObj(payload.review)) return 'pull_request_review';
  if (isObj(payload.pull_request)) return 'pull_request';
  if (isObj(payload.check_suite)) return 'check_suite';
  if (isObj(payload.workflow_run)) return 'workflow_run';
  if (isObj(payload.issue)) return 'issues';
  if (isObj(payload.release)) return 'release';
  return null;
}

/**
 * Executes the `/gh` slash command (`pr`, `checks`, `triage`, `status`).
 *
 * @param {{
 *   rawCommand?: string,
 *   args?: string,
 *   channelId?: string,
 *   actorId?: string,
 * }} input
 */
export function handleGhCommand(input) {
  const channelId = typeof input.channelId === 'string' && input.channelId.trim()
    ? input.channelId.trim()
    : 'chan_dev';
  const actorId = typeof input.actorId === 'string' && input.actorId.trim()
    ? input.actorId.trim()
    : 'usr_unknown';
  const rawLine =
    typeof input.rawCommand === 'string' && input.rawCommand.trim().startsWith('/')
      ? input.rawCommand.trim()
      : `/gh ${String(input.args ?? '').trim()}`.trim();

  const parsed = parseCommandInvocation(rawLine);
  const subcommand = parsed.subcommand ? parsed.subcommand.toLowerCase() : 'status';
  if (!GITHUB_SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
    throw new ExtensionSdkError(
      'UNSUPPORTED_GITHUB_SUBCOMMAND',
      `Unsupported /gh subcommand "${subcommand}"; expected one of: ${GITHUB_SUPPORTED_SUBCOMMANDS.join(', ')}.`
    );
  }

  const rawRepo = parsed.flags.repo ?? parsed.args[0] ?? 'kodera-hq/kodera';
  const repo = validateGithubRepoSlug(rawRepo);

  if (subcommand === 'pr') {
    const state = typeof parsed.flags.state === 'string' ? parsed.flags.state.toLowerCase() : 'open';
    if (!['open', 'merged', 'closed', 'draft', 'all'].includes(state)) {
      throw new ExtensionSdkError('INVALID_PR_STATE', `Unsupported PR state filter "${state}".`);
    }
    const numberFlag = parsed.flags.number !== undefined ? Number(parsed.flags.number) : null;
    if (numberFlag !== null && (!Number.isSafeInteger(numberFlag) || numberFlag < 1)) {
      throw new ExtensionSdkError('INVALID_PR_NUMBER', 'Pull request number must be a positive integer.');
    }
    const url = validateGithubUrl(
      numberFlag ? `https://github.com/${repo}/pull/${numberFlag}` : `https://github.com/${repo}/pulls`
    );
    return {
      text: `[GitHub PR] **${repo}**${numberFlag ? ` #${numberFlag}` : ''} [state=${state}] requested by <@${actorId}> (${url}).`,
      ephemeral: true,
      subcommand: 'pr',
      repository: repo,
      state,
      number: numberFlag,
      url,
    };
  }

  if (subcommand === 'checks') {
    const branch = typeof parsed.flags.branch === 'string' ? parsed.flags.branch.trim() : 'main';
    if (!SAFE_REF_PATTERN.test(branch) || branch.includes('..')) {
      throw new ExtensionSdkError('INVALID_BRANCH_REF', `Invalid git branch reference "${branch}".`);
    }
    const url = validateGithubUrl(`https://github.com/${repo}/actions`);
    return {
      text: `[GitHub Checks] **${repo}** branch \`${branch}\` CI summary requested by <@${actorId}> (${url}).`,
      ephemeral: true,
      subcommand: 'checks',
      repository: repo,
      branch,
      url,
    };
  }

  if (subcommand === 'triage') {
    const rawNumber = parsed.flags.number ?? parsed.args[1] ?? '1';
    const issueNumber = Number(rawNumber);
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      throw new ExtensionSdkError('INVALID_ISSUE_NUMBER', 'Issue number must be a positive integer.');
    }
    const rawLabel = typeof parsed.flags.label === 'string' ? parsed.flags.label.trim() : 'needs-triage';
    if (!SAFE_LABEL_PATTERN.test(rawLabel)) {
      throw new ExtensionSdkError('INVALID_LABEL', `Invalid triage label "${rawLabel}".`);
    }
    const assignee = typeof parsed.flags.assignee === 'string' ? parsed.flags.assignee.trim() : null;
    if (assignee !== null && !SAFE_LOGIN_PATTERN.test(assignee)) {
      throw new ExtensionSdkError('INVALID_ASSIGNEE', `Invalid GitHub login "${assignee}".`);
    }
    const url = validateGithubUrl(`https://github.com/${repo}/issues/${issueNumber}`);
    return {
      text: `[GitHub Triage] **${repo}#${issueNumber}** queued with label \`${rawLabel}\`${assignee ? ` → @${assignee}` : ''} in <#${channelId}> by <@${actorId}> (${url}).`,
      ephemeral: false,
      subcommand: 'triage',
      repository: repo,
      issueNumber,
      label: rawLabel,
      assignee,
      url,
    };
  }

  return {
    text: `[GitHub] Bridge ready in <#${channelId}> for **${repo}** — subcommands: \`pr\`, \`checks\`, \`triage\`, \`status\`.`,
    ephemeral: true,
    subcommand: 'status',
    repository: repo,
  };
}

export const ghCommand = defineSlashCommand({
  name: '/gh',
  description: 'Inspect pull requests, CI checks, or triage issues for a GitHub repository',
  scopes: ['messages:write', 'commands:register'],
  handler: ({ args, channelId, actorId }) => handleGhCommand({ args, channelId, actorId }),
});

export const slashCommand = ghCommand;

/**
 * Formats and dispatches normalized GitHub events (`pull_request`, `pull_request_review`,
 * `check_suite`, `workflow_run`, `issues`, `release`) to Kodera channels and PR threads.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {{
 *   defaultChannelId: string,
 *   allowedHosts: readonly string[],
 *   includeDrafts: boolean,
 *   prThreads: Map<string, string>,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} state
 */
async function processGithubEvent(eventName, payload, state) {
  const { defaultChannelId, allowedHosts, includeDrafts, prThreads, client } = state;
  const repoObj = /** @type {Record<string, unknown> | undefined} */ (
    typeof payload.repository === 'object' && payload.repository !== null ? payload.repository : undefined
  );
  const repo = validateGithubRepoSlug(repoObj?.full_name ?? payload.repository ?? payload.repo);
  const channelId = String(payload.channelId ?? defaultChannelId);

  const rememberThread = (prKey, threadId) => {
    if (prThreads.size >= MAX_PR_THREADS && !prThreads.has(prKey)) {
      const oldest = prThreads.keys().next().value;
      if (oldest !== undefined) prThreads.delete(oldest);
    }
    prThreads.set(prKey, threadId);
  };

  if (eventName === 'pull_request') {
    const pr = /** @type {Record<string, unknown> | undefined} */ (payload.pull_request);
    if (!pr || typeof pr !== 'object') {
      throw new ExtensionSdkError('INVALID_PR_PAYLOAD', 'Missing pull_request object.');
    }
    const prNumber = Number(pr.number);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
      throw new ExtensionSdkError('INVALID_PR_NUMBER', 'pull_request.number must be a positive integer.');
    }
    const action = String(payload.action ?? '');
    const isDraft = Boolean(pr.draft);
    if (isDraft && action !== 'ready_for_review' && !includeDrafts) {
      return { posted: false, ignored: true, reason: 'draft_pull_request', repository: repo, number: prNumber };
    }
    const isMerged = action === 'closed' && Boolean(pr.merged);
    const transition =
      action === 'opened' || action === 'reopened'
        ? action
        : action === 'ready_for_review'
          ? 'ready_for_review'
          : isMerged
            ? 'merged'
            : action === 'closed'
              ? 'closed'
              : null;
    if (!transition) {
      return { posted: false, ignored: true, reason: 'unsupported_pr_action', repository: repo, number: prNumber };
    }

    const title = sanitizeGithubText(pr.title, `Pull request #${prNumber}`, 160);
    const userObj = /** @type {Record<string, unknown> | undefined} */ (pr.user);
    const author = sanitizeGithubText(userObj?.login ?? payload.sender?.login, 'contributor', 60);
    const headRef = sanitizeGithubText(pr.head?.ref, 'feature', 80);
    const baseRef = sanitizeGithubText(pr.base?.ref, 'main', 80);
    const prUrl = validateGithubUrl(pr.html_url ?? `https://github.com/${repo}/pull/${prNumber}`, allowedHosts);
    const badgeMap = {
      opened: '[PR OPENED]',
      reopened: '[PR REOPENED]',
      ready_for_review: '[PR READY FOR REVIEW]',
      merged: '[PR MERGED]',
      closed: '[PR CLOSED]',
    };
    const badge = badgeMap[transition];
    const text = `${badge} **${repo}#${prNumber}** ${title} (\`${headRef}\` → \`${baseRef}\`) by **${author}**\n${prUrl}`;
    const idempotencyKey = `github:pr:${repo}:${prNumber}:${transition}`;
    const blocks = [
      {
        type: 'github_pr_card',
        repository: repo,
        number: prNumber,
        transition,
        title,
        author,
        headRef,
        baseRef,
        url: prUrl,
      },
    ];

    const prKey = `${repo}#${prNumber}`;
    if (client) {
      const existingThread = prThreads.get(prKey);
      if (existingThread && transition !== 'opened') {
        const delivery = await client.postThreadReply({
          channelId,
          threadRootId: existingThread,
          text,
          blocks,
          idempotencyKey,
        });
        return { posted: true, threaded: true, repository: repo, number: prNumber, transition, idempotencyKey, delivery };
      }
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      if (typeof delivery.id === 'string') {
        rememberThread(prKey, delivery.id);
      }
      return { posted: true, threaded: false, repository: repo, number: prNumber, transition, idempotencyKey, delivery };
    }
    return { posted: false, repository: repo, number: prNumber, transition, idempotencyKey, text, blocks };
  }

  if (eventName === 'pull_request_review') {
    const pr = /** @type {Record<string, unknown> | undefined} */ (payload.pull_request);
    const review = /** @type {Record<string, unknown> | undefined} */ (payload.review);
    const prNumber = Number(pr?.number);
    if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !review || typeof review !== 'object') {
      throw new ExtensionSdkError('INVALID_REVIEW_PAYLOAD', 'Invalid pull_request_review payload.');
    }
    const reviewState = String(review.state ?? '').toLowerCase();
    if (payload.action !== 'submitted' || !['approved', 'changes_requested', 'commented'].includes(reviewState)) {
      return { posted: false, ignored: true, reason: 'unsupported_review_state', repository: repo, number: prNumber };
    }
    const reviewer = sanitizeGithubText(review.user?.login, 'reviewer', 60);
    const bodyPreview = sanitizeGithubText(review.body, '', 220);
    const reviewId = String(review.id ?? `${prNumber}-${reviewState}`);
    const reviewUrl = validateGithubUrl(
      review.html_url ?? pr?.html_url ?? `https://github.com/${repo}/pull/${prNumber}`,
      allowedHosts
    );
    const stateLabel =
      reviewState === 'approved'
        ? '[PR APPROVED]'
        : reviewState === 'changes_requested'
          ? '[CHANGES REQUESTED]'
          : '[PR REVIEW COMMENT]';
    const noteLine = bodyPreview ? `\nSummary: ${bodyPreview}` : '';
    const text = `${stateLabel} **${repo}#${prNumber}** reviewed by **${reviewer}**${noteLine}\n${reviewUrl}`;
    const idempotencyKey = `github:review:${repo}:${prNumber}:${reviewId}`;
    const blocks = [
      {
        type: 'github_review_card',
        repository: repo,
        number: prNumber,
        state: reviewState,
        reviewer,
        bodyPreview,
        url: reviewUrl,
      },
    ];

    const prKey = `${repo}#${prNumber}`;
    if (client) {
      const existingThread = prThreads.get(prKey);
      if (existingThread) {
        const delivery = await client.postThreadReply({
          channelId,
          threadRootId: existingThread,
          text,
          blocks,
          idempotencyKey,
        });
        return { posted: true, threaded: true, repository: repo, number: prNumber, state: reviewState, idempotencyKey, delivery };
      }
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, threaded: false, repository: repo, number: prNumber, state: reviewState, idempotencyKey, delivery };
    }
    return { posted: false, repository: repo, number: prNumber, state: reviewState, idempotencyKey, text, blocks };
  }

  if (eventName === 'check_suite' || eventName === 'workflow_run' || eventName === 'ci.workflow_failed') {
    if (eventName === 'ci.workflow_failed') {
      const workflow = sanitizeGithubText(payload.workflow, 'CI', 100);
      const branch = sanitizeGithubText(payload.branch, 'main', 80);
      const runId = String(payload.runId ?? payload.id ?? '1');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) {
        throw new ExtensionSdkError('INVALID_RUN_ID', 'Workflow runId must be alphanumeric.');
      }
      const runUrl = validateGithubUrl(
        payload.runUrl ?? `https://github.com/${repo}/actions/runs/${runId}`,
        allowedHosts
      );
      const summary = sanitizeGithubText(payload.summary ?? payload.failureSummary, 'Workflow failed.', 240);
      const idempotencyKey = `github:ci:${repo}:${runId}:failure`;
      const text = `[CI FAILURE] **${repo}** workflow **${workflow}** failed on \`${branch}\` — ${summary}\n${runUrl}`;
      const blocks = [{ type: 'github_ci_card', repository: repo, workflow, branch, conclusion: 'failure', runId, url: runUrl }];
      if (client) {
        const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
        return { posted: true, repository: repo, conclusion: 'failure', idempotencyKey, delivery };
      }
      return { posted: false, repository: repo, conclusion: 'failure', idempotencyKey, text, blocks };
    }

    const runObj = /** @type {Record<string, unknown> | undefined} */ (
      eventName === 'workflow_run' ? payload.workflow_run : payload.check_suite
    );
    if (!runObj || typeof runObj !== 'object') {
      throw new ExtensionSdkError('INVALID_CI_PAYLOAD', `Missing ${eventName} object.`);
    }
    if (payload.action !== 'completed') {
      return { posted: false, ignored: true, reason: 'ci_not_completed', repository: repo };
    }
    const conclusion = String(runObj.conclusion ?? '').toLowerCase();
    if (!['success', 'failure', 'timed_out', 'cancelled', 'action_required'].includes(conclusion)) {
      return { posted: false, ignored: true, reason: 'unsupported_conclusion', repository: repo };
    }
    const runId = String(runObj.id ?? '0');
    if (!/^[0-9]{1,20}$/.test(runId)) {
      throw new ExtensionSdkError('INVALID_RUN_ID', 'GitHub run id must be numeric.');
    }
    const suiteName = sanitizeGithubText(
      runObj.name ?? runObj.app?.name ?? (eventName === 'workflow_run' ? 'Workflow' : 'Check Suite'),
      'CI',
      100
    );
    const branch = sanitizeGithubText(runObj.head_branch, 'main', 80);
    const shortSha = typeof runObj.head_sha === 'string' && /^[0-9a-fA-F]{7,40}$/.test(runObj.head_sha)
      ? runObj.head_sha.slice(0, 7)
      : 'HEAD';
    const runUrl = validateGithubUrl(
      runObj.html_url ?? `https://github.com/${repo}/actions/runs/${runId}`,
      allowedHosts
    );
    const badge = conclusion === 'success' ? '[CI PASSED]' : '[CI FAILURE]';
    const text = `${badge} **${repo}** ${suiteName} \`${conclusion}\` on \`${branch}\` (\`${shortSha}\`)\n${runUrl}`;
    const idempotencyKey = `github:${eventName}:${repo}:${runId}:${conclusion}`;
    const blocks = [
      {
        type: 'github_ci_card',
        repository: repo,
        source: eventName,
        suiteName,
        branch,
        commit: shortSha,
        conclusion,
        runId,
        url: runUrl,
      },
    ];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, repository: repo, conclusion, runId, idempotencyKey, delivery };
    }
    return { posted: false, repository: repo, conclusion, runId, idempotencyKey, text, blocks };
  }

  if (eventName === 'issues') {
    const issue = /** @type {Record<string, unknown> | undefined} */ (payload.issue);
    const issueNumber = Number(issue?.number);
    if (!issue || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      throw new ExtensionSdkError('INVALID_ISSUE_PAYLOAD', 'Invalid GitHub issue payload.');
    }
    const action = String(payload.action ?? '');
    if (!['opened', 'closed', 'reopened', 'labeled'].includes(action)) {
      return { posted: false, ignored: true, reason: 'unsupported_issue_action', repository: repo, number: issueNumber };
    }
    const title = sanitizeGithubText(issue.title, `Issue #${issueNumber}`, 160);
    const author = sanitizeGithubText(issue.user?.login, 'reporter', 60);
    const labels = Array.isArray(issue.labels)
      ? issue.labels
          .map((lbl) => sanitizeGithubText(typeof lbl === 'string' ? lbl : lbl?.name, '', 40))
          .filter(Boolean)
          .slice(0, 8)
      : [];
    const issueUrl = validateGithubUrl(
      issue.html_url ?? `https://github.com/${repo}/issues/${issueNumber}`,
      allowedHosts
    );
    const labelSuffix = labels.length > 0 ? ` [${labels.join(', ')}]` : '';
    const text = `[ISSUE ${action.toUpperCase()}] **${repo}#${issueNumber}** ${title}${labelSuffix} by **${author}**\n${issueUrl}`;
    const idempotencyKey = `github:issue:${repo}:${issueNumber}:${action}`;
    const blocks = [{ type: 'github_issue_card', repository: repo, number: issueNumber, action, title, labels, url: issueUrl }];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, repository: repo, number: issueNumber, action, idempotencyKey, delivery };
    }
    return { posted: false, repository: repo, number: issueNumber, action, idempotencyKey, text, blocks };
  }

  if (eventName === 'release' || eventName === 'release.published') {
    const rel = /** @type {Record<string, unknown>} */ (
      typeof payload.release === 'object' && payload.release !== null ? payload.release : payload
    );
    if (eventName === 'release' && (payload.action !== 'published' || Boolean(rel.draft))) {
      return { posted: false, ignored: true, reason: 'unpublished_or_draft_release', repository: repo };
    }
    const rawTag = String(rel.tag_name ?? rel.tag ?? '').trim();
    if (!rawTag || !SAFE_REF_PATTERN.test(rawTag) || rawTag.includes('..')) {
      throw new ExtensionSdkError('INVALID_RELEASE_TAG', `Invalid release tag "${rawTag}".`);
    }
    const releaseUrl = validateGithubUrl(
      rel.html_url ?? rel.url ?? `https://github.com/${repo}/releases/tag/${encodeURIComponent(rawTag)}`,
      allowedHosts
    );
    const notes = sanitizeGithubText(rel.body ?? rel.notes, 'Release published.', 320);
    const prerelease = Boolean(rel.prerelease);
    const badge = prerelease ? '[PRE-RELEASE]' : '[RELEASE]';
    const text = `${badge} **${repo} ${rawTag}** — ${notes}\n${releaseUrl}`;
    const idempotencyKey = `github:release:${repo}:${rawTag}`;
    const blocks = [{ type: 'github_release_card', repository: repo, tag: rawTag, prerelease, notes, url: releaseUrl }];
    if (client) {
      const delivery = await client.postChannelMessage({ channelId, text, blocks, idempotencyKey });
      return { posted: true, repository: repo, tag: rawTag, idempotencyKey, delivery };
    }
    return { posted: false, repository: repo, tag: rawTag, idempotencyKey, text, blocks };
  }

  return { posted: false, ignored: true, reason: 'unhandled_event', event: eventName };
}

/**
 * Creates a webhook handler supporting both canonical Kodera `x-kodera-signature-256`
 * deliveries and native GitHub `X-Hub-Signature-256` webhooks with replay protection.
 *
 * @param {{
 *   secret: string,
 *   githubSecret?: string,
 *   defaultChannelId?: string,
 *   allowedHosts?: readonly string[],
 *   includeDrafts?: boolean,
 *   maxSkewSeconds?: number,
 *   maxReplayEntries?: number,
 *   client?: ReturnType<typeof createExtensionClient>,
 * }} config
 */
export function createGithubWebhookHandler(config) {
  if (!config || typeof config.secret !== 'string' || config.secret.length < 16) {
    throw new WebhookVerificationError('INVALID_SECRET', 'Webhook handler requires a secret of at least 16 characters.');
  }

  const defaultChannelId = config.defaultChannelId ?? 'chan_github';
  const githubSecret = config.githubSecret ?? config.secret;
  const allowedHosts = config.allowedHosts ?? DEFAULT_ALLOWED_GITHUB_HOSTS;
  const includeDrafts = Boolean(config.includeDrafts);
  const maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const maxReplayEntries = config.maxReplayEntries ?? MAX_WEBHOOK_REPLAY_ENTRIES;

  /** @type {Map<string, string>} */
  const prThreads = new Map();
  /** @type {Map<string, number>} */
  const nativeSeenSignatures = new Map();
  /** @type {Map<string, number>} */
  const nativeSeenDeliveries = new Map();

  const pruneNativeReplay = (nowSec) => {
    for (const [sig, ts] of nativeSeenSignatures.entries()) {
      if (nowSec - ts > maxSkewSeconds) nativeSeenSignatures.delete(sig);
    }
    for (const [deliv, ts] of nativeSeenDeliveries.entries()) {
      if (nowSec - ts > maxSkewSeconds) nativeSeenDeliveries.delete(deliv);
    }
  };

  const stateBase = {
    defaultChannelId,
    allowedHosts,
    includeDrafts,
    prThreads,
  };

  const koderaHandler = createWebhookHandler({
    secret: config.secret,
    maxSkewSeconds,
    maxReplayEntries,
    client: config.client,
    handlers: {
      pull_request: (payload, { client }) => processGithubEvent('pull_request', payload, { ...stateBase, client }),
      pull_request_review: (payload, { client }) => processGithubEvent('pull_request_review', payload, { ...stateBase, client }),
      check_suite: (payload, { client }) => processGithubEvent('check_suite', payload, { ...stateBase, client }),
      workflow_run: (payload, { client }) => processGithubEvent('workflow_run', payload, { ...stateBase, client }),
      'ci.workflow_failed': (payload, { client }) => processGithubEvent('ci.workflow_failed', payload, { ...stateBase, client }),
      issues: (payload, { client }) => processGithubEvent('issues', payload, { ...stateBase, client }),
      release: (payload, { client }) => processGithubEvent('release', payload, { ...stateBase, client }),
      'release.published': (payload, { client }) => processGithubEvent('release.published', payload, { ...stateBase, client }),
      'command.invoked': async (payload) =>
        ghCommand.handler({
          command: 'gh',
          args: String(payload.args ?? ''),
          channelId: String(payload.channelId ?? defaultChannelId),
          actorId: String(payload.actorId ?? 'usr_unknown'),
        }),
    },
  });

  return async function handleIncomingGithubWebhook(req) {
    const koderaSig = getHeaderValue(req.headers, SIGNATURE_HEADER);
    const hubSig = getHeaderValue(req.headers, 'x-hub-signature-256');

    if (koderaSig !== undefined || hubSig === undefined) {
      return koderaHandler(req);
    }

    const nowSec = req.nowUnixSeconds ?? req.nowSeconds ?? Math.floor(Date.now() / 1000);
    const deliveryId = getHeaderValue(req.headers, 'x-github-delivery');
    if (!deliveryId || !DELIVERY_ID_PATTERN.test(deliveryId)) {
      throw new WebhookVerificationError(
        'INVALID_DELIVERY_ID',
        'Native GitHub webhook requires a bounded X-GitHub-Delivery header.'
      );
    }

    const { event, payload, signature } = verifyGithubWebhookSignature({
      secret: githubSecret,
      rawBody: req.rawBody,
      signatureHeader: hubSig,
      eventHeader: getHeaderValue(req.headers, 'x-github-event'),
    });

    pruneNativeReplay(nowSec);
    if (nativeSeenSignatures.has(signature) || nativeSeenDeliveries.has(deliveryId)) {
      throw new WebhookVerificationError('REPLAY_DETECTED', 'Duplicate GitHub webhook delivery rejected.');
    }
    if (nativeSeenSignatures.size >= maxReplayEntries) {
      throw new WebhookVerificationError('REPLAY_CAPACITY_EXCEEDED', 'GitHub webhook replay cache is full.');
    }
    nativeSeenSignatures.set(signature, nowSec);
    nativeSeenDeliveries.set(deliveryId, nowSec);

    const activeClient = req.client ?? config.client;
    const result = await processGithubEvent(event, payload, { ...stateBase, client: activeClient });
    return {
      ok: true,
      status: result.ignored ? 202 : 200,
      event,
      deliveryId,
      result,
    };
  };
}

export const createExtensionWebhookHandler = createGithubWebhookHandler;

export default {
  manifest,
  extensionManifest,
  slashCommand,
  ghCommand,
  handleGhCommand,
  createGithubWebhookHandler,
  createExtensionWebhookHandler,
};
