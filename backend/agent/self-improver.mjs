import { readKnowledge, saveKnowledge } from '../knowledge-engine.mjs';
import { readSkill, saveSkill } from '../skills-engine.mjs';
import { getRuntimePaths } from '../state/paths.mjs';

export const LEARNED_FIXES_DOC = 'LEARNED_FIXES';
export const AUTO_LEARNED_SKILL = 'self-learned-fixes';

const TOOL_NAME_ALIASES = {
  bash: 'run_command',
  sh: 'run_command',
  zsh: 'run_command',
  shell: 'run_command',
  exec: 'run_command',
  terminal: 'run_command',
  execute_command: 'run_command',
  cmd: 'run_command',
  run: 'run_command',
  run_shell: 'run_command',
  terminal_command: 'run_command',
  ls: 'list_dir',
  dir: 'list_dir',
  list_files: 'list_dir',
  list_directory: 'list_dir',
  read_dir: 'list_dir',
  list_folder: 'list_dir',
  cat: 'read_file',
  read: 'read_file',
  view_file: 'read_file',
  open_file: 'read_file',
  get_file: 'read_file',
  show_file: 'read_file',
  display_file: 'read_file',
  load_file: 'read_file',
  create_file: 'write_file',
  save_file: 'write_file',
  overwrite_file: 'write_file',
  write: 'write_file',
  put_file: 'write_file',
  new_file: 'write_file',
  replace_in_file: 'edit_file',
  patch_file: 'edit_file',
  str_replace: 'edit_file',
  modify_file: 'edit_file',
  edit: 'edit_file',
  update_file: 'edit_file',
  change_file: 'edit_file',
  insert_in_file: 'edit_file',
  mv: 'move_file',
  move: 'move_file',
  rename: 'move_file',
  rename_file: 'move_file',
  relocate: 'move_file',
  copy_file: 'move_file',
  transfer_file: 'move_file',
  undo: 'undo_file_moves',
  undo_moves: 'undo_file_moves',
  revert_moves: 'undo_file_moves',
  reverse_move: 'undo_file_moves',
  grep: 'search_files',
  find_files: 'search_files',
  search: 'search_files',
  find: 'search_files',
  grep_files: 'search_files',
  search_content: 'search_files',
  calc: 'calculate',
  math: 'calculate',
  evaluate: 'calculate',
  compute: 'calculate',
  solve: 'calculate',
  calculator: 'calculate',
  arithmetic: 'calculate',
  view_image: 'inspect_media',
  inspect_image: 'inspect_media',
  inspect_video: 'inspect_media',
  media_info: 'inspect_media',
  image_info: 'inspect_media',
  learn_skill: 'save_skill',
  create_skill: 'save_skill',
  skills: 'list_skills',
  get_skills: 'list_skills',
  skill: 'read_skill',
  get_skill: 'read_skill',
  load_skill: 'read_skill',
  improve: 'self_improve',
  learn: 'self_improve',
  self_learn: 'self_improve',
  remember: 'save_knowledge',
  save_memory: 'save_knowledge',
  add_knowledge: 'save_knowledge',
  knowledge: 'list_knowledge',
  list_memory: 'list_knowledge',
  memories: 'list_knowledge',
  search_memory: 'search_knowledge',
  recall: 'search_knowledge',
  read_memory: 'read_knowledge',
  get_knowledge: 'read_knowledge',
  fetch: 'fetch_url',
  http: 'fetch_url',
  get_url: 'fetch_url',
  download_url: 'fetch_url',
  curl: 'fetch_url',
  request_url: 'fetch_url',
  web_search: 'search_web',
  google: 'search_web',
  browse_web: 'search_web',
  internet_search: 'search_web',
  duckduckgo: 'search_web',
  browse: 'open_url',
  open_link: 'open_url',
  visit: 'open_url',
  navigate: 'open_url',
  goto: 'open_url',
  git: 'git_op',
  git_command: 'git_op',
  git_action: 'git_op',
  version_control: 'git_op',
  docker: 'docker_op',
  docker_command: 'docker_op',
  container: 'docker_op',
  sql: 'sqlite_query',
  db_query: 'sqlite_query',
  sqlite: 'sqlite_query',
  run_sql: 'sqlite_query',
  execute_sql: 'sqlite_query',
  database_query: 'sqlite_query',
  screenshot: 'take_screenshot',
  screencapture: 'take_screenshot',
  capture_screen: 'take_screenshot',
  screen_capture: 'take_screenshot',
  snap: 'take_screenshot',
  health: 'system_stats',
  system_health: 'system_stats',
  stats: 'system_stats',
  system_info: 'system_stats',
  system_monitor: 'system_stats',
  launch: 'open_app',
  open_application: 'open_app',
  launch_app: 'open_app',
  start_app: 'open_app',
  run_app: 'open_app',
  applescript: 'run_applescript',
  osascript: 'run_applescript',
  osa: 'run_applescript',
  shortcut: 'run_shortcut',
  shortcuts: 'run_shortcut',
  copy: 'copy_to_clipboard',
  clipboard_copy: 'copy_to_clipboard',
  set_clipboard: 'copy_to_clipboard',
  to_clipboard: 'copy_to_clipboard',
  paste: 'paste_from_clipboard',
  clipboard_paste: 'paste_from_clipboard',
  get_clipboard: 'paste_from_clipboard',
  from_clipboard: 'paste_from_clipboard',
  notify: 'show_notification',
  notification: 'show_notification',
  alert: 'show_notification',
  banner: 'show_notification',
  remind: 'set_reminder',
  reminder: 'set_reminder',
  create_reminder: 'set_reminder',
  notes: 'manage_notes',
  apple_notes: 'manage_notes',
  note: 'manage_notes',
  plan: 'update_plan',
  set_plan: 'update_plan',
  todo: 'update_plan',
  add_event: 'add_schedule_item',
  create_event: 'add_schedule_item',
  add_appointment: 'add_schedule_item',
  schedule_event: 'add_schedule_item',
  list_events: 'list_schedule_items',
  get_schedule: 'list_schedule_items',
  events: 'list_schedule_items',
  remove_event: 'remove_schedule_item',
  delete_event: 'remove_schedule_item',
  cancel_event: 'remove_schedule_item',
  spotlight: 'spotlight_search',
  mdfind: 'spotlight_search',
  mac_search: 'spotlight_search',
  delegate: 'delegate_task',
  subtask: 'delegate_task',
  big_files: 'large_files',
  large_file: 'large_files',
  biggest_files: 'large_files',
  disk_usage: 'large_files',
  find_large: 'large_files',
};

