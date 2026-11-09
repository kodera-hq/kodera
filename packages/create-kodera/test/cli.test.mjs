import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseArgs,
  plan,
  generate,
  claimCloud,
  publicHttps,
  TEMPLATES,
} from '../src/cli.ts'
test('Community shell and standalone commands use identical template manifests', async () => {
  const { readFile } = await import('node:fs/promises')
  const templates = JSON.parse(await readFile(
    new URL('../../../deploy/community/workspace-templates.json', import.meta.url), 'utf8',
  ))
  assert.deepEqual(templates, TEMPLATES)
})
for (const template of Object.keys(TEMPLATES))
  test(`dry run ${template} is deterministic and uses only admitted channels`, async () => {
    const options = parseArgs([
      '--self-host',
      '--domain',
      'chat.example.org',
      '--oidc-issuer',
      'https://id.example.org/realms/studio',
      '--oidc-client-id',
      'console',
      '--template',
      template,
      '--dry-run',
    ])
    assert.deepEqual(await generate(options), await generate(options))
  })
test('cloud planning is explicit and has no mutation in dry-run mode', async () => {
  const result = await claimCloud({
    cloud: true,
    org: 'Cinema',
    'dry-run': true,
  })
  assert.equal(result.payload.enabledConnectors[0], 'frameio-review-bridge')
  assert.equal(result.apiUrl, undefined)
})
for (const url of [
  'http://id.example.org',
  'https://127.0.0.1',
  'https://foo.local',
  'https://user:pass@id.example.org',
  'https://id.example.org/\nINJECT=1',
])
  test('refuses unsafe issuer ' + JSON.stringify(url), () =>
    assert.throws(() => publicHttps(url)),
  )
test('refuses unknown flags and templates', () => {
  assert.throws(() => parseArgs(['--execute']))
  assert.throws(() => plan({ cloud: true, org: 'Cinema', template: 'invalid' }))
})
test('committed JavaScript runtime matches the TypeScript source', async () => {
  const { readFile } = await import('node:fs/promises')
  const { stripTypeScriptTypes } = await import('node:module')
  const source = await readFile(
    new URL('../src/cli.ts', import.meta.url),
    'utf8',
  )
  const runtime = await readFile(
    new URL('../runtime/cli.mjs', import.meta.url),
    'utf8',
  )
  assert.equal(runtime, stripTypeScriptTypes(source, { mode: 'strip' }).replace(/[\t ]+$/gmu, ''))
})
test('Cloud mode prepares without an endpoint and validates a real response through its bounded transport', async () => {
  const original = globalThis.fetch
  let captured
  try {
    globalThis.fetch = async (url, init) => {
      captured = { url, init }
      return new Response(
        JSON.stringify({
          workspaceId: 'w-1',
          workspaceUrl: 'https://cinema.example.org',
          channels: [{ name: 'production' }],
        }),
      )
    }
    const prepared = await claimCloud({ cloud: true, org: 'Cinema' })
    assert.equal(prepared.status, 'request-prepared')
    assert.equal(captured, undefined)
    const result = await claimCloud({
      cloud: true,
      org: 'Cinema',
      'api-url': 'https://api.example.org/api/v1',
      'idempotency-key': 'same-intent',
    })
    assert.equal(result.workspaceId, 'w-1')
    assert.equal(
      captured.url,
      'https://api.example.org/api/v1/workspaces/instant-claim',
    )
    assert.equal(captured.init.redirect, 'error')
    assert.equal(captured.init.headers['Idempotency-Key'], 'same-intent')
    assert.ok(result.loginCommand.includes("'https://cinema.example.org/'"))
  } finally {
    globalThis.fetch = original
  }
})
