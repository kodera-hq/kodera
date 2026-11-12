import { randomBytes, randomUUID, createPublicKey } from 'node:crypto'
import { readFile, mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import assert from 'node:assert/strict'

export const TEMPLATES = Object.freeze({
  'audiovisual-production': {
    channels: [
      'production',
      'post-production',
      'dailies-rushes',
      'tournage',
      'stage-control',
      'editing-room',
    ],
    connectors: ['frameio-review-bridge'],
    roles: ['Producer', 'Director', 'post-production', 'VFX/Sound Supervisor'],
  },
  'tech-studio': {
    channels: ['general', 'architecture', 'incident-prod'],
    connectors: ['github-repo-tracker'],
    roles: ['Owner', 'Engineer'],
  },
  'b2b-advisory': {
    channels: ['general', 'client-projects', 'deliverables'],
    connectors: ['qonto-treasury-feed'],
    roles: ['Partner', 'Consultant'],
  },
  'public-sector': {
    channels: ['general', 'compliance', 'on-call'],
    connectors: [],
    roles: ['Coordinator', 'Member'],
  },
  proximity: {
    aliases: ['crisis-cell'],
    channels: ['general', 'incident-log', 'field-bridge', 'proximity'],
    connectors: ['uptime-incident-bridge'],
    roles: ['Coordinator', 'Responder'],
  },
  community: {
    channels: [
      'announcements',
      'general',
      'developers-community',
      'support',
      'extensions',
      'self-hosting',
      'show-and-tell',
      'office-hours',
      'dev',
      'strategy',
      'ops-oncall',
    ],
    connectors: [],
    roles: ['Owner', 'Administrator', 'Member'],
    categories: [
      {
        name: 'Community',
        visibility: 'members',
        channels: [
          'announcements',
          'general',
          'developers-community',
          'support',
          'extensions',
          'self-hosting',
          'show-and-tell',
          'office-hours',
        ],
      },
      {
        name: 'Core Kodera',
        visibility: 'restricted',
        channels: ['dev', 'strategy', 'ops-oncall'],
      },
      {
        name: 'Design Partners',
        visibility: 'restricted',
        channels: [],
      },
    ],
    readOnlyChannels: ['announcements'],
    voiceChannels: ['office-hours'],
  },
})
export type TemplateId = keyof typeof TEMPLATES
export type Options = Record<string, string | boolean>
// A template keeps every identifier it ever had: `crisis-cell` selects `proximity`, permanently.
export const TEMPLATE_ALIASES: Readonly<Record<string, TemplateId>> =
  Object.freeze({ 'crisis-cell': 'proximity' })
// The only placeholders this generator may fill with random bytes. Every other placeholder is a
// credential someone issues (an agent token, an identity provider's client secret): it is left
// empty, never invented.
const GENERATED_SECRETS: ReadonlySet<string> = new Set([
  'POSTGRES_PASSWORD',
  'SYNAPSE_POSTGRES_PASSWORD',
  'DJANGO_SECRET_KEY',
  'KODERA_CONTACT_SEAL_KEY',
  'KODERA_OUTBOX_SEAL_KEY',
  'KODERA_MEMBERSHIP_CURSOR_KEY',
  'KODERA_DISCOVERY_HMAC_KEY',
  'ROOM_ACCESS_MATRIX_TOKEN',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
])
// The Compose assets, copied from `deploy/community` by `sync-assets.mjs` and checked against it.
export const ASSET_FILES = Object.freeze([
  'docker-compose.yml',
  'Caddyfile',
  'livekit.yaml',
  'configure_synapse.py',
])
const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url))
export function publicDomain(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value) ||
    /\.(local|internal|localhost|test|invalid)$/u.test(value)
  )
    throw new Error('INVALID_PUBLIC_DOMAIN')
  return value
}
export function publicHttps(value: unknown, origin = false): URL {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\s\\'"`$]/u.test(value)
  )
    throw new Error('INVALID_HTTPS_URL')
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (origin && url.pathname !== '/')
  )
    throw new Error('INVALID_HTTPS_URL')
  publicDomain(url.hostname)
  return url
}
export function scalar(value: unknown, max = 128): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    /[\p{Cc}\p{Cf}'"`$\\]/u.test(value)
  )
    throw new Error('INVALID_SCALAR')
  return value
}
export function parseArgs(args: readonly string[]): Options {
  if (args.length > 64) throw new Error('TOO_MANY_ARGUMENTS')
  const booleans = new Set([
    'self-host',
    'cloud',
    'dry-run',
    'selftest',
    'help',
  ])
  const strings = new Set([
    'domain',
    'oidc-issuer',
    'oidc-client-id',
    'template',
    'output-dir',
    'org',
    'api-url',
    'trust-file',
    'support-mailbox',
    'source-dir',
    'token-file',
    'idempotency-key',
  ])
  const result: Options = {}
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (!raw?.startsWith('--') || raw.length > 4096)
      throw new Error('INVALID_ARGUMENT')
    const key = raw.slice(2)
    if (key in result) throw new Error('DUPLICATE_ARGUMENT')
    if (booleans.has(key)) result[key] = true
    else if (strings.has(key)) {
      const value = args[++i]
      if (!value || value.startsWith('--') || value.length > 4096)
        throw new Error('MISSING_ARGUMENT')
      result[key] = value
    } else throw new Error('UNKNOWN_ARGUMENT')
  }
  if (result.cloud && result['self-host']) throw new Error('CONFLICTING_MODES')
  return result
}
export function plan(options: Options) {
  const requested = options.template ?? 'audiovisual-production'
  const id =
    typeof requested === 'string' && Object.hasOwn(TEMPLATE_ALIASES, requested)
      ? TEMPLATE_ALIASES[requested]
      : requested
  if (typeof id !== 'string' || !Object.hasOwn(TEMPLATES, id))
    throw new Error('INVALID_TEMPLATE')
  const { aliases: _aliases, ...template } = TEMPLATES[id as TemplateId] as {
    aliases?: readonly string[]
  } & (typeof TEMPLATES)[TemplateId]
  if (options['self-host']) {
    const domain = publicDomain(options.domain)
    const issuer = publicHttps(options['oidc-issuer'])
    const clientId = scalar(options['oidc-client-id'])
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(clientId))
      throw new Error('INVALID_CLIENT_ID')
    return {
      mode: 'self-host' as const,
      domain,
      issuer: issuer.href,
      clientId,
      templateId: id as TemplateId,
      ...template,
      files: ['.env', ...ASSET_FILES, 'workspace-template.json', 'README.md'],
    }
  }
  if (options.cloud) {
    if (id === 'community') throw new Error('INVALID_TEMPLATE')
    const name = scalar(options.org, 80).trim()
    if (!name) throw new Error('INVALID_ORGANIZATION')
    const slug = name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 63)
    if (!slug) throw new Error('INVALID_SLUG')
    const api = options['api-url']
      ? publicHttps(options['api-url']).href
      : undefined
    return {
      mode: 'cloud' as const,
      apiUrl: api,
      payload: {
        organizationName: name,
        slug,
        hostingMode: 'cloud',
        templateId: id as TemplateId,
        themeId: 'givre',
        soundPackId: 'givre',
        enabledConnectors: template.connectors,
      },
      ...template,
    }
  }
  throw new Error('CHOOSE_CLOUD_OR_SELF_HOST')
}
async function publicTrust(path: unknown, issuer: string) {
  const file = scalar(path, 4096)
  if (/(^|\/)\.env(?:\.|$)/u.test(file))
    throw new Error('TRUST_FILE_MUST_BE_PUBLIC_JSON')
  if ((await stat(file)).size > 65536) throw new Error('TRUST_TOO_LARGE')
  const trust: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(trust) || trust.length < 1 || trust.length > 8)
    throw new Error('INVALID_PUBLIC_TRUST')
  for (const item of trust) {
    if (
      !item ||
      typeof item !== 'object' ||
      !['customer', 'staff'].includes(item.lane) ||
      typeof item.generation !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(item.generation) ||
      !Number.isSafeInteger(item.expires_at) ||
      item.expires_at <= Date.now() / 1000
    )
      throw new Error('INVALID_PUBLIC_TRUST')
    publicHttps(item.issuer)
    const keys = item.public_jwks?.keys
    if (!Array.isArray(keys) || !keys.length || keys.length > 16)
      throw new Error('INVALID_PUBLIC_KEYS')
    for (const key of keys) {
      if (
        !key ||
        typeof key !== 'object' ||
        ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some((k) =>
          Object.hasOwn(key, k),
        )
      )
        throw new Error('PRIVATE_TRUST_MATERIAL')
      createPublicKey({ key, format: 'jwk' })
    }
  }
  if (
    !trust.some(
      (item) =>
        item.lane === 'customer' && item.issuer === issuer.replace(/\/$/u, ''),
    )
  )
    throw new Error('ISSUER_TRUST_MISMATCH')
  const serialized = JSON.stringify(trust)
  if (/[\r\n']/u.test(serialized)) throw new Error('INVALID_PUBLIC_TRUST')
  return serialized
}
export async function generate(options: Options) {
  const prepared = plan(options)
  if (prepared.mode !== 'self-host') throw new Error('SELF_HOST_REQUIRED')
  if (options['dry-run']) return prepared
  const trust = await publicTrust(options['trust-file'], prepared.issuer)
  const source = resolve(
    typeof options['source-dir'] === 'string'
      ? options['source-dir']
      : process.cwd(),
  )
  scalar(source, 4096)
  await stat(join(source, 'deploy/community/docker-compose.yml'))
  const mailbox = options['support-mailbox'] ?? `support@${prepared.domain}`
  if (
    typeof mailbox !== 'string' ||
    mailbox.length > 254 ||
    !/^[a-zA-Z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/u.test(mailbox)
  )
    throw new Error('INVALID_SUPPORT_MAILBOX')
  const labels = prepared.domain.split('.')
  const values: Record<string, string> = {
    KODERA_OIDC_CLIENT_ID: prepared.clientId,
    KODERA_DOMAIN: prepared.domain,
    // The base domain, without the tenant label, as `deploy/community/kodera_deploy.py` derives it.
    KODERA_MATRIX_DOMAIN:
      labels.length >= 3 ? labels.slice(1).join('.') : prepared.domain,
    KODERA_ACME_EMAIL: mailbox,
    DJANGO_ALLOWED_HOSTS: `${prepared.domain},127.0.0.1`,
    KODERA_OIDC_PROVIDER_ORIGIN: new URL(prepared.issuer).origin,
    KODERA_AUTH_TRUST: `'${trust}'`,
    // An isolated self-host: no canonical Community bootstrap and no tenant agent.
    KODERA_DEFAULT_COMMUNITY_ORG_SLUG: '',
  }
  const example = await readFile(join(ASSETS, '.env.example'), 'utf8')
  const content =
    example
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .map((line) => {
        if (!line.includes('=')) return line
        const [key, ...rest] = line.split('=')
        const value =
          values[key] ??
          (rest.join('=').includes('CHANGE_ME_')
            ? !GENERATED_SECRETS.has(key)
              ? ''
              : key.endsWith('SEAL_KEY')
                ? randomBytes(32)
                    .toString('base64')
                    .replace(/\+/gu, '-')
                    .replace(/\//gu, '_')
                : randomBytes(32).toString('hex')
            : rest.join('='))
        return `${key}=${value}`
      })
      .join('\n') + `\nKODERA_SOURCE_DIR='${source}'\n`
  if (content.includes('CHANGE_ME_')) throw new Error('UNFILLED_CONFIGURATION')
  const output = resolve(
    typeof options['output-dir'] === 'string'
      ? options['output-dir']
      : 'kodera-workspace',
  )
  await mkdir(output, { mode: 0o700 })
  try {
    await writeFile(join(output, '.env'), content, { mode: 0o600, flag: 'wx' })
    for (const name of ASSET_FILES)
      await writeFile(join(output, name), await readFile(join(ASSETS, name)), {
        flag: 'wx',
      })
    const intent: Record<string, unknown> = {
      templateId: prepared.templateId,
      channels: prepared.channels,
      roles: prepared.roles,
      enabledConnectors: prepared.connectors,
    }
    for (const key of ['categories', 'readOnlyChannels', 'voiceChannels'] as const)
      if (key in prepared)
        intent[key] = (prepared as Record<string, unknown>)[key]
    await writeFile(
      join(output, 'workspace-template.json'),
      JSON.stringify(intent, null, 2) + '\n',
      { flag: 'wx' },
    )
    await writeFile(
      join(output, 'README.md'),
      '# Kodera Community\n\nExternal OIDC issuer and public trust are configured. Runtime images are built from KODERA_SOURCE_DIR.\nThe workspace-template.json is a provisioning intent, not proof that remote channels or connectors exist.\nMatrix sign-in is not configured: set KODERA_SYNAPSE_OIDC_ISSUER and KODERA_SYNAPSE_OIDC_CLIENT_SECRET in .env (see deploy/community/README.md in the source checkout, "Matrix sign-in"). Federation is closed.\n\nStart explicitly from this directory: docker compose --env-file .env up -d --build\n',
      { flag: 'wx' },
    )
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
  return { ...prepared, output }
}
export async function claimCloud(options: Options) {
  const prepared = plan(options)
  if (prepared.mode !== 'cloud') throw new Error('CLOUD_REQUIRED')
  if (options['dry-run']) return prepared
  if (!prepared.apiUrl)
    return {
      ...prepared,
      status: 'request-prepared',
      next: 'Provide --api-url with the Core API base to request allocation.',
    }
  const url = prepared.apiUrl.replace(/\/$/u, '') + '/workspaces/instant-claim'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': options['idempotency-key']
      ? scalar(options['idempotency-key'])
      : randomUUID(),
  }
  if (options['token-file']) {
    const file = scalar(options['token-file'], 4096)
    if (/(^|\/)\.env(?:\.|$)/u.test(file) || (await stat(file)).size > 16384)
      throw new Error('INVALID_TOKEN_FILE')
    const token = (await readFile(file, 'utf8')).trim()
    if (!/^[A-Za-z0-9._~-]{1,16384}$/u.test(token))
      throw new Error('INVALID_ACCESS_TOKEN')
    headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(prepared.payload),
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  })
  if (![200, 201].includes(response.status))
    throw new Error(`CLOUD_REFUSED_${response.status}`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('INVALID_CLOUD_RESPONSE')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 65536) {
        await reader.cancel()
        throw new Error('CLOUD_RESPONSE_TOO_LARGE')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const workspace = publicHttps(body.workspaceUrl)
  if (
    typeof body.workspaceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(body.workspaceId) ||
    !Array.isArray(body.channels) ||
    body.channels.length > 128 ||
    !body.channels.every(
      (c: unknown) =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Record<string, unknown>).name === 'string' &&
        String((c as Record<string, unknown>).name).length <= 80 &&
        !/[\p{Cc}\p{Cf}]/u.test(String((c as Record<string, unknown>).name)),
    )
  )
    throw new Error('INVALID_CLOUD_RESPONSE')
  return {
    workspaceId: body.workspaceId,
    workspaceUrl: workspace.href,
    channels: body.channels.map((c: { name: string }) => c.name),
    loginCommand: `${process.platform === 'darwin' ? 'open' : 'xdg-open'} '${workspace.href}'`,
  }
}
export async function selftest() {
  let count = 0
  const test = (fn: () => unknown) => {
    fn()
    count++
  }
  const base = {
    'self-host': true,
    domain: 'chat.example.org',
    'oidc-issuer': 'https://id.example.org/realms/studio',
    'oidc-client-id': 'kodera-web',
    'dry-run': true,
  }
  for (const template of Object.keys(TEMPLATES))
    test(() => {
      const prepared = plan({ ...base, template })
      assert.equal(
        prepared.mode === 'self-host'
          ? prepared.templateId
          : prepared.payload.templateId,
        template,
      )
    })
  test(() =>
    assert.throws(() =>
      plan({ ...base, 'oidc-issuer': 'http://id.example.org' }),
    ),
  )
  test(() => assert.throws(() => plan({ ...base, domain: 'invalid;command' })))
  test(() =>
    assert.throws(() =>
      plan({ ...base, 'oidc-client-id': 'client\nINJECT=1' }),
    ),
  )
  test(() => assert.deepEqual(plan(base), plan(base)))
  test(() => assert.throws(() => parseArgs(['--cloud', '--self-host'])))
  test(() => assert.throws(() => parseArgs(['--domain', 'a', '--domain', 'b'])))
  test(() =>
    assert.throws(() => publicHttps('https://user:password@id.example.org')),
  )
  test(() => assert.throws(() => plan({ ...base, template: 'unknown' })))
  test(() =>
    assert.deepEqual(
      plan({ ...base, template: 'crisis-cell' }),
      plan({ ...base, template: 'proximity' }),
    ),
  )
  test(() =>
    assert.throws(() =>
      plan({ cloud: true, org: 'Cinema', template: 'community' }),
    ),
  )
  test(() =>
    assert.equal(
      plan({ ...base, template: 'audiovisual-production' }).connectors[0],
      'frameio-review-bridge',
    ),
  )
  const temporary = await mkdtemp(join(tmpdir(), 'kodera-cli-selftest-'))
  try {
    const { publicKey } = await import('node:crypto').then((m) =>
      m.generateKeyPairSync('rsa', { modulusLength: 2048 }),
    )
    const trust = join(temporary, 'public-trust.json')
    await writeFile(
      trust,
      JSON.stringify([
        {
          lane: 'customer',
          issuer: 'https://id.example.org/realms/studio',
          generation: 'selftest',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          public_jwks: { keys: [publicKey.export({ format: 'jwk' })] },
        },
      ]),
    )
    const fixtureSource = join(temporary, 'source')
    await mkdir(join(fixtureSource, 'deploy/community'), { recursive: true })
    await writeFile(
      join(fixtureSource, 'deploy/community/docker-compose.yml'),
      '# Synthetic source checkout',
    )
    const output = join(temporary, 'workspace')
    await generate({
      ...base,
      'dry-run': false,
      'trust-file': trust,
      'output-dir': output,
      'source-dir': fixtureSource,
    })
    const mode = (await stat(join(output, '.env'))).mode & 0o777
    test(() => assert.equal(mode, 0o600))
    await assert.rejects(() =>
      generate({
        ...base,
        'dry-run': false,
        'trust-file': trust,
        'output-dir': output,
        'source-dir': fixtureSource,
      }),
    )
    count++
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  console.log(`PASS: ${count} CLI selftests`)
}
export async function run(args: readonly string[]) {
  try {
    const options = parseArgs(args)
    if (options.selftest) {
      await selftest()
      return 0
    }
    if (options.help) {
      console.log(
        'create-kodera --self-host --domain DOMAIN --oidc-issuer HTTPS --oidc-client-id ID --trust-file PUBLIC_JSON --source-dir CHECKOUT [--template ID] [--output-dir DIR] [--dry-run]\ncreate-kodera --cloud --org NAME --template ID [--api-url CORE_HTTPS] [--token-file FILE] [--dry-run]\ncreate-kodera --selftest',
      )
      return 0
    }
    const result = options.cloud
      ? await claimCloud(options)
      : await generate(options)
    console.log(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    console.error(
      error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : 'REQUEST_OR_CONFIGURATION_REFUSED',
    )
    return 1
  }
}
