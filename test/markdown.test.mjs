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

test('renderMarkdown renders LaTeX math blocks & inline formulas while leaving plain currency prices intact', () => {
  const md = [
    'This tier costs $0 local or $20 per month compared to $4.99 API credits.',
    '',
    'Energy scales cleanly with $E = mc^2$ and throughput $\\frac{tokens}{sec}$.',
    '',
    '$$T_{total} = \\frac{P + G}{B} + \\sqrt{N}$$',
  ].join('\n');

  const html = renderMarkdown(md);
  assert.match(html, /\$0 local or \$20 per month compared to \$4\.99/);
  assert.match(html, /class="math-inline">E = mc<sup>2<\/sup><\/span>/);
  assert.match(html, /class="math-frac"><span class="math-num">tokens<\/span><span class="math-den">sec<\/span><\/span>/);
  assert.match(html, /<div class="math-block">T<sub>total<\/sub>/);
  assert.match(html, /class="math-sqrt">/);
});

test('renderMarkdown renders GitHub callouts and artifact canvas buttons safely', () => {
  const md = [
    '> [!TIP] Keep Deep Think Off for quick local tool loops.',
    '> Swap stays low when under 8k context.',
    '',
    '```html',
    '<div>Hello &amp; <script>bad()</script></div>',
    '```',
  ].join('\n');

  const html = renderMarkdown(md);
  assert.match(html, /class="md-callout md-callout-tip"/);
  assert.match(html, /class="md-callout-title">Tip<\/div>/);
  assert.match(html, /class="open-artifact-btn" data-lang="html"/);
  assert.match(html, /class="artifact-card-trigger open-artifact-btn"/);
  assert.doesNotMatch(html, /<script>bad/i);
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
