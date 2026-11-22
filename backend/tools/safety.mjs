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

const SAFE_GIT_SUBVERBS = new Set(['status', 'log', 'diff', 'show', 'rev-parse']);
const SAFE_GIT_BRANCH_FLAGS = new Set([
  '--list',
  '-l',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '--show-current',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
]);
const SAFE_OLLAMA_SUBVERBS = new Set(['list', 'ps', 'show', '--version']);
const SIPS_READ_FLAGS = new Set(['-g', '--getProperty', '-X', '--xml', '-1', '--oneLine']);

const CATASTROPHIC_PATTERNS = [
  { re: /(?:^|[\s;|&`(])sudo\s+[^\n]*rm\b.*(?:\/|\*|~|\$HOME)/i, reason: 'Privileged recursive/broad delete is blocked.' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bomb pattern is permanently blocked.' },
  { re: /diskutil\s+(?:eraseDisk|eraseVolume|apfs\s+delete)/i, reason: 'Disk erasure command is permanently blocked.' },
  { re: /(?:^|[\s;|&`])(?:mkfs(?:\.\w+)?|newfs_\w+|dd\s+[^\n]*\bof=\/dev\/)/i, reason: 'Raw disk formatting/writing is permanently blocked.' },
  { re: /(?:chmod|chown)\s+[^\n]*-R\s+[^\n]*\s+(?:\/+|~|\$HOME)(?:\s|$)/i, reason: 'Recursive permission change on root/home is blocked.' },
];

const DANGEROUS_ROOT_TARGET_RE = /^(?:\/+\*?|\.\.?|~\/*\*?|~\/\.\*|\$HOME\/*\*?|\$\{HOME\}\/*\*?|\/Users(?:\/\*|\/[A-Za-z0-9_.-]+)?\/*\*?|\/System\S*|\/Applications\S*|\/Library\S*)$/;

function isCatastrophicTokenized(segmentTokens) {
  if (segmentTokens.length === 0) return null;
  const verb = path.basename(segmentTokens[0]);

  if (verb === 'rm') {
    const flags = segmentTokens.filter((t) => t.startsWith('-') && t !== '-');
    const hasRecursiveOrForce = flags.some(
      (f) => /^-[a-zA-Z]*[rRfF]/.test(f) || f === '--recursive' || f === '--force'
    );
    const targets = segmentTokens.slice(1).filter((t) => !t.startsWith('-'));
    if (hasRecursiveOrForce && targets.some((t) => DANGEROUS_ROOT_TARGET_RE.test(t))) {
      return 'Catastrophic recursive deletion target is permanently blocked.';
    }
  }

  if (verb === 'find') {
    const hasDelete = segmentTokens.includes('-delete') || /-(?:exec|execdir)\b/.test(segmentTokens.join(' ')) && segmentTokens.includes('rm');
    const targets = segmentTokens.slice(1).filter((t) => !t.startsWith('-') && t !== '!' && t !== '(' && t !== ')');
    if (hasDelete && targets.some((t) => DANGEROUS_ROOT_TARGET_RE.test(t))) {
      return 'Catastrophic find deletion on root/home is permanently blocked.';
    }
  }

  return null;
}

function splitCommandSegments(command) {
  // Split roughly on shell separators so quoted/prefixed catastrophic rm/find patterns are inspected per command
  return command
    .split(/(?:&&|\|\||[;\n|]|`\s*|\$\(|\=\()/)
    .map((s) => s.trim())
    .filter(Boolean);
}

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
      if (!inDouble) {
        if ((ch === '=' && command[i + 1] === '(') || (ch === '<' && command[i + 1] === '(') || (ch === '>' && command[i + 1] === '(')) {
          return true;
        }
        if (ch === '*' && command[i + 1] === '(') {
          return true;
        }
        if (ch === '(' && command[i + 1] === '#') {
          return true;
        }
        if (ch === ';' || ch === '|' || ch === '&' || ch === '>' || ch === '<' || ch === '\n') {
          return true;
        }
      }
    }
  }
  return false;
}

function tokenizeCommand(command) {
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

  for (const segment of splitCommandSegments(raw)) {
    const segTokens = tokenizeCommand(segment);
    const catReason = isCatastrophicTokenized(segTokens);
    if (catReason) {
      return { level: 'catastrophic', reason: catReason };
    }
  }

  if (containsShellMetacharacters(raw)) {
    return { level: 'risky', reason: 'Shell chaining, redirection, or substitution requires approval.' };
  }

  const tokens = tokenizeCommand(raw);
  const verb = path.basename(tokens[0] || '');
  const sub = tokens[1] || '';

  if (verb === 'git') {
    if (SAFE_GIT_SUBVERBS.has(sub)) {
      return { level: 'readonly', reason: `Read-only git ${sub}.` };
    }
    if (sub === 'branch') {
      const args = tokens.slice(2);
      const onlySafeFlags = args.every((arg) => SAFE_GIT_BRANCH_FLAGS.has(arg));
      return onlySafeFlags
        ? { level: 'readonly', reason: 'Read-only git branch inspection.' }
        : { level: 'risky', reason: 'Mutating git branch command requires approval.' };
    }
    return { level: 'risky', reason: 'Mutating git command requires approval.' };
  }

  if (verb === 'ollama') {
    return SAFE_OLLAMA_SUBVERBS.has(sub)
      ? { level: 'readonly', reason: `Read-only ollama ${sub}.` }
      : { level: 'risky', reason: 'Ollama model modification requires approval.' };
  }

  if (verb === 'sips') {
    const flags = tokens.slice(1).filter((t) => t.startsWith('-'));
    const hasReadFlag = flags.some((f) => SIPS_READ_FLAGS.has(f));
    const allFlagsSafe = flags.every((f) => SIPS_READ_FLAGS.has(f));
    return hasReadFlag && allFlagsSafe
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

export function expandUserPath(targetPath, baseCwd) {
  if (!targetPath || typeof targetPath !== 'string') return '';
  if (targetPath === '~') return os.homedir();
  if (targetPath.startsWith('~/')) return path.join(os.homedir(), targetPath.slice(2));
  // Relative paths resolve against the session's working directory (baseCwd), not the
  // server's process.cwd(), so the model's "src/app.js" lands where the user is working.
  return path.resolve(baseCwd || process.cwd(), targetPath);
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
