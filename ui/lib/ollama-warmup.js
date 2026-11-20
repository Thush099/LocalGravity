export function createOllamaWarmupRequester(request) {
  const requestedModels = new Map();

  const warmup = (model) => {
    if (!model) return Promise.resolve();
    const existing = requestedModels.get(model);
    if (existing) return existing;

    let pending;
    pending = Promise.resolve()
      .then(() => request(model))
      .catch((error) => {
        if (requestedModels.get(model) === pending) requestedModels.delete(model);
        throw error;
      });
    requestedModels.set(model, pending);
    return pending;
  };

  warmup.reset = () => requestedModels.clear();
  return warmup;
}
