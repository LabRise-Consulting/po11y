// map.html and ai-map.html carry hand-synced duplicates of the dialog /
// n8n-deep-link helpers (site/* accepts tiny duplication over a shared
// module — map.html says so where the block starts). Hand-synced means a fix
// applied to one can silently miss the other; these pins turn that miss into
// a failing test. Quote style differs between the two files, so compare
// normalized text, not bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const normalize = (s) => s.replaceAll('"', "'").replace(/\s+/g, ' ').trim();

/** Extract one top-level function's source from an HTML file's script. */
function fnSource(html, name, file) {
  const re = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = re.exec(html);
  assert.ok(m, `${file}: function ${name} not found — the hand-synced pair moved?`);
  return m[0];
}

const MAP = read('./map.html');
const AI = read('./ai-map.html');

for (const name of ['resolveN8nBase', 'openDialog', 'closeDialog']) {
  test(`map.html and ai-map.html agree on ${name}`, () => {
    assert.equal(
      normalize(fnSource(MAP, name, 'map.html')),
      normalize(fnSource(AI, name, 'ai-map.html')),
      `${name} drifted between map.html and ai-map.html — sync the fix into both`,
    );
  });
}
