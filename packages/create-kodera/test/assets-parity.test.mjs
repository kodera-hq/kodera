// The scaffolder ships the Compose assets of `deploy/community`, never its own. These tests are
// the gate: the committed copies are byte-identical to what `sync-assets.mjs` derives, and a
// drifted, missing or unlisted asset is refused by name.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  EXPECTED_MANIFEST,
  check,
  derive,
  parityProblems,
  pathProblem,
  readManifest,
} from '../sync-assets.mjs'
import { ASSET_FILES, TEMPLATES, TEMPLATE_ALIASES, generate, plan } from '../src/cli.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const run = promisify(execFile)

async function texts(directory, names) {
  const found = {}
  for (const name of names) found[name] = await readFile(join(directory, name), 'utf8')
  return found
}
const sources = await texts(join(ROOT, 'deploy/community'), EXPECTED_MANIFEST.files)
const assets = await texts(
  join(ROOT, 'packages/create-kodera/assets'),
  await readdir(join(ROOT, 'packages/create-kodera/assets')),
)
const manifest = await readManifest()

test('committed assets are exactly what deploy/community derives', async () => {
  assert.deepEqual(await check(), [])
  assert.deepEqual(parityProblems(manifest, sources, assets), [])
  for (const name of ASSET_FILES) assert.ok(EXPECTED_MANIFEST.files.includes(name), name)
})

test('the only difference from deploy/community is the source checkout path', () => {
  for (const name of EXPECTED_MANIFEST.files) {
    if (name === 'docker-compose.yml') continue
    assert.equal(assets[name], sources[name], name)
  }
  const compose = assets['docker-compose.yml']
  assert.ok(!compose.includes('../..'))
  assert.equal(
    compose.replaceAll('${KODERA_SOURCE_DIR:?Set the Community source checkout}', '../..'),
    sources['docker-compose.yml'],
  )
})

test('refusal: a drifted, missing or unlisted asset is refused by name', () => {
  const cases = [
    [
      'the agent API is routed again',
      { ...assets, Caddyfile: assets.Caddyfile.replace('/api/* /health/*', '/api/* /health/* /agent/*') },
      'create-kodera asset drifted from deploy/community: Caddyfile',
    ],
    [
      'a service is dropped from the stack',
      { ...assets, 'docker-compose.yml': assets['docker-compose.yml'].replace('  synapse-db:\n', '  synapse-cache:\n') },
      'create-kodera asset drifted from deploy/community: docker-compose.yml',
    ],
    [
      'the Synapse configuration is edited in place',
      { ...assets, 'configure_synapse.py': assets['configure_synapse.py'].replace('"psycopg2"', '"sqlite3"') },
      'create-kodera asset drifted from deploy/community: configure_synapse.py',
    ],
    [
      'a setting is missing from the template',
      { ...assets, '.env.example': assets['.env.example'].replace(/^SYNAPSE_POSTGRES_PASSWORD=.*\n/mu, '') },
      'create-kodera asset drifted from deploy/community: .env.example',
    ],
    [
      'an asset is deleted',
      Object.fromEntries(Object.entries(assets).filter(([name]) => name !== 'livekit.yaml')),
      'create-kodera asset is missing: livekit.yaml',
    ],
    [
      'an asset has no source',
      { ...assets, 'override.yml': 'services: {}\n' },
      'create-kodera asset has no source in deploy/community: override.yml',
    ],
  ]
  for (const [label, mutated, expected] of cases) {
    assert.notDeepEqual(mutated, assets, label)
    assert.ok(parityProblems(manifest, sources, mutated).includes(expected), label)
  }
})

test('refusal: a manifest that hides a difference is refused', () => {
  const widened = structuredClone(manifest)
  widened.rewrites['docker-compose.yml'].push(['  synapse-db:\n', '  synapse-cache:\n'])
  const drifted = { ...assets }
  drifted['docker-compose.yml'] = derive('docker-compose.yml', sources['docker-compose.yml'], widened)
  const problems = parityProblems(widened, sources, drifted)
  assert.ok(problems.includes('assets.manifest.json is not the reviewed manifest'))
  assert.ok(problems.includes('create-kodera asset drifted from deploy/community: docker-compose.yml'))
  const narrowed = { ...structuredClone(manifest), files: manifest.files.slice(1) }
  assert.ok(
    parityProblems(narrowed, sources, assets).includes('assets.manifest.json is not the reviewed manifest'),
  )
})

