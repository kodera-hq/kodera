import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ExtensionSdkError, validateEndpointUrl, validateManifest } from '@kodera/extension-sdk';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export const extensionManifest = validateManifest(readJson('../kodera-extension.json'));
const messages = { en: readJson('./locales/en.json'), fr: readJson('./locales/fr.json') };
const MAX_BYTES = 1_048_576;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => { throw new ExtensionSdkError(code, 'Git tracker request rejected.'); };
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function header(headers, name) {
  if (headers instanceof Headers) return headers.get(name);
  const values = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  if (values.length !== 1 || typeof values[0][1] !== 'string') return null;
  return values[0][1];
}

/** Authenticate exact raw bytes before JSON parsing or replay reservation. */
export function verifyProviderRequest({ provider, secret, headers, rawBody }) {
  if (!['github', 'gitlab'].includes(provider) || typeof secret !== 'string' || secret.length < 32) fail('INVALID_CONFIG');
  if (!(typeof rawBody === 'string' || rawBody instanceof Uint8Array)) fail('INVALID_BODY');
  const bytes = Buffer.from(rawBody);
  if (!bytes.length || bytes.length > MAX_BYTES) fail('INVALID_BODY');
  if (provider === 'github') {
    const signature = header(headers, 'x-hub-signature-256');
    if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature ?? '')) fail('INVALID_SIGNATURE');
    const expected = createHmac('sha256', secret).update(bytes).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) fail('INVALID_SIGNATURE');
  } else {
    // GitLab's legacy token is a bearer secret, NOT a per-payload HMAC signature.
    const token = header(headers, 'x-gitlab-token');
    if (typeof token !== 'string' || token.length > 4096) fail('INVALID_SIGNATURE');
    const digest = (value) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(secret), digest(token))) fail('INVALID_SIGNATURE');
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('INVALID_BODY'); }
  if (!object(payload)) fail('INVALID_BODY');
  return { payload, digest: sha(bytes) };
}

function eventKind(provider, payload, headers) {
  if (provider === 'gitlab') {
    const names = { push: 'Push Hook', merge_request: 'Merge Request Hook', issue: 'Issue Hook', release: 'Release Hook', pipeline: 'Pipeline Hook' };
    if (!Object.hasOwn(names, payload.object_kind) || header(headers, 'x-gitlab-event') !== names[payload.object_kind]) fail('INVALID_EVENT');
    return payload.object_kind;
  }
  // GitHub does not sign its event header. Infer the event from the signed body too.
  const candidates = [
    ['push', typeof payload.ref === 'string' && Array.isArray(payload.commits)],
    ['pull_request_review', object(payload.pull_request) && object(payload.review)],
    ['pull_request', object(payload.pull_request) && !payload.review],
    ['issues', object(payload.issue)], ['release', object(payload.release)],
    ['workflow_run', object(payload.workflow_run)], ['check_suite', object(payload.check_suite)],
  ].filter(([, matches]) => matches);
  if (candidates.length !== 1 || header(headers, 'x-github-event') !== candidates[0][0]) fail('INVALID_EVENT');
  return candidates[0][0];
}

const lockfiles = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;
function botLockfiles(commits, botNames) {
  return commits.length > 0 && commits.every((commit) => {
    const actor = commit.author?.username ?? commit.author?.name;
    const files = ['added', 'modified', 'removed'].flatMap((key) => Array.isArray(commit[key]) ? commit[key] : []);
    return botNames.includes(actor) && files.length > 0 && files.every((file) => typeof file === 'string' && lockfiles.test(file));
  });
}