/**
 * Normalize common LLM tool name and parameter aliases so minor schema drift never causes tool failures.
 */
export function normalizeToolCall(rawCall = {}) {
  const originalName = String(rawCall.name || '').trim();
  const normalizedName = TOOL_NAME_ALIASES[originalName.toLowerCase()] || originalName;
  const rawArgs =
    rawCall.arguments && typeof rawCall.arguments === 'object' && !Array.isArray(rawCall.arguments)
      ? { ...rawCall.arguments }
      : {};

  const repairs = [];
  if (normalizedName !== originalName && originalName) {
    repairs.push(`mapped tool alias "${originalName}" -> "${normalizedName}"`);
  }

  const aliasKey = (targetKey, candidates) => {
    if (rawArgs[targetKey] !== undefined && rawArgs[targetKey] !== '') return;
    for (const cand of candidates) {
      if (rawArgs[cand] !== undefined && rawArgs[cand] !== '') {
        rawArgs[targetKey] = rawArgs[cand];
        delete rawArgs[cand];
        repairs.push(`mapped arg "${cand}" -> "${targetKey}" on ${normalizedName}`);
        return;
      }
    }
  };

  switch (normalizedName) {
    case 'list_dir':
      aliasKey('path', ['dir', 'directory', 'folder', 'dir_path', 'directory_path', 'file_path', 'filepath', 'root', 'target']);
      if (!rawArgs.path) rawArgs.path = '.';
      break;
    case 'read_file':
      aliasKey('path', ['file_path', 'filepath', 'file', 'filename', 'target_file', 'target']);
      aliasKey('start_line', ['startLine', 'from_line', 'line_start', 'offset']);
      aliasKey('end_line', ['endLine', 'to_line', 'line_end', 'limit']);
      break;
    case 'write_file':
      aliasKey('path', ['file_path', 'filepath', 'file', 'filename', 'target_file', 'target']);
      aliasKey('content', ['text', 'body', 'code', 'data', 'contents']);
      break;
    case 'edit_file':
      aliasKey('path', ['file_path', 'filepath', 'file', 'filename', 'target_file']);
      aliasKey('target', ['old_text', 'old_str', 'old_string', 'search', 'find', 'original', 'before']);
      aliasKey('replacement', ['new_text', 'new_str', 'new_string', 'replace', 'with', 'after', 'content']);
      aliasKey('replace_all', ['replaceAll', 'all', 'replace_all_occurrences', 'global']);
      break;
    case 'search_files':
      aliasKey('root', ['path', 'dir', 'directory', 'folder', 'search_dir', 'search_path']);
      aliasKey('query', ['q', 'pattern', 'keyword', 'search', 'term', 'text']);
      aliasKey('glob', ['ext', 'extension', 'filter', 'file_pattern']);
      if (!rawArgs.root) rawArgs.root = '.';
      break;
    case 'calculate':
      aliasKey('expression', ['expr', 'equation', 'math', 'calc', 'code', 'operation', 'computation', 'formula', 'sum']);
      break;
    case 'move_file':
      aliasKey('source', ['from', 'src', 'source_path', 'file', 'file_path', 'filepath', 'path', 'old_path', 'old_name']);
      aliasKey('destination', ['to', 'dest', 'destination_path', 'target', 'target_path', 'new_path', 'new_name', 'new_location']);
      break;
    case 'run_command':
      aliasKey('command', ['cmd', 'shell', 'script', 'command_line', 'commandLine', 'bash', 'zsh']);
      aliasKey('cwd', ['dir', 'directory', 'workdir', 'working_directory', 'path']);
      aliasKey('timeout_ms', ['timeout', 'timeoutMs']);
      break;
    case 'inspect_media':
      aliasKey('path', ['file_path', 'filepath', 'file', 'image', 'video', 'media', 'url']);
      aliasKey('timestamp_sec', ['timestamp', 'time', 'sec', 'seconds']);
      break;
    case 'read_skill':
      aliasKey('name', ['slug', 'skill', 'skill_name', 'id']);
      break;
    case 'save_skill':
      aliasKey('name', ['slug', 'skill', 'skill_name', 'id']);
      aliasKey('content', ['body', 'markdown', 'instructions', 'text']);
      aliasKey('description', ['desc', 'summary']);
      break;
    case 'fetch_url':
      aliasKey('url', ['href', 'link', 'uri', 'endpoint']);
      break;
    case 'search_knowledge':
      aliasKey('query', ['q', 'keyword', 'search', 'term']);
      break;
    case 'read_knowledge':
      aliasKey('name', ['id', 'doc', 'slug', 'title']);
      break;
    case 'save_knowledge':
      aliasKey('name', ['id', 'doc', 'slug']);
      aliasKey('title', ['heading', 'label']);
      aliasKey('content', ['body', 'text', 'markdown']);
      break;
    case 'sqlite_query':
      aliasKey('query', ['sql', 'statement', 'stmt', 'select', 'command']);
      aliasKey('db_path', ['db', 'database', 'database_path', 'dbPath', 'path']);
      break;
    case 'add_schedule_item':
      aliasKey('time', ['start', 'start_time', 'startTime', 'begin', 'at', 'when']);
      aliasKey('duration_min', ['duration', 'length', 'minutes', 'mins', 'durationMin', 'duration_minutes']);
      aliasKey('title', ['name', 'event', 'summary']);
      break;
    case 'remove_schedule_item':
      aliasKey('id', ['entry_id', 'entryId', 'item_id', 'schedule_id', 'event_id']);
      aliasKey('title', ['name', 'entry', 'event']);
      break;
    case 'large_files':
      aliasKey('folders', ['folder', 'dirs', 'directories', 'paths', 'dir']);
      aliasKey('limit', ['count', 'top', 'n', 'max']);
      break;
    default:
      break;
  }

  return {
    id: rawCall.id,
    name: normalizedName,
    arguments: rawArgs,
    ...(rawCall.parseError ? { parseError: rawCall.parseError } : {}),
    repaired: repairs.length > 0,
    repairNote: repairs.join('; '),
  };
}

