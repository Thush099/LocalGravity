import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { extractFallbackToolCalls } from '../backend/providers/tool-parser.mjs';
import { streamOllamaChat } from '../backend/providers/ollama.mjs';
import { CLOUD_PRESETS, streamOpenAIChat } from '../backend/providers/openai-compat.mjs';
import { streamAnthropicChat } from '../backend/providers/anthropic.mjs';

test('tool-parser extracts valid fallback tool calls and converts malformed JSON into parseError', () => {
  const mixed = `Let me check.\n<tool_call>{"name":"list_dir","arguments":{"path":"~"}}</tool_call>\nDone.`;
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
  assert.ok(CLOUD_PRESETS.openai);
  assert.ok(CLOUD_PRESETS.anthropic);

  const server = http.createServer((req, res) => {
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', thinking: 'Let me ' }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Hi ' }, done: false }) + '\n');
      res.write(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: 'there!',
            tool_calls: [{ function: { name: 'list_dir', arguments: { path: '~/Downloads' } } }],
          },
          done: true,
          eval_count: 42,
        }) + '\n'
      );
      res.end();
      return;
    }

    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Plan ' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Answer ' } }] }) + '\n\n');
      res.write(
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
          '\n\n'
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (req.url === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: content_block_start\ndata: ' + JSON.stringify({ index: 0, content_block: { type: 'thinking', thinking: '' } }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ index: 0, delta: { type: 'thinking_delta', thinking: 'Check ' } }) + '\n\n');
      res.write('event: content_block_start\ndata: ' + JSON.stringify({ index: 1, content_block: { type: 'text', text: '' } }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ index: 1, delta: { type: 'text_delta', text: 'Claude ok' } }) + '\n\n');
      res.write('event: content_block_start\ndata: ' + JSON.stringify({ index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_skills', input: {} } }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }) + '\n\n');
      res.write('event: message_stop\ndata: {}\n\n');
      res.end();
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const events = [];
    const ollamaRes = await streamOllamaChat({
      baseUrl: base,
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
      baseUrl: `${base}/v1`,
      apiKey: 'test-key',
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(oaiRes.thinking, 'Plan ');
    assert.equal(oaiRes.content, 'Answer ');
    assert.equal(oaiRes.toolCalls[0].name, 'read_file');
    assert.deepEqual(oaiRes.toolCalls[0].arguments, { path: 'a.txt' });

    const claudeRes = await streamAnthropicChat({
      baseUrl: base,
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(claudeRes.thinking, 'Check ');
    assert.equal(claudeRes.content, 'Claude ok');
    assert.equal(claudeRes.toolCalls[0].name, 'list_skills');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
