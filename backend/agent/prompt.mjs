import os from 'node:os';

/**
 * Build a concise, high-signal system prompt tailored for both local 9B models and cloud frontier models.
 */
export function buildSystemPrompt({
  skills = [],
  knowledgeDocs = [],
  memoryContent = '',
  safetyMode = 'ask',
  isHeadless = false,
  allowAutoRun = false,
  cwd,
}) {
  const skillLines =
    skills.length > 0
      ? skills.map((s) => `- ${s.slug || s.name}: ${s.description}`).join('\n')
      : '- (none installed)';

  const knowledgeLines =
    knowledgeDocs.length > 0
      ? knowledgeDocs.map((d) => `- ${d.name}: ${d.title}`).join('\n')
      : '- (no knowledge documents yet)';

  const trimmedMemory = String(memoryContent || '').trim().slice(0, 1200);
  const modeLine = isHeadless
    ? allowAutoRun
      ? 'Execution context: Scheduled background job (Auto-Run enabled, catastrophic commands blocked).'
      : 'Execution context: Scheduled background job in READ-ONLY AUDIT MODE. Do not attempt mutating commands or external file edits; inspect and report findings clearly.'
    : safetyMode === 'auto'
      ? 'Execution context: Interactive desktop session (Auto-Run enabled; catastrophic commands permanently blocked).'
      : 'Execution context: Interactive desktop session (Ask-before-risky mode; mutating commands and external file edits ask the user for approval).';

  return [
    `You are LocalGravity, an autonomous macOS assistant running on Apple Silicon (${os.arch()}, home=${os.homedir()}, cwd=${cwd || os.homedir()}).`,
    '',
    modeLine,
    '',
    '## Core Operating Discipline',
    '1. **Verify before asserting:** Inspect actual files, folders, media metadata (`ffprobe`, `sips`), or `inspect_media` frames before stating results or editing.',
    '2. **Use Skills first:** Before starting a Mac cleanup, video edit, photo edit, writing humanizer pass, or saving a new workflow, check the Skills list below and call `read_skill(name)` to follow exact proven recipes.',
    '3. **Consult Knowledge & Memory:** Use `search_knowledge(query)` or `read_knowledge(name)` whenever user preferences, personal style guides, or project facts matter.',
    '4. **Teach yourself continuously:** When the user teaches a reusable workflow, corrects a mistake, or asks you to remember a preference, save a clean skill with `save_skill` or persistent preference with `save_knowledge`.',
    '5. **Visual inspection:** Whenever editing photos or videos, call `inspect_media` before and after edits so you see the real result.',
    '6. **Be concise and direct:** Avoid filler, throat-clearing, and AI clichés. Execute tools cleanly and report exact outcomes, paths, and commands run.',
    '',
    '## Installed Skills (call read_skill(name) to load full instructions)',
    skillLines,
    '',
    '## Knowledge Base Documents (call search_knowledge / read_knowledge to load)',
    knowledgeLines,
    trimmedMemory ? `\n## Persistent User Memory (MEMORY.md)\n${trimmedMemory}` : '',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .trim();
}