/**
 * Diagnose why a tool execution failed and produce a targeted self-healing hint for the agent.
 */
export function diagnoseToolFailure({ name, args = {}, output = '' }) {
  const text = String(output || '');

  if (name === 'edit_file' && /Target snippet not found/i.test(text)) {
    return 'Read the exact target lines with `read_file` first or copy the snippet verbatim (or use `write_file` if replacing the whole file).';
  }
  if (/ENOENT|no such file or directory/i.test(text)) {
    return `Path "${args.path || args.root || args.cwd || ''}" does not exist. Use \`list_dir\` or \`search_files\` to verify the exact path before retrying. For moving or renaming files, use \`move_file\`—it handles spaces in names without shell quoting.`;
  }
  if (/command not found/i.test(text)) {
    const missingCmd = text.match(/:\s*([a-zA-Z0-9_.-]+):\s*command not found/i)?.[1] || 'binary';
    return `Command "${missingCmd}" is not installed or not in PATH. Check \`/opt/homebrew/bin/${missingCmd}\`, use an alternative built-in macOS tool (\`sips\`, \`osascript\`, \`python3\`, \`node\`), or install it via \`brew install\`. If "${missingCmd}" is part of a filename with spaces, quote the whole path or use the file tools (\`read_file\`/\`write_file\`/\`move_file\`) instead of shell commands.`;
  }
  if (/timed out/i.test(text)) {
    return 'The command timed out. Avoid interactive flags (add `-y` for ffmpeg, `--non-interactive`), scope `find` to a specific folder instead of `~`, or raise `timeout_ms`.';
  }
  if (/EACCES|Operation not permitted|Permission denied/i.test(text)) {
    return 'macOS TCC / permission denied on that folder. Operate only inside user-accessible folders or ask the user to grant access.';
  }
  if (/SyntaxError|unexpected token|IndentationError|Traceback/i.test(text)) {
    return 'Script failed with a syntax or runtime error. Inspect the traceback line above, fix the script, and re-run.';
  }
  return 'Inspect the error output above and adjust your parameters or command instead of repeating the identical call.';
}

