import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('React output matches the reviewed insta UI snapshot', async () => {
  const script = fileURLToPath(new URL('./snapshots.mjs', import.meta.url));
  const actual = execFileSync(process.execPath, [script], { encoding: 'utf8' }).replaceAll('\r\n', '\n').trimEnd();
  const saved = await readFile(new URL('../../../cli/tests/snapshots/stressced_ui__context_status_snapshots.snap', import.meta.url), 'utf8');
  const expected = saved.replaceAll('\r\n', '\n').split('\n---\n')[1].trimEnd();
  assert.equal(actual, expected);
});
