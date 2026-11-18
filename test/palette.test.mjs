import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaletteItems } from '../ui/lib/palette.js';

const groups = [
  {
    id: 'actions',
    label: 'Actions',
    items: [
      { label: 'New task', hint: 'Start a fresh conversation', keywords: 'create session' },
      { label: 'Toggle Deep Think', hint: 'Slower reasoning', keywords: 'model thinking' },
      { label: 'Skill Library', hint: 'Import installed skills', keywords: 'skills import' },
      { label: 'Export conversation', hint: 'Download Markdown', keywords: 'download save' },
    ],
  },
  {
    id: 'skills',
    label: 'Skills',
    limit: 2,
    items: [
      { label: 'skill-scout', hint: 'Find and vet skills', keywords: 'skills discover' },
      { label: 'video-producer', hint: 'ffmpeg recipes', keywords: 'video ffmpeg' },
      { label: 'technical-writer', hint: 'Documentation', keywords: 'docs writing' },
    ],
  },
];

test('palette preserves group order and limits with an empty query', () => {
  const items = buildPaletteItems({ query: '', groups, limits: { actions: 2 } });
  assert.deepEqual(
    items.map((item) => `${item.group}:${item.label}`),
    ['Actions:New task', 'Actions:Toggle Deep Think', 'Skills:skill-scout', 'Skills:video-producer']
  );
});

test('palette ranks label matches above keyword and hint matches', () => {
  const items = buildPaletteItems({ query: 'skill', groups });
  assert.equal(items.find((item) => item.group === 'Skills').label, 'skill-scout');
  assert.ok(items.some((item) => item.label === 'Skill Library'));
});

test('palette matches hints, is case-insensitive, and returns empty on no match', () => {
  const byHint = buildPaletteItems({ query: 'FFMPEG', groups });
  assert.deepEqual(byHint.map((item) => item.label), ['video-producer']);
  assert.deepEqual(buildPaletteItems({ query: 'zzzz-no-match', groups }), []);
});

test('palette ignores malformed groups instead of throwing', () => {
  assert.deepEqual(
    buildPaletteItems({ query: '', groups: [null, { id: 'bad' }, { id: 'ok', label: 'OK', items: [] }] }),
    []
  );
});