/**
 * Stable JSON for duplicate signatures: key order must not change the signature, because
 * models re-emit the same arguments in different orders across retries.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Track struggles, tool failures, loop attempts, and recoveries during a single agent turn.
 */
export class TurnStruggleTracker {
  constructor() {
    this.callCounts = new Map();
    this.failedByTool = new Map();
    this.consecutiveFailures = new Map();
    this.struggles = [];
    this.recoveredFixes = [];
    this.emptyOutputRecovered = false;
  }

  recordAliasRepair(toolName, repairNote) {
    if (!repairNote) return;
    this.struggles.push({
      type: 'alias_repair',
      toolName,
      lesson: `Tool "${toolName}": ${repairNote}. Always pass canonical schema parameter names.`,
    });
  }

  recordParseError(toolName, parseError) {
    this.struggles.push({
      type: 'parse_error',
      toolName,
      lesson: `Tool call "${toolName}" had malformed JSON (${parseError}). Emit strict double-quoted JSON objects in tool calls.`,
    });
  }

  checkDuplicateCall(name, args) {
    const signature = `${name}:${stableStringify(args || {})}`;
    const count = (this.callCounts.get(signature) || 0) + 1;
    this.callCounts.set(signature, count);
    // Mutating write/edit/save calls with different state are fine, but repeating the exact same call 2+ times in one turn is a loop
    if (count >= 2 && name !== 'save_skill' && name !== 'save_knowledge') {
      this.struggles.push({
        type: 'loop_detected',
        toolName: name,
        lesson: `Avoid calling "${name}" repeatedly with identical arguments (${JSON.stringify(args).slice(0, 100)}). Use the previous output or change parameters.`,
      });
      return {
        isDuplicate: true,
        count,
        message: `[Self-Healing Loop Breaker] You already called \`${name}\` with these exact arguments in this turn. Do NOT repeat the same call—use the previous tool result to answer the user or try a different approach.`,
      };
    }
    return { isDuplicate: false, count };
  }

