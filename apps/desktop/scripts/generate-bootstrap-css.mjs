import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { indexTokens, loadTokens, resolve as resolveToken } from '../../../packages/design-tokens/scripts/lib/tokens.mjs';

const templateUrl = new URL('../src-tauri/assets/bootstrap.template.css', import.meta.url);
const outputUrl = new URL('../src-tauri/assets/bootstrap.css', import.meta.url);
export function generateBootstrapCss(template = readFileSync(templateUrl, 'utf8')) {
  if (/#(?:[0-9a-f]{3,8})\b|\brgba?\s*\(|\b\d+(?:\.\d+)?(?:px|rem|em)\b/i.test(template) || [...template.matchAll(/font-family:\s*([^;]+)/gi)].some(match => !match[1].startsWith('var('))) {
    throw new Error('fallback_style_requires_design_tokens');
  }
  for (const [, property, value] of template.matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;}]+)/g)) {
    if (/^(?:color|background(?:-color)?|border-color|font(?:-family)?)$/i.test(property) &&
        !/^(?:var\(--[\w-]+\)|none|transparent|currentColor|inherit)\s*$/.test(value)) {
      throw new Error('fallback_style_requires_design_tokens');
    }
  }
  const index = indexTokens(loadTokens());
  const names = [...new Set([...template.matchAll(/var\(--([\w-]+)\)/g)].map(match => match[1]))].sort();
  const declarations = names.map(name => {
    const token = [...index.keys()].find(path => path.replaceAll('.', '-') === name);
    if (!token) throw new Error(`unknown_fallback_token:${name}`);
    const value = resolveToken(token, index);
    const css = Array.isArray(value) ? value.map(item => /^(?:system-ui|-apple-system|sans-serif|serif|monospace|ui-monospace)$/.test(item) ? item : JSON.stringify(item)).join(', ') : String(value);
    if (typeof value === 'object' && !Array.isArray(value)) throw new Error('unsupported_fallback_token');
    return `  --${name}: ${css};`;
  });
  return `/* Generated from @kodera/design-tokens. Edit bootstrap.template.css. */\n:root {\n${declarations.join('\n')}\n}\n${template}`;
}
export function checkBootstrapCss() {
  if (readFileSync(outputUrl, 'utf8') !== generateBootstrapCss()) throw new Error('fallback_token_drift');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) writeFileSync(outputUrl, generateBootstrapCss());
  else checkBootstrapCss();
}
