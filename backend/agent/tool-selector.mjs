const MEDIA_EXT_RE = /\.(?:png|jpe?g|webp|heic|gif|tiff?|bmp|mp4|mov|mkv|webm|m4v|avi)$/i;

// Actionable requests get a small tool core even when no domain pattern matched, so the
// local model can always act instead of replying that it cannot.
const MUTATING_TASK_RE = /\b(?:fix|edit|write|create|make|build|install|uninstall|clean|organize|sort|delete|remove|move|copy|rename|update|refactor|debug|implement|generate|convert|deploy|commit|test|run|execute|compile|repair|replace|set\s+up|configure)\b/i;
const READ_TASK_RE = /\b(?:list|show|find|read|open|check|search|look|browse|summarize|analy[sz]e|review|inspect|locate)\b/i;
const LOCAL_CONTEXT_RE =
  /\b(?:this|that|these|those|my|our|here|current|local|the)\s+(?:folder|directory|files?|project|repo|codebase|app|screen|mac|computer|machine|laptop|desktop|documents?|downloads?|notes?|calendar|images?|photos?|videos?|inbox|drive|battery|ram|cpu|disk|memory|storage|scripts?|modules?|components?|functions?)\b/i;

// A request to transform text the user just supplied (rewrite / humanize / summarize …) is a
// pure language task. Selecting tools drags their schemas into prefill — slowing the first
// token on a local model — and tempts it to call system_stats on a rewrite. Keep those turns
// tool-free unless the request points at a real file or folder to act on instead.
const TEXT_VERB_STRONG_RE =
  /\b(?:humaniz\w*|rewrite|reword|rephras\w*|paraphras\w*|summariz\w*|summaris\w*|condens\w*|shorten|tighten|polish|simplif\w*|proofread|translat\w*|restyle|restructur\w*|expand)\b/i;
const TEXT_VERB_WEAK_RE = /\b(?:make|fix|improv\w*|clean\s*up|tidy\s*up)\b/i;
const TEXT_NOUN_RE =
  /\b(?:text|paragraph|copy|prose|passage|content|answer|message|description|writing|note|sentence|grammar|spelling|typo\w*|tone|style|wording|email|letter|post|caption|intro|summary)\b/i;
const TEXT_ADJ_RE = /\b(?:concise|shorter|clearer|nicer|natural\w*|readable|professional|casual|formal|polished|simpler|fluid|smooth)\b/i;
const LOCAL_FS_REF_RE =
  /(?:~\/|\.\/|\/Users\/|\b[\w-]+\.(?:m?js|tsx?|jsx?|py|go|rs|swift|html|css|json|txt|md|pdf|docx?|xlsx?|csv|png|jpe?g|mp4|mov)\b)|\b(?:my|the|this|that)\s+(?:folder|directory|documents?|project|repo|codebase|downloads?|desktop|inbox|drive|files?|code|script|app|component|function|module|page|website|class|method|variable|endpoint|button|view|screen|element|widget|api|database|table|form)\b/i;

/** True when the request is purely to rewrite/summarize text the user pasted, not to act on files. */
function isPureTextTransform(msg) {
  const s = String(msg || '');
  // Only the request phrasing matters; anything pasted after a colon is data to transform.
  const request = s.split(/[:\n]/)[0].slice(0, 200);
  if (LOCAL_FS_REF_RE.test(request)) return false;
  const strong = TEXT_VERB_STRONG_RE.test(request);
  const weak = TEXT_VERB_WEAK_RE.test(request);
  if (!strong && !weak) return false;
  // An explicit text noun ("this paragraph", "my prose") is a provided-text transform.
  if (/\b(?:this|that|it|the|my)\b/i.test(request) && TEXT_NOUN_RE.test(request)) return true;
  // Bare "this/that/it" with a text adjective ("make this concise").
  if (/\b(?:this|that|it)\b/i.test(request) && TEXT_ADJ_RE.test(request)) return true;
  // Pasted content after a colon ("humanize this: …", "summarize: …") is a transform — unless
  // the "content" is really just a file reference ("summarize: README.md"), which needs tools.
  const content = s.split(/[:\n]/).slice(1).join(' ').trim();
  const contentIsFileRef = /^[\w./~-]+\.[a-z0-9]{1,5}$/i.test(content);
  return strong && /:\s*\S[\s\S]{4,}/.test(s) && !contentIsFileRef;
}