  recordToolOutcome({ name, args, ok, output }) {
    const outStr = String(output || '');
    const nonZeroExit = name === 'run_command' && /^Exit code:\s*(?!0\b)\d+/m.test(outStr);
    const failed = !ok || nonZeroExit;

    if (failed) {
      const failures = (this.consecutiveFailures.get(name) || 0) + 1;
      this.consecutiveFailures.set(name, failures);
      let hint = diagnoseToolFailure({ name, args, output: outStr });
      if (failures >= 3) {
        hint = `STOP: "${name}" has now failed ${failures} times in this turn. Do not retry variants of it—report the blocker to the user or take a completely different approach. ${hint}`;
      }
      const summary = outStr.split('\n').slice(0, 3).join(' ').slice(0, 180);
      this.failedByTool.set(name, { args, summary, hint });
      this.struggles.push({
        type: 'tool_failure',
        toolName: name,
        args,
        summary,
        hint,
        lesson: `When using "${name}" (${JSON.stringify(args || {}).slice(0, 100)}), avoid error "${summary.slice(0, 100)}": ${hint}`,
      });
      return { failed: true, hint };
    }

    // If this tool previously failed in the same turn and now succeeded, capture the exact Broken -> Working pair!
    this.consecutiveFailures.delete(name);
    if (this.failedByTool.has(name)) {
      const prev = this.failedByTool.get(name);
      this.failedByTool.delete(name);
      const fixLesson =
        name === 'run_command'
          ? `Command recovery: "${prev.args?.command || ''}" failed (${prev.summary.slice(0, 80)}); working command was "${args?.command || ''}".`
          : `Tool "${name}" recovery: after failure (${prev.summary.slice(0, 80)}), succeeded with args ${JSON.stringify(args || {}).slice(0, 120)}.`;
      this.recoveredFixes.push({
        toolName: name,
        failedArgs: prev.args,
        workingArgs: args,
        lesson: fixLesson,
      });
    }
    return { failed: false, hint: '' };
  }

  recordEmptyOutputRecovery(reason) {
    this.emptyOutputRecovered = true;
    this.struggles.push({
      type: 'empty_output',
      toolName: 'response',
      lesson: `Output recovery: ${reason}. Always provide a direct user-facing markdown response after thinking or running tools.`,
    });
  }

  hasStruggles() {
    return this.struggles.length > 0 || this.recoveredFixes.length > 0 || this.emptyOutputRecovered;
  }
}

/**
 * Synthesize a clean user-facing response if the model returns empty content after thinking or running tools.
 */
export function synthesizeFallbackOutput({ thinking = '', toolResults = [] }) {
  const cleanedThinking = String(thinking || '')
    .replace(/<\/?think>/gi, '')
    .trim();

  if (toolResults.length > 0) {
    const bullets = toolResults.slice(-5).map((tr) => {
      const status = tr.ok ? 'Completed' : 'Attempted';
      const firstLines = String(tr.output || '')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('Exit code: 0'))
        .slice(0, 4)
        .join('\n  ');
      return `- **${status} \`${tr.name}\`**:\n  ${firstLines || '(done)'}`;
    });
    return `Here are the results from executing your request:\n\n${bullets.join('\n\n')}`;
  }

  if (cleanedThinking) {
    // Extract the final paragraph of thinking if the model placed its answer inside thinking
    const paragraphs = cleanedThinking
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    return paragraphs[paragraphs.length - 1] || cleanedThinking;
  }

  return 'Task processed. Let me know if you would like me to adjust or run any follow-up steps.';
}

