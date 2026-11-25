import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../backend/providers/http-retry.mjs';
import { extractFallbackToolCalls, extractInlineThinking, safeParseArguments } from '../backend/providers/tool-parser.mjs';
import {
  listRunningOllamaModels,
  selectBestInstalledOllamaModel,
  streamOllamaChat,
  warmOllamaModel,
  unloadOllamaModels,
} from '../backend/providers/ollama.mjs';
import { CLOUD_PRESETS, streamOpenAIChat } from '../backend/providers/openai-compat.mjs';
import { streamAnthropicChat } from '../backend/providers/anthropic.mjs';

function makeStreamResponse(chunks, status = 200, headers = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

test('tool-parser extracts valid fallback tool calls, repairs loose JSON, and extracts inline thinking', () => {
  const mixed = `Let me check.\n<tool_call>{"name":"list_dir","arguments":{"path":"~",}}</tool_call>\nDone.`;
  const res1 = extractFallbackToolCalls(mixed);
  assert.equal(res1.toolCalls.length, 1);
  assert.equal(res1.toolCalls[0].name, 'list_dir');
  assert.deepEqual(res1.toolCalls[0].arguments, { path: '~' });
  assert.equal(res1.toolCalls[0].parseError, undefined);
  assert.equal(res1.cleanedText, 'Let me check.\n\nDone.');

  const broken = `<tool_call>{"name":"run_command","arguments":{broken json</tool_call>`;
  const res2 = extractFallbackToolCalls(broken);
  assert.equal(res2.toolCalls.length, 1);
  assert.ok(res2.toolCalls[0].parseError);

  const fencedInside = `<tool_call>\n\`\`\`json\n{"name":"read_file","arguments":{"path":"README.md"}}\n\`\`\`\n</tool_call>`;
  const res3 = extractFallbackToolCalls(fencedInside);
  assert.equal(res3.toolCalls.length, 1);
  assert.equal(res3.toolCalls[0].name, 'read_file');
  assert.equal(res3.toolCalls[0].parseError, undefined);

  const standaloneFence = `Checking:\n\`\`\`tool_call\n{"name":"list_skills","arguments":{}}\n\`\`\``;
  const res4 = extractFallbackToolCalls(standaloneFence);
  assert.equal(res4.toolCalls.length, 1);
  assert.equal(res4.toolCalls[0].name, 'list_skills');

  const jsonFenceTool = `I will run this:\n\`\`\`json\n{"tool":"run_command","args":{"command":"df -h"}}\n\`\`\``;
  const res5 = extractFallbackToolCalls(jsonFenceTool);
  assert.equal(res5.toolCalls.length, 1);
  assert.equal(res5.toolCalls[0].name, 'run_command');
  assert.deepEqual(res5.toolCalls[0].arguments, { command: 'df -h' });

  const inlineThink = extractInlineThinking('<think>Step 1: analyze</think>Final clean output.');
  assert.equal(inlineThink.thinkingText, 'Step 1: analyze');
  assert.equal(inlineThink.cleanedText, 'Final clean output.');

  assert.equal(
    selectBestInstalledOllamaModel([{ name: 'qwen3.5:9b' }, { name: 'gemma4:12b' }], 'qwen3.5:4b'),
    'qwen3.5:9b'
  );
});

test('ensureOllamaRunning handles missing ollama binary without crashing process', async () => {
  const { ensureOllamaRunning } = await import('../backend/providers/ollama.mjs');
  await assert.rejects(
    () => ensureOllamaRunning('http://127.0.0.1:19999', { binary: '/nonexistent/ollama-bin' }),
    /ollama/i
  );
});

test('ollama, openai-compatible, and anthropic adapters stream thinking, text, and tool_calls uniformly', async () => {
  assert.ok(CLOUD_PRESETS.openrouter);
  assert.ok(CLOUD_PRESETS.groq);
  assert.ok(CLOUD_PRESETS.gemini);
  assert.ok(CLOUD_PRESETS.gemini.suggestedModels.includes('gemini-4-argon'));
  assert.ok(CLOUD_PRESETS.openai);
  assert.ok(CLOUD_PRESETS.anthropic);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/chat')) {
      return makeStreamResponse([
        JSON.stringify({ message: { role: 'assistant', thinking: 'Let me ' }, done: false }) + '\n',
        JSON.stringify({ message: { role: 'assistant', content: 'Hi ' }, done: false }) + '\n',
        JSON.stringify({
          message: {
            role: 'assistant',
            content: 'there!',
            tool_calls: [{ function: { name: 'list_dir', arguments: { path: '~/Downloads' } } }],
          },
          done: true,
          eval_count: 42,
        }) + '\n',
      ]);
    }
    if (u.endsWith('/v1/chat/completions')) {
      return makeStreamResponse([
        'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Plan ' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Answer ' } }] }) + '\n\n',
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
                },
              },
            ],
          }) +
          '\n\n',
        'data: [DONE]\n\n',
      ]);
    }
    if (u.endsWith('/v1/messages')) {
      return makeStreamResponse([
        'event: content_block_start\ndata: ' + JSON.stringify({ index: 0, content_block: { type: 'thinking', thinking: '' } }) + '\n\n',
        'event: content_block_delta\ndata: ' + JSON.stringify({ index: 0, delta: { type: 'thinking_delta', thinking: 'Check ' } }) + '\n\n',
        'event: content_block_start\ndata: ' + JSON.stringify({ index: 1, content_block: { type: 'text', text: '' } }) + '\n\n',
        'event: content_block_delta\ndata: ' + JSON.stringify({ index: 1, delta: { type: 'text_delta', text: 'Claude ok' } }) + '\n\n',
        'event: content_block_start\ndata: ' + JSON.stringify({ index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_skills', input: {} } }) + '\n\n',
        'event: content_block_delta\ndata: ' + JSON.stringify({ index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }) + '\n\n',
        'event: message_stop\ndata: {}\n\n',
      ]);
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const events = [];
    const ollamaRes = await streamOllamaChat({
      baseUrl: 'http://mock-ollama.local',
      model: 'qwen3.5:9b',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: true,
      numCtx: 16384,
      onEvent: (ev) => events.push(ev),
    });
    assert.equal(ollamaRes.thinking, 'Let me ');
    assert.equal(ollamaRes.content, 'Hi there!');
    assert.equal(ollamaRes.toolCalls[0].name, 'list_dir');
    assert.deepEqual(ollamaRes.toolCalls[0].arguments, { path: '~/Downloads' });

    const oaiRes = await streamOpenAIChat({
      baseUrl: 'http://mock-oai.local/v1',
      apiKey: 'test-key',
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(oaiRes.thinking, 'Plan ');
    assert.equal(oaiRes.content, 'Answer ');
    assert.equal(oaiRes.toolCalls[0].name, 'read_file');
    assert.deepEqual(oaiRes.toolCalls[0].arguments, { path: 'a.txt' });

    const claudeRes = await streamAnthropicChat({
      baseUrl: 'http://mock-claude.local',
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(claudeRes.thinking, 'Check ');
    assert.equal(claudeRes.content, 'Claude ok');
    assert.equal(claudeRes.toolCalls[0].name, 'list_skills');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchWithRetry retries transient provider errors once and leaves client errors alone', async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
      : new Response('ok', { status: 200 });
  };
  const recovered = await fetchWithRetry(flaky, 'http://mock.test', {}, { maxRetries: 1, baseDelayMs: 1 });
  assert.equal(recovered.status, 200);
  assert.equal(attempts, 2);

  let clientAttempts = 0;
  const unauthorized = async () => {
    clientAttempts += 1;
    return new Response('no', { status: 401 });
  };
  const failed = await fetchWithRetry(unauthorized, 'http://mock.test', {}, { maxRetries: 2, baseDelayMs: 1 });
  assert.equal(failed.status, 401);
  assert.equal(clientAttempts, 1);
});

test('openai-compatible adapter recovers from a 429 before streaming', async () => {
  const origFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    }
    return makeStreamResponse([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Recovered' } }] }) + '\n\n',
      'data: [DONE]\n\n',
    ]);
  };

  try {
    const res = await streamOpenAIChat({
      baseUrl: 'http://mock-oai.local/v1',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      retryOptions: { maxRetries: 1, baseDelayMs: 1 },
    });
    assert.equal(attempts, 2);
    assert.equal(res.content, 'Recovered');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('streamOllamaChat auto-recovers missing model tag and retries cleanly when model rejects think option', async () => {
  let sawThink = false;
  let attempts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen3.5:9b', size: 1000 }] }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    attempts++;
    if (body.model === 'qwen3.5:4b') {
      return new Response(JSON.stringify({ error: "model 'qwen3.5:4b' not found" }), { status: 404 });
    }
    if ('think' in body) {
      sawThink = true;
      return new Response(JSON.stringify({ error: 'registry.ollama.ai/library/moondream does not support thinking' }), {
        status: 400,
      });
    }
    return makeStreamResponse([JSON.stringify({ message: { role: 'assistant', content: 'Retried ok!' }, done: true }) + '\n']);
  };

  try {
    const res = await streamOllamaChat({
      baseUrl: 'http://mock-ollama.local',
      model: 'qwen3.5:4b',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: false,
    });
    assert.equal(sawThink, true);
    assert.equal(attempts, 3);
    assert.equal(res.resolvedModel, 'qwen3.5:9b');
    assert.equal(res.content, 'Retried ok!');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('warmOllamaModel loads only installed models and skips models already resident', async () => {
  const origFetch = globalThis.fetch;
  const requests = [];
  let installed = true;
  let resident = false;
  globalThis.fetch = async (url, init = {}) => {
    const endpoint = new URL(String(url));
    requests.push({ path: endpoint.pathname, body: init.body ? JSON.parse(init.body) : null });
    if (endpoint.pathname === '/api/tags') {
      return new Response(JSON.stringify({ models: installed ? [{ name: 'qwen3.5:9b' }] : [] }), { status: 200 });
    }
    if (endpoint.pathname === '/api/ps') {
      return new Response(JSON.stringify({ models: resident ? [{ name: 'qwen3.5:9b' }] : [] }), { status: 200 });
    }
    if (endpoint.pathname === '/api/generate') {
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const loaded = await warmOllamaModel('qwen3.5:9b', { baseUrl: 'http://mock-ollama.local', numCtx: 8192 });
    assert.equal(loaded.status, 'loaded');
    assert.deepEqual(requests.at(-1), {
      path: '/api/generate',
      body: { model: 'qwen3.5:9b', prompt: '', stream: false, keep_alive: '15m', options: { num_ctx: 8192 } },
    });

    requests.length = 0;
    resident = true;
    const alreadyLoaded = await warmOllamaModel('qwen3.5:9b', { baseUrl: 'http://mock-ollama.local' });
    assert.equal(alreadyLoaded.status, 'already_loaded');
    assert.ok(!requests.some((request) => request.path === '/api/generate'));

    requests.length = 0;
    resident = false;
    installed = false;
    const missing = await warmOllamaModel('qwen3.5:9b', { baseUrl: 'http://mock-ollama.local' });
    assert.equal(missing.status, 'not_installed');
    assert.ok(!requests.some((request) => request.path === '/api/generate'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('warmOllamaModel bounds a wedged generate request with its timeout', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const endpoint = new URL(String(url));
    if (endpoint.pathname === '/api/tags') {
      return new Response(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] }), { status: 200 });
    }
    if (endpoint.pathname === '/api/ps') {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (endpoint.pathname === '/api/generate') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    // AbortSignal.timeout() uses an unref'd timer; hold the event loop until the timeout fires.
    const keepAlive = setInterval(() => {}, 10);
    try {
      await assert.rejects(
        () => warmOllamaModel('qwen3.5:9b', { baseUrl: 'http://mock-ollama.local', timeoutMs: 25 }),
        (err) => err.name === 'TimeoutError' || err.name === 'AbortError'
      );
    } finally {
      clearInterval(keepAlive);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Ollama ps/unload helpers, RAM-aware selection, and transient disconnect retry work cleanly', async () => {
  assert.equal(
    selectBestInstalledOllamaModel([{ name: 'qwen3.5:9b' }, { name: 'qwen3.5:4b' }], '', { totalRamGb: 16 }),
    'qwen3.5:4b'
  );
  assert.equal(
    selectBestInstalledOllamaModel([{ name: 'qwen3.5:9b' }, { name: 'qwen3.5:4b' }], '', { totalRamGb: 32 }),
    'qwen3.5:9b'
  );

  const origFetch = globalThis.fetch;
  const unloadedBodies = [];
  let chatCalls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) {
      return new Response(
        JSON.stringify({
          models: [{ name: 'qwen3.5:9b', size: 9_100_000_000, size_vram: 9_100_000_000, context_length: 8192 }],
        }),
        { status: 200 }
      );
    }
    if (u.endsWith('/api/generate')) {
      unloadedBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    }
    if (u.endsWith('/api/chat')) {
      chatCalls++;
      if (chatCalls === 1) throw new TypeError('terminated');
      return makeStreamResponse([
        JSON.stringify({ message: { role: 'assistant', content: 'Recovered after drop' }, done: true }) + '\n',
      ]);
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const running = await listRunningOllamaModels('http://mock-ollama.local');
    assert.equal(running.length, 1);
    assert.equal(running[0].name, 'qwen3.5:9b');
    assert.equal(running[0].sizeVram, 9_100_000_000);

    const unloaded = await unloadOllamaModels('http://mock-ollama.local');
    assert.deepEqual(unloaded.unloaded, ['qwen3.5:9b']);
    assert.equal(unloadedBodies[0].keep_alive, 0);

    const recovered = await streamOllamaChat({
      baseUrl: 'http://mock-ollama.local',
      model: 'qwen3.5:9b',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(chatCalls, 2);
    assert.equal(recovered.content, 'Recovered after drop');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('tool-call JSON repair recovers common model mistakes instead of erroring', () => {
  const OPEN = '<' + 'tool_call>';
  const CLOSE = '<' + '/tool_call>';
  const cases = [
    [`{'name':'run_command','arguments':{'command':'ls'}}`, 'run_command', { command: 'ls' }],
    [`{name:"run_command",arguments:{command:"pwd"}}`, 'run_command', { command: 'pwd' }],
    [`{"name":"x","arguments":{"a":True,"b":False,"c":None}}`, 'x', { a: true, b: false, c: null }],
    [`{"name":"x", // note
 "arguments":{"a":1, /* mid */ "b":2}}`, 'x', { a: 1, b: 2 }],
    [`{"name":"x","arguments":{"a":1,"b":[1,2,],},}`, 'x', { a: 1, b: [1, 2] }],
    [`{"name":"run_command","arguments":{"command":"ls`, 'run_command', { command: 'ls' }],
    [`{"name":"x","arguments":{"msg":"don't do it"}}`, 'x', { msg: "don't do it" }],
    [`{"name":"x","arguments":{"msg":"a, } b"}}`, 'x', { msg: 'a, } b' }],
    [`{'name':'run_command', // run
 'arguments':{'command':'ls', 'cwd':'/tmp',},}`, 'run_command', { command: 'ls', cwd: '/tmp' }],
  ];
  for (const [inner, expName, expArgs] of cases) {
    const { toolCalls } = extractFallbackToolCalls(OPEN + '\n' + inner + '\n' + CLOSE);
    assert.equal(toolCalls.length, 1, `should recover: ${inner}`);
    const call = toolCalls[0];
    assert.ok(!call.parseError, `should not error: ${inner} -> ${call.parseError}`);
    assert.equal(call.name, expName);
    assert.deepEqual(call.arguments, expArgs);
  }
});

test('tool-call JSON repair never corrupts valid JSON or string contents', () => {
  const OPEN = '<' + 'tool_call>';
  const CLOSE = '<' + '/tool_call>';
  const { toolCalls } = extractFallbackToolCalls(
    OPEN + '\n' + `{"name":"x","arguments":{"msg":"a, } b, then {braces} and [brackets]"}}` + '\n' + CLOSE,
  );
  assert.ok(!toolCalls[0].parseError);
  assert.deepEqual(toolCalls[0].arguments, { msg: 'a, } b, then {braces} and [brackets]' });

  // safeParseArguments handles the same repairs for bare args
  assert.deepEqual(safeParseArguments(`{a:True}`).arguments, { a: true });
  assert.deepEqual(safeParseArguments(`{'a':'b'}`).arguments, { a: 'b' });
  assert.ok(safeParseArguments(`{"a":"don't"}`).arguments.a === "don't");
});

test('a dropped local connection retries when nothing has streamed yet', async () => {
  const origFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url) => {
    const endpoint = new URL(String(url));
    if (endpoint.pathname === '/api/chat') {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      return makeStreamResponse([JSON.stringify({ message: { role: 'assistant', content: 'Recovered' }, done: true }) + '\n']);
    }
    return new Response('Not found', { status: 404 });
  };
  try {
    const events = [];
    const result = await streamOllamaChat({
      baseUrl: 'http://mock-ollama.local',
      model: 'qwen3.5:4b',
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: (e) => events.push(e),
    });
    assert.equal(attempts, 2);
    assert.equal(result.content, 'Recovered');
    assert.deepEqual(events.filter((e) => e.type === 'text_delta').map((e) => e.text), ['Recovered']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('a connection that drops mid-stream is not replayed and is explained in plain language', async () => {
  const origFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url) => {
    const endpoint = new URL(String(url));
    if (endpoint.pathname === '/api/chat') {
      attempts += 1;
      const encoder = new TextEncoder();
      // Deliver one real chunk first, then drop the socket: `error()` called in the
      // same tick would discard the queued chunk, which is a different scenario.
      let pulls = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(
                encoder.encode(JSON.stringify({ message: { content: 'Partial' }, done: false }) + '\n')
              );
            } else {
              controller.error(new Error('fetch failed'));
            }
          },
        }),
        { status: 200 }
      );
    }
    return new Response('Not found', { status: 404 });
  };
  try {
    const deltas = [];
    await assert.rejects(
      () =>
        streamOllamaChat({
          baseUrl: 'http://mock-ollama.local',
          model: 'qwen3.5:4b',
          messages: [{ role: 'user', content: 'hi' }],
          onEvent: (e) => {
            if (e.type === 'text_delta') deltas.push(e.text);
          },
        }),
      (err) => {
        // Never retry once tokens are on screen, or the user sees the answer twice.
        assert.equal(attempts, 1);
        assert.match(err.message, /connection dropped/i);
        assert.match(err.message, /fetch failed/);
        assert.doesNotMatch(err.message, /^fetch failed$/);
        return true;
      }
    );
    assert.deepEqual(deltas, ['Partial']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('a rejected local request keeps the server error instead of blaming the network', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const endpoint = new URL(String(url));
    if (endpoint.pathname === '/api/chat') return new Response('model requires more system memory', { status: 500 });
    return new Response('Not found', { status: 404 });
  };
  try {
    await assert.rejects(
      () =>
        streamOllamaChat({
          baseUrl: 'http://mock-ollama.local',
          model: 'qwen3.5:4b',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      /Ollama chat error \(500\): model requires more system memory/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});