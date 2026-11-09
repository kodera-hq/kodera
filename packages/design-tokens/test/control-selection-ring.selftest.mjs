import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadTokens, indexTokens, resolve } from '../scripts/lib/tokens.mjs';
import { focusRingIndicatorWidth } from '../scripts/lib/spec.mjs';
import preset from '../dist/tailwind.preset.js';

function assertSelectionRing(tree, css, config) {
  const index = indexTokens(tree);
  assert.equal(resolve('semantic.control.selection-ring-width', index), '5px', 'preserve 5px selection ring');
  assert.equal(tree.semantic.control['selection-ring-width'].$value, '{space.control-selection-ring-width}');
  assert.match(css, /--control-selection-ring-width: 5px;/);
  assert.equal(config.theme.extend.ringWidth['control-selection'], '5px', 'named selection ring');
  // The focus ring is addressed at its source — scripts/lib/spec.mjs, which is
  // where the ring's geometry lives — rather than by a pixel literal, so this
  // stays a statement about the selection ring not disturbing the focus ring
  // even after the focus ring's own geometry is revised. The literal moved; the
  // claim did not.
  assert.equal(
    config.theme.extend.ringWidth.DEFAULT,
    focusRingIndicatorWidth(),
    'focus ring width remains unchanged',
  );
  // ...and the two rings stay tellable apart. Addressing the focus ring by its
  // source would otherwise say nothing on the day the focus ring's own outer
  // tone is 5px too, which is exactly the width the selection ring carries.
  assert.notEqual(
    config.theme.extend.ringWidth.DEFAULT,
    config.theme.extend.ringWidth['control-selection'],
    'the focus ring and the selection ring are different indicators and must not render identically',
  );
  assert.equal(config.theme.extend.colors['control-selection-ring-width'], undefined, 'a dimension is not a color');
}
const tree = loadTokens();
const css = readFileSync(join(ROOT, 'dist/tokens.css'), 'utf8');

test('the selected control ring preserves its existing width through the token API', () => assertSelectionRing(tree, css, preset));

test('the contract rejects changed or missing selection ring values', () => {
  assertSelectionRing(tree, css, preset);
  const changed = structuredClone(tree);
  changed.space['control-selection-ring-width'].$value = '4px';
  assert.throws(() => assertSelectionRing(changed, css, preset), /preserve 5px selection ring/);
  const missing = structuredClone(preset);
  delete missing.theme.extend.ringWidth['control-selection'];
  assert.throws(() => assertSelectionRing(tree, css, missing), /named selection ring/);
});