/**
 * Load a compact excerpt of LEARNED_FIXES.md to inject into the system prompt.
 */
export async function loadLearnedFixesExcerpt(paths = getRuntimePaths()) {
  const doc = await readKnowledge(LEARNED_FIXES_DOC, paths);
  if (!doc?.content) return '';
  const lines = doc.content
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .slice(-12);
  return lines.join('\n').slice(0, 1000);
}

/**
 * Persist deduplicated mistake lessons into LEARNED_FIXES.md and update the self-learned-fixes skill.
 */
export async function persistTurnLearnings({ tracker, userMessage = '', paths = getRuntimePaths() }) {
  if (!tracker || !tracker.hasStruggles()) {
    return { learnedCount: 0, lessons: [] };
  }

  const candidateLessons = [];
  for (const fix of tracker.recoveredFixes) {
    if (fix.lesson) candidateLessons.push(fix.lesson);
  }
  for (const s of tracker.struggles) {
    if (s.lesson && candidateLessons.length < 4) {
      candidateLessons.push(s.lesson);
    }
  }

  const uniqueNew = [...new Set(candidateLessons.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (uniqueNew.length === 0) {
    return { learnedCount: 0, lessons: [] };
  }

  const existingDoc = await readKnowledge(LEARNED_FIXES_DOC, paths);
  const existingLines = existingDoc?.content
    ? existingDoc.content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
    : [];

  const existingSet = new Set(existingLines.map((l) => l.toLowerCase()));
  const addedLessons = [];

  for (const lesson of uniqueNew) {
    const bullet = `- ${lesson}`;
    if (!existingSet.has(bullet.toLowerCase())) {
      existingLines.push(bullet);
      existingSet.add(bullet.toLowerCase());
      addedLessons.push(lesson);
    }
  }

  const cappedLines = existingLines.slice(-25);
  const updatedBody = [
    '# Autonomous Self-Learned Mistake Prevention Rules',
    '',
    'Automatically programmed from past tool errors, command recoveries, and output struggles so LocalGravity improves on every run:',
    '',
    ...cappedLines,
  ].join('\n');

  await saveKnowledge(
    {
      name: LEARNED_FIXES_DOC,
      title: 'Self-Learned Mistake Prevention & Recovery Rules',
      tags: ['self-improvement', 'mistakes', 'auto-learned'],
      content: updatedBody,
    },
    paths
  );

  // If we have verified Broken -> Working command/tool recoveries, also program them into the self-learned-fixes skill
  if (tracker.recoveredFixes.length > 0) {
    const existingSkill = await readSkill(AUTO_LEARNED_SKILL, paths);
    const prevLines = existingSkill?.content
      ? existingSkill.content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('- '))
      : [];
    const skillSet = new Set(prevLines.map((l) => l.toLowerCase()));
    for (const fix of tracker.recoveredFixes) {
      const bullet = `- ${fix.lesson}`;
      if (!skillSet.has(bullet.toLowerCase())) {
        prevLines.push(bullet);
        skillSet.add(bullet.toLowerCase());
      }
    }
    const skillBody = [
      '# Self-Learned Verified Command & Tool Fixes',
      '',
      'Consult these verified recoveries captured from real execution struggles on this Mac:',
      '',
      ...prevLines.slice(-30),
    ].join('\n');

    await saveSkill(
      {
        name: AUTO_LEARNED_SKILL,
        description: 'Auto-programmed fixes and working command recipes learned from past execution struggles.',
        triggers: ['fix', 'error', 'retry', 'command', 'troubleshoot'],
        content: skillBody,
      },
      paths
    ).catch(() => {});
  }

  return {
    learnedCount: addedLessons.length || uniqueNew.length,
    lessons: addedLessons.length > 0 ? addedLessons : uniqueNew.slice(0, 2),
  };
}
