/**
 * Estimate token usage across conversation messages (~3.5 chars per token + image allowance).
 */
export function estimateMessagesTokens(messages = []) {
  let total = 0;
  for (const msg of messages) {
    total += 8;
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 3.5);
    }
    if (typeof msg.thinking === 'string') {
      total += Math.ceil(msg.thinking.length / 3.5);
    }
    if (Array.isArray(msg.toolCalls)) {
      total += Math.ceil(JSON.stringify(msg.toolCalls).length / 3.5);
    }
    if (Array.isArray(msg.images)) {
      total += msg.images.length * 768;
    }
  }
  return total;
}

/**
 * Compact older conversation turns into a crisp summary when approaching the context budget.
 */
export async function compactConversation(messages, { numCtx = 16384, force = false, summarizeFn } = {}) {
  const threshold = Math.floor((Number(numCtx) || 16384) * 0.7);
  const currentTokens = estimateMessagesTokens(messages);

  if (!force && currentTokens <= threshold) {
    return { messages, compacted: false, tokensBefore: currentTokens, tokensAfter: currentTokens };
  }

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  if (nonSystem.length <= 4) {
    return { messages, compacted: false, tokensBefore: currentTokens, tokensAfter: currentTokens };
  }

  let splitIdx = Math.max(0, nonSystem.length - 4);
  while (splitIdx > 0 && (nonSystem[splitIdx].role !== 'user' || nonSystem[splitIdx].isCompactionSummary)) {
    splitIdx--;
  }
  if (splitIdx === 0) {
    return { messages, compacted: false, tokensBefore: currentTokens, tokensAfter: currentTokens };
  }

  const older = nonSystem.slice(0, splitIdx);
  const recent = nonSystem.slice(splitIdx);

  const transcript = older
    .map((m) => `[${m.role}${m.toolName ? `:${m.toolName}` : ''}] ${String(m.content || '').slice(0, 600)}`)
    .join('\n');

  let summary = '';
  if (typeof summarizeFn === 'function') {
    try {
      summary = await summarizeFn(transcript);
    } catch {
      summary = '';
    }
  }
  if (!summary) {
    summary = older
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map((m) => `${m.role}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 180)}`)
      .join('\n');
  }

  const summaryMessage = {
    role: 'user',
    content: `[Compacted earlier conversation context]\n${summary}`,
    isCompactionSummary: true,
  };

  const compactedMessages = [...systemMessages, summaryMessage, ...recent];
  return {
    messages: compactedMessages,
    compacted: true,
    summary,
    tokensBefore: currentTokens,
    tokensAfter: estimateMessagesTokens(compactedMessages),
  };
}
