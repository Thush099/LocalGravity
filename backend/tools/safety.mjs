import os from 'node:os';
import path from 'node:path';

const READONLY_VERBS = new Set([
  'ls',
  'll',
  'pwd',
  'whoami',
  'id',
  'date',
  'df',
  'du',
  'which',
  'whereis',
  'type',
  'ffprobe',
  'mdls',
  'mdfind',
  'stat',
  'file',
  'wc',
  'head',
  'tail',
  'cat',
  'sw_vers',
  'uname',
  'system_profiler',
  'sysctl',
  'uptime',
  'ps',
  'git',
  'sips',
  'ollama',
]);

const SAFE_GIT_SUBVERBS = new Set(['status', 'log', 'diff', 'branch', 'show', 'rev-parse']);
const SAFE_OLLAMA_SUBVERBS = new Set(['list', 'ps', 'show', '--version']);

const CATASTROPHIC_PATTERNS = [
  { re: /(?:^|[\s;|&`(])sudo\s+rm\b.*(?:\/|\*|~|\$HOME)/i, reason: 'Privileged recursive/broad delete is blocked.' },
  {
    re: /(?:^|[\s;|&`(])rm\b(?=[^\n;|&]*(?:-[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*|--recursive|--force))[^\n;|&]*(?:\s+(?:\/+\*?|\.\.?|~\/*|\$HOME\/*|\/Users(?:\/\*|\/[A-Za-z0-9_.-]+)?|\/System\S*|\/Applications\S*|\/Library\S*)\s*(?:$|[\s;|&`)]))/,
    reason: 'Catastrophic recursive deletion target is permanently blocked.',
  },
  { re: /diskutil\s+(?:eraseDisk|eraseVolume|apfs\s+delete)/i, reason: 'Disk erasure command is permanently blocked.' },
  { re: /(?:^|[\s;|&`])(?:mkfs(?:\.\w+)?|newfs_\w+|dd\s+[^\n]*\bof=\/dev\/)/i, reason: 'Raw disk formatting/writing is permanently blocked.' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bomb pattern is permanently blocked.' },
  { re: /(?:chmod|chown)\s+[^\n]*-R\s+[^\n]*\s+(?:\/+|~|\$HOME)(?:\s|$)/i, reason: 'Recursive permission change on root/home is blocked.' },
];

function containsShellMetacharacters(command) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle) {
      if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
        return true;
      }
      if (!inDouble && (ch === ';' || ch === '|' || ch === '&' || ch === '>' || ch === '<' || ch === '\n')) {
        return true;
      }
    }
  }
  return false;
}

function tokenizeFirstArgs(command) {
  const tokens = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
        if (tokens.length >= 4) break;
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Classify a shell command as catastrophic, risky, or readonly.
 */
export function classifyCommand(command, extraAllowedVerbs = []) {
  const raw = String(command || '').trim();
  if (!raw) {
    return { level: 'risky', reason: 'Empty command requires confirmation.' };
  }

  for (const rule of CATASTROPHIC_PATTERNS) {
    if (rule.re.test(raw)) {
      return { level: 'catastrophic', reason: rule.reason };
    }
  }

  if (containsShellMetacharacters(raw)) {
    return { level: 'risky', reason: 'Shell chaining, redirection, or command substitution requires approval.' };
  }

  const tokens = tokenizeFirstArgs(raw);
  const verb = path.basename(tokens[0] || '');
  const sub = tokens[1] || '';

  if (verb === 'git') {
    return SAFE_GIT_SUBVERBS.has(sub)
      ? { level: 'readonly', reason: `Read-only git ${sub}.` }
      : { level: 'risky', reason: 'Mutating git command requires approval.' };
  }

  if (verb === 'ollama') {
    return SAFE_OLLAMA_SUBVERBS.has(sub)
      ? { level: 'readonly', reason: `Read-only ollama ${sub}.` }
      : { level: 'risky', reason: 'Ollama model modification requires approval.' };
  }

  if (verb === 'sips') {
    const isRead = tokens.some((t) => t === '-g' || t === '--getProperty');
    return isRead && !tokens.includes('--out') && !tokens.includes('-o')
      ? { level: 'readonly', reason: 'Read-only sips metadata query.' }
      : { level: 'risky', reason: 'sips image modification requires approval.' };
  }

  if (verb === 'find') {
    const dangerousFind = /-(?:delete|exec|execdir|ok|okdir)\b/.test(raw);
    return dangerousFind
      ? { level: 'risky', reason: 'find with -exec or -delete requires approval.' }
      : { level: 'readonly', reason: 'Read-only find query.' };
  }

  if (READONLY_VERBS.has(verb) || extraAllowedVerbs.includes(verb)) {
    return { level: 'readonly', reason: `Read-only command (${verb}).` };
  }

  return { level: 'risky', reason: `Command "${verb}" may modify state or invoke external tools.` };
}

export function expandUserPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return '';
  if (targetPath === '~') return os.homedir();
  if (targetPath.startsWith('~/')) return path.join(os.homedir(), targetPath.slice(2));
  return path.resolve(targetPath);
}

/**
 * Determine whether a file write targets LocalGravity's internal skills/knowledge directories.
 */
export function classifyFileWrite(targetPath, skillsDir, knowledgeDir) {
  const resolved = path.resolve(expandUserPath(targetPath));
  const allowedRoots = [skillsDir, knowledgeDir].filter(Boolean).map((d) => path.resolve(d));
  const insideManaged = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
  return { autoAllowInAskMode: insideManaged };
}
