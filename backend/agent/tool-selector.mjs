const CORE_LOCAL_TOOLS = new Set([
  'list_dir',
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'run_command',
  'read_skill',
  'save_skill',
  'update_plan',
  'system_stats',
]);

const MEDIA_EXT_RE = /\.(?:png|jpe?g|webp|heic|gif|tiff?|bmp|mp4|mov|mkv|webm|m4v|avi)$/i;

const DOMAIN_TOOL_GROUPS = [
  {
    tools: ['inspect_media', 'take_screenshot'],
    pattern: /\b(?:photo|image|picture|video|clip|reel|frame|ffmpeg|magick|sips|screenshot|screen|display|desktop|on my screen|what'?s on|crop|resize|thumbnail|color|grade|audio|png|jpe?g|mp4|mov|webp|heic)\b/i,
  },
  {
    tools: ['spotlight_search'],
    pattern: /\b(?:spotlight|mdfind|find my|locate|where is my|pdf|keynote|pages|numbers|invoice|resume|receipt|downloads)\b/i,
  },
  {
    tools: ['list_schedule_items', 'add_schedule_item', 'remove_schedule_item'],
    pattern: /\b(?:schedule|timetable|agenda|calendar|meeting|class|workout|block|routine|daily|weekly|tomorrow|today|what'?s next|plan my day|timeblock)\b/i,
  },
  {
    tools: ['copy_to_clipboard', 'paste_from_clipboard'],
    pattern: /\b(?:clipboard|copy|paste|pbcopy|pbpaste)\b/i,
  },
  {
    tools: ['show_notification', 'set_reminder'],
    pattern: /\b(?:notify|notification|alert|remind|reminder|timer|alarm|nudge|in \d+\s*(?:sec|second|min|minute|hour|hr)s?)\b/i,
  },
  {
    tools: ['open_app', 'run_shortcut', 'run_applescript', 'manage_notes'],
    pattern: /\b(?:open\s+[a-z]|launch\s+[a-z]|shortcut|shortcuts|applescript|osascript|finder|safari|notes|apple notes|my notes|note titled|save.*note|create.*note|mail|music|calendar|system events|automate)\b/i,
  },
  {
    tools: ['search_knowledge', 'read_knowledge', 'save_knowledge', 'self_improve'],
    pattern: /\b(?:knowledge|memory|remember|preference|preferences|note|guide|learn|mistake|improve|self[- ]?improve|reprogram|install|upgrade|skill|workflow|teach)\b/i,
  },
  {
    tools: ['calculate'],
    pattern: /\b(?:calculate|calc|compute|math|sum|percent|percentage|average|mean|convert|equation|sqrt|log)\b|\d+\s*[+\-*/^%]\s*\d+/i,
  },
  {
    tools: ['search_web', 'fetch_url', 'open_url'],
    pattern: /https?:\/\/|\b(?:search\s+the\s+web|web\s+search|google|internet|online|latest|news|look\s+up|lookup|fetch|url|website|webpage|web page|docs|github|article|link|scrape)\b/i,
  },
];

/**
 * Select the optimal set of tool definitions for the current turn.
 * Cloud providers receive the full catalog; local Ollama models receive a lean core set
 * plus any domain groups relevant to the conversation or already used in the session.
 */
export function selectToolsForTurn(
  allTools = [],
  { provider = 'ollama', userMessage = '', sessionMessages = [], attachments = [] } = {}
) {
  if (!Array.isArray(allTools) || allTools.length === 0) return [];
  if (provider !== 'ollama') return allTools;

  const selected = new Set(CORE_LOCAL_TOOLS);

  // Keep any tool already invoked in this session active for KV-cache & multi-turn continuity
  const recentTextParts = [String(userMessage || '')];
  const recentMessages = Array.isArray(sessionMessages) ? sessionMessages.slice(-8) : [];
  for (const msg of recentMessages) {
    if (!msg) continue;
    if (msg.role === 'user' && typeof msg.content === 'string') {
      recentTextParts.push(msg.content);
    }
    if (Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        if (tc?.name) selected.add(tc.name);
      }
    }
  }

  if (Array.isArray(attachments) && attachments.some((p) => MEDIA_EXT_RE.test(String(p || '')))) {
    selected.add('inspect_media');
  }

  const combinedText = recentTextParts.join('\n');
  for (const group of DOMAIN_TOOL_GROUPS) {
    if (group.pattern.test(combinedText)) {
      for (const name of group.tools) selected.add(name);
    }
  }

  return allTools.filter((tool) => selected.has(tool?.function?.name));
}

/**
 * Return a compact copy of tool definitions tailored for local models with smaller context budgets.
 * Preserves every tool name, required field, and parameter type while trimming verbose prose.
 */
export function compactToolDefinitions(tools = []) {
  return tools.map((tool) => {
    const fn = tool?.function;
    if (!fn) return tool;
    const desc = String(fn.description || '').replace(/\s+/g, ' ').trim();
    const shortDesc = desc.length > 96 ? `${desc.slice(0, 93).trimEnd()}...` : desc;

    const params = fn.parameters;
    let compactParams = params;
    if (params && typeof params === 'object' && params.properties && typeof params.properties === 'object') {
      const nextProps = {};
      for (const [key, prop] of Object.entries(params.properties)) {
        if (!prop || typeof prop !== 'object') {
          nextProps[key] = prop;
          continue;
        }
        const clone = { ...prop };
        if (typeof clone.description === 'string' && clone.description.length > 56) {
          clone.description = `${clone.description.slice(0, 53).trimEnd()}...`;
        }
        nextProps[key] = clone;
      }
      compactParams = { ...params, properties: nextProps };
    }

    return {
      ...tool,
      function: {
        ...fn,
        description: shortDesc,
        parameters: compactParams,
      },
    };
  });
}
