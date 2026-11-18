import fs from 'node:fs/promises';
import { LEARNED_FIXES_DOC, normalizeToolCall } from '../agent/self-improver.mjs';
import { invalidateKnowledgeCache, listKnowledge, readKnowledge, saveKnowledge, searchKnowledge } from '../knowledge-engine.mjs';
import { invalidateSkillsCache, listSkills, readSkill, saveSkill } from '../skills-engine.mjs';
import { getRuntimePaths } from '../state/paths.mjs';
import { runAppleScriptTool } from './applescript-tool.mjs';
import { calculateTool } from './calc-tool.mjs';
import { runCommandTool } from './exec-tool.mjs';
import { buildCompactDiff, editFileTool, listDir, readFileTool, searchFilesTool, writeFileTool } from './fs-tools.mjs';
import { inspectMediaTool } from './media-tool.mjs';
import {
  copyToClipboardTool,
  openAppTool,
  pasteFromClipboardTool,
  runShortcutTool,
  setReminderTool,
  showNotificationTool,
} from './macos-tool.mjs';
import { updatePlanTool } from './plan-tool.mjs';
import { classifyCommand, classifyFileWrite, expandUserPath } from './safety.mjs';

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
      name: 'run_applescript',
      description: 'Run an AppleScript via osascript for deep macOS automation (Finder, Notes, Safari, System Events). Always requires approval.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'The AppleScript source to run.' },
          timeout_ms: { type: 'number' },
        },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate an arithmetic expression safely (supports + - * / % ^, parentheses, sqrt/abs/round/log, pi/e). No shell, no eval.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'The arithmetic expression to evaluate.' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description: 'Publish the current multi-step task checklist so the user can watch progress. Call it once at the start and update step statuses as you go.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Short step description.' },
                status: { type: 'string', enum: ['pending', 'active', 'done'], description: 'Current status.' },
              },
              required: ['text'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_to_clipboard',
      description: 'Copy text to the macOS clipboard (pbcopy) so the user can paste it anywhere.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to copy.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'paste_from_clipboard',
      description: 'Read the current macOS clipboard text (pbpaste).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_notification',
      description: 'Show a macOS notification banner (title + message).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title (default: LocalGravity).' },
          message: { type: 'string', description: 'Notification body.' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Open a macOS application by name (e.g. Safari, Notes, Finder).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Application name.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shortcut',
      description: 'Run an existing macOS Shortcut by name (Shortcuts app). Turns every user Shortcut into an agent capability. Always requires approval.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Shortcut name.' },
          input: { type: 'string', description: 'Optional text input piped to the Shortcut.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Show a one-shot macOS notification reminder after N seconds (fires in the background).',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Delay in seconds before the reminder fires.' },
          message: { type: 'string', description: 'Reminder text.' },
        },
        required: ['seconds', 'message'],
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
      name: 'self_improve',
      description: 'Record a mistake-prevention rule into LEARNED_FIXES.md and optionally program a reusable skill or helper script so you never repeat a mistake.',
      parameters: {
        type: 'object',
        properties: {
          mistake: { type: 'string', description: 'What failed or caused friction.' },
          fix: { type: 'string', description: 'Verified command, code pattern, or rule that solves it.' },
          skill_name: { type: 'string', description: 'Optional lowercase hyphenated skill slug to create or update.' },
          skill_content: { type: 'string', description: 'Optional markdown instructions for the skill.' },
          helper_scripts: {
            type: 'object',
            description: 'Optional relative script files to bundle inside the skill (e.g. {"scripts/fix.sh": "..."}).',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['mistake', 'fix'],
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
  'calculate',
  'update_plan',
  'paste_from_clipboard',
  'list_skills',
  'read_skill',
  'list_knowledge',
  'search_knowledge',
  'read_knowledge',
]);

// Non-destructive macOS actions: frictionless in interactive use, but a scheduled
// background job must not silently poke at the live desktop (clipboards, banners, apps).
const HARMLESS_ACTION_TOOLS = new Set(['copy_to_clipboard', 'show_notification', 'open_app', 'set_reminder']);

/**
 * Evaluate whether a tool call should auto-run, pause for approval, or be blocked.
 */
export function evaluateToolSafety({ name: rawName, args: rawArgs = {} }, context = {}) {
  const normalized = normalizeToolCall({ name: rawName, arguments: rawArgs });
  const name = normalized.name;
  const args = normalized.arguments;

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

  if (name === 'save_skill' || name === 'save_knowledge' || name === 'self_improve') {
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

  if (name === 'run_applescript') {
    // AppleScript can drive arbitrary macOS apps and system state: always treat as mutating.
    if (isHeadless) {
      return allowAutoRun
        ? { decision: 'allow' }
        : { decision: 'block', reason: 'Scheduled audit mode does not allow AppleScript automation.' };
    }
    return safetyMode === 'auto'
      ? { decision: 'allow' }
      : { decision: 'ask', reason: 'Run AppleScript automation (can modify apps and files).', preview: String(args.script || '') };
  }

  if (name === 'run_shortcut') {
    // A Shortcut is opaque automation that can do anything: treat as mutating.
    if (isHeadless) {
      return allowAutoRun
        ? { decision: 'allow' }
        : { decision: 'block', reason: 'Scheduled audit mode does not allow running Shortcuts.' };
    }
    return safetyMode === 'auto'
      ? { decision: 'allow' }
      : { decision: 'ask', reason: 'Run macOS Shortcut (can perform arbitrary actions).', preview: `shortcuts run ${String(args.name || '')}` };
  }

  if (HARMLESS_ACTION_TOOLS.has(name)) {
    if (isHeadless) {
      return allowAutoRun
        ? { decision: 'allow' }
        : { decision: 'block', reason: 'Scheduled audit mode does not allow this macOS action.' };
    }
    return { decision: 'allow' };
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

export async function generateToolPreview({ name: rawName, args: rawArgs = {} }) {
  const normalized = normalizeToolCall({ name: rawName, arguments: rawArgs });
  const name = normalized.name;
  const args = normalized.arguments;

  if (name === 'run_command') return String(args.command || '');
  if (name === 'run_applescript') return String(args.script || '');
  if (name === 'run_shortcut') return `shortcuts run ${String(args.name || '')}`;
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

export async function executeToolCall({ name: rawName, args: rawArgs = {} }, context = {}) {
  const normalized = normalizeToolCall({ name: rawName, arguments: rawArgs });
  const name = normalized.name;
  const args = normalized.arguments;
  const paths = context.paths || getRuntimePaths();

  try {
    switch (name) {
      case 'list_dir':
        return await listDir(args);
      case 'read_file':
        return await readFileTool(args);
      case 'write_file': {
        const result = await writeFileTool(args);
        if (result.ok) {
          invalidateSkillsCache(paths.skillsDir);
          invalidateKnowledgeCache(paths.knowledgeDir);
        }
        return result;
      }
      case 'edit_file': {
        const result = await editFileTool(args);
        if (result.ok) {
          invalidateSkillsCache(paths.skillsDir);
          invalidateKnowledgeCache(paths.knowledgeDir);
        }
        return result;
      }
      case 'search_files':
        return await searchFilesTool(args);
      case 'run_command': {
        const result = await runCommandTool({
          ...args,
          cwd: args.cwd || context.cwd,
          onStdout: context.onStdout,
          onStderr: context.onStderr,
          abortSignal: context.abortSignal,
        });
        // Shell recipes and inline scripts can edit managed skills/knowledge files directly.
        invalidateSkillsCache(paths.skillsDir);
        invalidateKnowledgeCache(paths.knowledgeDir);
        return result;
      }
      case 'run_applescript':
        return await runAppleScriptTool(args, { abortSignal: context.abortSignal });
      case 'calculate':
        return calculateTool(args);
      case 'update_plan':
        return updatePlanTool(args, { onEvent: context.onEvent });
      case 'copy_to_clipboard':
        return await copyToClipboardTool(args);
      case 'paste_from_clipboard':
        return await pasteFromClipboardTool();
      case 'show_notification':
        return await showNotificationTool(args);
      case 'open_app':
        return await openAppTool(args);
      case 'run_shortcut':
        return await runShortcutTool(args);
      case 'set_reminder':
        return await setReminderTool(args);
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
      case 'self_improve': {
        const mistake = String(args.mistake || '').trim();
        const fix = String(args.fix || '').trim();
        if (!mistake || !fix) {
          return { ok: false, output: 'Both "mistake" and "fix" are required for self_improve.' };
        }
        const existing = await readKnowledge(LEARNED_FIXES_DOC, paths);
        const prevLines = existing?.content
          ? existing.content
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.startsWith('- '))
          : [];
        const newRule = `- **Avoid**: ${mistake} -> **Fix**: ${fix}`;
        if (!prevLines.some((l) => l.toLowerCase() === newRule.toLowerCase())) {
          prevLines.push(newRule);
        }
        const body = [
          '# Autonomous Self-Learned Mistake Prevention Rules',
          '',
          'Automatically programmed from past tool errors, command recoveries, and output struggles:',
          '',
          ...prevLines.slice(-25),
        ].join('\n');
        await saveKnowledge(
          {
            name: LEARNED_FIXES_DOC,
            title: 'Self-Learned Mistake Prevention & Recovery Rules',
            tags: ['self-improvement', 'mistakes', 'auto-learned'],
            content: body,
          },
          paths
        );
        let skillMsg = '';
        if (args.skill_name && args.skill_content) {
          const slug = String(args.skill_name)
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-|-$/g, '');
          const savedSkill = await saveSkill(
            {
              name: slug,
              description: `Self-programmed workflow for: ${fix.slice(0, 100)}`,
              triggers: ['self-improved', slug],
              content: String(args.skill_content),
              extraFiles: args.helper_scripts,
            },
            paths
          );
          skillMsg = ` Also programmed reusable skill "${savedSkill.slug}".`;
        }
        return {
          ok: true,
          output: `Recorded mistake-prevention rule into ${LEARNED_FIXES_DOC}.${skillMsg}`,
        };
      }
      case 'fetch_url': {
        const parsedUrl = new URL(String(args.url || ''));
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return { ok: false, output: 'Only http:// and https:// URLs are supported.' };
        }
        const fetchImpl = context.fetchFn || globalThis.fetch;
        const res = await fetchImpl(parsedUrl.toString(), { signal: AbortSignal.timeout(12000) });
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
