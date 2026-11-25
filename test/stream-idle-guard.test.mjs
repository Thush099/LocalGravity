import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readResponseLines } from '../backend/providers/tool-parser.mjs';

const execFile = promisify(execFileCb);

/**
 * A local model runner can stop sending bytes without closing the socket. Local streams are
 * opened with zero socket timeouts (so heavy prefill is not killed), which means without an
 * idle guard the turn would hang forever. These tests pin that a stalled stream is stopped
 * with a clear error while a normally streaming response is left untouched.
 */

function streamingResponse(frames) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    })
  );
}

/** A body that emits one line, then never sends anything again. */
function stallingResponse() {
  const encoder = new TextEncoder();
  let canceled = false;
  return {
    canceled: () => canceled,
    response: new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"ok":1}\n'));
          // Deliberately never closes or enqueues again.
        },
        cancel() {
          canceled = true;
        },
      })
    ),
  };
}

test('readResponseLines stops a stalled stream with a clear error instead of hanging', async () => {
  const { response } = stallingResponse();
  const seen = [];
  const started = Date.now();
  await assert.rejects(
    () => readResponseLines(response, (line) => seen.push(line), { idleTimeoutMs: 80 }),
    (err) => {
      assert.equal(err.code, 'STREAM_STALLED');
      assert.match(err.message, /stalled/i);
      assert.match(err.message, /no output for/i);
      return true;
    }
  );
  // The line that did arrive was still processed.
  assert.deepEqual(seen, ['{"ok":1}']);
  assert.ok(Date.now() - started < 5000, 'watchdog fired promptly');
});

test('readResponseLines cancels the stalled reader so the socket is released', async () => {
  const stall = stallingResponse();
  await assert.rejects(() => readResponseLines(stall.response, () => {}, { idleTimeoutMs: 60 }));
  assert.equal(stall.canceled(), true);
});

test('readResponseLines leaves a healthy stream untouched when the guard is on', async () => {
  const lines = [];
  await readResponseLines(
    streamingResponse(['{"a":1}\n{"b":2}\n', '{"c":3}\n']),
    (line) => lines.push(line),
    { idleTimeoutMs: 5000 }
  );
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('readResponseLines disables the guard by default', async () => {
  const lines = [];
  await readResponseLines(streamingResponse(['{"x":1}\n']), (line) => lines.push(line));
  assert.deepEqual(lines, ['{"x":1}']);
});

test('a stalled local Ollama stream rejects through the real provider instead of hanging', async () => {
  const http = await import('node:http');
  const { streamOllamaChat } = await import('../backend/providers/ollama.mjs');

  // Fake Ollama: send one valid NDJSON chunk, then go silent without closing the socket.
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { content: 'hello' }, done: false })}\n`);
    // Never end the response — this is the wedge the guard must catch.
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const prev = process.env.LOCALGRAVITY_STREAM_IDLE_MS;
  process.env.LOCALGRAVITY_STREAM_IDLE_MS = '150';
  try {
    const started = Date.now();
    await assert.rejects(
      () =>
        streamOllamaChat({
          baseUrl,
          model: 'qwen3.5:9b',
          messages: [{ role: 'user', content: 'hi' }],
          onEvent: () => {},
        }),
      (err) => {
        assert.match(err.message, /stalled/i);
        return true;
      }
    );
    assert.ok(Date.now() - started < 5000, 'stall was detected promptly, not after a hang');
  } finally {
    if (prev === undefined) delete process.env.LOCALGRAVITY_STREAM_IDLE_MS;
    else process.env.LOCALGRAVITY_STREAM_IDLE_MS = prev;
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('readResponseLines stall watchdog fires even when nothing else holds the event loop', async () => {
  // Regression: the watchdog timer was unref'd, so in any process where the stalled
  // read was the only pending work (one-shot CLI runs, node --test child runners on
  // Node 22), the event loop drained before the timer could fire and the read hung
  // forever ("unsettled top-level await", exit 13). The watchdog must hold the loop
  // itself until it fires; it is cleared as soon as the read settles either way.
  const toolParserPath = fileURLToPath(new URL('../backend/providers/tool-parser.mjs', import.meta.url));
  const script = `
    import { readResponseLines } from ${JSON.stringify(toolParserPath)};
    const enc = new TextEncoder();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('{"ok":1}\\n')); } }));
    try {
      await readResponseLines(response, () => {}, { idleTimeoutMs: 250 });
      console.log('NO-ERROR');
    } catch (e) {
      console.log('ERR', e.code);
    }
  `;
  const child = await execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 8000 });
  assert.match(child.stdout, /ERR STREAM_STALLED/);
});
