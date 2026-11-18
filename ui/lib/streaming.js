/**
 * Avoid reparsing an ever-growing Markdown response for every streamed token.
 * The first update is immediate; subsequent rich renders are capped to a cadence.
 */
export function shouldRenderStreamingMarkdown(lastRenderedAt, now, minIntervalMs = 100) {
  return !Number.isFinite(lastRenderedAt) || now - lastRenderedAt >= minIntervalMs;
}
