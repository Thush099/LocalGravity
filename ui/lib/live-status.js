// A local turn can spend a minute inside one tool. Saying which tool is running
// turns a blank, frozen-looking bubble into an explanation of the wait.
const TOOL_PHASES = {
  read_email: 'Reading your email',
  daily_briefing: 'Gathering your briefing',
  world_news: 'Checking the news',
  list_dir: 'Looking through the folder',
  read_file: 'Reading the file',
  search_files: 'Searching your files',
  write_file: 'Writing the file',
  edit_file: 'Editing the file',
  move_file: 'Moving files',
  undo_file_moves: 'Undoing the last move',
  run_command: 'Running a command',
  system_stats: 'Checking the Mac',
  network_usage: 'Checking network usage',
  speed_test: 'Testing the connection',
  search_web: 'Searching the web',
  fetch_url: 'Reading the page',
  take_screenshot: 'Looking at your screen',
  spotlight_search: 'Searching Spotlight',
  inspect_media: 'Opening the media',
  read_document: 'Reading the document',
  list_schedule_items: 'Reading your timetable',
  add_schedule_item: 'Updating your timetable',
  remove_schedule_item: 'Updating your timetable',
  set_reminder: 'Setting a reminder',
  show_notification: 'Showing a notification',
  open_app: 'Opening the app',
  run_shortcut: 'Running the shortcut',
  run_applescript: 'Driving the Mac',
  manage_notes: 'Updating Notes',
  copy_to_clipboard: 'Copying to the clipboard',
  paste_from_clipboard: 'Reading the clipboard',
  calculate: 'Doing the maths',
  save_knowledge: 'Saving to memory',
  search_knowledge: 'Checking your notes',
  read_knowledge: 'Reading your notes',
  read_skill: 'Loading a skill',
  save_skill: 'Saving a skill',
  git_op: 'Working with git',
  sqlite_query: 'Querying the database',
  large_files: 'Finding large files',
  self_improve: 'Updating its own instructions',
};

function describeTool(name) {
  const key = String(name || '')
    .toLowerCase()
    .trim();
  if (!key) return 'Running tools';
  if (TOOL_PHASES[key]) return TOOL_PHASES[key];
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? `Running ${words}` : 'Running tools';
}

export function getLivePhase(item, model, isWarming = false) {
  if (item.thinking?.length > 0 && !item.content && item.tools?.length === 0) return 'Deep thinking';
  if (item.tools?.some((tool) => tool.status === 'wait')) return 'Waiting for your approval';
  const running = (item.tools || []).filter((tool) => tool.status === 'running');
  if (running.length === 1) return describeTool(running[0].name);
  if (running.length > 1) return `Running ${running.length} tools`;
  if (!item.content) return isWarming ? 'Warming up model' : `Running ${model || 'model'}`;
  return 'Streaming reply';
}

/**
 * Pure derivation of where the active model runs and that runtime's health.
 * Free of DOM and module state so it can be unit-tested and shared between the
 * top-right mode pill and the sidebar runtime chip (which must never disagree).
 */
export function describeRuntimeState(config = {}, presets = {}, health = {}) {
  const prov = config.provider || 'ollama';
  const model = config.model || 'qwen3.5:4b';
  const thinking = Boolean(config.thinking);
  const isLocal = prov === 'ollama';
  const provLabel = isLocal ? 'Ollama' : presets?.[prov]?.label?.split(' ')[0] || prov;
  const ollama = health.ollama || {};
  const installed = Boolean(health.system?.tools?.ollama);
  const runningModels = Array.isArray(ollama.runningModels) ? ollama.runningModels : [];
  let daemon = 'stopped';
  if (!isLocal) daemon = 'cloud';
  else if (!installed) daemon = 'not-installed';
  else if (runningModels.some((m) => m.name === model)) daemon = 'loaded';
  else if (ollama.running) daemon = 'idle';
  return {
    isLocal,
    model,
    thinking,
    mode: thinking ? 'Deep Think' : 'Fast Mode',
    prov,
    provLabel,
    daemon,
    installed,
    runningModels,
  };
}
