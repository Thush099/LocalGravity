/**
 * Build a ranked, grouped command-palette result list.
 * Kept framework-free so it can be unit tested without a browser.
 */
function scoreItem(item, query) {
  if (!query) return 1;
  const label = String(item.label || '').toLowerCase();
  const hint = String(item.hint || '').toLowerCase();
  const keywords = String(item.keywords || '').toLowerCase();
  if (label.startsWith(query)) return 4;
  if (label.includes(query)) return 3;
  if (keywords.includes(query)) return 2;
  if (hint.includes(query)) return 1;
  return 0;
}

export function buildPaletteItems({ query = '', groups = [], limits = {} } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const out = [];

  for (const group of groups) {
    if (!group || !Array.isArray(group.items)) continue;
    const limit = Number(limits[group.id] || group.limit || 8);
    const scored = group.items
      .map((item) => ({ item, score: scoreItem(item, q) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) =>
        q
          ? b.score - a.score || String(a.item.label).localeCompare(String(b.item.label))
          : 0
      )
      .slice(0, Math.max(0, limit));

    for (const { item } of scored) {
      out.push({ ...item, group: group.label });
    }
  }

  return out;
}
