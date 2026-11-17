const WORD_RE = /[a-z0-9]+/g;

function words(text) {
  return new Set(String(text || '').toLowerCase().match(WORD_RE) || []);
}

/**
 * Score how relevant an installed skill is to a user message using trigger hits,
 * slug overlap, and description overlap.
 */
export function scoreSkillForMessage(skill, message) {
  const messageText = String(message || '').toLowerCase();
  const messageWords = words(messageText);
  if (messageWords.size === 0) return 0;

  let score = 0;

  for (const rawTrigger of skill?.triggers || []) {
    const trigger = String(rawTrigger || '').toLowerCase().trim();
    if (!trigger) continue;
    if (trigger.includes(' ')) {
      if (messageText.includes(trigger)) score += 5;
    } else if (messageWords.has(trigger)) {
      score += 4;
    }
  }

  const slugWords = words(skill?.slug || skill?.name);
  for (const word of slugWords) {
    if (word.length > 2 && messageWords.has(word)) score += 2;
  }

  const descWords = words(skill?.description);
  let overlap = 0;
  for (const word of descWords) {
    if (word.length > 3 && messageWords.has(word)) overlap += 1;
  }
  score += Math.min(overlap, 5);

  return score;
}

/**
 * Return the best matching skills for a message, highest score first.
 * A minimum score keeps generic chatter from surfacing irrelevant skills.
 */
export function selectRelevantSkills(skills = [], message = '', { limit = 2, minScore = 4 } = {}) {
  return skills
    .map((skill) => ({ skill, score: scoreSkillForMessage(skill, message) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.skill.slug).localeCompare(String(b.skill.slug));
    })
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.skill);
}
