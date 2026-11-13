/** Refuse a runtime dependency outside the reviewed permissive license set. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const allowed = new Set(['MIT', 'ISC', 'Python-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '(MIT OR CC0-1.0)'])
export function checkLicenses(lock) {
const rows = []
for (const [path, value] of Object.entries(lock.packages)) {
  if (!path) continue
  if (!allowed.has(value.license)) throw new Error('Unreviewed runtime license: ' + path)
  if (!value.integrity?.startsWith('sha512-') || !value.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error('Unpinned runtime package: ' + path)
  rows.push({ package: path.replace(/^node_modules\//, ''), version: value.version, license: value.license })
}
return rows
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url)))
console.log(JSON.stringify(checkLicenses(lock), null, 2))
}
