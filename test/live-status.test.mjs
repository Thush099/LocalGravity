import test from 'node:test';
import assert from 'node:assert/strict';
import { getLivePhase } from '../ui/lib/live-status.js';

test('live status distinguishes model warm-up from inference', () => {
  const item = { thinking: [], tools: [], content: '' };

  assert.equal(getLivePhase(item, 'qwen3.5:9b', true), 'Warming up model');
  assert.equal(getLivePhase(item, 'qwen3.5:9b', false), 'Running qwen3.5:9b');
});

test('live status keeps thinking, approvals, tools, and streaming labels', () => {
  assert.equal(getLivePhase({ thinking: ['reasoning'], tools: [], content: '' }, 'model', true), 'Deep thinking');
  assert.equal(getLivePhase({ thinking: [], tools: [{ status: 'wait' }], content: '' }, 'model', true), 'Waiting for your approval');
  assert.equal(getLivePhase({ thinking: [], tools: [{ status: 'running' }], content: '' }, 'model', true), 'Running tools');
  assert.equal(getLivePhase({ thinking: [], tools: [], content: 'hello' }, 'model', true), 'Streaming reply');
});