function normalize(provider, event, payload, repository, config) {
  const github = provider === 'github';
  const base = `${config.providerOrigin}/${repository.slug}`;
  const item = payload.object_attributes;
  const pull = github ? payload.pull_request : item;
  const link = (type, id) => github ? `${base}/${type}/${id}` : `${base}/-/${type}/${id}`;
  const card = (kind, url, number = null) => ({ kind, url, number });
  if (event === 'push') {
    if (payload.deleted || payload.ref !== `refs/heads/${repository.defaultBranch}` && !config.includeOtherBranches) return null;
    if (!Array.isArray(payload.commits) || !payload.commits.length) return null;
    if (!config.includeBotLockfiles && botLockfiles(payload.commits, config.botNames)) return null;
    return card('push', github ? `${base}/commits` : `${base}/-/commits`);
  }
  if (event === 'pull_request' || event === 'merge_request') {
    if (!object(pull) || !integer(github ? pull.number : pull.iid)) fail('INVALID_EVENT');
    const action = github ? payload.action : pull.action;
    const ready = github ? action === 'ready_for_review' : action === 'update' && payload.changes?.draft?.previous === true && payload.changes?.draft?.current === false;
    if ((pull.draft || pull.work_in_progress) && !config.includeDrafts) return null;
    const kind = action === 'opened' || action === 'open' ? 'pull_opened' : ready ? 'pull_ready' : (action === 'closed' && pull.merged === true) || action === 'merge' ? 'pull_merged' : action === 'closed' || action === 'close' ? 'pull_closed' : null;
    const id = github ? pull.number : pull.iid;
    return kind ? card(kind, link(github ? 'pull' : 'merge_requests', id), id) : null;
  }
  if (event === 'pull_request_review') {
    const state = payload.review.state;
    if (payload.action !== 'submitted' || !['approved', 'changes_requested', 'commented'].includes(state)) return null;
    if (!integer(pull.number)) fail('INVALID_EVENT');
    return card(`review_${state}`, link('pull', pull.number), pull.number);
  }
  if (event === 'issues' || event === 'issue') {
    const issue = github ? payload.issue : item;
    const action = github ? payload.action : issue?.action;
    const id = github ? issue?.number : issue?.iid;
    if (!integer(id)) fail('INVALID_EVENT');
    const kind = ['opened', 'open'].includes(action) ? 'issue_opened' : ['closed', 'close'].includes(action) ? 'issue_closed' : null;
    return kind ? card(kind, link('issues', id), id) : null;
  }
  if (event === 'release') {
    if ((github && payload.action !== 'published') || (!github && payload.action !== 'create')) return null;
    if (github && payload.release.draft) return null;
    return card('release', github ? `${base}/releases` : `${base}/-/releases`);
  }
  const run = github ? payload.workflow_run ?? payload.check_suite : item;
  if (!object(run) || !integer(run.id)) fail('INVALID_EVENT');
  if (github && (payload.action !== 'completed' || run.status !== 'completed')) return null;
  const result = github ? run.conclusion : run.status;
  if (!['failure', 'failed', 'timed_out', 'action_required', 'success'].includes(result)) return null;
  const branch = github ? run.head_branch : run.ref;
  if (branch !== repository.defaultBranch) return null;
  const workflow = event === 'workflow_run' ? run.workflow_id : event === 'check_suite' ? run.app?.id : 1;
  const sequence = event === 'workflow_run' ? run.run_number : run.id;
  if (!integer(workflow) || !integer(sequence)) fail('INVALID_EVENT');
  const state = result === 'success' ? 'success' : 'failure';
  return {
    ...card(state === 'success' ? 'recovered' : 'failed', github ? event === 'workflow_run' ? `${base}/actions/runs/${run.id}` : `${base}/actions` : `${base}/-/pipelines/${run.id}`, run.id),
    transition: { key: `${event}:${repository.slug}:${workflow}`, state, sequence: [sequence, integer(run.run_attempt) ? run.run_attempt : 1] },
  };
}

/**
 * Native ingress with a REQUIRED transactional durable outbox.
 * enqueue atomically stores receipt keys, safe card and CI transition; see README.
 * client is createExtensionClient(...) from the SDK; no credentials enter cards.
 */
