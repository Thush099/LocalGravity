import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRuntimePaths } from '../backend/state/paths.mjs';
import { createAgentServer } from '../backend/server.mjs';

// A speech process stub: same surface the server touches (on + kill), zero noise.
function stubSpeakFn(procs) {
  return (text) => {
    const proc = new EventEmitter();
    proc.text = text;
    proc.killedWith = null;
    proc.kill = (signal) => {
      proc.killedWith = signal ?? 'SIGTERM';
    };
    procs.push(proc);
    return proc;
  };
}

test('voice barge-in: a new user message interrupts in-flight speech immediately', async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-barge-'));
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));
  const paths = getRuntimePaths(tmpHome);
  const authToken = 'barge-secret-token';
  const procs = [];
  const runMessages = [];
  const srv = createAgentServer({
    authToken,
    paths,
    speakFn: stubSpeakFn(procs),
    runAgentTurnFn: async ({ userMessage }) => {
      runMessages.push(userMessage);
    },
  });
  const { port } = await srv.start();
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Auth-Token': authToken };

  try {
    // LocalGravity reads an answer aloud.
    const speak = await fetch(`${base}/api/chat/speak`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'The build finished **successfully**.' }),
    }).then((r) => r.json());
    assert.equal(speak.speaking, true);
    assert.equal(procs.length, 1);
    assert.match(procs[0].text, /build finished/, 'markdown is stripped for speech');
    assert.equal(procs[0].killedWith, null, 'speaking itself does not kill the new speech');

    // The user sends a new message mid-sentence -> the voice must stop first.
    const runRes = await fetch(`${base}/api/sessions/voice-barge/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Stop — I have a follow-up question.' }),
    });
    assert.equal(runRes.status, 200);
    assert.deepEqual(runMessages, ['Stop — I have a follow-up question.']);
    assert.equal(procs[0].killedWith, 'SIGTERM', 'in-flight speech is interrupted at run start');

    // Overlapping speech also interrupts (turn-taking), and explicit stop works.
    await fetch(`${base}/api/chat/speak`, { method: 'POST', headers, body: JSON.stringify({ text: 'First' }) });
    await fetch(`${base}/api/chat/speak`, { method: 'POST', headers, body: JSON.stringify({ text: 'Second' }) });
    assert.equal(procs[1].killedWith, 'SIGTERM', 'a newer utterance replaces the previous one');
    assert.equal(procs[2].killedWith, null);

    const stop = await fetch(`${base}/api/chat/speak/stop`, { method: 'POST', headers });
    assert.equal(stop.status, 200);
    assert.equal(procs[2].killedWith, 'SIGTERM', 'explicit stop silences the active speech');

    // Nothing to say -> a clear 400, no process spawned.
    const empty = await fetch(`${base}/api/chat/speak`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(empty.status, 400);
    assert.equal(procs.length, 3);
  } finally {
    await srv.stop();
  }
});