const TASK_FALLBACK_TOOLS = {
  read: ['list_dir', 'read_file', 'search_files'],
  mutating: ['list_dir', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command'],
};
// Once any of these investigative tools is selected, the request is already actionable.
const DISCOVERY_TOOLS = new Set([
  'list_dir',
  'read_file',
  'search_files',
  'inspect_media',
  'take_screenshot',
  'system_stats',
  'search_web',
  'fetch_url',
  'open_url',
  'read_email',
  'list_schedule_items',
  'git_op',
  'sqlite_query',
  'docker_op',
  'calculate',
]);

const DOMAIN_TOOL_GROUPS = [
  {
    tools: ['list_dir'],
    pattern:
      /\b(?:list|show)\b.{0,60}\b(?:files?|folders?|directories|paths|contents|entries)\b|\b(?:directory|folder)\s+(?:contents|listing|entries)\b|\bwhat(?:'s| is| are)\s+(?:in|inside|under|within)\s+(?:this|that|my|our|here|these|those)\b|\b(?:what|which)\s+(?:files?|folders?|directories|items|entries)\b|\b(?:contents?|entries)\s+(?:of|in|inside)\b/i,
  },
  {
    tools: ['read_file', 'search_files'],
    pattern: /\b(?:read|search|inspect|find|look\s+at)\b.{0,60}\b(?:files?|folders?|directories|paths|documents?|source|code)\b|\b(?:file|folder|directory|document|source\s+code)\b/i,
  },
  {
    tools: ['read_file', 'write_file', 'edit_file', 'search_files'],
    pattern:
      /\b(?:fix|debug|refactor|implement|edit|modify|rewrite|create|generate|update)\b.{0,80}\b(?:bug|issue|code|script|app|project|repo|file|component|function|module|website|page)\b|\b(?:bug|issue)\s+(?:in|with)\b|\b(?:[\w-]+\.(?:m?js|tsx?|jsx?|py|go|rs|swift|html|css|json|txt|md|pdf|docx?|xlsx?|csv|rtf|pages|numbers|key|log|sql|ya?ml|toml))\b/i,
  },
  {
    tools: ['move_file', 'undo_file_moves'],
    pattern:
      /\b(?:move|rename|relocate|reorganiz\w*|organize|tidy\s+up|declutter|clean\s+up|sort|undo|revert|put|place|restore)\b.{0,80}\b(?:files?|folders?|photos?|videos?|images?|documents?|downloads?|desktop|into|subfolders?|directory|folder|moves?|back|that|last|recent|organiz\w*|chang\w*)\b/i,
  },
  {
    tools: ['run_command'],
    pattern: /\b(?:run|execute|test|build|compile|install|npm|node|git|shell|terminal|command)\b/i,
  },
  {
    tools: ['git_op'],
    pattern: /\b(?:git|commit|push|pull|branch|checkout|diff|log|status|stage|repository|repo)\b/i,
  },
  {
    tools: ['sqlite_query'],
    pattern: /\b(?:sqlite|database|db|query|table|schema|sql)\b/i,
  },
  {
    tools: ['docker_op'],
    pattern: /\b(?:docker|container|images|ps|logs|stats|daemon)\b/i,
  },
  {
    tools: ['update_plan'],
    pattern:
      /\b(?:plan|roadmap|checklist|break\s+down|multi[- ]step|then\s+(?:run|check|verify|fix|edit|test))\b|\b(?:organize|clean\s+up|sort|tidy|declutter|reorganiz\w*|rename)\b.{0,60}\b(?:all|every|batch|bulk|multiple|entire|files?|folders?|photos?|videos?|downloads?|desktop|documents?|inbox|everything)\b/i,
  },
  {
    tools: ['system_stats'],
    pattern:
      /\b(?:system\s+stats|system\s+monitor|cpu|memory\s+usage|ram|gpu|disk\s+space|top\s+processes|slow\s+mac|activity\s+monitor)\b|\b(?:battery|power|charge|charging|uptime|storage|free\s+(?:space|memory|ram)|slow|sluggish|overheat\w*|fans?|temperature)\b|\b(?:how(?:'s| is)\s+(?:my|the)|my|the|this)\s+(?:mac|computer|machine|laptop|system|pc)\b/i,
  },
  {
    tools: ['network_usage', 'speed_test'],
    pattern:
      /\b(?:data\s+usage|network\s+usage|internet\s+(?:speed|usage)|speed\s*test|bandwidth|how\s+much\s+data|data\s+consumption|monthly\s+(?:data|usage|bandwidth)|upload\s+(?:speed|usage|rate)|download\s+(?:speed|usage|rate)|which\s+app\w*.{0,24}(?:data|network|bandwidth)|\d+\s*mbps|megabits?|connection\s+speed|(?:wifi|wi-?fi)\s+(?:speed|data|usage)|top\s+talkers?)\b/i,
  },
  {
    // Inbox questions come in every shape: "my unread emails", "summarize the
    // inbox", "anything urgent in my mail today". A qualifier between the
    // possessive and the noun used to defeat the briefing pattern entirely, so
    // the model was handed file tools and correctly answered that it could not
    // read mail. Match the mail nouns directly instead.
    tools: ['read_email'],
    pattern:
      /\b(?:unread|new|recent|latest|today'?s?|flagged|important|urgent)\s+(?:e-?mails?|inbox|mail)\b|\b(?:my|the)\s+(?:e-?mails?|inbox|mail)\b|\b(?:e-?mails?|inbox)\b.{0,40}\b(?:unread|urgent|important|summar\w*|digest|triage|flag\w*)\b|\b(?:check|read|open|summarize|triage)\s+(?:my\s+|the\s+)?(?:e-?mails?|inbox|mail)\b/i,
  },
  {
    tools: ['daily_briefing', 'world_news', 'read_email'],
    pattern:
      /\b(?:daily\s+briefing|briefing|morning\s+(?:brief|summary|update)|summarize\s+my\s+(?:day|email|inbox|mail|messages)|world\s+news|(?:top|latest|today\w{0,6})\s+(?:\d+\s+)?(?:world\s+)?news|news\s+(?:today|summary|headlines|roundup|update)|what\w{0,10}\s+(?:is\s+)?happening\s+in\s+the\s+world|read\s+my\s+(?:email|inbox|mail|messages)|emails?\s+(?:today|this\s+morning|unread))\b/i,
  },
  {
    tools: ['large_files'],
    pattern:
      /\b(?:large|big|biggest|largest|huge|massive)\s+(?:files?|items?|documents?|videos?|photos?)\b|\b(?:what'?s|what is)\s+(?:taking|eating|using|hogging|filling)\s+(?:up\s+)?(?:my\s+)?(?:disk|storage|space|drive)\b|\b(?:disk|storage|drive)\s+(?:cleanup|clean\s?up|usage|full|clutter)\b|\bfree\s*up\s+(?:disk|space|storage)\b/i,
  },
  {
    tools: ['inspect_media', 'take_screenshot', 'run_command'],
    pattern: /\b(?:photo|image|picture|video|clip|reel|frame|ffmpeg|magick|sips|screenshot|screen|display|desktop|on my screen|what'?s on|crop|resize|thumbnail|color|grade|audio|png|jpe?g|mp4|mov|webp|heic)\b/i,
  },
  {
    tools: ['spotlight_search'],
    pattern: /\b(?:spotlight|mdfind|find my|locate|where is my|pdf|keynote|pages|numbers|invoice|resume|receipt|downloads)\b/i,
  },
  {
    tools: ['read_document', 'read_file'],
    pattern:
      /\b(?:summarize|read|open|extract|parse|review|digest)\b.{0,60}\b(?:document|docx?|pdf|rtf|odt|word\s*doc|report|essay|paper|article|webarchive|manual)\b|\b(?:docx?|pdf|rtf|odt|webarchive)\b|\b(?:word\s*document|read\s+the\s+doc)\b/i,
  },
  {
    tools: ['list_schedule_items', 'add_schedule_item', 'remove_schedule_item'],
    // "today" and "daily" on their own are far too common to imply a timetable
    // question; a bare mention used to drag three schedule schemas into every
    // turn that said "today", slowing local prefill for no reason.
    pattern:
      /\b(?:schedule|timetable|agenda|calendar|meeting|class|workout|routine|timeblock|what'?s next|plan my day)\b|\b(?:daily|weekly)\s+(?:plan|schedule|routine|agenda|review|standup)\b|\b(?:add|remove|delete|move|cancel|reschedule)\b.{0,40}\b(?:block|session)\b|\b(?:today|tomorrow)\b.{0,30}\b(?:schedule|plan|agenda|blocks?|timetable)\b|\b(?:schedule|plan|agenda|blocks?|timetable)\b.{0,30}\b(?:today|tomorrow)\b/i,
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
    // Bare "mail", "music" or "calendar" made every inbox question load app
    // automation tools; the explicit open/launch verb covers those requests.
    pattern:
      /\b(?:open|launch)\s+[a-z]|\b(?:shortcut|shortcuts|applescript|osascript|finder|safari|apple notes|my notes|note titled|system events|automate)\b|\b(?:save|create)\b.{0,20}\bnote\b/i,
  },
  {
    tools: ['search_knowledge', 'read_knowledge', 'save_knowledge', 'read_skill', 'save_skill', 'self_improve'],
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
 * Cloud providers receive the full catalog; local Ollama models receive only tools relevant
 * to the current request or already used in the session.
 */
export function selectToolsForTurn(
  allTools = [],
  { provider = 'ollama', userMessage = '', sessionMessages = [], attachments = [], mode = 'auto' } = {}
) {
  if (!Array.isArray(allTools) || allTools.length === 0) return [];
  if (provider !== 'ollama') return allTools;

  // Pure provided-text turns (rewrite / humanize / summarize a pasted block) need no tools:
  // keep them tool-free so the lean prompt runs and the first token lands sooner.
  if (isPureTextTransform(userMessage)) return [];

  const selected = new Set();

  if (mode === 'researcher') {
    for (const name of ['search_web', 'fetch_url', 'open_url']) selected.add(name);
  } else if (mode === 'macops') {
    for (const name of [
      'spotlight_search',
      'manage_notes',
      'open_app',
      'run_shortcut',
      'list_schedule_items',
      'add_schedule_item',
    ]) {
      selected.add(name);
    }
  } else if (mode === 'writer') {
    for (const name of ['copy_to_clipboard', 'paste_from_clipboard', 'manage_notes']) selected.add(name);
  }

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

  const isMutatingTask = MUTATING_TASK_RE.test(combinedText);
  const isTaskLike = isMutatingTask || READ_TASK_RE.test(combinedText) || LOCAL_CONTEXT_RE.test(combinedText);
  const hasDiscoveryTool = [...selected].some((name) => DISCOVERY_TOOLS.has(name));
  if (isMutatingTask) {
    for (const name of TASK_FALLBACK_TOOLS.mutating) selected.add(name);
  } else if (isTaskLike && !hasDiscoveryTool) {
    for (const name of TASK_FALLBACK_TOOLS.read) selected.add(name);
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
