/**
 * Turn-local notices for a memory write that already happened.
 *
 * The capture sidecars persist a fact or a rule before the model is called, but
 * nothing told the model it happened: whether the user saw a confirmation was
 * left to luck. These notes hand the observation back to the model so the reply
 * confirms the write instead of guessing whether it landed. They are turn-local
 * (the loop strips self-correction turns) and contain only what was stored.
 */

export function memoryCaptureNotices({ fact = null, rule = null } = {}) {
  const notices = [];
  if (fact) {
    notices.push(
      `[Memory] Saved to MEMORY.md: "${fact}". Confirm the save in one short line, then continue with the request if there is one.`,
    );
  }
  if (rule) {
    notices.push(
      `[Memory] Standing preference saved: "${rule}". It applies to every later turn; confirm the save in one short line.`,
    );
  }
  return notices;
}