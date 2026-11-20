const DEFAULT_WARMUP_TTL_MS = 14 * 60 * 1000;
const DEFAULT_STATUS_POLL_MS = 1500;
const DEFAULT_MAX_STATUS_POLLS = 80;

export function createOllamaWarmupRequester(
  request,
  {
    ttlMs = DEFAULT_WARMUP_TTL_MS,
    now = Date.now,
    getStatus,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs = DEFAULT_STATUS_POLL_MS,
    maxStatusPolls = DEFAULT_MAX_STATUS_POLLS,
  } = {}
) {
  const requestedModels = new Map();

  const warmup = (model) => {
    if (!model) return Promise.resolve();
    const existing = requestedModels.get(model);
    if (existing && (existing.expiresAt === null || now() < existing.expiresAt)) return existing.promise;
    if (existing) requestedModels.delete(model);

    const requestState = { promise: null, expiresAt: null };
    requestedModels.set(model, requestState);
    requestState.promise = Promise.resolve()
      .then(() => request(model))
      .then(async (result) => {
        if (!getStatus || result?.status !== 'warming') return result;

        for (let attempt = 0; attempt < maxStatusPolls; attempt++) {
          await sleep(pollIntervalMs);
          const status = await getStatus(model);
          if (status?.status === 'loaded') return status;
          if (status?.status === 'failed' || status?.status === 'idle') {
            throw new Error('Ollama model warm-up failed');
          }
        }

        throw new Error('Ollama model warm-up timed out');
      })
      .then((result) => {
        if (requestedModels.get(model) === requestState) {
          requestState.expiresAt = now() + ttlMs;
        }
        return result;
      })
      .catch((error) => {
        if (requestedModels.get(model) === requestState) requestedModels.delete(model);
        throw error;
      });
    return requestState.promise;
  };

  warmup.isPending = (model) => {
    const requestState = requestedModels.get(model);
    return Boolean(requestState && requestState.expiresAt === null);
  };
  warmup.reset = () => requestedModels.clear();
  return warmup;
}
