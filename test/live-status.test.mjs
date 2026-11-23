import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRuntimeState, getLivePhase } from '../ui/lib/live-status.js';

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

test('describeRuntimeState unifies source and daemon state for both indicators', () => {
  // Local, model loaded into GPU → 'loaded'
  const loaded = describeRuntimeState(
    { provider: 'ollama', model: 'qwen3.5:9b' },
    {},
    { system: { tools: { ollama: true } }, ollama: { running: true, runningModels: [{ name: 'qwen3.5:9b' }] } }
  );
  assert.equal(loaded.isLocal, true);
  assert.equal(loaded.daemon, 'loaded');
  assert.equal(loaded.mode, 'Fast Mode');

  // Local, daemon up but model not loaded → 'idle'
  const idle = describeRuntimeState(
    { provider: 'ollama', model: 'qwen3.5:9b' },
    {},
    { system: { tools: { ollama: true } }, ollama: { running: true, runningModels: [] } }
  );
  assert.equal(idle.daemon, 'idle');

  // Local, daemon stopped → 'stopped'
  const stopped = describeRuntimeState(
    { provider: 'ollama', model: 'qwen3.5:9b' },
    {},
    { system: { tools: { ollama: true } }, ollama: { running: false } }
  );
  assert.equal(stopped.daemon, 'stopped');

  // Ollama not installed → 'not-installed'
  const missing = describeRuntimeState(
    { provider: 'ollama', model: 'qwen3.5:9b' },
    {},
    { system: { tools: { ollama: false } }, ollama: { running: false } }
  );
  assert.equal(missing.daemon, 'not-installed');
});

test('describeRuntimeState reports cloud source with provider label and thinking mode', () => {
  const cloud = describeRuntimeState(
    { provider: 'openrouter', model: 'qwen/qwen3-235b', thinking: true },
    { openrouter: { label: 'OpenRouter Chat' } },
    { ollama: { running: false } }
  );
  assert.equal(cloud.isLocal, false);
  assert.equal(cloud.daemon, 'cloud');
  assert.equal(cloud.provLabel, 'OpenRouter');
  assert.equal(cloud.mode, 'Deep Think');
  assert.equal(cloud.model, 'qwen/qwen3-235b');
});
