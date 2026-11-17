import { listKnowledge, readKnowledge, saveKnowledge, searchKnowledge } from '../knowledge-engine.mjs';
import { listSkills, readSkill, saveSkill } from '../skills-engine.mjs';
import { getRuntimePaths } from '../state/paths.mjs';
import { runCommandTool } from './exec-tool.mjs';
import { buildCompactDiff, editFileTool, listDir, readFileTool, searchFilesTool, writeFileTool } from './fs-tools.mjs';
import { inspectMediaTool } from './media-tool.mjs';
import { classifyCommand, classifyFileWrite, expandUserPath } from './safety.mjs';
import fs from 'node:fs/promises';

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and subdirectories inside a folder with file sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (supports ~).' },
          recursive: { type: 'boolean', description: 'Walk subdirectories recursively.' },
          max_entries: { type: 'number', description: 'Maximum entries to list (default 120).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text/code/config file with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number' },
          end_line: { type: 'number' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact text snippet inside an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          target: { type: 'string' },
          replacement: { type: 'string' },
        },
        required: ['path', 'target', 'replacement'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search filenames and file text recursively under a folder.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          query: { type: 'string' },
          glob: { type: 'string', description: 'Optional extension filter like *.md or *.mp4' },
        },
        required: ['root', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a zsh shell command on macOS (ffmpeg, magick, sips, osascript, find, python3, etc.).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeout_ms: { type: 'number' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_media',
      description: 'Visually inspect a photo or extract a video frame so you can see and verify edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          timestamp_sec: { type: 'number', description: 'Optional video timestamp in seconds.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List installed reusable skills.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: 'Read full instructions and recipes for an installed skill by name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_skill',
      description: 'Install, create, or update a reusable SKILL.md workflow and optional helper scripts.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lowercase hyphenated slug.' },
          description: { type: 'string' },
          triggers: { type: 'array', items: { type: 'string' } },
          content: { type: 'string', description: 'Markdown instructions without YAML frontmatter.' },
          extra_files: {
            type: 'object',
            description: 'Optional relative paths to helper scripts inside the skill folder (e.g. {"scripts/run.py": "..."}).',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['name', 'description', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch plain text/markdown content from a public HTTP/HTTPS URL (docs, raw GitHub SKILL.md, guides).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_knowledge',
      description: 'List documents in your local Knowledge Base & Memory.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Search user Knowledge Base documents and MEMORY.md by keyword.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_knowledge',
      description: 'Read a specific Knowledge Base document or MEMORY.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_knowledge',
      description: 'Save or update a Knowledge Base document or MEMORY with persistent facts and preferences.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          content: { type: 'string' },
        },
        required: ['name', 'title', 'content'],
      },
    },
  },
];

const ALWAYS_READONLY_TOOLS = new Set([
  'list_dir',
  'read_file',
  'search_files',
  'inspect_media',
  'fetch_url',
  'list_skills',
  'read_skill',
  'list_knowledge',
  'search_knowledge',
  'read_knowledge',
]);

/**
 * Evaluate whether a tool call should auto-run, pause for approval, or be blocked.
 */
export function evaluateToolSafety({ name, args = {} }, context = {}) {
  const {
    safetyMode = 'ask',
    isHeadless = false,
    allowAutoRun = false,
    skillsDir = getRuntimePaths().skillsDir,
    knowledgeDir = getRuntimePaths().knowledgeDir,
    allowedReadCommands = [],
  } = context;

  if (ALWAYS_READONLY_TOOLS.has(name)) {
    return { decision: 'allow' };
  }

  if (name === 'save_skill' || name === 'save_knowledge') {
    return { decision: 'allow' };
  }

  if (name === 'run_command') {
    const classification = classifyCommand(args.command, allowedReadCommands);
    if (classification.level === 'catastrophic') {
      return { decision: 'block', reason: classification.reason };
    }
    if (classification.level === 'readonly') {
      return { decision: 'allow' };
    }
    if (isHeadless) {
      return allowAutoRun
        ? { decision: 'allow' }
        : { decision: 'block', reason: 'Scheduled audit mode does not allow mutating shell commands.' };
    }
    return safetyMode === 'auto'
      ? { decision: 'allow' }
      : { decision: 'ask', reason: classification.reason, preview: String(args.command || '') };
  }

  if (name === 'write_file' || name === 'edit_file') {
    const fileInfo = classifyFileWrite(args.path || '', skillsDir, knowledgeDir);
    if (fileInfo.autoAllowInAskMode) {
      return { decision: 'allow' };
    }
    if (isHeadless) {
      return allowAutoRun
        ? { decision: 'allow' }
        : { decision: 'block', reason: 'Scheduled audit mode does not allow modifying external files.' };
    }
    return safetyMode === 'auto'
      ? { decision: 'allow' }
      : { decision: 'ask', reason: `Modify file: ${expandUserPath(args.path || '')}` };
  }

  return { decision: 'ask', reason: `Tool "${name}" requires approval.` };
}

