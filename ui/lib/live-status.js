export function getLivePhase(item, model, isWarming = false) {
  if (item.thinking?.length > 0 && !item.content && item.tools?.length === 0) return 'Deep thinking';
  if (item.tools?.some((tool) => tool.status === 'wait')) return 'Waiting for your approval';
  if (item.tools?.some((tool) => tool.status === 'running')) return 'Running tools';
  if (!item.content) return isWarming ? 'Warming up model' : `Running ${model || 'model'}`;
  return 'Streaming reply';
}

/**
 * Pure derivation of where the active model runs and that runtime's health.
 * Free of DOM and module state so it can be unit-tested and shared between the
 * top-right mode pill and the sidebar runtime chip (which must never disagree).
 */
export function describeRuntimeState(config = {}, presets = {}, health = {}) {
  const prov = config.provider || 'ollama';
  const model = config.model || 'qwen3.5:4b';
  const thinking = Boolean(config.thinking);
  const isLocal = prov === 'ollama';
  const provLabel = isLocal ? 'Ollama' : presets?.[prov]?.label?.split(' ')[0] || prov;
  const ollama = health.ollama || {};
  const installed = Boolean(health.system?.tools?.ollama);
  const runningModels = Array.isArray(ollama.runningModels) ? ollama.runningModels : [];
  let daemon = 'stopped';
  if (!isLocal) daemon = 'cloud';
  else if (!installed) daemon = 'not-installed';
  else if (runningModels.some((m) => m.name === model)) daemon = 'loaded';
  else if (ollama.running) daemon = 'idle';
  return {
    isLocal,
    model,
    thinking,
    mode: thinking ? 'Deep Think' : 'Fast Mode',
    prov,
    provLabel,
    daemon,
    installed,
    runningModels,
  };
}
