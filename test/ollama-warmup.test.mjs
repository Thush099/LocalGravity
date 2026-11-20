import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaWarmupRequester } from '../ui/lib/ollama-warmup.js';

test('Ollama warm-up requester retries after a failed request and deduplicates success', async () => {
  let calls = 0;
  const warmup = createOllamaWarmupRequester(async () => {
    calls++;
    if (calls === 1) throw new Error('server unavailable');
  });

  await assert.rejects(warmup('qwen3.5:9b'), /server unavailable/);
  await warmup('qwen3.5:9b');
  await warmup('qwen3.5:9b');

  assert.equal(calls, 2);
});

test('Ollama warm-up requester shares a single in-flight request', async () => {
  let calls = 0;
  let resolveRequest;
  const warmup = createOllamaWarmupRequester(
    () =>
      new Promise((resolve) => {
        calls++;
        resolveRequest = resolve;
      })
  );

  const first = warmup('qwen3.5:9b');
  const second = warmup('qwen3.5:9b');
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveRequest();
  await Promise.all([first, second]);
});

test('Ollama warm-up requester retries after its keep-alive window expires', async () => {
  let now = 0;
  let calls = 0;
  const warmup = createOllamaWarmupRequester(async () => calls++, { ttlMs: 100, now: () => now });

  await warmup('qwen3.5:9b');
  now = 99;
  await warmup('qwen3.5:9b');
  now = 100;
  await warmup('qwen3.5:9b');

  assert.equal(calls, 2);
});

test('Ollama warm-up requester allows a new model and can be reset after unload', async () => {
  const models = [];
  const warmup = createOllamaWarmupRequester(async (model) => models.push(model));

  await warmup('qwen3.5:9b');
  await warmup('qwen3.5:4b');
  warmup.reset();
  await warmup('qwen3.5:4b');

  assert.deepEqual(models, ['qwen3.5:9b', 'qwen3.5:4b', 'qwen3.5:4b']);
});