test('crisis-cell stays an alias of the proximity template', () => {
  assert.deepEqual(
    TEMPLATE_ALIASES,
    Object.fromEntries(
      Object.entries(TEMPLATES).flatMap(([id, template]) =>
        (template.aliases ?? []).map((alias) => [alias, id]),
      ),
    ),
  )
  assert.equal(TEMPLATE_ALIASES['crisis-cell'], 'proximity')
  const base = {
    'self-host': true,
    domain: 'chat.example.org',
    'oidc-issuer': 'https://id.example.org/realms/studio',
    'oidc-client-id': 'console',
    'dry-run': true,
  }
  const aliased = plan({ ...base, template: 'crisis-cell' })
  assert.deepEqual(aliased, plan({ ...base, template: 'proximity' }))
  assert.equal(aliased.templateId, 'proximity')
  // The channel's former name, assembled so that the wording check does not read it here.
  assert.ok(aliased.channels.includes('proximity') && !aliased.channels.includes(['ur', 'gence'].join('')))
  assert.ok(!('aliases' in aliased))
  const cloud = plan({ cloud: true, org: 'Quartier', template: 'crisis-cell' })
  assert.equal(cloud.payload.templateId, 'proximity')
})

test('a generated directory holds the deploy/community assets and passes its preflight', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'kodera-parity-'))
  try {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const trust = join(temporary, 'public-trust.json')
    await writeFile(
      trust,
      JSON.stringify([
        {
          lane: 'customer',
          issuer: 'https://id.example.org/realms/studio',
          generation: 'parity',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          public_jwks: { keys: [publicKey.export({ format: 'jwk' })] },
        },
      ]),
    )
    const source = join(temporary, 'source')
    await mkdir(join(source, 'deploy/community'), { recursive: true })
    await writeFile(join(source, 'deploy/community/docker-compose.yml'), '# Synthetic source checkout')
    const output = join(temporary, 'workspace')
    await generate({
      'self-host': true,
      domain: 'chat.example.org',
      'oidc-issuer': 'https://id.example.org/realms/studio',
      'oidc-client-id': 'console',
      template: 'crisis-cell',
      'trust-file': trust,
      'output-dir': output,
      'source-dir': source,
    })
    for (const name of ASSET_FILES)
      assert.equal(await readFile(join(output, name), 'utf8'), assets[name], name)
    const intent = JSON.parse(await readFile(join(output, 'workspace-template.json'), 'utf8'))
    assert.equal(intent.templateId, 'proximity')
    const env = await readFile(join(output, '.env'), 'utf8')
    assert.match(env, /^KODERA_MATRIX_DOMAIN=example\.org$/mu)
    // Issued credentials are never invented, and federation stays closed.
    for (const key of [
      'KODERA_DEFAULT_COMMUNITY_ORG_SLUG',
      'KODERA_DEFAULT_COMMUNITY_ISSUER',
      'KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID',
      'KODERA_AGENT_TOKEN',
      'KODERA_SYNAPSE_TOKEN',
      'KODERA_SYNAPSE_OIDC_ISSUER',
      'KODERA_SYNAPSE_OIDC_CLIENT_SECRET',
      'KODERA_MATRIX_FEDERATION_ALLOWLIST',
    ])
      assert.match(env, new RegExp(`^${key}=$`, 'mu'), key)
    assert.match(env, /^SYNAPSE_POSTGRES_PASSWORD=[0-9a-f]{64}$/mu)
    // The same preflight an operator runs on deploy/community accepts the generated file.
    const preflight = await run('python3', [
      join(ROOT, 'scripts/ci/check-community-deploy.py'),
      '--preflight',
      join(output, '.env'),
    ])
    assert.match(preflight.stdout, /^OK: /u)
    // And it still refuses that file once a required value is gone.
    await writeFile(join(output, '.env'), env.replace(/^SYNAPSE_POSTGRES_PASSWORD=.*$/mu, 'SYNAPSE_POSTGRES_PASSWORD='))
    await assert.rejects(
      run('python3', [join(ROOT, 'scripts/ci/check-community-deploy.py'), '--preflight', join(output, '.env')]),
      /SYNAPSE_POSTGRES_PASSWORD is not set/u,
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('refusal: an asset or a source that is a symbolic link is named and never followed', async () => {
  const marker = 'OUTSIDE-FILE-CONTENT-MUST-NOT-BE-READ'
  const temporary = await mkdtemp(join(tmpdir(), 'kodera-parity-link-'))
  try {
    const outside = join(temporary, 'outside.txt')
    await writeFile(outside, `${marker}\n`)
    const root = join(temporary, 'repository')
    const scaffolder = join(root, 'packages/create-kodera')
    await mkdir(join(root, 'deploy/community'), { recursive: true })
    await mkdir(join(scaffolder, 'assets'), { recursive: true })
    await writeFile(join(scaffolder, 'assets.manifest.json'), JSON.stringify(EXPECTED_MANIFEST))
    for (const name of EXPECTED_MANIFEST.files) {
      await writeFile(join(root, 'deploy/community', name), sources[name])
      await writeFile(join(scaffolder, 'assets', name), derive(name, sources[name], EXPECTED_MANIFEST))
    }
    const rootUrl = pathToFileURL(`${root}/`)
    assert.deepEqual(await check(rootUrl), [])
    // A linked asset would compare equal to the file it points at: it is refused instead.
    const asset = join(scaffolder, 'assets/Caddyfile')
    await unlink(asset)
    await symlink(join(root, 'deploy/community/Caddyfile'), asset)
    assert.deepEqual(await check(rootUrl), [
      'create-kodera asset is a symbolic link, which the check does not follow: Caddyfile',
      'create-kodera asset is missing: Caddyfile',
    ])
    await unlink(asset)
    await symlink(outside, asset)
    const outsideProblems = await check(rootUrl)
    assert.ok(
      outsideProblems.includes('create-kodera asset is a symbolic link, which the check does not follow: Caddyfile'),
    )
    assert.ok(!outsideProblems.join('\n').includes(marker))
    await unlink(asset)
    await writeFile(asset, sources.Caddyfile)
    const source = join(root, 'deploy/community/livekit.yaml')
    await unlink(source)
    await symlink(outside, source)
    assert.deepEqual(await check(rootUrl), [
      'deploy/community file is a symbolic link, which the check does not follow: livekit.yaml',
      'deploy/community/livekit.yaml is missing',
    ])
    await unlink(source)
    await writeFile(source, sources['livekit.yaml'])
    assert.deepEqual(await check(rootUrl), [])

    // A linked directory anywhere above a file is refused too. The tree it leads to is valid on
    // its own (and carries the marker): a check that followed the link would pass.
    const elsewhere = join(temporary, 'elsewhere')
    await mkdir(join(elsewhere, 'deploy/community'), { recursive: true })
    await mkdir(join(elsewhere, 'packages/create-kodera/assets'), { recursive: true })
    await writeFile(join(elsewhere, 'packages/create-kodera/assets.manifest.json'), JSON.stringify(EXPECTED_MANIFEST))
    for (const name of EXPECTED_MANIFEST.files) {
      const poisoned = `${sources[name]}\n# ${marker}\n`
      await writeFile(join(elsewhere, 'deploy/community', name), poisoned)
      await writeFile(join(elsewhere, 'packages/create-kodera/assets', name), derive(name, poisoned, EXPECTED_MANIFEST))
    }
    assert.deepEqual(await check(pathToFileURL(`${elsewhere}/`)), [])
    const cases = [
      ['deploy/community', 'deploy/community file is reached through a symbolic link, which the check does not follow: Caddyfile'],
      ['deploy', 'deploy/community file is reached through a symbolic link, which the check does not follow: docker-compose.yml'],
      ['packages/create-kodera/assets', 'create-kodera assets directory is a symbolic link, which the check does not follow'],
      ['packages/create-kodera', 'create-kodera assets directory is reached through a symbolic link, which the check does not follow'],
      ['packages', 'create-kodera manifest is reached through a symbolic link, which the check does not follow: assets.manifest.json'],
    ]
    for (const [relative, expected] of cases) {
      const directory = join(root, relative)
      const aside = join(temporary, `aside-${relative.replaceAll('/', '_')}`)
      await rename(directory, aside)
      await symlink(join(elsewhere, relative), directory, 'dir')
      const problems = await check(rootUrl)
      await unlink(directory)
      await rename(aside, directory)
      assert.ok(problems.includes(expected), `${relative}: ${JSON.stringify(problems)}`)
      assert.ok(!problems.join('\n').includes(marker), relative)
    }
    assert.deepEqual(await check(rootUrl), [])
    assert.equal(await pathProblem(root, 'deploy/community/Caddyfile'), null)
    assert.equal(await pathProblem(root, 'deploy/community/absent'), 'missing')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
