import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyFrontendAssets(root, { maxDepth = 16, maxEntries = 8192 } = {}) {
  const rootStat = lstatSync(resolve(root));
  if (rootStat.isSymbolicLink()) throw new Error('frontend_symlink_root_refused');
  if (!rootStat.isDirectory()) throw new Error('frontend_root_type_refused');
  const canonical = realpathSync(root);
  const files = [];
  let total = 0, entries = 1;
  function walk(dir, depth = 0) {
    if (depth > maxDepth) throw new Error('frontend_directory_depth_limit');
    for (const entry of readdirSync(dir)) {
      if (++entries > maxEntries) throw new Error('frontend_entry_limit');
      const path = join(dir, entry), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('frontend_symlink_refused');
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (stat.isFile()) {
        total += stat.size;
        if (stat.size > 32 * 1024 * 1024 || total > 256 * 1024 * 1024 || files.length >= 4096)
          throw new Error('frontend_asset_limit');
        files.push(relative(canonical, path).split('\\').join('/'));
      } else throw new Error('frontend_file_type_refused');
    }
  }
  walk(canonical);
  const index = readFileSync(join(canonical, 'index.html'), 'utf8');
  const scripts = [...index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)];
  if (scripts.length === 0) throw new Error('frontend_entry_script_missing');
  if (scripts.some(([, ref]) => /^(?:[a-z]+:|#|\/\/)/i.test(ref)))
    throw new Error('frontend_nonlocal_reference');
  for (const [, ref] of index.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (ref.startsWith('#') || ref.startsWith('data:')) continue;
    if (/^[a-z]+:/i.test(ref) || ref.startsWith('//') || ref.includes('\\'))
      throw new Error('frontend_nonlocal_reference');
    const name = decodeURIComponent(ref.split(/[?#]/)[0]).replace(/^\//, '');
    const path = resolve(canonical, name), rel = relative(canonical, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || !files.includes(rel.split('\\').join('/')))
      throw new Error('frontend_asset_missing_or_uncontained');
  }
  return files.sort();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../web/dist', import.meta.url));
  verifyFrontendAssets(root);
  console.log('Desktop frontend resources verified.');
}
