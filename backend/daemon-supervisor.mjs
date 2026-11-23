import os from 'node:os';

/**
 * Background supervisor for the local model daemon (Ollama).
 *
 * Keeps the daemon warm-but-lean so local tasks start instantly: it auto-starts
 * the daemon in the background (and restarts it after a crash) when a local
 * model is the active provider and memory allows. It never force-loads a model
 * — models unload themselves via OLLAMA_KEEP_ALIVE — and it never blocks a
 * request or the UI thread. Under memory pressure it stays idle, so the daemon
 * cold-starts lazily on the next local task instead of competing for RAM.
 */

const DEFAULT_MIN_FREE_BYTES = 1.5 * 1024 ** 3; // don't fight the system for RAM
const DEFAULT_INTERVAL_MS = 45_000;

/**
 * Pure policy: should we (re)start the local daemon right now?
 */
export function shouldStartDaemon({
  provider,
  installed = true,
  running = false,
  freeMemBytes = null,
  minFreeMemBytes = DEFAULT_MIN_FREE_BYTES,
} = {}) {
  if (provider !== 'ollama') return false; // only manage the local daemon
  if (!installed) return false; // nothing to manage
  if (running) return false; // already up
  if (typeof freeMemBytes === 'number' && freeMemBytes < minFreeMemBytes) return false; // memory pressure
  return true;
}

/**
 * Pure policy: should we unload loaded models to reclaim memory right now?
 * Conservative — only under real memory pressure and never while a task is live.
 * Models reload lazily on the next local task, so this trades a future warm-up
 * for stopping the system from thrashing on swap today.
 */
export function shouldReclaimModelMemory({
  hasActiveRun = false,
  swapUsedBytes = 0,
  ramUsedPercent = 0,
  swapThresholdBytes = 2 * 1024 ** 3,
  ramThresholdPercent = 88,
} = {}) {
  if (hasActiveRun) return false; // never yank a model mid-run
  return swapUsedBytes >= swapThresholdBytes || ramUsedPercent >= ramThresholdPercent;
}

/**
 * Non-blocking daemon supervisor. `tick()` may be called manually; `start()`
 * schedules gentle background checks. Every dependency is injectable so the
 * decision logic is unit-testable without a live Ollama.
 */
export function createDaemonSupervisor({
  getProvider,
  checkHealth,
  ensureRunning,
  getFreeMemBytes = () => os.freemem(),
  intervalMs = DEFAULT_INTERVAL_MS,
  minFreeMemBytes = DEFAULT_MIN_FREE_BYTES,
  now = Date.now,
  log = () => {},
} = {}) {
  let timer = null;
  let inFlight = false;
  let lastAttemptAt = -Infinity; // never attempted; the first tick must always run

  async function tick() {
    if (inFlight || typeof getProvider !== 'function') return;
    if (now() - lastAttemptAt < intervalMs) return; // rate-limit restart attempts
    inFlight = true;
    try {
      const provider = await getProvider();
      const health = await checkHealth();
      const freeMemBytes = await getFreeMemBytes();
      if (
        shouldStartDaemon({
          provider,
          installed: Boolean(health?.installed),
          running: Boolean(health?.running),
          freeMemBytes,
          minFreeMemBytes,
        })
      ) {
        lastAttemptAt = now();
        log(`LocalGravity: starting ${provider} daemon in the background`);
        await ensureRunning();
      }
    } catch {
      // Best-effort supervision; a failure here must never affect the app.
    } finally {
      inFlight = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.(); // don't hold the process open just for supervision
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}