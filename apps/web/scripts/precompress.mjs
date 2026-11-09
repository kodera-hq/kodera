// Writes a brotli (`.br`) and a gzip (`.gz`) copy beside every text file under `<dist>/assets`, for
// `server/static.mjs` to serve to a browser that accepts the encoding
// (docs/specs/asset-caching-and-compression.md). Node built-ins only.
//
// It is the last step of `npm run build`. The production-bundle scans run after it and read the
// plain files; a compressed copy is derived from one and adds no content of its own. A copy is
// written only when it is smaller than its source. The run fails when there is no `assets`
// directory, or when a copy already exists, so it never runs twice over one build or over the
// wrong directory.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const TEXT = new Set(['.js', '.mjs', '.css', '.svg', '.json', '.wasm', '.txt'])
// Below this size, the encoded copy saves less than its headers cost.
const MINIMUM = 1024

export async function precompress(dist) {
  // Preview/e2e callers may skip compression; release builds keep it by default.
  if (process.env.KODERA_SKIP_PRECOMPRESS === '1') return []
  const assets = join(dist, 'assets')
  if (!(await stat(assets)).isDirectory()) throw new Error(`${assets} is not a directory`)
  const names = (await readdir(assets)).sort()
  // Checked before anything is written, so a refused run leaves the tree as it found it.
  const compressed = names.find((name) => name.endsWith('.br') || name.endsWith('.gz'))
  if (compressed !== undefined) {
    throw new Error(`${compressed}: already compressed, refusing to run over a compressed build`)
  }
  const written = []
  for (const name of names) {
    if (!TEXT.has(extname(name).toLowerCase())) continue
    const path = join(assets, name)
    if (!(await stat(path)).isFile()) continue
    const source = await readFile(path)
    if (source.length < MINIMUM) continue
    const copies = [
      [
        '.br',
        brotliCompressSync(source, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
          },
        }),
      ],
      ['.gz', gzipSync(source, { level: constants.Z_BEST_COMPRESSION })],
    ]
    for (const [suffix, encoded] of copies) {
      if (encoded.length >= source.length) continue
      await writeFile(path + suffix, encoded, { flag: 'wx' })
      written.push({ name: name + suffix, bytes: encoded.length, source: source.length })
    }
  }
  return written
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const dist = process.argv[2]
  if (dist === undefined || process.argv.length !== 3) {
    console.error('usage: node scripts/precompress.mjs <dist>')
    process.exit(2)
  }
  const written = await precompress(dist)
  const before = written.filter((copy) => copy.name.endsWith('.br'))
  const source = before.reduce((sum, copy) => sum + copy.source, 0)
  const encoded = before.reduce((sum, copy) => sum + copy.bytes, 0)
  console.log(`precompressed ${written.length} copies; brotli ${encoded} of ${source} source bytes`)
}
