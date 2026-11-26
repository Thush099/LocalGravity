import test from 'node:test';
import assert from 'node:assert/strict';
import { streamOllamaChat } from '../backend/providers/ollama.mjs';

const okBody = [
  JSON.stringify({ message: { content: 'hello' }, done: false }),
  JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 3, eval_count: 2 }),
  '',
].join('\n');

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('a malformed tool-call markup 500 is retried once and can succeed', async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('XML syntax error on line 3: element <function> closed by </parameter>', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response(okBody, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  });
  try {
    const result = await streamOllamaChat({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:4b',
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: () => {},
    });
    assert.equal(calls, 2, 'the request must be attempted twice');
    assert.equal(result.content, 'hello');
    assert.equal(result.usage.completionTokens, 2);
  } finally {
    restore();
  }
});

test('an unrelated 500 is not retried', async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return new Response('internal server error', { status: 500, headers: { 'content-type': 'text/plain' } });
  });
  try {
    await assert.rejects(
      () => streamOllamaChat({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3.5:4b',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      /Ollama chat error \(500\)/
    );
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});