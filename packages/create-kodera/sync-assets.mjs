// Copies the Compose assets of `deploy/community` into `assets/`, or checks that the committed
// copies are exactly what that copy would write. The scaffolder ships no configuration of its
// own: `assets.manifest.json` lists the files and the one rewrite a generated directory needs
// (build contexts point at the source checkout, since the directory sits outside it).
//
//   node sync-assets.mjs           write assets/
//   node sync-assets.mjs --check   refuse a committed asset that differs from deploy/community
import { lstat, readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../../', import.meta.url)
const HERE = new URL('packages/create-kodera/', ROOT)

/** The one manifest the gate accepts. A new file or rewrite is a reviewed change to this constant. */
export const EXPECTED_MANIFEST = Object.freeze({
  source: 'deploy/community',
  files: ['.env.example', 'Caddyfile', 'configure_synapse.py', 'docker-compose.yml', 'livekit.yaml'],
  rewrites: {
    'docker-compose.yml': [['../..', '${KODERA_SOURCE_DIR:?Set the Community source checkout}']],
  },
})

export async function readManifest() {
  return JSON.parse(await readFile(new URL('assets.manifest.json', HERE), 'utf8'))
}

/** What `assets/<name>` must contain, from the text of `deploy/community/<name>`. */
export function derive(name, source, manifest) {
  let text = source
  for (const [from, to] of manifest.rewrites[name] ?? []) text = text.replaceAll(from, to)
  return text
}

/**
 * Every way the committed assets differ from `deploy/community`, by name.
 * `sources` and `assets` map a file name to its text; `assets` lists everything in `assets/`.
 */
export function parityProblems(manifest, sources, assets) {
  const problems = []
  if (JSON.stringify(manifest) !== JSON.stringify(EXPECTED_MANIFEST))
    problems.push('assets.manifest.json is not the reviewed manifest')
  for (const name of EXPECTED_MANIFEST.files) {
    if (!(name in sources)) problems.push(`deploy/community/${name} is missing`)
    else if (!(name in assets)) problems.push(`create-kodera asset is missing: ${name}`)
    else if (assets[name] !== derive(name, sources[name], EXPECTED_MANIFEST))
      problems.push(`create-kodera asset drifted from deploy/community: ${name}`)
  }
  for (const name of Object.keys(assets))
    if (!EXPECTED_MANIFEST.files.includes(name))
      problems.push(`create-kodera asset has no source in deploy/community: ${name}`)
  return problems
}

/**
 * The text of each named regular file, and a refusal for each entry that is not one. A symbolic
 * link is never followed: a linked asset would compare equal to whatever it points at, and a
 * link could make the check read a file outside the repository.
 */
async function readAll(directory, names, label) {
  const found = {}
  const refused = []
  for (const name of names) {
    let entry
    try {
      entry = await lstat(new URL(name, directory))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      continue
    }
    if (entry.isSymbolicLink())
      refused.push(`${label} is a symbolic link, which the check does not follow: ${name}`)
    else if (!entry.isFile()) refused.push(`${label} is not a regular file: ${name}`)
    else found[name] = await readFile(new URL(name, directory), 'utf8')
  }
  return { found, refused }
}

export async function check(root = ROOT) {
  const scaffolder = new URL('packages/create-kodera/', root)
  const assetsDirectory = new URL('assets/', scaffolder)
  if ((await lstat(new URL('assets', scaffolder))).isSymbolicLink())
    return ['create-kodera assets directory is a symbolic link, which the check does not follow']
  const manifestRead = await readAll(scaffolder, ['assets.manifest.json'], 'create-kodera manifest')
  let manifest = null
  try {
    manifest = JSON.parse(manifestRead.found['assets.manifest.json'] ?? 'null')
  } catch {
    manifest = null
  }
  const sources = await readAll(new URL('deploy/community/', root), EXPECTED_MANIFEST.files, 'deploy/community file')
  const assets = await readAll(assetsDirectory, await readdir(assetsDirectory), 'create-kodera asset')
  return [
    ...manifestRead.refused,
    ...sources.refused,
    ...assets.refused,
    ...parityProblems(manifest, sources.found, assets.found),
  ]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const problems = await check()
    for (const problem of problems) console.error(`[FAIL] ${problem}`)
    if (problems.length) process.exit(1)
    console.log(`OK: ${EXPECTED_MANIFEST.files.length} create-kodera assets match deploy/community`)
  } else {
    const manifest = await readManifest()
    for (const name of manifest.files) {
      const source = await readFile(new URL(`deploy/community/${name}`, ROOT), 'utf8')
      await writeFile(new URL(`assets/${name}`, HERE), derive(name, source, manifest))
    }
    console.log(`Wrote ${manifest.files.length} assets from deploy/community`)
  }
}