export function createGitTracker(config) {
  const { provider, secret, hookId, channelId, deliveryStore, client, locale = 'en' } = config;
  if (!['github', 'gitlab'].includes(provider) || typeof secret !== 'string' || secret.length < 32 || !/^[a-zA-Z0-9_-]{1,64}$/.test(hookId ?? '') || !/^[a-zA-Z0-9:_-]{1,128}$/.test(channelId ?? '') || !Object.hasOwn(messages, locale)) fail('INVALID_CONFIG');
  if (!deliveryStore || ['enqueue', 'pending', 'complete'].some((key) => typeof deliveryStore[key] !== 'function') || typeof client?.postChannelMessage !== 'function') fail('DURABLE_OUTBOX_REQUIRED');
  const origin = new URL(validateEndpointUrl(config.providerOrigin ?? (provider === 'github' ? 'https://github.com' : 'https://gitlab.com')));
  if (origin.pathname !== '/' || origin.search || origin.hash) fail('INVALID_CONFIG');
  if (!Array.isArray(config.repositories) || !config.repositories.length) fail('INVALID_CONFIG');
  const repositories = new Map();
  for (const repository of config.repositories) {
    if (!object(repository) || typeof repository.slug !== 'string' || repository.slug.length > 250 || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/.test(repository.slug) || typeof repository.defaultBranch !== 'string' || !repository.defaultBranch.length || repository.defaultBranch.length > 250) fail('INVALID_CONFIG');
    repositories.set(repository.slug, { ...repository });
  }
  const safeConfig = { ...config, providerOrigin: origin.origin, botNames: config.botNames ?? ['dependabot[bot]', 'renovate[bot]', 'renovate-bot'] };
  const scope = sha(`${provider}:${hookId}:${channelId}`);
  return {
    async receive({ headers, rawBody }) {
      const { payload, digest } = verifyProviderRequest({ provider, secret, headers, rawBody });
      const delivery = header(headers, provider === 'github' ? 'x-github-delivery' : 'x-gitlab-event-uuid');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(delivery ?? '')) fail('INVALID_DELIVERY');
      const event = eventKind(provider, payload, headers);
      const slug = provider === 'github' ? payload.repository?.full_name : payload.project?.path_with_namespace;
      const repository = repositories.get(slug);
      if (!repository) fail('REPOSITORY_NOT_ALLOWED');
      const normalized = normalize(provider, event, payload, repository, safeConfig);
      const id = sha(`${scope}:${digest}`);
      const keys = [`${scope}:body:${digest}`, `${scope}:delivery:${delivery}`];
      const { transition, ...metadata } = normalized ?? {};
      const text = normalized ? `${repository.slug} · ${messages[locale][metadata.kind]}${metadata.number ? ` #${metadata.number}` : ''}\n${metadata.url}` : '';
      // Never store the raw body, sender, title, message, URL query or bearer secret.
      const item = normalized ? { id, scope, channelId, text, blocks: [{ type: 'git_tracker_card', provider, repository: repository.slug, ...metadata }] } : null;
      return deliveryStore.enqueue({ id, keys, item, transition: transition ? { ...transition, key: `${scope}:${transition.key}` } : null });
    },
    async deliverPending(limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_LIMIT');
      let sent = 0;
      for (const item of await deliveryStore.pending(limit, scope)) {
        if (item.scope !== scope || item.channelId !== channelId) fail('OUTBOX_SCOPE_MISMATCH');
        await client.postChannelMessage({ channelId: item.channelId, text: item.text, blocks: item.blocks, idempotencyKey: item.id });
        await deliveryStore.complete(item.id);
        sent += 1;
      }
      return sent;
    },
  };
}

/** Tests/local development ONLY. Production must inject a durable transactional store. */
export function createMemoryDeliveryStore({ capacity = 4096 } = {}) {
  if (!Number.isInteger(capacity) || capacity < 2) fail('INVALID_CONFIG');
  const receipts = new Set();
  const outbox = new Map();
  const states = new Map();
  return {
    async enqueue({ id, keys, item, transition }) {
      // No await inside this atomic section. A DB adapter needs unique keys + a transaction.
      if (keys.some((key) => receipts.has(key))) return { status: 'duplicate' };
      if (receipts.size + keys.length > capacity) fail('REPLAY_STORE_FULL');
      let emit = item !== null;
      if (transition) {
        const previous = states.get(transition.key);
        const newer = !previous || transition.sequence[0] > previous.sequence[0] || transition.sequence[0] === previous.sequence[0] && transition.sequence[1] > previous.sequence[1];
        if (!newer) emit = false;
        else {
          emit = transition.state === 'failure' ? previous?.state !== 'failure' : previous?.state === 'failure';
          states.set(transition.key, structuredClone(transition));
        }
      }
      keys.forEach((key) => receipts.add(key));
      if (emit) outbox.set(id, structuredClone(item));
      return { status: emit ? 'queued' : 'ignored' };
    },
    async pending(limit, scope) { return structuredClone([...outbox.values()].filter((item) => item.scope === scope).slice(0, limit)); },
    async complete(id) { outbox.delete(id); },
  };
}