export async function generateToolPreview({ name, args = {} }) {
  if (name === 'run_command') return String(args.command || '');
  if (name === 'write_file') {
    const resolved = expandUserPath(args.path || '');
    let oldContent = '';
    try {
      oldContent = await fs.readFile(resolved, 'utf8');
    } catch {
      oldContent = '';
    }
    return buildCompactDiff(oldContent, String(args.content ?? ''), resolved);
  }
  if (name === 'edit_file') {
    const resolved = expandUserPath(args.path || '');
    try {
      const oldContent = await fs.readFile(resolved, 'utf8');
      const nextContent = oldContent.replaceAll(String(args.target || ''), () => String(args.replacement ?? ''));
      return buildCompactDiff(oldContent, nextContent, resolved);
    } catch {
      return `Edit ${resolved}`;
    }
  }
  return JSON.stringify(args, null, 2);
}

export async function executeToolCall({ name, args = {} }, context = {}) {
  const paths = context.paths || getRuntimePaths();
  try {
    switch (name) {
      case 'list_dir':
        return await listDir(args);
      case 'read_file':
        return await readFileTool(args);
      case 'write_file':
        return await writeFileTool(args);
      case 'edit_file':
        return await editFileTool(args);
      case 'search_files':
        return await searchFilesTool(args);
      case 'run_command':
        return await runCommandTool({
          ...args,
          cwd: args.cwd || context.cwd,
          onStdout: context.onStdout,
          onStderr: context.onStderr,
          abortSignal: context.abortSignal,
        });
      case 'inspect_media':
        return await inspectMediaTool(args);
      case 'list_skills': {
        const skills = await listSkills(paths);
        return {
          ok: true,
          output: skills.map((s) => `- ${s.slug}: ${s.description}`).join('\n') || '(no skills)',
        };
      }
      case 'read_skill': {
        const skill = await readSkill(args.name, paths);
        return skill
          ? { ok: true, output: skill.raw }
          : { ok: false, output: `Skill "${args.name}" not found.` };
      }
      case 'save_skill': {
        const saved = await saveSkill(
          {
            ...args,
            extraFiles: args.extra_files || args.extraFiles,
          },
          paths
        );
        return { ok: true, output: `Saved skill "${saved.slug}" to ${saved.path}` };
      }
      case 'fetch_url': {
        const parsedUrl = new URL(String(args.url || ''));
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return { ok: false, output: 'Only http:// and https:// URLs are supported.' };
        }
        const res = await fetch(parsedUrl.toString(), { signal: AbortSignal.timeout(12000) });
        if (!res.ok) {
          return { ok: false, output: `HTTP ${res.status} fetching ${parsedUrl}` };
        }
        const raw = await res.text();
        const cleaned = raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, 12000);
        return { ok: true, output: cleaned || '(empty response)' };
      }
      case 'list_knowledge': {
        const docs = await listKnowledge(paths);
        return {
          ok: true,
          output: docs.map((d) => `- ${d.name}: ${d.title} (${d.sizeBytes} bytes)`).join('\n') || '(no knowledge docs)',
        };
      }
      case 'search_knowledge': {
        const hits = await searchKnowledge(args.query, paths);
        return {
          ok: true,
          output:
            hits.map((h) => `[${h.name}] ${h.title} (score ${h.score})\n  ${h.snippet}`).join('\n\n') ||
            `No knowledge matches for "${args.query}"`,
        };
      }
      case 'read_knowledge': {
        const doc = await readKnowledge(args.name, paths);
        return doc
          ? { ok: true, output: `# ${doc.title}\n\n${doc.content}` }
          : { ok: false, output: `Knowledge doc "${args.name}" not found.` };
      }
      case 'save_knowledge': {
        const saved = await saveKnowledge(args, paths);
        return { ok: true, output: `Saved knowledge doc "${saved.name}" to ${saved.path}` };
      }
      default:
        return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, output: `Tool "${name}" failed: ${err.message}` };
  }
}
