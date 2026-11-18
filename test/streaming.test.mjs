import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenderStreamingMarkdown } from '../ui/lib/streaming.js';

test('streaming Markdown renders immediately, then at most once per cadence', () => {
  assert.equal(shouldRenderStreamingMarkdown(undefined, 10), true);
  assert.equal(shouldRenderStreamingMarkdown(10, 50), false);
  assert.equal(shouldRenderStreamingMarkdown(10, 109), false);
  assert.equal(shouldRenderStreamingMarkdown(10, 110), true);
  assert.equal(shouldRenderStreamingMarkdown(10, 110, 50), true);
});

test('invalid last-render time triggers an immediate Markdown render', () => {
  assert.equal(shouldRenderStreamingMarkdown(Number.NaN, 1), true);
});
