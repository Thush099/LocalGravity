const DEFAULT_WARMUP_TTL_MS = 14 * 60 * 1000;

export function createOllamaWarmupRequester(request, { ttlMs = DEFAULT_WARMUP_TTL_MS, now = Date.now } = {}) {
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

  warmup.reset = () => requestedModels.clear();
  return warmup;
}
