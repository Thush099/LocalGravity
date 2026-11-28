import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let thrown = null;

mock.module('../backend/agent/loop.mjs', {
  namedExports: {
    runAgentTurn: async (opts) => {
      if (thrown) {
        const err = thrown;
        thrown = null;
        throw err;
      }
      calls.push(opts);
      opts.onEvent?.({ type: 'text_delta', text: 'Hello ' });
      opts.onEvent?.({ type: 'text_delta', text: 'world' });
      opts.onEvent?.({ type: 'tool_use', name: 'ignored' });
      return { ok: true };
    },
  },
});

const { delegateTaskTool } = await import('../backend/tools/agent-tool.mjs');

const baseContext = {
  paths: { sessions: '/tmp/does-not-matter' },
  sessionId: 'parent-1',
  providerConfig: { provider: 'ollama', model: 'base-model' },
  cwd: '/tmp/workspace',
  requestApproval: async () => true,
};

beforeEach(() => {
  calls.length = 0;
  thrown = null;
});

describe('delegateTaskTool', () => {
  test('a missing task is rejected without running a sub-agent', async () => {
    const res = await delegateTaskTool({}, baseContext);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'task description is required');
    assert.equal(calls.length, 0, 'no sub-agent runs without a task');
  });

  test('successful delegation accumulates streamed text and reports the sub-session', async () => {
    const res = await delegateTaskTool({ task: 'research this API' }, baseContext);
    assert.equal(res.ok, true);
    assert.match(res.output, /research this API/);
    assert.match(res.output, /Hello world/, 'text deltas accumulate in order');
    assert.match(res.subSessionId, /^sub-[0-9a-f]{8}$/);

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.userMessage, 'research this API');
    assert.equal(call.session.parentSessionId, 'parent-1');
    assert.equal(call.session.source, 'delegated');
    assert.equal(call.session.mode, 'auto');
    assert.equal(call.mode, 'auto');
    assert.equal(call.providerConfig.provider, 'ollama');
    assert.equal(call.providerConfig.model, 'base-model');
    assert.equal(call.requestApproval, baseContext.requestApproval, 'sub-agents respect user approval');
  });

  test('provider, model, and mode overrides flow to the sub-agent', async () => {
    const res = await delegateTaskTool(
      { task: 'do it', provider: 'anthropic', model: 'big-model', mode: 'plan' },
      baseContext,
    );
    assert.equal(res.ok, true);
    const call = calls[0];
    assert.equal(call.providerConfig.provider, 'anthropic');
    assert.equal(call.providerConfig.model, 'big-model');
    assert.equal(call.providerConfig.provider !== 'ollama', true, 'override replaces the inherited provider');
    assert.equal(call.session.provider, 'anthropic');
    assert.equal(call.session.model, 'big-model');
    assert.equal(call.session.mode, 'plan');
    assert.equal(call.mode, 'plan');
  });

  test('a failing sub-agent surfaces the failure and its message', async () => {
    thrown = new Error('provider exploded');
    const res = await delegateTaskTool({ task: 'do it' }, baseContext);
    assert.equal(res.ok, false);
    assert.match(res.error, /^Delegation failed: provider exploded/);
    assert.equal(res.output, undefined);
  });
});
