// Copies the Compose assets of `deploy/community` into `assets/`, or checks that the committed
// copies are exactly what that copy would write. The scaffolder ships no configuration of its
// own: `assets.manifest.json` lists the files and the one rewrite a generated directory needs
// (build contexts point at the source checkout, since the directory sits outside it).
//
//   node sync-assets.mjs           write assets/
//   node sync-assets.mjs --check   refuse a committed asset that differs from deploy/community
import { lstat, readFile, realpath, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// File-system paths throughout, joined with `path.join`: a name is never spliced into a URL,
// where `#`, `?` or `%41` would make it name another file.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SOURCE_DIRECTORY = 'deploy/community'
const SCAFFOLDER_DIRECTORY = 'packages/create-kodera'
const ASSETS_DIRECTORY = join(SCAFFOLDER_DIRECTORY, 'assets')
const asPath = (root) => (root instanceof URL ? fileURLToPath(root) : String(root))

/** The one manifest the gate accepts. A new file or rewrite is a reviewed change to this constant. */
export const EXPECTED_MANIFEST = Object.freeze({
  source: 'deploy/community',
  files: ['.env.example', 'Caddyfile', 'configure_synapse.py', 'docker-compose.yml', 'livekit.yaml'],
  rewrites: {
    'docker-compose.yml': [['../..', '${KODERA_SOURCE_DIR:?Set the Community source checkout}']],
  },
})

/**
 * Why `relative` may not be read under `root`, or null. A path is read only when its real path
 * is the root's real path joined with it: no component, the last one or any directory above
 * it, may be a symbolic link. A linked directory would otherwise lead the check to compare,
 * and quote, files outside the repository.
 */
export async function pathProblem(root, relative) {
  const full = join(root, relative)
  let entry
  try {
    entry = await lstat(full)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing'
    throw error
  }
  if (entry.isSymbolicLink()) return 'a symbolic link'
  if ((await realpath(full)) !== join(await realpath(root), relative))
    return 'reached through a symbolic link'
  if (!entry.isFile() && !entry.isDirectory()) return 'not a regular file'
  return null
}

export async function readManifest(root = ROOT) {
  const relative = join(SCAFFOLDER_DIRECTORY, 'assets.manifest.json')
  if ((await pathProblem(asPath(root), relative)) !== null) return null
  try {
    return JSON.parse(await readFile(join(asPath(root), relative), 'utf8'))
  } catch {
    return null
  }
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
 * The text of each named regular file of a directory, and a refusal for each entry that is not
 * one or is reached through a link. A linked asset would compare equal to whatever it points
 * at, and a link could make the check read a file outside the repository.
 */
async function readAll(root, directory, names, label) {
  const found = {}
  const refused = []
  for (const name of names) {
    const relative = join(directory, name)
    const problem = await pathProblem(root, relative)
    if (problem === 'missing') continue
    if (problem !== null)
      refused.push(`${label} is ${problem}, which the check does not follow: ${name}`)
    else if (!(await lstat(join(root, relative))).isFile())
      refused.push(`${label} is not a regular file: ${name}`)
    else found[name] = await readFile(join(root, relative), 'utf8')
  }
  return { found, refused }
}

export async function check(root = ROOT) {
  const base = asPath(root)
  const refused = []
  const manifestProblem = await pathProblem(base, join(SCAFFOLDER_DIRECTORY, 'assets.manifest.json'))
  if (manifestProblem !== null && manifestProblem !== 'missing')
    refused.push(`create-kodera manifest is ${manifestProblem}, which the check does not follow: assets.manifest.json`)
  const manifest = await readManifest(base)
  const sources = await readAll(base, SOURCE_DIRECTORY, EXPECTED_MANIFEST.files, 'deploy/community file')
  // A directory behind a link is not listed at all: its listing would name files elsewhere.
  const directoryProblem = await pathProblem(base, ASSETS_DIRECTORY)
  let assets = { found: {}, refused: [] }
  if (directoryProblem !== null)
    refused.push(`create-kodera assets directory is ${directoryProblem}, which the check does not follow`)
  else assets = await readAll(base, ASSETS_DIRECTORY, await readdir(join(base, ASSETS_DIRECTORY)), 'create-kodera asset')
  return [
    ...refused,
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
    if (JSON.stringify(manifest) !== JSON.stringify(EXPECTED_MANIFEST))
      throw new Error('assets.manifest.json is not the reviewed manifest')
    for (const name of manifest.files) {
      // Neither end of the copy may be, or sit behind, a link: nothing is read or written elsewhere.
      const from = join(SOURCE_DIRECTORY, name)
      const to = join(ASSETS_DIRECTORY, name)
      const toProblem = await pathProblem(ROOT, to)
      if ((await pathProblem(ROOT, from)) !== null || (toProblem !== null && toProblem !== 'missing'))
        throw new Error(`refusing to copy ${name}: a symbolic link is on its path`)
      await writeFile(join(ROOT, to), derive(name, await readFile(join(ROOT, from), 'utf8'), manifest))
    }
    console.log(`Wrote ${manifest.files.length} assets from deploy/community`)
  }
}
