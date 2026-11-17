import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSkillForMessage, selectRelevantSkills } from '../backend/agent/skill-match.mjs';
import { buildSystemPrompt } from '../backend/agent/prompt.mjs';

const skills = [
  {
    slug: 'academic-researcher',
    description: 'Search scholarly databases and verify citations.',
    triggers: ['paper', 'literature', 'citation'],
  },
  {
    slug: 'video-editor',
    description: 'Trim and export video with ffmpeg.',
    triggers: ['video', 'ffmpeg', 'reel'],
  },
  {
    slug: 'security-reviewer',
    description: 'Find vulnerabilities across trust boundaries.',
    triggers: ['security', 'vulnerability'],
  },
];

test('skill matching scores trigger hits above description overlap and ignores unrelated chatter', () => {
  assert.ok(scoreSkillForMessage(skills[0], 'Find the literature on transformer scaling') >= 4);
  assert.ok(scoreSkillForMessage(skills[1], 'trim this video and export a reel') > 4);
  assert.equal(scoreSkillForMessage(skills[2], 'hello there, how are you'), 0);
});

test('selectRelevantSkills returns the best two matches, ordered by score', () => {
  const picked = selectRelevantSkills(skills, 'write a literature review with citations for my paper');
  assert.equal(picked[0].slug, 'academic-researcher');
  assert.ok(picked.length <= 2);
  assert.deepEqual(selectRelevantSkills(skills, 'just saying hi'), []);
});

test('system prompt lists triggers and surfaces the suggested skills for the turn', () => {
  const prompt = buildSystemPrompt({
    skills,
    suggestedSkills: [skills[0]],
    knowledgeDocs: [],
    memoryContent: '',
    learnedFixesContent: '',
    repoPath: '',
    safetyMode: 'ask',
    cwd: '/tmp',
  });

  assert.match(prompt, /triggers: paper, literature, citation/);
  assert.match(prompt, /## Most Relevant Skills For This Turn/);
  assert.match(prompt, /academic-researcher: Search scholarly databases/);
});
