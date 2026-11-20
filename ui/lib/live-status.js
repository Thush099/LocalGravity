export function getLivePhase(item, model, isWarming = false) {
  if (item.thinking?.length > 0 && !item.content && item.tools?.length === 0) return 'Deep thinking';
  if (item.tools?.some((tool) => tool.status === 'wait')) return 'Waiting for your approval';
  if (item.tools?.some((tool) => tool.status === 'running')) return 'Running tools';
  if (!item.content) return isWarming ? 'Warming up model' : `Running ${model || 'model'}`;
  return 'Streaming reply';
}
