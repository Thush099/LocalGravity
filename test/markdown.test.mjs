import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../ui/lib/markdown.js';

test('renderMarkdown renders GFM tables with column alignments and inline formatting', () => {
  const md = [
    '| Feature | Status | Score |',
    '| :--- | :---: | ---: |',
    '| **Parallel Tools** | `Active` | 100% |',
    '| ~~Legacy Loop~~ | Replaced | 0% |',
  ].join('\n');

  const html = renderMarkdown(md);
  assert.match(html, /<div class="md-table-wrap"><table class="md-table">/);
  assert.match(html, /<th>Feature<\/th>/);
  assert.match(html, /<th style="text-align:center">Status<\/th>/);
  assert.match(html, /<th style="text-align:right">Score<\/th>/);
  assert.match(html, /<td><strong>Parallel Tools<\/strong><\/td>/);
  assert.match(html, /<td style="text-align:center"><code class="inline-code">Active<\/code><\/td>/);
  assert.match(html, /<td><del>Legacy Loop<\/del><\/td>/);
});

test('renderMarkdown highlights code syntax safely without introducing XSS', () => {
  const md = [
    '```js',
    'const x = "<script>alert(1)</script>"; // unsafe string',
    'export async function run(n) {',
    '  return n + 42;',
    '}',
    '```',
  ].join('\n');

  const html = renderMarkdown(md);
  assert.match(html, /class="tok-keyword">const<\/span>/);
  assert.match(html, /class="tok-string">&quot;&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;<\/span>/);
  assert.match(html, /class="tok-comment">\/\/ unsafe string<\/span>/);
  assert.match(html, /class="tok-number">42<\/span>/);
  assert.doesNotMatch(html, /<script>/i);
});

test('renderMarkdown renders task list checkboxes, file:// links, and auto-linked URLs safely', () => {
  const md = [
    '- [x] Completed task with [Local File](file:///Users/test/notes.md)',
    '- [ ] Pending item at https://github.com/Thush099/LocalGravity',
  ].join('\n');

  const html = renderMarkdown(md);
  assert.match(html, /<li class="md-task-item"><input type="checkbox" class="md-task-cb" disabled checked \/>/);
  assert.match(html, /<li class="md-task-item"><input type="checkbox" class="md-task-cb" disabled \/>/);
  assert.match(html, /href="file:\/\/\/Users\/test\/notes\.md"/);
  assert.match(html, /href="https:\/\/github\.com\/Thush099\/LocalGravity"/);
});
